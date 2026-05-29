/**
 * 账户/FB Token 业务逻辑。所有写入走 withTenant，确保 RLS 上下文。
 */
import { and, eq, inArray, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../lib/db';
import { encryptToken } from '../../lib/crypto';
import { meta } from '../../lib/meta-client';
import { crm } from '../../lib/crm-client';
import { env } from '../../env';
import { notifier } from '../../lib/notifier';
import { redis } from '../../lib/redis';
import { BreakerKey } from '../../lib/breaker';
import { Forbidden, NotFound } from '../../lib/http-error';
import { writeAudit } from '../iam/auth-service';
import type { AuthPrincipal } from '../iam/auth-service';

async function withTenant<T>(
  companyId: string,
  fn: (txDb: typeof db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
    return fn(tx as unknown as typeof db);
  });
}

export async function getAuthorizeUrl(): Promise<string> {
  const r = await crm.authorizeUrl(env.fbOauthRedirectUri);
  return r.authorize_url;
}

export interface EffectiveScope {
  bypass: boolean;
  fbAccountIds: string[];
  adAccountIds: string[];
}

interface EffectiveScopeInternal {
  bypass: boolean;
  fbAccountIds: Set<string>;
  adAccountIds: Set<string>;
  visibleAdCountByFb: Map<string, number>;
}

async function invalidatePrincipalCache(userId: string): Promise<void> {
  const stream = redis.scanStream({ match: `perm:${userId}:*`, count: 50 });
  const keys: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: string[]) => keys.push(...chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  if (keys.length > 0) await redis.del(...keys);
}

async function resolveEffectiveScopeInTenant(
  tx: typeof db,
  principal: AuthPrincipal,
): Promise<EffectiveScopeInternal> {
  const [fbRows, adRows] = await Promise.all([
    tx
      .select({ id: schema.fbAccounts.id })
      .from(schema.fbAccounts)
      .where(eq(schema.fbAccounts.companyId, principal.companyId)),
    tx
      .select({
        id: schema.adAccounts.id,
        fbAccountId: schema.adAccounts.fbAccountId,
      })
      .from(schema.adAccounts)
      .where(eq(schema.adAccounts.companyId, principal.companyId)),
  ]);

  const fbGrantSet = new Set(principal.scope.fbAccounts);
  const adGrantSet = new Set(principal.scope.adAccounts);
  const fbAccountIds = new Set<string>();
  const adAccountIds = new Set<string>();
  const visibleAdCountByFb = new Map<string, number>();

  for (const fb of fbRows) {
    if (principal.scope.bypass || fbGrantSet.has(fb.id)) {
      fbAccountIds.add(fb.id);
    }
  }

  for (const ad of adRows) {
    const visible =
      principal.scope.bypass ||
      adGrantSet.has(ad.id);
    if (!visible) continue;
    adAccountIds.add(ad.id);
    fbAccountIds.add(ad.fbAccountId);
    visibleAdCountByFb.set(
      ad.fbAccountId,
      (visibleAdCountByFb.get(ad.fbAccountId) ?? 0) + 1,
    );
  }

  return {
    bypass: principal.scope.bypass,
    fbAccountIds,
    adAccountIds,
    visibleAdCountByFb,
  };
}

export async function resolveEffectiveScope(
  principal: AuthPrincipal,
): Promise<EffectiveScope> {
  return withTenant(principal.companyId, async (tx) => {
    const scope = await resolveEffectiveScopeInTenant(tx, principal);
    return {
      bypass: scope.bypass,
      fbAccountIds: Array.from(scope.fbAccountIds),
      adAccountIds: Array.from(scope.adAccountIds),
    };
  });
}

/**
 * code → token → 拉 me + 广告账户 → 写库（fb_accounts + ad_accounts）
 * 返回 fb_account 与新增广告账户列表（不含 token）
 */
