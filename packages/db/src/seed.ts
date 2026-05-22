/**
 * 种子: 1 个 company + 平台级 PlatformAdmin + 公司级 CompanyAdmin/Operator/Viewer
 *       + 所有权限 + 1 个 PlatformAdmin/CompanyAdmin 用户。
 *   bun run db:seed
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, and, isNull } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import {
  companies,
  users,
  roles,
  permissions,
  rolePermissions,
  userRoles,
} from './schema';
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from '@ads/shared';

const url =
  process.env['DATABASE_ADMIN_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgres://ads:ads@localhost:5432/ads';

async function main() {
  const sql = postgres(url, { max: 1, prepare: false });
  const db = drizzle(sql);

  // 种子全程走 bypass，绕过 RLS
  await sql`SET app.bypass_rls = '1'`;

  console.log('[seed] permissions…');
  for (const code of Object.values(PERMISSIONS)) {
    const [resource, action] = code.split(':') as [string, string];
    await db
      .insert(permissions)
      .values({ code, resource, action })
      .onConflictDoNothing({ target: permissions.code });
  }

  // company
  console.log('[seed] company "Demo Co."…');
  const existed = await db
    .select()
    .from(companies)
    .where(eq(companies.name, 'Demo Co.'))
    .limit(1);
  const company =
    existed[0] ?? (await db.insert(companies).values({ name: 'Demo Co.' }).returning())[0]!;

  // 平台级 PlatformAdmin
  console.log('[seed] roles…');
  const platformAdmin =
    (
      await db
        .select()
        .from(roles)
        .where(and(eq(roles.code, ROLES.PLATFORM_ADMIN), isNull(roles.companyId)))
        .limit(1)
    )[0] ??
    (
      await db
        .insert(roles)
        .values({ code: ROLES.PLATFORM_ADMIN, name: '平台管理员', companyId: null })
        .returning()
    )[0]!;

  // 公司级三个角色
  async function ensureCompanyRole(code: string, name: string) {
    const found = (
      await db
        .select()
        .from(roles)
        .where(and(eq(roles.code, code), eq(roles.companyId, company.id)))
        .limit(1)
    )[0];
    if (found) return found;
    const inserted = await db
      .insert(roles)
      .values({ code, name, companyId: company.id })
      .returning();
    return inserted[0]!;
  }
  const companyAdmin = await ensureCompanyRole(ROLES.COMPANY_ADMIN, '公司管理员');
  const operator = await ensureCompanyRole(ROLES.OPERATOR, '操作员');
  const viewer = await ensureCompanyRole(ROLES.VIEWER, '只读');

  // 关联 role_permissions
  console.log('[seed] role_permissions…');
  const allPerms = await db.select().from(permissions);
  const permByCode = new Map(allPerms.map((p) => [p.code, p]));

  async function bindRolePerms(roleId: string, codes: readonly string[]) {
    for (const code of codes) {
      const p = permByCode.get(code);
      if (!p) continue;
      await db
        .insert(rolePermissions)
        .values({ roleId, permissionId: p.id })
        .onConflictDoNothing();
    }
  }
  await bindRolePerms(platformAdmin.id, ROLE_PERMISSIONS.PlatformAdmin);
  await bindRolePerms(companyAdmin.id, ROLE_PERMISSIONS.CompanyAdmin);
  await bindRolePerms(operator.id, ROLE_PERMISSIONS.Operator);
  await bindRolePerms(viewer.id, ROLE_PERMISSIONS.Viewer);

  // 默认用户
  console.log('[seed] default user admin@demo.local / admin123 …');
  const existedUser = await db
    .select()
    .from(users)
    .where(eq(users.email, 'admin@demo.local'))
    .limit(1);
  const user =
    existedUser[0] ??
    (
      await db
        .insert(users)
        .values({
          companyId: company.id,
          email: 'admin@demo.local',
          pwdHash: await bcrypt.hash('admin123', 10),
        })
        .returning()
    )[0]!;
  await db
    .insert(userRoles)
    .values({ userId: user.id, roleId: companyAdmin.id })
    .onConflictDoNothing();
  await db
    .insert(userRoles)
    .values({ userId: user.id, roleId: platformAdmin.id })
    .onConflictDoNothing();

  console.log('[seed] done:');
  console.log(`  company.id = ${company.id}`);
  console.log(`  user.email = admin@demo.local  password = admin123`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
