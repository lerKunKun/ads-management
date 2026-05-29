import { and, eq, isNull, or, sql as dsql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { ROLE_PERMISSIONS, ROLES } from '@ads/shared';
import { db, schema } from '../../lib/db';
import { redis } from '../../lib/redis';
import { HttpError } from '../../lib/http-error';
import type { AuthPrincipal } from '../iam/auth-service';

export interface CompanyListItem {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  createdAt: string;
  userCount: number;
  accountGroupCount: number;
  adAccountCount: number;
}

export interface CompanyUserItem {
  id: string;
  email: string;
  status: 'active' | 'disabled';
  createdAt: string;
  roles: string[];
  grantsCount: number;
}

const COMPANY_ROLES: Array<{ code: string; name: string }> = [
  { code: ROLES.COMPANY_ADMIN, name: '公司管理员' },
  { code: ROLES.OPERATOR, name: '操作员' },
  { code: ROLES.VIEWER, name: '只读' },
];
const ASSIGNABLE_ROLES = new Set<string>([ROLES.COMPANY_ADMIN, ROLES.OPERATOR, ROLES.VIEWER]);

function isPlatformAdmin(principal: AuthPrincipal): boolean {
  return principal.roles.includes(ROLES.PLATFORM_ADMIN);
}

function assertCompanyAccess(principal: AuthPrincipal, companyId: string) {
  if (isPlatformAdmin(principal)) return;
  if (principal.companyId !== companyId) {
    throw new HttpError(403, 403, 'company not in scope');
  }
}

function assertPlatformAdmin(principal: AuthPrincipal) {
  if (!isPlatformAdmin(principal)) {
    throw new HttpError(403, 403, '仅超管可以修改或删除其他用户');
  }
}

function normalizeAccount(email: string): string {
  return email.trim();
}

async function invalidateUser(userId: string): Promise<void> {
  const stream = redis.scanStream({ match: `perm:${userId}:*`, count: 50 });
  const keys: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: string[]) => keys.push(...chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  if (keys.length > 0) await redis.del(...keys);
}

export async function listCompanies(principal: AuthPrincipal): Promise<CompanyListItem[]> {
  return db.transaction(async (tx) => {
    if (isPlatformAdmin(principal)) {
      await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    } else {
      await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    }
    const rows = (await tx.execute(dsql`
      SELECT
        c.id::text AS id,
        c.name AS name,
        c.status::text AS status,
        c.created_at AS created_at,
        COUNT(DISTINCT u.id)::int AS user_count,
        COUNT(DISTINCT fb.id)::int AS account_group_count,
        COUNT(DISTINCT aa.id)::int AS ad_account_count
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id
      LEFT JOIN fb_accounts fb ON fb.company_id = c.id
      LEFT JOIN ad_accounts aa ON aa.company_id = c.id
      ${isPlatformAdmin(principal) ? dsql`` : dsql`WHERE c.id = ${principal.companyId}`}
      GROUP BY c.id
      ORDER BY c.created_at ASC
    `)) as unknown as Array<{
      id: string;
      name: string;
      status: string;
      created_at: Date | string;
      user_count: number;
      account_group_count: number;
      ad_account_count: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status as 'active' | 'disabled',
      createdAt: new Date(row.created_at).toISOString(),
      userCount: row.user_count ?? 0,
      accountGroupCount: row.account_group_count ?? 0,
      adAccountCount: row.ad_account_count ?? 0,
    }));
  });
}

export async function createCompany(
  principal: AuthPrincipal,
  name: string,
): Promise<{ id: string }> {
  if (!isPlatformAdmin(principal)) throw new HttpError(403, 403, 'only PlatformAdmin can create company');
  const trimmed = name.trim();
  if (!trimmed) throw new HttpError(422, 422, '公司名称不能为空');

  return db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    const dup = await tx
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(eq(schema.companies.name, trimmed))
      .limit(1);
    if (dup[0]) throw new HttpError(409, 409, '公司名称已存在');
    const company = (await tx.insert(schema.companies).values({ name: trimmed }).returning({ id: schema.companies.id }))[0]!;
    await ensureCompanyRoles(tx as unknown as typeof db, company.id);
    return company;
  });
}

export async function updateCompany(
  principal: AuthPrincipal,
  companyId: string,
  patch: { name?: string; status?: 'active' | 'disabled' },
): Promise<void> {
  assertCompanyAccess(principal, companyId);
  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) throw new HttpError(422, 422, '公司名称不能为空');

  await db.transaction(async (tx) => {
    if (isPlatformAdmin(principal)) {
      await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    } else {
      await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    }
    const found = await tx
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1);
    if (!found[0]) throw new HttpError(404, 404, '公司不存在');
    await tx
      .update(schema.companies)
      .set({
        ...(name ? { name } : {}),
        ...(patch.status ? { status: patch.status } : {}),
      })
      .where(eq(schema.companies.id, companyId));
  });
}

export async function listCompanyUsers(
  principal: AuthPrincipal,
  companyId: string,
): Promise<CompanyUserItem[]> {
  assertCompanyAccess(principal, companyId);
  return db.transaction(async (tx) => {
    if (isPlatformAdmin(principal)) {
      await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    } else {
      await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    }
    const rows = (await tx.execute(dsql`
      SELECT
        u.id::text AS id,
        u.email AS email,
        u.status::text AS status,
        u.created_at AS created_at,
        COALESCE(
          ARRAY_AGG(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL),
          '{}'::text[]
        ) AS roles,
        (SELECT COUNT(*)::int FROM user_resource_grants g WHERE g.user_id = u.id) AS grants_count
      FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.company_id = ${companyId}
      GROUP BY u.id
      ORDER BY u.created_at ASC
    `)) as unknown as Array<{
      id: string;
      email: string;
      status: string;
      created_at: Date | string;
      roles: string[];
      grants_count: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      status: row.status as 'active' | 'disabled',
      createdAt: new Date(row.created_at).toISOString(),
      roles: row.roles ?? [],
      grantsCount: row.grants_count ?? 0,
    }));
  });
}

