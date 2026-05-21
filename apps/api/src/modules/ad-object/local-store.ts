import { createHash } from 'node:crypto';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../lib/db';
import { env } from '../../env';
import type {
  EntityStatus,
  MetaAd,
  MetaAdSet,
  MetaCampaign,
  MetaObjectOwnership,
} from '../../lib/meta-client';

type ObjectType = 'campaign' | 'adset' | 'ad';
type SyncObjectType = ObjectType;

const CACHE_TTL_MS = Number.isFinite(env.adObjectCacheTtlMs)
  ? env.adObjectCacheTtlMs
  : 30_000;

export async function readFreshCampaigns(
  companyId: string,
  adAccountId: string,
): Promise<MetaCampaign[] | null> {
  if (!(await hasFreshSync(companyId, adAccountId, 'campaign', ''))) return null;
  return listLocalCampaigns(companyId, adAccountId);
}

export async function readFreshAdSets(
  companyId: string,
  adAccountId: string,
  campaignId: string,
): Promise<MetaAdSet[] | null> {
  if (!(await hasFreshSync(companyId, adAccountId, 'adset', campaignId))) return null;
  return listLocalAdSets(companyId, adAccountId, campaignId);
}

export async function readFreshAds(
  companyId: string,
  adAccountId: string,
  adsetId: string,
): Promise<MetaAd[] | null> {
  if (!(await hasFreshSync(companyId, adAccountId, 'ad', adsetId))) return null;
  return listLocalAds(companyId, adAccountId, adsetId);
}

export async function upsertCampaignSnapshots(
  companyId: string,
  adAccountId: string,
  rows: MetaCampaign[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await setTenant(tx, companyId);
    const now = new Date();
    if (rows.length > 0) {
      await tx
        .insert(schema.adCampaigns)
        .values(
          rows.map((row) => ({
            companyId,
            adAccountId,
            metaId: row.id,
            name: row.name,
            status: row.status,
            effectiveStatus: row.effectiveStatus ?? null,
            objective: row.objective ?? null,
            dailyBudget: row.dailyBudget ?? null,
            lifetimeBudget: row.lifetimeBudget ?? null,
            startTime: parseMetaDate(row.startTime),
            stopTime: parseMetaDate(row.stopTime),
            metaCreatedTime: parseMetaDate(row.createdTime),
            metaUpdatedTime: parseMetaDate(row.updatedTime),
            lastSyncedAt: now,
            syncHash: syncHash(row),
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.adCampaigns.companyId, schema.adCampaigns.metaId],
          set: {
            adAccountId: dsql`excluded.ad_account_id`,
            name: dsql`excluded.name`,
            status: dsql`excluded.status`,
            effectiveStatus: dsql`excluded.effective_status`,
            objective: dsql`excluded.objective`,
            dailyBudget: dsql`excluded.daily_budget`,
            lifetimeBudget: dsql`excluded.lifetime_budget`,
            startTime: dsql`excluded.start_time`,
            stopTime: dsql`excluded.stop_time`,
            metaCreatedTime: dsql`excluded.meta_created_time`,
            metaUpdatedTime: dsql`excluded.meta_updated_time`,
            lastSyncedAt: dsql`excluded.last_synced_at`,
            syncHash: dsql`excluded.sync_hash`,
            updatedAt: now,
          },
        });
    }
    await markSyncSuccessTx(tx, companyId, adAccountId, 'campaign', '', now);
  });
}

export async function upsertAdSetSnapshots(
  companyId: string,
  adAccountId: string,
  campaignId: string,
  rows: MetaAdSet[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await setTenant(tx, companyId);
    const now = new Date();
    if (rows.length > 0) {
      await tx
        .insert(schema.adSetObjects)
        .values(
          rows.map((row) => ({
            companyId,
            adAccountId,
            campaignMetaId: row.campaignId ?? campaignId,
            metaId: row.id,
            name: row.name,
            status: row.status,
            effectiveStatus: row.effectiveStatus ?? null,
            dailyBudget: row.dailyBudget ?? null,
            lifetimeBudget: row.lifetimeBudget ?? null,
            optimizationGoal: row.optimizationGoal ?? null,
            billingEvent: row.billingEvent ?? null,
            bidAmount: row.bidAmount ?? null,
            startTime: parseMetaDate(row.startTime),
            endTime: parseMetaDate(row.endTime),
            metaUpdatedTime: parseMetaDate(row.updatedTime),
            lastSyncedAt: now,
            syncHash: syncHash(row),
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.adSetObjects.companyId, schema.adSetObjects.metaId],
          set: {
            adAccountId: dsql`excluded.ad_account_id`,
            campaignMetaId: dsql`excluded.campaign_meta_id`,
            name: dsql`excluded.name`,
            status: dsql`excluded.status`,
            effectiveStatus: dsql`excluded.effective_status`,
            dailyBudget: dsql`excluded.daily_budget`,
            lifetimeBudget: dsql`excluded.lifetime_budget`,
            optimizationGoal: dsql`excluded.optimization_goal`,
            billingEvent: dsql`excluded.billing_event`,
            bidAmount: dsql`excluded.bid_amount`,
            startTime: dsql`excluded.start_time`,
            endTime: dsql`excluded.end_time`,
            metaUpdatedTime: dsql`excluded.meta_updated_time`,
            lastSyncedAt: dsql`excluded.last_synced_at`,
            syncHash: dsql`excluded.sync_hash`,
            updatedAt: now,
          },
        });
    }
    await markSyncSuccessTx(tx, companyId, adAccountId, 'adset', campaignId, now);
  });
}

