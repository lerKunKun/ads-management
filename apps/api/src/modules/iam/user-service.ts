/**
 * IAM 用户/角色/作用域管理。
 *
 * 安全要点:
 *   - 写入走 RLS 事务(set_config('app.current_company_id', ...))
 *   - 修改用户(改角色/作用域/状态)后立即 DEL Redis perm:{userId} 缓存,
 *     下次该用户请求会从 DB 重建。
 *   - 角色可分配:本公司角色 + 平台级(company_id IS NULL)的 Operator/Viewer;
 *     PlatformAdmin 角色不允许通过此接口分配(防权限提升)。
 */
import { and, eq, inArray, isNull, or, sql as dsql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db, schema } from '../../lib/db';
import { redis } from '../../lib/redis';
import { HttpError } from '../../lib/http-error';
import type { AuthPrincipal } from './auth-service';

export interface UserListItem {
  id: string;
  email: string;
  status: 'active' | 'disabled';
  createdAt: string;
  roles: string[]; // role code
  grantsCount: number;
  fbAccountGrantCount: number;
  adAccountGrantCount: number;
}

export interface RoleOption {
  id: string;
  code: string;
  name: string;
  scope: 'platform' | 'company';
}

const ROLE_ALLOW = new Set(['CompanyAdmin', 'Operator', 'Viewer']);

function isPlatformAdmin(principal: AuthPrincipal): boolean {
  return principal.roles.includes('PlatformAdmin');
}

function assertPlatformAdmin(principal: AuthPrincipal) {
  if (!isPlatformAdmin(principal)) {
    throw new HttpError(403, 403, '仅超管可以修改或删除其他用户');
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function bumpPermCache(userId: string): Promise<void> {
  const stream = redis.scanStream({ match: `perm:${userId}:*`, count: 50 });
  const keys: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: string[]) => keys.push(...chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  if (keys.length > 0) await redis.del(...keys);
}

/** 列出本公司用户(含角色 + 作用域计数) */
export async function listUsers(
  principal: AuthPrincipal,
): Promise<UserListItem[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );
    const rows = (await tx.execute(dsql`
      SELECT
        u.id::text         AS id,
        u.email            AS email,
        u.status::text     AS status,
        u.created_at       AS created_at,
        COALESCE(
          ARRAY_AGG(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL),
          '{}'::text[]
        ) AS roles,
        (SELECT COUNT(*)::int FROM user_resource_grants g WHERE g.user_id = u.id) AS grants_count,
        (SELECT COUNT(*)::int FROM user_resource_grants g WHERE g.user_id = u.id AND g.resource_type = 'fb_account') AS fb_account_grant_count,
        (SELECT COUNT(*)::int FROM user_resource_grants g WHERE g.user_id = u.id AND g.resource_type = 'ad_account') AS ad_account_grant_count
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r       ON r.id = ur.role_id
      WHERE u.company_id = ${principal.companyId}
      GROUP BY u.id
      ORDER BY u.created_at ASC
    `)) as unknown as Array<{
      id: string;
      email: string;
      status: string;
      created_at: Date | string;
      roles: string[];
      grants_count: number;
      fb_account_grant_count: number;
      ad_account_grant_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      status: (r.status as UserListItem['status']) ?? 'active',
      createdAt: new Date(r.created_at).toISOString(),
      roles: r.roles ?? [],
      grantsCount: r.grants_count ?? 0,
      fbAccountGrantCount: r.fb_account_grant_count ?? 0,
      adAccountGrantCount: r.ad_account_grant_count ?? 0,
    }));
  });
}

/** 创建用户(指定一个角色) */
export async function createUser(
  principal: AuthPrincipal,
  args: { email: string; password: string; roleCode: string },
): Promise<{ id: string }> {
  if (!ROLE_ALLOW.has(args.roleCode)) {
    throw new HttpError(403, 403, `不允许分配角色 ${args.roleCode}`);
  }
  if (args.password.length < 6) {
    throw new HttpError(422, 422, '密码至少 6 位');
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );

    // 邮箱唯一性
    const email = normalizeEmail(args.email);
    const dup = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (dup[0]) throw new HttpError(409, 409, '邮箱已注册');

    const ins = await tx
      .insert(schema.users)
      .values({
        companyId: principal.companyId,
        email,
        pwdHash: await bcrypt.hash(args.password, 10),
        status: 'active',
      })
      .returning({ id: schema.users.id });
    const userId = ins[0]!.id;

    const role = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          eq(schema.roles.code, args.roleCode),
          or(
            eq(schema.roles.companyId, principal.companyId),
            isNull(schema.roles.companyId),
          )!,
        ),
      )
      .limit(1);
    if (!role[0]) throw new HttpError(404, 404, `角色 ${args.roleCode} 不存在`);
    await tx.insert(schema.userRoles).values({ userId, roleId: role[0].id });
    return { id: userId };
  });
}