export async function bindFbAccount(args: {
  principal: AuthPrincipal;
  code: string;
}): Promise<{ fbAccountId: string; adAccountsSynced: number }> {
  const { principal, code } = args;
  const exchanged = await crm.exchangeToken(env.fbOauthRedirectUri, code);
  const accessToken = exchanged.access_token;
  const expiresIn = exchanged.expires_in ?? 60 * 24 * 3600; // 60 days default

  const me = await meta.me(accessToken);
  const adAccounts = await meta.listUserAdAccounts(accessToken);

  return withTenant(principal.companyId, async (tx) => {
    const tokenEnc = encryptToken(accessToken);
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    // upsert by (company_id, fb_user_id)
    const existed = await tx
      .select()
      .from(schema.fbAccounts)
      .where(
        and(
          eq(schema.fbAccounts.companyId, principal.companyId),
          eq(schema.fbAccounts.fbUserId, me.id),
        ),
      )
      .limit(1);
    let fbAccountId: string;
    if (existed[0]) {
      fbAccountId = existed[0].id;
      await tx
        .update(schema.fbAccounts)
        .set({
          name: me.name,
          accessTokenEnc: tokenEnc,
          tokenExpiresAt,
          status: 'active',
        })
        .where(eq(schema.fbAccounts.id, fbAccountId));
    } else {
      const inserted = await tx
        .insert(schema.fbAccounts)
        .values({
          companyId: principal.companyId,
          fbUserId: me.id,
          name: me.name,
          accessTokenEnc: tokenEnc,
          tokenExpiresAt,
          status: 'active',
        })
        .returning();
      fbAccountId = inserted[0]!.id;
    }

    // 同步广告账户
    let synced = 0;
    for (const a of adAccounts) {
      const existedAd = await tx
        .select()
        .from(schema.adAccounts)
        .where(
          and(
            eq(schema.adAccounts.companyId, principal.companyId),
            eq(schema.adAccounts.metaActId, a.metaActId),
          ),
        )
        .limit(1);
      if (existedAd[0]) {
        await tx
          .update(schema.adAccounts)
          .set({
            fbAccountId,
            name: a.name,
            currency: a.currency ?? null,
            timezoneName: a.timezoneName ?? null,
            businessCountryCode: a.businessCountryCode ?? null,
            status: a.status,
            lastSyncedAt: new Date(),
          })
          .where(eq(schema.adAccounts.id, existedAd[0].id));
      } else {
        await tx.insert(schema.adAccounts).values({
          fbAccountId,
          companyId: principal.companyId,
          metaActId: a.metaActId,
          name: a.name,
          currency: a.currency ?? null,
          timezoneName: a.timezoneName ?? null,
          businessCountryCode: a.businessCountryCode ?? null,
          status: a.status,
          lastSyncedAt: new Date(),
        });
      }
      synced++;
    }

    await tx
      .insert(schema.userResourceGrants)
      .values({
        userId: principal.userId,
        resourceType: 'fb_account',
        resourceId: fbAccountId,
        grantedBy: principal.userId,
      })
      .onConflictDoNothing();

    return { fbAccountId, adAccountsSynced: synced };
  }).then(async (res) => {
    await invalidatePrincipalCache(principal.userId);
    await redis.del(`token:${res.fbAccountId}`, BreakerKey.fbAccount(res.fbAccountId));
    await writeAudit({
      companyId: principal.companyId,
      userId: principal.userId,
      action: 'fb_account:bind',
      resource: `fb_account:${res.fbAccountId}`,
      detail: { fbUserId: me.id, synced: res.adAccountsSynced },
    });
    return res;
  });
}

