import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { companies } from './companies';

export const fbAccountStatus = pgEnum('fb_account_status', [
  'active',
  'token_invalid',
  'disabled',
]);

export const fbAccounts = pgTable(
  'fb_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    fbUserId: text('fb_user_id').notNull(),
    name: text('name').notNull(),
    /** AES-256-GCM 加密后的 base64(iv|ciphertext|tag) */
    accessTokenEnc: text('access_token_enc').notNull(),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    status: fbAccountStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqFbUserPerCompany: uniqueIndex('fb_accounts_company_fb_user_idx').on(t.companyId, t.fbUserId),
    companyIdx: index('fb_accounts_company_idx').on(t.companyId),
  }),
);

export const adAccountStatus = pgEnum('ad_account_status', [
  'active',
  'disabled',
  'closed',
  'pending',
]);

export const adAccounts = pgTable(
  'ad_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fbAccountId: uuid('fb_account_id').notNull().references(() => fbAccounts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    metaActId: text('meta_act_id').notNull(),
    name: text('name').notNull(),
    currency: text('currency'),
    timezoneName: text('timezone_name'),
    businessCountryCode: text('business_country_code'),
    status: adAccountStatus('status').notNull().default('active'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqActPerCompany: uniqueIndex('ad_accounts_company_act_idx').on(t.companyId, t.metaActId),
    fbAccountIdx: index('ad_accounts_fb_account_idx').on(t.fbAccountId),
    companyIdx: index('ad_accounts_company_idx').on(t.companyId),
  }),
);