/** 改用户角色/状态 */
export async function updateUser(
  principal: AuthPrincipal,
  userId: string,
  patch: { email?: string; roleCode?: string; status?: 'active' | 'disabled' },
): Promise<void> {
  assertPlatformAdmin(principal);
  if (userId === principal.userId && patch.status === 'disabled') {
    throw new HttpError(422, 422, '不能禁用自己');
  }
  if (patch.roleCode !== undefined && !ROLE_ALLOW.has(patch.roleCode)) {
    throw new HttpError(403, 403, `不允许分配角色 ${patch.roleCode}`);
  }
  await db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );
    const u = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, userId),
          eq(schema.users.companyId, principal.companyId),
        ),
      )
      .limit(1);
    if (!u[0]) throw new HttpError(404, 404, '用户不存在');

    if (patch.email !== undefined) {
      const email = normalizeEmail(patch.email);
      const dup = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      if (dup[0] && dup[0].id !== userId) {
        throw new HttpError(409, 409, '邮箱已注册');
      }
      await tx.update(schema.users).set({ email }).where(eq(schema.users.id, userId));
    }

    if (patch.status) {
      await tx
        .update(schema.users)
        .set({ status: patch.status })
        .where(eq(schema.users.id, userId));
    }
    if (patch.roleCode) {
      const r = await tx
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(
          and(
            eq(schema.roles.code, patch.roleCode),
            or(
              eq(schema.roles.companyId, principal.companyId),
              isNull(schema.roles.companyId),
            )!,
          ),
        )
        .limit(1);
      if (!r[0]) throw new HttpError(404, 404, `角色 ${patch.roleCode} 不存在`);
      // 简化:每个用户只保留一个角色。删旧 + 加新。
      await tx.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
      await tx.insert(schema.userRoles).values({ userId, roleId: r[0].id });
    }
  });
  await bumpPermCache(userId);
}

/** 删除用户 */
export async function deleteUser(
  principal: AuthPrincipal,
  userId: string,
): Promise<void> {
  assertPlatformAdmin(principal);
  if (userId === principal.userId) {
    throw new HttpError(422, 422, '不能删除自己');
  }
  await db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );
    const user = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), eq(schema.users.companyId, principal.companyId)))
      .limit(1);
    if (!user[0]) throw new HttpError(404, 404, '用户不存在');

    await tx
      .update(schema.auditLogs)
      .set({ userId: null })
      .where(eq(schema.auditLogs.userId, userId));
    await tx
      .update(schema.operationTasks)
      .set({ userId: principal.userId })
      .where(eq(schema.operationTasks.userId, userId));
    await tx
      .update(schema.userResourceGrants)
      .set({ grantedBy: principal.userId })
      .where(eq(schema.userResourceGrants.grantedBy, userId));
    await tx.delete(schema.users).where(eq(schema.users.id, userId));
  });
  await bumpPermCache(userId);
}

export async function changeOwnPassword(
  principal: AuthPrincipal,
  args: { currentPassword: string; newPassword: string },
): Promise<void> {
  if (!isPlatformAdmin(principal)) {
    throw new HttpError(403, 403, '仅超管可以修改自己的密码');
  }
  if (args.newPassword.length < 6) {
    throw new HttpError(422, 422, '密码至少 6 位');
  }
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    const user = await tx
      .select({ id: schema.users.id, pwdHash: schema.users.pwdHash })
      .from(schema.users)
      .where(eq(schema.users.id, principal.userId))
      .limit(1);
    if (!user[0]) throw new HttpError(404, 404, '用户不存在');
    const ok = await bcrypt.compare(args.currentPassword, user[0].pwdHash);
    if (!ok) throw new HttpError(401, 401, '当前密码不正确');
    await tx
      .update(schema.users)
      .set({ pwdHash: await bcrypt.hash(args.newPassword, 10) })
      .where(eq(schema.users.id, principal.userId));
  });
  await bumpPermCache(principal.userId);
}

export async function listRoles(
  principal: AuthPrincipal,
): Promise<RoleOption[]> {
  return db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );
    const rows = await tx
      .select({
        id: schema.roles.id,
        code: schema.roles.code,
        name: schema.roles.name,
        companyId: schema.roles.companyId,
      })
      .from(schema.roles)
      .where(
        or(
          eq(schema.roles.companyId, principal.companyId),
          isNull(schema.roles.companyId),
        )!,
      );
    return rows
      .filter((r) => ROLE_ALLOW.has(r.code))
      .map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        scope: (r.companyId ? 'company' : 'platform') as 'company' | 'platform',
      }));
  });
}

/** 列用户的作用域 */
export async function listGrants(
  principal: AuthPrincipal,
  userId: string,
): Promise<
  Array<{ id: string; resourceType: 'fb_account' | 'ad_account'; resourceId: string }>
