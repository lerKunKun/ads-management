/**
 * 登录、用户权限/作用域查询。读取走 ads_app（受 RLS），但登录是无租户上下文 —— 用 `withBypass` 临时绕过 RLS。
 * 同样的 bypass 由独立的 admin 连接处理（不污染 ads_app 默认连接）。
 */
import bcrypt from 'bcryptjs';
import { eq, inArray, sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { db, schema } from '../../lib/db';
import { env } from '../../env';

/** 登录前没有租户上下文 — 用 admin 连接(superuser, bypass RLS)做用户查找。 */
const adminUrl =
  process.env['DATABASE_ADMIN_URL'] ?? 'postgres://ads:ads@localhost:5432/ads';
const adminSql = postgres(adminUrl, { max: 4, prepare: false });
const adminDb = drizzle(adminSql, { schema });

export interface AuthPrincipal {
  userId: string;
  companyId: string;
  companyName: string;
  email: string;
  roles: string[];
  permissions: string[];
  /** 作用域: fb_account 与 ad_account 的 ID 集合；CompanyAdmin/PlatformAdmin 跳过作用域校验 */
  scope: { fbAccounts: string[]; adAccounts: string[]; bypass: boolean };
}

export async function authenticate(
  email: string,
  password: string,
): Promise<AuthPrincipal | null> {
  const account = email.trim();
  if (!account) return null;
  const rows = await adminDb
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, account))
    .limit(1);
  const user = rows[0];
  if (!user) return null;
  if (user.status !== 'active') return null;
  const ok = await bcrypt.compare(password, user.pwdHash);
  if (!ok) return null;
  return loadPrincipal(user.id);
}

export async function loadPrincipal(
  userId: string,
  targetCompanyId?: string,
): Promise<AuthPrincipal | null> {
  const userRow = (
    await adminDb
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)
  )[0];
  if (!userRow) return null;

  // 角色
  const roleRows = await adminDb
    .select({ id: schema.roles.id, code: schema.roles.code, companyId: schema.roles.companyId })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(eq(schema.userRoles.userId, userId));

  const allRoleCodes = roleRows.map((r) => r.code);
  const isPlatformAdmin = allRoleCodes.includes('PlatformAdmin');
  const companyId = targetCompanyId ?? userRow.companyId;
  if (companyId !== userRow.companyId && !isPlatformAdmin) return null;

  const company = (
    await adminDb
      .select({ id: schema.companies.id, name: schema.companies.name, status: schema.companies.status })
      .from(schema.companies)
      .where(eq(schema.companies.id, companyId))
      .limit(1)
  )[0];
  if (!company || company.status !== 'active') return null;

  const scopedRoleRows = roleRows.filter(
    (role) => role.companyId === null || role.companyId === companyId,
  );

  // 权限码
  const roleIds = scopedRoleRows.map((r) => r.id);
  let permCodes: string[] = [];
  if (roleIds.length) {
    const perms = await adminDb
      .select({ code: schema.permissions.code })
      .from(schema.rolePermissions)
      .innerJoin(
        schema.permissions,
        eq(schema.permissions.id, schema.rolePermissions.permissionId),
      )
      .where(inArray(schema.rolePermissions.roleId, roleIds));
    permCodes = Array.from(new Set(perms.map((p) => p.code)));
  }

  const roleCodes = scopedRoleRows.map((r) => r.code);
  const bypass =
    roleCodes.includes('PlatformAdmin') || roleCodes.includes('CompanyAdmin');

  // 作用域
  const grants = await adminDb
    .select()
    .from(schema.userResourceGrants)
    .where(eq(schema.userResourceGrants.userId, userId));
  const fbAccounts = grants
    .filter((g) => g.resourceType === 'fb_account')
    .map((g) => g.resourceId);
  const adAccounts = grants
    .filter((g) => g.resourceType === 'ad_account')
    .map((g) => g.resourceId);

  return {
    userId: userRow.id,
    companyId,
    companyName: company.name,
    email: userRow.email,
    roles: roleCodes,
    permissions: permCodes,
    scope: { fbAccounts, adAccounts, bypass },
  };
}

export async function writeAudit(args: {
  companyId: string;
  userId: string | null;
  action: string;
  resource: string;
  detail?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  await adminDb.insert(schema.auditLogs).values({
    companyId: args.companyId,
    userId: args.userId,
    action: args.action,
    resource: args.resource,
    detail: args.detail ?? null,
    ip: args.ip ?? null,
  });
}

/**
 * 用 ads_app 连接执行带 RLS 上下文的查询/写入。
 * SET LOCAL 在事务内生效；事务结束自动重置。
 */
export async function withTenant<T>(
  companyId: string,
  fn: (txDb: typeof db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
    return fn(tx as unknown as typeof db);
  });
}

export { env };
