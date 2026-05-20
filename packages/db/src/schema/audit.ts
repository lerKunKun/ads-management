import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { users } from './iam';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id),
    action: text('action').notNull(),
    resource: text('resource').notNull(),
    detail: jsonb('detail'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('audit_company_idx').on(t.companyId),
    actionIdx: index('audit_action_idx').on(t.action),
    createdIdx: index('audit_created_idx').on(t.createdAt),
  }),
);
