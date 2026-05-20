import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { users } from './iam';

export const operationStatus = pgEnum('operation_status', [
  'pending',
  'running',
  'partial',
  'success',
  'failed',
  'cancelled',
]);

export const operationItemStatus = pgEnum('operation_item_status', [
  'pending',
  'running',
  'success',
  'failed',
  'retrying',
  'dead',
]);

export const operationTasks = pgTable(
  'operation_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id),
    /** 业务 action 码，例如 campaign:status / campaign:budget / campaign:copy / campaign:delete */
    type: text('type').notNull(),
    status: operationStatus('status').notNull().default('pending'),
    total: integer('total').notNull().default(0),
    success: integer('success').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index('op_tasks_company_idx').on(t.companyId),
    userIdx: index('op_tasks_user_idx').on(t.userId),
  }),
);

export const operationTaskItems = pgTable(
  'operation_task_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => operationTasks.id, { onDelete: 'cascade' }),
    adAccountId: uuid('ad_account_id').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    action: text('action').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: operationItemStatus('status').notNull().default('pending'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqIdempotency: uniqueIndex('op_items_idempotency_idx').on(t.idempotencyKey),
    taskIdx: index('op_items_task_idx').on(t.taskId),
    adAcctIdx: index('op_items_ad_account_idx').on(t.adAccountId),
  }),
);
