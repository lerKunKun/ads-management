import { and, desc, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../lib/db';
import { meta, type EntityStatus, type MetaObjectOwnership } from '../../lib/meta-client';

export interface ArchivedAdDto {
  id: string;
  adAccountId: string;
  campaignMetaId: string | null;
  adsetMetaId: string | null;
  adMetaId: string;
  adName: string;
  status: EntityStatus;
  effectiveStatus: string | null;
  creativeId: string | null;
  postUrl: string | null;
  archivedAt: string;
}

export async function archiveAdForUser(args: {
  companyId: string;
  userId: string;
  adAccountId: string;
  adId: string;
  token?: string;
  owner?: MetaObjectOwnership;
}): Promise<void> {
  const snapshot = await readAdArchiveSnapshot(args);
  const postUrl = await resolvePostUrlBestEffort(args.token, snapshot.creativeId);
  const now = new Date();

  await db.transaction(async (tx) => {
    await setTenant(tx, args.companyId);
    await tx
      .insert(schema.archivedAds)
      .values({
        companyId: args.companyId,
        userId: args.userId,
        adAccountId: args.adAccountId,
        campaignMetaId: snapshot.campaignMetaId,
        adsetMetaId: snapshot.adsetMetaId,
        adMetaId: args.adId,
        adName: snapshot.adName,
        status: 'ARCHIVED',
        effectiveStatus: snapshot.effectiveStatus,
        creativeId: snapshot.creativeId,
        postUrl,
        raw: {
          source: snapshot.source,
          originalStatus: snapshot.originalStatus,
          local: snapshot.local,
          owner: args.owner ?? null,
        },
        archivedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.archivedAds.companyId,
          schema.archivedAds.userId,
          schema.archivedAds.adMetaId,
        ],
        set: {
          adAccountId: args.adAccountId,
          campaignMetaId: snapshot.campaignMetaId,
          adsetMetaId: snapshot.adsetMetaId,
          adName: snapshot.adName,
          status: 'ARCHIVED',
          effectiveStatus: snapshot.effectiveStatus,
          creativeId: snapshot.creativeId,
          postUrl,
          raw: {
            source: snapshot.source,
            originalStatus: snapshot.originalStatus,
            local: snapshot.local,
            owner: args.owner ?? null,
          },
          archivedAt: now,
        },
      });
  });
}

export async function archiveAdForTaskUser(args: {
  companyId: string;
  userId?: string;
  taskId: string;
  adAccountId: string;
  adId: string;
  token?: string;
  owner?: MetaObjectOwnership;
}): Promise<void> {
  const userId = args.userId ?? (await readTaskUserId(args.companyId, args.taskId));
  if (!userId) return;
  await archiveAdForUser({ ...args, userId });
}

export async function listArchivedAdsForUser(args: {
  companyId: string;
  userId: string;
  limit?: number;
}): Promise<ArchivedAdDto[]> {
  const requestedLimit = args.limit ?? 200;
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 500)
    : 200;
  const rows = await db.transaction(async (tx) => {
    await setTenant(tx, args.companyId);
    return tx
      .select({
        id: schema.archivedAds.id,
        adAccountId: schema.archivedAds.adAccountId,
        campaignMetaId: schema.archivedAds.campaignMetaId,
        adsetMetaId: schema.archivedAds.adsetMetaId,
        adMetaId: schema.archivedAds.adMetaId,
        adName: schema.archivedAds.adName,
        status: schema.archivedAds.status,
        effectiveStatus: schema.archivedAds.effectiveStatus,
        creativeId: schema.archivedAds.creativeId,
        postUrl: schema.archivedAds.postUrl,
        archivedAt: schema.archivedAds.archivedAt,
      })
      .from(schema.archivedAds)
      .where(
        and(
          eq(schema.archivedAds.companyId, args.companyId),
          eq(schema.archivedAds.userId, args.userId),
        ),
      )
      .orderBy(desc(schema.archivedAds.archivedAt))
      .limit(limit);
  });

  return rows.map((row) => ({
    ...row,
    archivedAt: row.archivedAt.toISOString(),
  }));
}

async function readTaskUserId(companyId: string, taskId: string): Promise<string | undefined> {
  const rows = await db.transaction(async (tx) => {
    await setTenant(tx, companyId);
    return tx
      .select({ userId: schema.operationTasks.userId })
      .from(schema.operationTasks)
      .where(and(eq(schema.operationTasks.companyId, companyId), eq(schema.operationTasks.id, taskId)))
      .limit(1);
  });
  return rows[0]?.userId;
}

async function readAdArchiveSnapshot(args: {
  companyId: string;
  adAccountId: string;
  adId: string;
  owner?: MetaObjectOwnership;
}): Promise<{
  source: 'local_snapshot' | 'fallback';
  adName: string;
  campaignMetaId: string | null;
  adsetMetaId: string | null;
  originalStatus: EntityStatus | null;
  effectiveStatus: string | null;
  creativeId: string | null;
  local: Record<string, unknown> | null;
}> {
  const rows = await db.transaction(async (tx) => {
    await setTenant(tx, args.companyId);
    return tx
      .select()
      .from(schema.adObjects)
      .where(
        and(
          eq(schema.adObjects.companyId, args.companyId),
          eq(schema.adObjects.adAccountId, args.adAccountId),
          eq(schema.adObjects.metaId, args.adId),
        ),
      )
      .limit(1);
  });
  const row = rows[0];
  if (!row) {
    return {
      source: 'fallback',
      adName: args.adId,
      campaignMetaId: args.owner?.campaignId ?? null,
      adsetMetaId: args.owner?.adsetId ?? null,
      originalStatus: null,
      effectiveStatus: null,
      creativeId: null,
      local: null,
    };
  }
  return {
    source: 'local_snapshot',
    adName: row.name,
    campaignMetaId: row.campaignMetaId ?? args.owner?.campaignId ?? null,
    adsetMetaId: row.adsetMetaId ?? args.owner?.adsetId ?? null,
    originalStatus: row.status,
    effectiveStatus: row.effectiveStatus,
    creativeId: row.creativeId,
    local: {
      id: row.id,
      metaId: row.metaId,
      name: row.name,
      status: row.status,
      effectiveStatus: row.effectiveStatus,
      campaignMetaId: row.campaignMetaId,
      adsetMetaId: row.adsetMetaId,
      creativeId: row.creativeId,
      metaUpdatedTime: row.metaUpdatedTime?.toISOString() ?? null,
      lastSyncedAt: row.lastSyncedAt.toISOString(),
    },
  };
}

async function resolvePostUrlBestEffort(
  token: string | undefined,
  creativeId: string | null,
): Promise<string | null> {
  if (!token || !creativeId) return null;
  try {
    return await meta.getCreativePostUrl(token, creativeId) ?? null;
  } catch (err) {
    console.warn('[archive-ad] failed to resolve creative post url', {
      creativeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function setTenant(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: string,
) {
  await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
}