export async function unbindFbAccount(args: {
  principal: AuthPrincipal;
  fbAccountId: string;
}): Promise<{ fbAccountId: string; adAccountsRemoved: number }> {
  const { principal, fbAccountId } = args;
  const result = await withTenant(principal.companyId, async (tx) => {
    const fb = await tx
      .select({
        id: schema.fbAccounts.id,
        fbUserId: schema.fbAccounts.fbUserId,
        name: schema.fbAccounts.name,
      })
      .from(schema.fbAccounts)
      .where(
        and(
          eq(schema.fbAccounts.id, fbAccountId),
          eq(schema.fbAccounts.companyId, principal.companyId),
        ),
      )
      .limit(1);
    const row = fb[0];
    if (!row) throw NotFound('FB个人号不存在');
    if (!principal.scope.bypass && !principal.scope.fbAccounts.includes(fbAccountId)) {
      throw Forbidden('无权解绑该FB个人号');
    }

    const adRows = await tx
      .select({
        id: schema.adAccounts.id,
        metaActId: schema.adAccounts.metaActId,
      })
      .from(schema.adAccounts)
      .where(
        and(
          eq(schema.adAccounts.companyId, principal.companyId),
          eq(schema.adAccounts.fbAccountId, fbAccountId),
        ),
      );
    const adAccountIds = adRows.map((ad) => ad.id);

    const fbGrantUsers = await tx
      .select({ userId: schema.userResourceGrants.userId })
      .from(schema.userResourceGrants)
      .where(
        and(
          eq(schema.userResourceGrants.resourceType, 'fb_account'),
          eq(schema.userResourceGrants.resourceId, fbAccountId),
        ),
      );
    const adGrantUsers = adAccountIds.length > 0
      ? await tx
        .select({ userId: schema.userResourceGrants.userId })
        .from(schema.userResourceGrants)
        .where(
          and(
            eq(schema.userResourceGrants.resourceType, 'ad_account'),
            inArray(schema.userResourceGrants.resourceId, adAccountIds),
          ),
        )
      : [];

    await tx
      .delete(schema.userResourceGrants)
      .where(
        and(
          eq(schema.userResourceGrants.resourceType, 'fb_account'),
          eq(schema.userResourceGrants.resourceId, fbAccountId),
        ),
      );
    if (adAccountIds.length > 0) {
      await tx
        .delete(schema.userResourceGrants)
        .where(
          and(
            eq(schema.userResourceGrants.resourceType, 'ad_account'),
            inArray(schema.userResourceGrants.resourceId, adAccountIds),
          ),
        );
    }

    await tx
      .delete(schema.fbAccounts)
      .where(
        and(
          eq(schema.fbAccounts.id, fbAccountId),
          eq(schema.fbAccounts.companyId, principal.companyId),
        ),
      );

    return {
      fbAccountId,
      fbUserId: row.fbUserId,
      name: row.name,
      adAccountsRemoved: adRows.length,
      adMetaActIds: adRows.map((ad) => ad.metaActId),
      affectedUserIds: Array.from(
        new Set([
          principal.userId,
          ...fbGrantUsers.map((grant) => grant.userId),
          ...adGrantUsers.map((grant) => grant.userId),
        ]),
      ),
    };
  });

  await Promise.all(result.affectedUserIds.map((userId) => invalidatePrincipalCache(userId)));
  await redis.del(
    `token:${fbAccountId}`,
    BreakerKey.fbAccount(fbAccountId),
    ...result.adMetaActIds.map((metaActId) => BreakerKey.adAccount(metaActId)),
  );
  await writeAudit({
    companyId: principal.companyId,
    userId: principal.userId,
    action: 'fb_account:unbind',
    resource: `fb_account:${fbAccountId}`,
    detail: {
      fbUserId: result.fbUserId,
      name: result.name,
      adAccountsRemoved: result.adAccountsRemoved,
    },
  });
  return {
    fbAccountId: result.fbAccountId,
    adAccountsRemoved: result.adAccountsRemoved,
  };
}

/**
 * 列出当前 principal 作用域内的 FB 个号(含其下广告账户数)。
 * Drill-down 第一层入口。
 */
export async function listFbAccounts(principal: AuthPrincipal): Promise<
  Array<{
    id: string;
    fbUserId: string;
    name: string;
    status: 'active' | 'token_invalid' | 'disabled';
    tokenExpiresAt: string | null;
    adAccountCount: number;
  }>