export async function upsertAdSnapshots(
  companyId: string,
  adAccountId: string,
  adsetId: string,
  rows: MetaAd[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await setTenant(tx, companyId);
    const now = new Date();
    if (rows.length > 0) {
      await tx
        .insert(schema.adObjects)
        .values(
          rows.map((row) => ({
            companyId,
            adAccountId,
            campaignMetaId: row.campaignId ?? null,
            adsetMetaId: row.adsetId ?? adsetId,
            metaId: row.id,
            name: row.name,
            status: row.status,
            effectiveStatus: row.effectiveStatus ?? null,
            creativeId: row.creativeId ?? null,
            metaUpdatedTime: parseMetaDate(row.updatedTime),
            lastSyncedAt: now,
            syncHash: syncHash(row),
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.adObjects.companyId, schema.adObjects.metaId],
          set: {
            adAccountId: dsql`excluded.ad_account_id`,
            campaignMetaId: dsql`excluded.campaign_meta_id`,
            adsetMetaId: dsql`excluded.adset_meta_id`,
            name: dsql`excluded.name`,
            status: dsql`excluded.status`,
            effectiveStatus: dsql`excluded.effective_status`,
            creativeId: dsql`excluded.creative_id`,
            metaUpdatedTime: dsql`excluded.meta_updated_time`,
            lastSyncedAt: dsql`excluded.last_synced_at`,
            syncHash: dsql`excluded.sync_hash`,
            updatedAt: now,
          },
        });
    }
    await markSyncSuccessTx(tx, companyId, adAccountId, 'ad', adsetId, now);
  });
}

export async function markLocalStatus(args: {
  companyId: string;
  adAccountId: string;
  targetType: ObjectType;
  targetId: string;
  status: EntityStatus;
  owner?: MetaObjectOwnership;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await setTenant(tx, args.companyId);
    const now = new Date();
    if (args.targetType === 'campaign') {
      await tx
        .insert(schema.adCampaigns)
        .values({
          companyId: args.companyId,
          adAccountId: args.adAccountId,
          metaId: args.targetId,
          name: args.targetId,
          status: args.status,
          effectiveStatus: args.status,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.adCampaigns.companyId, schema.adCampaigns.metaId],
          set: {
            status: args.status,
            effectiveStatus: args.status,
            lastSyncedAt: now,
            updatedAt: now,
          },
        });
      return;
    }
    if (args.targetType === 'adset') {
      await tx
        .insert(schema.adSetObjects)
        .values({
          companyId: args.companyId,
          adAccountId: args.adAccountId,
          campaignMetaId: args.owner?.campaignId ?? '',
          metaId: args.targetId,
          name: args.targetId,
          status: args.status,
          effectiveStatus: args.status,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.adSetObjects.companyId, schema.adSetObjects.metaId],
          set: {
            status: args.status,
            effectiveStatus: args.status,
            lastSyncedAt: now,
            updatedAt: now,
          },
        });
      return;
    }
    await tx
      .insert(schema.adObjects)
      .values({
        companyId: args.companyId,
        adAccountId: args.adAccountId,
        campaignMetaId: args.owner?.campaignId ?? null,
        adsetMetaId: args.owner?.adsetId ?? '',
        metaId: args.targetId,
        name: args.targetId,
        status: args.status,
        effectiveStatus: args.status,
        lastSyncedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.adObjects.companyId, schema.adObjects.metaId],
        set: {
          status: args.status,
          effectiveStatus: args.status,
          lastSyncedAt: now,
          updatedAt: now,
        },
      });
  });
}