> {
  return db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );
    const u = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, userId),
          eq(schema.users.companyId, principal.companyId),
        ),
      )
      .limit(1);
    if (!u[0]) throw new HttpError(404, 404, '用户不存在');
    const rows = await tx
      .select({
        id: schema.userResourceGrants.id,
        resourceType: schema.userResourceGrants.resourceType,
        resourceId: schema.userResourceGrants.resourceId,
      })
      .from(schema.userResourceGrants)
      .where(eq(schema.userResourceGrants.userId, userId));
    return rows.map((r) => ({
      id: r.id,
      resourceType: r.resourceType as 'fb_account' | 'ad_account',
      resourceId: r.resourceId,
    }));
  });
}

/** 加授权(同 type + resourceId 视为已存在,幂等) */
export async function addGrant(
  principal: AuthPrincipal,
  userId: string,
  args: { resourceType: 'fb_account' | 'ad_account'; resourceId: string },
): Promise<{ id: string }> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );

    // 用户必须本公司
    const u = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, userId),
          eq(schema.users.companyId, principal.companyId),
        ),
      )
      .limit(1);
    if (!u[0]) throw new HttpError(404, 404, '用户不存在');

    // 资源必须本公司
    if (args.resourceType === 'fb_account') {
      const fb = await tx
        .select({ id: schema.fbAccounts.id })
        .from(schema.fbAccounts)
        .where(
          and(
            eq(schema.fbAccounts.id, args.resourceId),
            eq(schema.fbAccounts.companyId, principal.companyId),
          ),
        )
        .limit(1);
      if (!fb[0]) throw new HttpError(404, 404, 'fb_account 不存在');
    } else {
      const ad = await tx
        .select({ id: schema.adAccounts.id })
        .from(schema.adAccounts)
        .where(
          and(
            eq(schema.adAccounts.id, args.resourceId),
            eq(schema.adAccounts.companyId, principal.companyId),
          ),
        )
        .limit(1);
      if (!ad[0]) throw new HttpError(404, 404, 'ad_account 不存在');
    }

    // 幂等 upsert
    const existed = await tx
      .select()
      .from(schema.userResourceGrants)
      .where(
        and(
          eq(schema.userResourceGrants.userId, userId),
          eq(schema.userResourceGrants.resourceType, args.resourceType),
          eq(schema.userResourceGrants.resourceId, args.resourceId),
        ),
      )
      .limit(1);
    if (existed[0]) return { id: existed[0].id };

    const ins = await tx
      .insert(schema.userResourceGrants)
      .values({
        userId,
        resourceType: args.resourceType,
        resourceId: args.resourceId,
        grantedBy: principal.userId,
      })
      .returning({ id: schema.userResourceGrants.id });
    return { id: ins[0]!.id };
  });
  await bumpPermCache(userId);
  return result;
}

/** 撤销授权 */
export async function removeGrant(
  principal: AuthPrincipal,
  userId: string,
  grantId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );
    const u = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.id, userId),
          eq(schema.users.companyId, principal.companyId),
        ),
      )
      .limit(1);
    if (!u[0]) throw new HttpError(404, 404, '用户不存在');

    await tx
      .delete(schema.userResourceGrants)
      .where(
        and(
          eq(schema.userResourceGrants.id, grantId),
          eq(schema.userResourceGrants.userId, userId),
        ),
      );
  });
  await bumpPermCache(userId);
}

/** 给前端列 fb + ad,做 grant 选择 */
export async function listResourcesForGrant(
  principal: AuthPrincipal,
): Promise<{
  fbAccounts: Array<{ id: string; name: string; status: string }>;
  adAccounts: Array<{
    id: string;
    name: string;
    metaActId: string;
    fbAccountId: string;
    status: string;
    currency: string | null;
    timezoneName: string | null;
    businessCountryCode: string | null;
  }>;
}> {
  return db.transaction(async (tx) => {
    await tx.execute(
      dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`,
    );
    const [fb, ad] = await Promise.all([
      tx
        .select({
          id: schema.fbAccounts.id,
          name: schema.fbAccounts.name,
          status: schema.fbAccounts.status,
        })
        .from(schema.fbAccounts)
        .where(eq(schema.fbAccounts.companyId, principal.companyId)),
      tx
        .select({
          id: schema.adAccounts.id,
          name: schema.adAccounts.name,
          metaActId: schema.adAccounts.metaActId,
          fbAccountId: schema.adAccounts.fbAccountId,
          status: schema.adAccounts.status,
          currency: schema.adAccounts.currency,
          timezoneName: schema.adAccounts.timezoneName,
          businessCountryCode: schema.adAccounts.businessCountryCode,
        })
        .from(schema.adAccounts)
        .where(eq(schema.adAccounts.companyId, principal.companyId)),
    ]);
    return { fbAccounts: fb, adAccounts: ad };
  });
}

// 兼容 inArray 未使用导致 lint;留接口供未来扩展
void inArray;
