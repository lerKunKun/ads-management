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
  'paused',
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

export const copyWorkflowStatus = pgEnum('copy_workflow_status', [
  'pending',
  'running',
  'waiting',
  'success',
  'partial',
  'failed',
  'canceled',
  'paused',
]);

export const copyWorkflowPhase = pgEnum('copy_workflow_phase', [
  'preflight',
  'create_campaign',
  'create_adsets',
  'create_ads',
  'verify',
  'repair',
  'restore_status',
  'done',
]);

export const copyStepStatus = pgEnum('copy_step_status', [
  'pending',
  'running',
  'success',
  'unknown',
  'failed',
  'skipped',
  'retrying',
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

export const operationCopyWorkflows = pgTable(
  'operation_copy_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull().references(() => operationTasks.id, { onDelete: 'cascade' }),
    taskItemId: uuid('task_item_id').notNull().references(() => operationTaskItems.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    fbAccountId: uuid('fb_account_id').notNull(),
    adAccountId: uuid('ad_account_id').notNull(),
    metaActId: text('meta_act_id').notNull(),
    sourceCampaignId: text('source_campaign_id').notNull(),
    newCampaignId: text('new_campaign_id'),
    status: copyWorkflowStatus('status').notNull().default('pending'),
    phase: copyWorkflowPhase('phase').notNull().default('preflight'),
    state: jsonb('state').notNull().default({}),
    version: integer('version').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqTaskItem: uniqueIndex('op_copy_workflows_task_item_idx').on(t.taskItemId),
    taskIdx: index('op_copy_workflows_task_idx').on(t.taskId),
    companyIdx: index('op_copy_workflows_company_idx').on(t.companyId),
    statusIdx: index('op_copy_workflows_status_idx').on(t.status),
  }),
);

export const operationCopySteps = pgTable(
  'operation_copy_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id').notNull().references(() => operationCopyWorkflows.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').notNull().references(() => operationTasks.id, { onDelete: 'cascade' }),
    taskItemId: uuid('task_item_id').notNull().references(() => operationTaskItems.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    stepKey: text('step_key').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    parentStepKey: text('parent_step_key'),
    newId: text('new_id'),
    status: copyStepStatus('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    error: text('error'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqStep: uniqueIndex('op_copy_steps_workflow_step_idx').on(t.workflowId, t.stepKey),
    workflowIdx: index('op_copy_steps_workflow_idx').on(t.workflowId),
    taskIdx: index('op_copy_steps_task_idx').on(t.taskId),
    companyIdx: index('op_copy_steps_company_idx').on(t.companyId),
    statusIdx: index('op_copy_steps_status_idx').on(t.status),
  }),
);
