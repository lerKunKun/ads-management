/**
 * authGuard: 解析 Bearer JWT, 加载有效权限/作用域，注入到 ctx.principal。
 * Redis 缓存 perm:{userId} TTL 5min；授权变更主动失效（grants 写入时 DEL）。
 */
import Elysia from 'elysia';
import { verify } from '../lib/jwt';
import { redis } from '../lib/redis';
import { Unauthorized } from '../lib/http-error';
import { loadPrincipal, type AuthPrincipal } from '../modules/iam/auth-service';

const PERM_TTL = 300; // 5 min

async function getPrincipal(userId: string): Promise<AuthPrincipal | null> {
  const key = `perm:${userId}`;
  const cached = await redis.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as AuthPrincipal;
    } catch {
      /* fallthrough */
    }
  }
  const p = await loadPrincipal(userId);
  if (p) await redis.set(key, JSON.stringify(p), 'EX', PERM_TTL);
  return p;
}

export function invalidatePrincipal(userId: string) {
  return redis.del(`perm:${userId}`);
}

export const authGuard = new Elysia({ name: 'auth-guard' }).derive(
  { as: 'scoped' },
  async ({ headers, query }) => {
    // 1) Authorization: Bearer ...  2) ?token=...  (EventSource 无 header)
    let tok: string | undefined;
    const auth = headers['authorization'] ?? '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) tok = m[1];
    if (!tok) {
      const q = (query as Record<string, string | undefined>)['token'];
      if (typeof q === 'string' && q.length) tok = q;
    }
    if (!tok) throw Unauthorized('missing bearer token');
    const payload = verify(tok);
    if (!payload) throw Unauthorized('invalid or expired token');
    const principal = await getPrincipal(payload.sub);
    if (!principal || principal.companyId !== payload.cid) {
      throw Unauthorized('principal not found');
    }
    return { principal };
  },
);

/**
 * requirePermission: 用于 route 的 beforeHandle，校验权限 code。
 *   `{ beforeHandle: requirePermission('iam:manage') }`
 */
export const requirePermission = (code: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((ctx: any) => {
    const p = ctx.principal as AuthPrincipal | undefined;
    if (!p) {
      ctx.set.status = 401;
      return { code: 401, msg: 'unauthorized', data: null };
    }
    if (!p.permissions.includes(code)) {
      ctx.set.status = 403;
      return { code: 403, msg: `forbidden: ${code}`, data: null };
    }
    return;
  });

/**
 * requireScope: 校验目标资源在 principal 的作用域内。CompanyAdmin/PlatformAdmin bypass。
 */
export function checkScope(
  principal: AuthPrincipal,
  resourceType: 'fb_account' | 'ad_account',
  resourceId: string,
): boolean {
  if (principal.scope.bypass) return true;
  const set =
    resourceType === 'fb_account'
      ? new Set(principal.scope.fbAccounts)
      : new Set(principal.scope.adAccounts);
  return set.has(resourceId);
}