export async function createCompanyUser(
  principal: AuthPrincipal,
  companyId: string,
  args: { email: string; password: string; roleCode: string },
): Promise<{ id: string }> {
  assertCompanyAccess(principal, companyId);
  if (!ASSIGNABLE_ROLES.has(args.roleCode)) {
    throw new HttpError(403, 403, `不允许分配角色 ${args.roleCode}`);
  }
  if (args.password.length < 6) throw new HttpError(422, 422, '密码至少 6 位');

  return db.transaction(async (tx) => {
    if (isPlatformAdmin(principal)) {
      await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    } else {
      await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    }
    const company = await tx
      .select({ id: schema.companies.id })
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1);
    if (!company[0]) throw new HttpError(404, 404, '公司不存在');

    const email = normalizeAccount(args.email);
    if (!email) throw new HttpError(422, 422, '账号不能为空');
    const dup = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (dup[0]) throw new HttpError(409, 409, '账号已存在');

    await ensureCompanyRoles(tx as unknown as typeof db, companyId);
    const role = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.companyId, companyId), eq(schema.roles.code, args.roleCode)))
      .limit(1);
    if (!role[0]) throw new HttpError(404, 404, `角色 ${args.roleCode} 不存在`);

    const user = (await tx
      .insert(schema.users)
      .values({
        companyId,
        email,
        pwdHash: await bcrypt.hash(args.password, 10),
        status: 'active',
      })
      .returning({ id: schema.users.id }))[0]!;
    await tx.insert(schema.userRoles).values({ userId: user.id, roleId: role[0].id });
    await invalidateUser(user.id);
    return user;
  });
}

export async function updateCompanyUser(
  principal: AuthPrincipal,
  companyId: string,
  userId: string,
  patch: { email?: string; roleCode?: string; status?: 'active' | 'disabled' },
): Promise<void> {
  assertPlatformAdmin(principal);
  assertCompanyAccess(principal, companyId);
  if (userId === principal.userId && patch.status === 'disabled') {
    throw new HttpError(422, 422, '不能禁用自己');
  }
  if (patch.roleCode !== undefined && !ASSIGNABLE_ROLES.has(patch.roleCode)) {
    throw new HttpError(403, 403, `不允许分配角色 ${patch.roleCode}`);
  }

  await db.transaction(async (tx) => {
    if (isPlatformAdmin(principal)) {
      await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    } else {
      await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    }

    const user = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), eq(schema.users.companyId, companyId)))
      .limit(1);
    if (!user[0]) throw new HttpError(404, 404, '用户不存在');

    if (patch.email !== undefined) {
      const email = normalizeAccount(patch.email);
      if (!email) throw new HttpError(422, 422, '账号不能为空');
      const dup = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      if (dup[0] && dup[0].id !== userId) {
        throw new HttpError(409, 409, '账号已存在');
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
      await ensureCompanyRoles(tx as unknown as typeof db, companyId);
      const role = await tx
        .select({ id: schema.roles.id })
        .from(schema.roles)
        .where(and(eq(schema.roles.companyId, companyId), eq(schema.roles.code, patch.roleCode)))
        .limit(1);
      if (!role[0]) throw new HttpError(404, 404, `角色 ${patch.roleCode} 不存在`);

      await tx.execute(dsql`
        DELETE FROM user_roles ur
        USING roles r
        WHERE ur.role_id = r.id
          AND ur.user_id = ${userId}
          AND r.company_id = ${companyId}
      `);
      await tx.insert(schema.userRoles).values({ userId, roleId: role[0].id });
    }
  });

  await invalidateUser(userId);
}

export async function deleteCompanyUser(
  principal: AuthPrincipal,
  companyId: string,
  userId: string,
): Promise<void> {
  assertPlatformAdmin(principal);
  assertCompanyAccess(principal, companyId);
  if (userId === principal.userId) {
    throw new HttpError(422, 422, '不能删除自己');
  }

  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);

    const user = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), eq(schema.users.companyId, companyId)))
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

  await invalidateUser(userId);
}

async function ensureCompanyRoles(tx: typeof db, companyId: string): Promise<void> {
  for (const role of COMPANY_ROLES) {
    await tx
      .insert(schema.roles)
      .values({ companyId, code: role.code, name: role.name })
      .onConflictDoNothing();
  }
  const roles = await tx
    .select({ id: schema.roles.id, code: schema.roles.code })
    .from(schema.roles)
    .where(or(eq(schema.roles.companyId, companyId), isNull(schema.roles.companyId))!);
  const permissions = await tx.select({ id: schema.permissions.id, code: schema.permissions.code }).from(schema.permissions);
  const permByCode = new Map(permissions.map((permission) => [permission.code, permission.id]));
  for (const role of roles) {
    const codes = ROLE_PERMISSIONS[role.code as keyof typeof ROLE_PERMISSIONS];
    if (!codes) continue;
    for (const code of codes) {
      const permissionId = permByCode.get(code);
      if (!permissionId) continue;
      await tx
        .insert(schema.rolePermissions)
        .values({ roleId: role.id, permissionId })
        .onConflictDoNothing();
    }
  }
}
