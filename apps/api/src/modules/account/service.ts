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
          status: a.status,
          lastSyncedAt: new Date(),
        });
      }
      synced++;
    }

    return { fbAccountId, adAccountsSynced: synced };
  }).then(async (res) => {
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
    const rows = (await tx.execute(dsql`
      SELECT
        f.id::text          AS id,
        f.fb_user_id        AS fb_user_id,
        f.name              AS name,
        f.status::text      AS status,
        f.token_expires_at  AS token_expires_at,
        (SELECT COUNT(*)::int FROM ad_accounts a WHERE a.fb_account_id = f.id) AS ad_account_count
      FROM fb_accounts f
      WHERE f.company_id = ${principal.companyId}
      ORDER BY f.created_at ASC
    `)) as unknown as Array<{
      id: string;
      fb_user_id: string;
      name: string;
      status: string;
      token_expires_at: Date | string | null;
      ad_account_count: number;
    }>;

    // Operator/Viewer: 过滤到 grants 内
    const filtered = principal.scope.bypass
      ? rows
      : rows.filter((r) => {
          if (principal.scope.fbAccounts.includes(r.id)) return true;
          // 没直接授权 fb,但有授权该 fb 下的某 ad_account → 也能看到这个 fb
          return false; // 简化:不下钻;若用户希望可以扩展
        });

    return filtered.map((r) => ({
      id: r.id,
      fbUserId: r.fb_user_id,
      name: r.name,
      status: (r.status as 'active' | 'token_invalid' | 'disabled') ?? 'active',
      tokenExpiresAt: r.token_expires_at ? new Date(r.token_expires_at).toISOString() : null,
      adAccountCount: r.ad_account_count ?? 0,
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
    const select = {
      id: schema.adAccounts.id,
      metaActId: schema.adAccounts.metaActId,
      name: schema.adAccounts.name,
      currency: schema.adAccounts.currency,
      status: schema.adAccounts.status,
      lastSyncedAt: schema.adAccounts.lastSyncedAt,
      fbAccountId: schema.adAccounts.fbAccountId,
    } as const;

    const fbFilter = filter.fbAccountId
      ? eq(schema.adAccounts.fbAccountId, filter.fbAccountId)
      : undefined;

    if (principal.scope.bypass) {
      const q = tx.select(select).from(schema.adAccounts);
      return fbFilter ? await q.where(fbFilter) : await q;
    }

    const adIds = principal.scope.adAccounts;
    const fbIds = principal.scope.fbAccounts;
    if (!adIds.length && !fbIds.length) return [];

    const scopeConds: ReturnType<typeof inArray>[] = [];
    if (adIds.length) scopeConds.push(inArray(schema.adAccounts.id, adIds));
    if (fbIds.length) scopeConds.push(inArray(schema.adAccounts.fbAccountId, fbIds));
    const scopeCond =
      scopeConds.length === 1 ? scopeConds[0] : dsql`${scopeConds[0]} OR ${scopeConds[1]}`;

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
