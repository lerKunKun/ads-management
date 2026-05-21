import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';
import { adAccounts } from './fb';

export const adObjectStatus = pgEnum('ad_object_status', [
  'ACTIVE',
  'PAUSED',
  'ARCHIVED',
  'DELETED',
]);

export const syncStatus = pgEnum('ad_object_sync_status', [
  'idle',
  'success',
  'failed',
]);

export const adCampaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    adAccountId: uuid('ad_account_id').notNull().references(() => adAccounts.id, { onDelete: 'cascade' }),
    metaId: text('meta_id').notNull(),
    name: text('name').notNull(),
    status: adObjectStatus('status').notNull().default('PAUSED'),
    effectiveStatus: text('effective_status'),
    objective: text('objective'),
    dailyBudget: integer('daily_budget'),
    lifetimeBudget: integer('lifetime_budget'),
    startTime: timestamp('start_time', { withTimezone: true }),
    stopTime: timestamp('stop_time', { withTimezone: true }),
    metaCreatedTime: timestamp('meta_created_time', { withTimezone: true }),
    metaUpdatedTime: timestamp('meta_updated_time', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
    syncHash: text('sync_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqCompanyMeta: uniqueIndex('campaigns_company_meta_idx').on(t.companyId, t.metaId),
    companyAccountIdx: index('campaigns_company_account_idx').on(t.companyId, t.adAccountId),
    accountStatusIdx: index('campaigns_account_status_idx').on(t.adAccountId, t.status),
  }),
);

export const adSetObjects = pgTable(
  'adsets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    adAccountId: uuid('ad_account_id').notNull().references(() => adAccounts.id, { onDelete: 'cascade' }),
    campaignMetaId: text('campaign_meta_id').notNull(),
    metaId: text('meta_id').notNull(),
    name: text('name').notNull(),
    status: adObjectStatus('status').notNull().default('PAUSED'),
    effectiveStatus: text('effective_status'),
    dailyBudget: integer('daily_budget'),
    lifetimeBudget: integer('lifetime_budget'),
    optimizationGoal: text('optimization_goal'),
    billingEvent: text('billing_event'),
    bidAmount: integer('bid_amount'),
    startTime: timestamp('start_time', { withTimezone: true }),
    endTime: timestamp('end_time', { withTimezone: true }),
    metaUpdatedTime: timestamp('meta_updated_time', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
    syncHash: text('sync_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqCompanyMeta: uniqueIndex('adsets_company_meta_idx').on(t.companyId, t.metaId),
    accountCampaignIdx: index('adsets_account_campaign_idx').on(t.adAccountId, t.campaignMetaId),
    accountStatusIdx: index('adsets_account_status_idx').on(t.adAccountId, t.status),
  }),
);

export const adObjects = pgTable(
  'ads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    adAccountId: uuid('ad_account_id').notNull().references(() => adAccounts.id, { onDelete: 'cascade' }),
    campaignMetaId: text('campaign_meta_id'),
    adsetMetaId: text('adset_meta_id').notNull(),
    metaId: text('meta_id').notNull(),
    name: text('name').notNull(),
    status: adObjectStatus('status').notNull().default('PAUSED'),
    effectiveStatus: text('effective_status'),
    creativeId: text('creative_id'),
    metaUpdatedTime: timestamp('meta_updated_time', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
    syncHash: text('sync_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqCompanyMeta: uniqueIndex('ads_company_meta_idx').on(t.companyId, t.metaId),
    accountAdsetIdx: index('ads_account_adset_idx').on(t.adAccountId, t.adsetMetaId),
    accountStatusIdx: index('ads_account_status_idx').on(t.adAccountId, t.status),
  }),
);

export const adAccountSyncState = pgTable(
  'ad_account_sync_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    adAccountId: uuid('ad_account_id').notNull().references(() => adAccounts.id, { onDelete: 'cascade' }),
    objectType: text('object_type').notNull(),
    parentMetaId: text('parent_meta_id').notNull().default(''),
    status: syncStatus('status').notNull().default('idle'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqScope: uniqueIndex('ad_sync_state_scope_idx').on(t.adAccountId, t.objectType, t.parentMetaId),
    companyIdx: index('ad_sync_state_company_idx').on(t.companyId),
  }),
);
