/**
 * 平台/公司管理员路由。
 *   - GET  /_admin/breakers          列当前 open 的熔断 key + TTL + reason
 *   - POST /_admin/breakers/reset    重置一个或多个熔断
 *   - POST /_admin/scan-token-health 立即触发 token 健康扫描
 *
 * 权限要求 iam:manage。MVP 不区分租户级和平台级:
 *   CompanyAdmin 可看 / 重置本公司 fb_account 的 breaker(通过比对 fb_id 所属公司)
 *   PlatformAdmin 全局
 */
import { Elysia, t } from 'elysia';
import { and, desc, eq, sql as dsql } from 'drizzle-orm';
import { redis } from '../../lib/redis';
import { close as breakerClose, BreakerKey } from '../../lib/breaker';
import { db, schema } from '../../lib/db';
import { scanTokenHealth } from '../account/service';
import {
  syncAdAccountObjects,
  syncDueAdAccounts,
  type SyncDepth,
} from '../ad-object/sync-service';
import { authGuard, requirePermission } from '../../middleware/auth';
import type { AuthPrincipal } from '../iam/auth-service';
import { writeAudit } from '../iam/auth-service';

type BreakerEntry = {
  key: string;
  kind: 'adacct' | 'fb';
  target: string;
  reason: string;
  ttl: number;
};

async function listOpenBreakers(): Promise<BreakerEntry[]> {
  const out: BreakerEntry[] = [];
  const stream = redis.scanStream({ match: 'breaker:*', count: 200 });
  const keys: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (ks: string[]) => keys.push(...ks));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  for (const k of keys) {
    const [reason, ttl] = await Promise.all([redis.get(k), redis.ttl(k)]);
    if (reason === null) continue;
    const parts = k.split(':');
    if (parts.length < 3) continue;
    const kind = parts[1] === 'adacct' ? 'adacct' : 'fb';
    const target = parts.slice(2).join(':');
    out.push({ key: k, kind, target, reason, ttl });
  }
  return out;
}

/** 过滤到当前 principal 可见的 breaker。CompanyAdmin 只看本公司 fb_account + 这些 fb 名下广告账户 */
async function filterByCompany(
  principal: AuthPrincipal,
  entries: BreakerEntry[],
): Promise<BreakerEntry[]> {
  if (principal.roles.includes('PlatformAdmin')) return entries;

  // fb_account id 直接可见
  const myFbIds = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    const fbs = await tx
      .select({ id: schema.fbAccounts.id, metaActIds: schema.adAccounts.metaActId })
      .from(schema.fbAccounts)
      .leftJoin(schema.adAccounts, eq(schema.adAccounts.fbAccountId, schema.fbAccounts.id));
    return fbs;
  });
  const myFbSet = new Set(myFbIds.map((x) => x.id));
  const myActSet = new Set(myFbIds.map((x) => x.metaActIds).filter((s): s is string => !!s));

  return entries.filter((e) =>
    e.kind === 'fb' ? myFbSet.has(e.target) : myActSet.has(e.target),
  );
}

