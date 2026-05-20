import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';

export const userStatus = pgEnum('user_status', ['active', 'disabled']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    pwdHash: text('pwd_hash').notNull(),
    status: userStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
    companyIdx: index('users_company_idx').on(t.companyId),
  }),
);

/** roles.company_id = NULL 表示平台级（PlatformAdmin） */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codePerCompanyIdx: uniqueIndex('roles_code_company_idx').on(t.code, t.companyId),
  }),
);

export const permissions = pgTable(
  'permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    resource: text('resource').notNull(),
    action: text('action').notNull(),
  },
  (t) => ({
    codeIdx: uniqueIndex('permissions_code_idx').on(t.code),
  }),
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id').notNull().references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.permissionId] }),
  }),
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.roleId] }),
  }),
);

export const grantResourceType = pgEnum('grant_resource_type', ['fb_account', 'ad_account']);

export const userResourceGrants = pgTable(
  'user_resource_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    resourceType: grantResourceType('resource_type').notNull(),
    resourceId: uuid('resource_id').notNull(),
    grantedBy: uuid('granted_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userResourceIdx: uniqueIndex('grants_user_resource_idx').on(t.userId, t.resourceType, t.resourceId),
  }),
);
