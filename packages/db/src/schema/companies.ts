import { pgTable, uuid, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const companyStatus = pgEnum('company_status', ['active', 'disabled']);

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  status: companyStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