export const admin = new Elysia({ name: 'admin' }).group('', (g) =>
  g
    .use(authGuard)
    .get(
      '/_admin/breakers',
      async ({ principal }) => {
        const all = await listOpenBreakers();
        const data = await filterByCompany(principal, all);
        return { code: 0, msg: 'ok', data };
      },
      { beforeHandle: requirePermission('iam:manage') },
    )
    .post(
      '/_admin/breakers/reset',
      async ({ principal, body, request }) => {
        const all = await listOpenBreakers();
        const visible = await filterByCompany(principal, all);
        const visibleSet = new Set(visible.map((e) => e.key));
        const targets = body.keys.filter((k) => visibleSet.has(k));
        if (targets.length === 0) {
          return { code: 0, msg: 'no matching breakers', data: { reset: 0 } };
        }
        for (const k of targets) await breakerClose(k);

        // 重置 fb 个号熔断时,把对应 fb_accounts.status 也改回 active
        for (const k of targets) {
          if (k.startsWith('breaker:fb:')) {
            const fbId = k.slice('breaker:fb:'.length);
            await db.transaction(async (tx) => {
              if (principal.roles.includes('PlatformAdmin')) {
                await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
              } else {
                await tx.execute(
                  dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
                );
              }
              await tx
                .update(schema.fbAccounts)
                .set({ status: 'active' })
                .where(eq(schema.fbAccounts.id, fbId));
            });
            await redis.del(`token:${fbId}`); // 强制重新解密(或下次拉)
          }
        }

        await writeAudit({
          companyId: principal.companyId,
          userId: principal.userId,
          action: 'admin:breakers:reset',
          resource: 'breaker',
          detail: { keys: targets },
          ...(request.headers.get('x-forwarded-for')
            ? { ip: request.headers.get('x-forwarded-for')!.split(',')[0]!.trim() }
            : {}),
        });

        return { code: 0, msg: 'ok', data: { reset: targets.length } };
      },
      {
        body: t.Object({ keys: t.Array(t.String({ minLength: 5 }), { minItems: 1 }) }),
        beforeHandle: requirePermission('iam:manage'),
      },
    )
    .post(
      '/_admin/scan-token-health',
      async ({ principal }) => {
        const r = await scanTokenHealth();
        await writeAudit({
          companyId: principal.companyId,
          userId: principal.userId,
          action: 'admin:scan-token-health',
          resource: 'token-health',
          detail: r,
        });
        return { code: 0, msg: 'ok', data: r };
      },
      { beforeHandle: requirePermission('iam:manage') },
    )
    .post(
      '/_admin/sync-ad-objects',
      async ({ principal, body, request }) => {
        const depth = (body.depth ?? 'campaign') as SyncDepth;
        const data = body.adAccountId
          ? await syncAdAccountObjects({
              companyId: principal.companyId,
              adAccountId: body.adAccountId,
              depth,
            })
          : await syncDueAdAccounts({
              companyId: principal.companyId,
              limit: body.limit ?? 2,
              depth,
            });
        await writeAudit({
          companyId: principal.companyId,
          userId: principal.userId,
          action: 'admin:sync-ad-objects',
          resource: body.adAccountId ? `ad_account:${body.adAccountId}` : 'ad_object_sync_due',
          detail: { depth, data },
          ...(request.headers.get('x-forwarded-for')
            ? { ip: request.headers.get('x-forwarded-for')!.split(',')[0]!.trim() }
            : {}),
        });
        return { code: 0, msg: 'ok', data };
      },
      {
        body: t.Object({
          adAccountId: t.Optional(t.String({ format: 'uuid' })),
          depth: t.Optional(
            t.Union([t.Literal('campaign'), t.Literal('adset'), t.Literal('ad')]),
          ),
          limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
        }),
        beforeHandle: requirePermission('iam:manage'),
      },
    )
    // 最近任务历史
    .get(
      '/_admin/tasks',
      async ({ principal, query }) => {
        const limit = Math.min(Math.max(Number(query.limit ?? '50'), 1), 200);
        const rows = await db.transaction(async (tx) => {
          await tx.execute(
            dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
          );
          return tx
            .select({
              id: schema.operationTasks.id,
              type: schema.operationTasks.type,
              status: schema.operationTasks.status,
              total: schema.operationTasks.total,
              success: schema.operationTasks.success,
              failed: schema.operationTasks.failed,
              userId: schema.operationTasks.userId,
              createdAt: schema.operationTasks.createdAt,
              payload: schema.operationTasks.payload,
            })
            .from(schema.operationTasks)
            .where(eq(schema.operationTasks.companyId, principal.companyId))
            .orderBy(desc(schema.operationTasks.createdAt))
            .limit(limit);
        });
        return { code: 0, msg: 'ok', data: rows };
      },
      {
        query: t.Object({ limit: t.Optional(t.String()) }),
        beforeHandle: requirePermission('iam:manage'),
      },
    )
    // 审计日志
    .get(
      '/_admin/audit',
      async ({ principal, query }) => {
        const limit = Math.min(Math.max(Number(query.limit ?? '100'), 1), 500);
        const rows = await db.transaction(async (tx) => {
          await tx.execute(
            dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
          );
          const conds = [eq(schema.auditLogs.companyId, principal.companyId)];
          if (query.action) conds.push(eq(schema.auditLogs.action, query.action));
          return tx
            .select({
              id: schema.auditLogs.id,
              action: schema.auditLogs.action,
              resource: schema.auditLogs.resource,
              detail: schema.auditLogs.detail,
              ip: schema.auditLogs.ip,
              userId: schema.auditLogs.userId,
              createdAt: schema.auditLogs.createdAt,
            })
            .from(schema.auditLogs)
            .where(and(...conds))
            .orderBy(desc(schema.auditLogs.createdAt))
            .limit(limit);
        });
        return { code: 0, msg: 'ok', data: rows };
      },
      {
        query: t.Object({
          limit: t.Optional(t.String()),
          action: t.Optional(t.String()),
        }),
        beforeHandle: requirePermission('iam:manage'),
      },
    ),
);

// 让 BreakerKey 在编译时被引用，避免 dead-code 警告
void BreakerKey;
