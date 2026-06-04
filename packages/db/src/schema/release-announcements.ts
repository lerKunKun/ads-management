import { boolean, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './iam';

export const releaseAnnouncements = pgTable(
  'release_announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    version: text('version').notNull(),
    content: text('content').notNull(),
    nextUpdateAt: timestamp('next_update_at', { withTimezone: true }),
    status: text('status').notNull().default('draft'),
    isPinned: boolean('is_pinned').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusPublishedIdx: index('release_announcements_status_published_idx').on(
      t.status,
      t.publishedAt,
    ),
    createdIdx: index('release_announcements_created_idx').on(t.createdAt),
    pinnedPublishedIdx: index('release_announcements_pinned_published_idx').on(
      t.isPinned,
      t.status,
      t.publishedAt,
    ),
  }),
);

export const releaseAnnouncementReads = pgTable(
  'release_announcement_reads',
  {
    announcementId: uuid('announcement_id')
      .notNull()
      .references(() => releaseAnnouncements.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.announcementId, t.userId] }),
    userReadIdx: index('release_announcement_reads_user_idx').on(t.userId, t.readAt),
  }),
);
