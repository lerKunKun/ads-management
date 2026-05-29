import { and, desc, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../lib/db';
import { Forbidden, HttpError, NotFound } from '../../lib/http-error';
import type { AuthPrincipal } from '../iam/auth-service';

export type ReleaseAnnouncementStatus = 'draft' | 'published' | 'archived';

export interface ReleaseAnnouncementDTO {
  id: string;
  title: string;
  version: string;
  content: string;
  nextUpdateAt: Date | null;
  status: ReleaseAnnouncementStatus;
  publishedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AnnouncementInput {
  title: string;
  version: string;
  content: string;
  nextUpdateAt?: string;
}

interface AnnouncementPatch {
  title?: string;
  version?: string;
  content?: string;
  nextUpdateAt?: string;
}

type AnnouncementRow = typeof schema.releaseAnnouncements.$inferSelect;

function assertPlatformAdmin(principal: AuthPrincipal): void {
  if (!principal.roles.includes('PlatformAdmin')) {
    throw Forbidden('only platform admin can manage release announcements');
  }
}

function normalizeText(value: string, label: string, maxLength: number): string {
  const text = value.trim();
  if (!text) throw new HttpError(422, 422, `${label} is required`);
  if (text.length > maxLength) throw new HttpError(422, 422, `${label} is too long`);
  return text;
}

function parseDateInput(value: string | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(422, 422, 'nextUpdateAt is invalid');
  }
  return date;
}

function toDTO(row: AnnouncementRow): ReleaseAnnouncementDTO {
  const status =
    row.status === 'published' || row.status === 'archived' ? row.status : 'draft';
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    content: row.content,
    nextUpdateAt: row.nextUpdateAt,
    status,
    publishedAt: row.publishedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function withBypass<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    return fn(tx as unknown as typeof db);
  });
}

export async function getUnreadReleaseAnnouncement(
  principal: AuthPrincipal,
): Promise<ReleaseAnnouncementDTO | null> {
  return withBypass(async (tx) => {
    const announcement = (
      await tx
        .select()
        .from(schema.releaseAnnouncements)
        .where(eq(schema.releaseAnnouncements.status, 'published'))
        .orderBy(
          desc(schema.releaseAnnouncements.publishedAt),
          desc(schema.releaseAnnouncements.createdAt),
        )
        .limit(1)
    )[0];
    if (!announcement) return null;

    const read = (
      await tx
        .select({ announcementId: schema.releaseAnnouncementReads.announcementId })
        .from(schema.releaseAnnouncementReads)
        .where(
          and(
            eq(schema.releaseAnnouncementReads.announcementId, announcement.id),
            eq(schema.releaseAnnouncementReads.userId, principal.userId),
          ),
        )
        .limit(1)
    )[0];
    return read ? null : toDTO(announcement);
  });
}

export async function markReleaseAnnouncementRead(
  principal: AuthPrincipal,
  announcementId: string,
): Promise<void> {
  await withBypass(async (tx) => {
    const announcement = (
      await tx
        .select({ id: schema.releaseAnnouncements.id })
        .from(schema.releaseAnnouncements)
        .where(
          and(
            eq(schema.releaseAnnouncements.id, announcementId),
            eq(schema.releaseAnnouncements.status, 'published'),
          ),
        )
        .limit(1)
    )[0];
    if (!announcement) throw NotFound('release announcement not found');

    await tx
      .insert(schema.releaseAnnouncementReads)
      .values({ announcementId, userId: principal.userId })
      .onConflictDoNothing();
  });
}

export async function listReleaseAnnouncements(
  principal: AuthPrincipal,
): Promise<ReleaseAnnouncementDTO[]> {
  assertPlatformAdmin(principal);
  return withBypass(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.releaseAnnouncements)
      .orderBy(desc(schema.releaseAnnouncements.createdAt))
      .limit(100);
    return rows.map(toDTO);
  });
}

export async function createReleaseAnnouncement(
  principal: AuthPrincipal,
  input: AnnouncementInput,
): Promise<ReleaseAnnouncementDTO> {
  assertPlatformAdmin(principal);
  const nextUpdateAt = parseDateInput(input.nextUpdateAt);
  return withBypass(async (tx) => {
    const row = (
      await tx
        .insert(schema.releaseAnnouncements)
        .values({
          title: normalizeText(input.title, 'title', 120),
          version: normalizeText(input.version, 'version', 80),
          content: normalizeText(input.content, 'content', 4000),
          nextUpdateAt: nextUpdateAt ?? null,
          status: 'draft',
          createdBy: principal.userId,
        })
        .returning()
    )[0];
    if (!row) throw new HttpError(500, 500, 'failed to create release announcement');
    return toDTO(row);
  });
}

export async function updateReleaseAnnouncement(
  principal: AuthPrincipal,
  id: string,
  input: AnnouncementPatch,
): Promise<ReleaseAnnouncementDTO> {
  assertPlatformAdmin(principal);
  const patch: Partial<typeof schema.releaseAnnouncements.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.title !== undefined) patch.title = normalizeText(input.title, 'title', 120);
  if (input.version !== undefined) patch.version = normalizeText(input.version, 'version', 80);
  if (input.content !== undefined) patch.content = normalizeText(input.content, 'content', 4000);
  if (input.nextUpdateAt !== undefined) {
    patch.nextUpdateAt = parseDateInput(input.nextUpdateAt) ?? null;
  }

  return withBypass(async (tx) => {
    const row = (
      await tx
        .update(schema.releaseAnnouncements)
        .set(patch)
        .where(eq(schema.releaseAnnouncements.id, id))
        .returning()
    )[0];
    if (!row) throw NotFound('release announcement not found');
    return toDTO(row);
  });
}

export async function publishReleaseAnnouncement(
  principal: AuthPrincipal,
  id: string,
): Promise<ReleaseAnnouncementDTO> {
  assertPlatformAdmin(principal);
  const now = new Date();
  return withBypass(async (tx) => {
    await tx
      .delete(schema.releaseAnnouncementReads)
      .where(eq(schema.releaseAnnouncementReads.announcementId, id));
    const row = (
      await tx
        .update(schema.releaseAnnouncements)
        .set({ status: 'published', publishedAt: now, updatedAt: now })
        .where(eq(schema.releaseAnnouncements.id, id))
        .returning()
    )[0];
    if (!row) throw NotFound('release announcement not found');
    return toDTO(row);
  });
}

export async function archiveReleaseAnnouncement(
  principal: AuthPrincipal,
  id: string,
): Promise<ReleaseAnnouncementDTO> {
  assertPlatformAdmin(principal);
  return withBypass(async (tx) => {
    const row = (
      await tx
        .update(schema.releaseAnnouncements)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(schema.releaseAnnouncements.id, id))
        .returning()
    )[0];
    if (!row) throw NotFound('release announcement not found');
    return toDTO(row);
  });
}

export async function deleteReleaseAnnouncement(
  principal: AuthPrincipal,
  id: string,
): Promise<void> {
  assertPlatformAdmin(principal);
  await withBypass(async (tx) => {
    const row = (
      await tx
        .delete(schema.releaseAnnouncements)
        .where(eq(schema.releaseAnnouncements.id, id))
        .returning({ id: schema.releaseAnnouncements.id })
    )[0];
    if (!row) throw NotFound('release announcement not found');
  });
}