export async function markLocalBudget(args: {
  companyId: string;
  adAccountId: string;
  targetType: 'campaign' | 'adset';
  targetId: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  owner?: MetaObjectOwnership;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await setTenant(tx, args.companyId);
    const now = new Date();
    const budgetSet = {
      ...(args.dailyBudget !== undefined ? { dailyBudget: args.dailyBudget } : {}),
      ...(args.lifetimeBudget !== undefined ? { lifetimeBudget: args.lifetimeBudget } : {}),
      lastSyncedAt: now,
      updatedAt: now,
    };
    if (args.targetType === 'campaign') {
      await tx
        .insert(schema.adCampaigns)
        .values({
          companyId: args.companyId,
          adAccountId: args.adAccountId,
          metaId: args.targetId,
          name: args.targetId,
          status: 'PAUSED',
          ...(args.dailyBudget !== undefined ? { dailyBudget: args.dailyBudget } : {}),
          ...(args.lifetimeBudget !== undefined ? { lifetimeBudget: args.lifetimeBudget } : {}),
          lastSyncedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.adCampaigns.companyId, schema.adCampaigns.metaId],
          set: budgetSet,
        });
      return;
    }
    await tx
      .insert(schema.adSetObjects)
      .values({
        companyId: args.companyId,
        adAccountId: args.adAccountId,
        campaignMetaId: args.owner?.campaignId ?? '',
        metaId: args.targetId,
        name: args.targetId,
        status: 'PAUSED',
        ...(args.dailyBudget !== undefined ? { dailyBudget: args.dailyBudget } : {}),
        ...(args.lifetimeBudget !== undefined ? { lifetimeBudget: args.lifetimeBudget } : {}),
        lastSyncedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.adSetObjects.companyId, schema.adSetObjects.metaId],
        set: budgetSet,
      });
  });
}

export async function markLocalDeleted(args: {
  companyId: string;
  adAccountId: string;
  targetType: ObjectType;
  targetId: string;
  hard: boolean;
  owner?: MetaObjectOwnership;
}): Promise<void> {
  if (args.hard) {
    await deleteLocalObject(args.companyId, args.targetType, args.targetId);
    return;
  }
  await markLocalStatus({ ...args, status: 'ARCHIVED' });
}

export async function markSyncFailed(args: {
  companyId: string;
  adAccountId: string;
  objectType: SyncObjectType;
  parentMetaId: string;
  error: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await setTenant(tx, args.companyId);
    const now = new Date();
    await tx
      .insert(schema.adAccountSyncState)
      .values({
        companyId: args.companyId,
        adAccountId: args.adAccountId,
        objectType: args.objectType,
        parentMetaId: args.parentMetaId,
        status: 'failed',
        lastError: args.error.slice(0, 1000),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.adAccountSyncState.adAccountId,
          schema.adAccountSyncState.objectType,
          schema.adAccountSyncState.parentMetaId,
        ],
        set: {
          status: 'failed',
          lastError: args.error.slice(0, 1000),
          updatedAt: now,
        },
      });
  });
}

export async function upsertLocalCopyPlaceholder(args: {
  companyId: string;
  adAccountId: string;
  targetType: ObjectType;
  sourceId: string;
  newId: string;
  owner?: MetaObjectOwnership;
}): Promise<void> {
  await markLocalStatus({
    companyId: args.companyId,
    adAccountId: args.adAccountId,
    targetType: args.targetType,
    targetId: args.newId,
    status: 'PAUSED',
    owner: args.owner,
  });
}

async function listLocalCampaigns(
  companyId: string,
  adAccountId: string,
): Promise<MetaCampaign[]> {
  return db.transaction(async (tx) => {
    await setTenant(tx, companyId);
    const rows = await tx
      .select()
      .from(schema.adCampaigns)
      .where(
        and(
          eq(schema.adCampaigns.companyId, companyId),
          eq(schema.adCampaigns.adAccountId, adAccountId),
        ),
      )
      .orderBy(schema.adCampaigns.createdAt);
    return rows.map((row) => ({
      id: row.metaId,
      name: row.name,
      status: row.status,
      ...(row.effectiveStatus ? { effectiveStatus: row.effectiveStatus } : {}),
      ...(row.objective ? { objective: row.objective } : {}),
      ...(row.dailyBudget !== null ? { dailyBudget: row.dailyBudget } : {}),
      ...(row.lifetimeBudget !== null ? { lifetimeBudget: row.lifetimeBudget } : {}),
      ...(row.startTime ? { startTime: row.startTime.toISOString() } : {}),
      ...(row.stopTime ? { stopTime: row.stopTime.toISOString() } : {}),
      ...(row.metaUpdatedTime ? { updatedTime: row.metaUpdatedTime.toISOString() } : {}),
      ...(row.metaCreatedTime ? { createdTime: row.metaCreatedTime.toISOString() } : {}),
    }));
  });
}