> {
  return withTenant(principal.companyId, async (tx) => {
    const scope = await resolveEffectiveScopeInTenant(tx, principal);
    const fbRows = await tx
      .select({
        id: schema.fbAccounts.id,
        fbUserId: schema.fbAccounts.fbUserId,
        name: schema.fbAccounts.name,
        status: schema.fbAccounts.status,
        tokenExpiresAt: schema.fbAccounts.tokenExpiresAt,
        createdAt: schema.fbAccounts.createdAt,
      })
      .from(schema.fbAccounts)
      .where(eq(schema.fbAccounts.companyId, principal.companyId));

    return fbRows
      .filter((f) => scope.fbAccountIds.has(f.id))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((f) => ({
        id: f.id,
        fbUserId: f.fbUserId,
        name: f.name,
        status: f.status,
        tokenExpiresAt: f.tokenExpiresAt ? f.tokenExpiresAt.toISOString() : null,
        adAccountCount: scope.visibleAdCountByFb.get(f.id) ?? 0,
    }));
  });
}

/**
 * 列出当前 principal 作用域内的广告账户（可选 fbAccountId 过滤,用于 drill-down 第二层）。
 * CompanyAdmin/PlatformAdmin: 公司全部
 * Operator/Viewer: 仅作用域内的 fb_account/ad_account
 */
export async function listAdAccounts(
  principal: AuthPrincipal,
  filter: { fbAccountId?: string } = {},
) {
  return withTenant(principal.companyId, async (tx) => {
    const scope = await resolveEffectiveScopeInTenant(tx, principal);
    const select = {
      id: schema.adAccounts.id,
      metaActId: schema.adAccounts.metaActId,
      name: schema.adAccounts.name,
      currency: schema.adAccounts.currency,
      timezoneName: schema.adAccounts.timezoneName,
      businessCountryCode: schema.adAccounts.businessCountryCode,
      status: schema.adAccounts.status,
      lastSyncedAt: schema.adAccounts.lastSyncedAt,
      fbAccountId: schema.adAccounts.fbAccountId,
    } as const;

    const fbFilter = filter.fbAccountId
      ? eq(schema.adAccounts.fbAccountId, filter.fbAccountId)
      : undefined;

    if (scope.bypass) {
      const q = tx.select(select).from(schema.adAccounts);
      return fbFilter ? await q.where(fbFilter) : await q;
    }

    const adIds = Array.from(scope.adAccountIds);
    if (!adIds.length) return [];

    const scopeCond = inArray(schema.adAccounts.id, adIds);
    const finalCond = fbFilter ? dsql`(${scopeCond}) AND ${fbFilter}` : scopeCond;
    return tx.select(select).from(schema.adAccounts).where(finalCond);
  });
}

/**
 * Token 健康扫描：到期 < 7 天的发告警。
 * 跨租户读取 → bypass_rls 事务。每 6h 由定时器调；也支持管理端手动触发。
 *
 * 同一 fb_account 一天内只告警一次（Redis 去重 key,TTL 24h）。
 */
export async function scanTokenHealth(): Promise<{ scanned: number; notified: number }> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    const r = await tx.execute(
      dsql`SELECT id::text AS id, company_id::text AS company_id, name,
                  token_expires_at, status
           FROM fb_accounts
           WHERE token_expires_at IS NOT NULL
             AND token_expires_at < NOW() + INTERVAL '7 days'
             AND status IN ('active', 'token_invalid')`,
    );
    return r as unknown as Array<{
      id: string;
      company_id: string;
      name: string;
      token_expires_at: Date;
      status: string;
    }>;
  });

  let notified = 0;
  for (const r of rows) {
    const dedupKey = `notify:tokenexpiry:${r.id}:${new Date().toISOString().slice(0, 10)}`;
    const seen = await redis.set(dedupKey, '1', 'EX', 24 * 3600, 'NX');
    if (seen !== 'OK') continue;
    notified++;
    const daysLeft = Math.max(
      0,
      Math.floor((new Date(r.token_expires_at).getTime() - Date.now()) / (24 * 3600 * 1000)),
    );
    await notifier.notify(
      r.status === 'token_invalid' || daysLeft <= 1 ? 'error' : 'warn',
      r.status === 'token_invalid' ? 'FB token 已失效' : `FB token 将在 ${daysLeft} 天内过期`,
      {
        fbAccountId: r.id,
        companyId: r.company_id,
        name: r.name,
        expiresAt: r.token_expires_at,
        status: r.status,
      },
    );
  }
  return { scanned: rows.length, notified };
}