async function listLocalAdSets(
  companyId: string,
  adAccountId: string,
  campaignId: string,
): Promise<MetaAdSet[]> {
  return db.transaction(async (tx) => {
    await setTenant(tx, companyId);
    const rows = await tx
      .select()
      .from(schema.adSetObjects)
      .where(
        and(
          eq(schema.adSetObjects.companyId, companyId),
          eq(schema.adSetObjects.adAccountId, adAccountId),
          eq(schema.adSetObjects.campaignMetaId, campaignId),
        ),
      )
      .orderBy(schema.adSetObjects.createdAt);
    return rows.map((row) => ({
      id: row.metaId,
      name: row.name,
      status: row.status,
      campaignId: row.campaignMetaId,
      ...(row.effectiveStatus ? { effectiveStatus: row.effectiveStatus } : {}),
      ...(row.dailyBudget !== null ? { dailyBudget: row.dailyBudget } : {}),
      ...(row.lifetimeBudget !== null ? { lifetimeBudget: row.lifetimeBudget } : {}),
      ...(row.optimizationGoal ? { optimizationGoal: row.optimizationGoal } : {}),
      ...(row.billingEvent ? { billingEvent: row.billingEvent } : {}),
      ...(row.bidAmount !== null ? { bidAmount: row.bidAmount } : {}),
      ...(row.startTime ? { startTime: row.startTime.toISOString() } : {}),
      ...(row.endTime ? { endTime: row.endTime.toISOString() } : {}),
      ...(row.metaUpdatedTime ? { updatedTime: row.metaUpdatedTime.toISOString() } : {}),
    }));
  });
}

async function listLocalAds(
  companyId: string,
  adAccountId: string,
  adsetId: string,
): Promise<MetaAd[]> {
  return db.transaction(async (tx) => {
    await setTenant(tx, companyId);
    const rows = await tx
      .select()
      .from(schema.adObjects)
      .where(
        and(
          eq(schema.adObjects.companyId, companyId),
          eq(schema.adObjects.adAccountId, adAccountId),
          eq(schema.adObjects.adsetMetaId, adsetId),
        ),
      )
      .orderBy(schema.adObjects.createdAt);
    return rows.map((row) => ({
      id: row.metaId,
      name: row.name,
      status: row.status,
      adsetId: row.adsetMetaId,
      ...(row.campaignMetaId ? { campaignId: row.campaignMetaId } : {}),
      ...(row.effectiveStatus ? { effectiveStatus: row.effectiveStatus } : {}),
      ...(row.creativeId ? { creativeId: row.creativeId } : {}),
      ...(row.metaUpdatedTime ? { updatedTime: row.metaUpdatedTime.toISOString() } : {}),
    }));
  });
}

async function hasFreshSync(
  companyId: string,
  adAccountId: string,
  objectType: SyncObjectType,
  parentMetaId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await setTenant(tx, companyId);
    const rows = await tx
      .select({
        status: schema.adAccountSyncState.status,
        lastSyncedAt: schema.adAccountSyncState.lastSyncedAt,
      })
      .from(schema.adAccountSyncState)
      .where(
        and(
          eq(schema.adAccountSyncState.adAccountId, adAccountId),
          eq(schema.adAccountSyncState.objectType, objectType),
          eq(schema.adAccountSyncState.parentMetaId, parentMetaId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || row.status !== 'success' || !row.lastSyncedAt) return false;
    return Date.now() - row.lastSyncedAt.getTime() <= CACHE_TTL_MS;
  });
}

async function markSyncSuccessTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: string,
  adAccountId: string,
  objectType: SyncObjectType,
  parentMetaId: string,
  now: Date,
) {
  await tx
    .insert(schema.adAccountSyncState)
    .values({
      companyId,
      adAccountId,
      objectType,
      parentMetaId,
      status: 'success',
      lastSyncedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.adAccountSyncState.adAccountId,
        schema.adAccountSyncState.objectType,
        schema.adAccountSyncState.parentMetaId,
      ],
      set: {
        status: 'success',
        lastSyncedAt: now,
        lastError: null,
        updatedAt: now,
      },
    });
}

async function deleteLocalObject(
  companyId: string,
  targetType: ObjectType,
  targetId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await setTenant(tx, companyId);
    if (targetType === 'campaign') {
      await tx
        .delete(schema.adCampaigns)
        .where(
          and(eq(schema.adCampaigns.companyId, companyId), eq(schema.adCampaigns.metaId, targetId)),
        );
      return;
    }
    if (targetType === 'adset') {
      await tx
        .delete(schema.adSetObjects)
        .where(
          and(eq(schema.adSetObjects.companyId, companyId), eq(schema.adSetObjects.metaId, targetId)),
        );
      return;
    }
    await tx
      .delete(schema.adObjects)
      .where(and(eq(schema.adObjects.companyId, companyId), eq(schema.adObjects.metaId, targetId)));
  });
}

async function setTenant(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: string,
) {
  await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
}

function parseMetaDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function syncHash(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}
