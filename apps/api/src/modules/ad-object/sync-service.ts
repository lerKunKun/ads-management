import { sql as dsql } from 'drizzle-orm';
import { db } from '../../lib/db';
import { BreakerKey, isOpen, openFor } from '../../lib/breaker';
import { acquire, DEFAULT_BUCKETS } from '../../lib/rate-limit';
import { HttpError } from '../../lib/http-error';
import { meta, MetaApiError, type MetaAdSet, type MetaCampaign } from '../../lib/meta-client';
import { env } from '../../env';
import { resolveAdAccount, markTokenInvalid } from '../account/token-service';
import {
  markSyncFailed,
  upsertAdSetSnapshots,
  upsertAdSnapshots,
  upsertCampaignSnapshots,
} from './local-store';

export type SyncDepth = 'campaign' | 'adset' | 'ad';

export interface SyncAdAccountArgs {
  companyId: string;
  adAccountId: string;
  depth?: SyncDepth;
  maxCampaigns?: number;
  maxAdsets?: number;
}

export interface SyncAdAccountResult {
  adAccountId: string;
  metaActId: string;
  campaigns: number;
  adsets: number;
  ads: number;
  depth: SyncDepth;
}

export interface SyncDueResult {
  candidates: number;
  synced: number;
  failed: number;
  skipped: number;
  results: SyncAdAccountResult[];
}

interface DueAdAccount {
  id: string;
  companyId: string;
}

export async function syncAdAccountObjects(
  args: SyncAdAccountArgs,
): Promise<SyncAdAccountResult> {
  const depth = args.depth ?? env.adObjectSyncDepth;
  const maxCampaigns = args.maxCampaigns ?? env.adObjectSyncMaxCampaigns;
  const maxAdsets = args.maxAdsets ?? env.adObjectSyncMaxAdsets;
  const ctx = await resolveAdAccount(args.companyId, args.adAccountId);

  await ensureSyncCanRun(ctx.fbAccountId, ctx.metaActId);
  const campaigns = await syncCampaigns(args.companyId, args.adAccountId, ctx);
  const result: SyncAdAccountResult = {
    adAccountId: args.adAccountId,
    metaActId: ctx.metaActId,
    campaigns: campaigns.length,
    adsets: 0,
    ads: 0,
    depth,
  };

  if (depth === 'campaign') return result;

  const campaignSlice = campaigns.slice(0, Math.max(0, maxCampaigns));
  const allAdsets: MetaAdSet[] = [];
  for (const campaign of campaignSlice) {
    await ensureSyncCanRun(ctx.fbAccountId, ctx.metaActId);
    try {
      const adsets = await withMetaRateLimit(ctx.metaActId, () =>
        meta.listAdSets(ctx.token, campaign.id),
      );
      await upsertAdSetSnapshots(args.companyId, args.adAccountId, campaign.id, adsets);
      result.adsets += adsets.length;
      allAdsets.push(...adsets);
    } catch (err) {
      await markChildSyncFailed(args.companyId, args.adAccountId, 'adset', campaign.id, err);
      await handleMetaSyncError(err, args.companyId, ctx.fbAccountId, ctx.metaActId);
    }
  }

  if (depth === 'ad') {
    const adsetSlice = allAdsets.slice(0, Math.max(0, maxAdsets));
    for (const adset of adsetSlice) {
      await ensureSyncCanRun(ctx.fbAccountId, ctx.metaActId);
      try {
        const ads = await withMetaRateLimit(ctx.metaActId, () =>
          meta.listAds(ctx.token, adset.id),
        );
        await upsertAdSnapshots(args.companyId, args.adAccountId, adset.id, ads);
        result.ads += ads.length;
      } catch (err) {
        await markChildSyncFailed(args.companyId, args.adAccountId, 'ad', adset.id, err);
        await handleMetaSyncError(err, args.companyId, ctx.fbAccountId, ctx.metaActId);
      }
    }
  }

  return result;
}

export async function syncDueAdAccounts(args: {
  companyId?: string;
  limit?: number;
  depth?: SyncDepth;
  staleMs?: number;
} = {}): Promise<SyncDueResult> {
  const limit = Math.max(1, Math.min(args.limit ?? env.adObjectSyncBatchSize, 20));
  const rows = await listDueAdAccounts({
    ...(args.companyId ? { companyId: args.companyId } : {}),
    limit,
    staleMs: args.staleMs ?? env.adObjectSyncStaleMs,
  });
  const summary: SyncDueResult = {
    candidates: rows.length,
    synced: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };

  for (const row of rows) {
    try {
      const result = await syncAdAccountObjects({
        companyId: row.companyId,
        adAccountId: row.id,
        ...(args.depth ? { depth: args.depth } : {}),
      });
      summary.synced++;
      summary.results.push(result);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 409 || status === 429) {
        summary.skipped++;
      } else {
        summary.failed++;
      }
      console.error('[ad-object-sync] account failed', row, err);
    }
  }

  return summary;
}

async function syncCampaigns(
  companyId: string,
  adAccountId: string,
  ctx: { token: string; metaActId: string; fbAccountId: string },
): Promise<MetaCampaign[]> {
  try {
    const campaigns = await withMetaRateLimit(ctx.metaActId, () =>
      meta.listCampaigns(ctx.token, ctx.metaActId),
    );
    await upsertCampaignSnapshots(companyId, adAccountId, campaigns);
    return campaigns;
  } catch (err) {
    await markChildSyncFailed(companyId, adAccountId, 'campaign', '', err);
    await handleMetaSyncError(err, companyId, ctx.fbAccountId, ctx.metaActId);
    throw err;
  }
}

async function listDueAdAccounts(args: {
  companyId?: string;
  limit: number;
  staleMs: number;
}): Promise<DueAdAccount[]> {
  const staleBefore = new Date(Date.now() - args.staleMs);
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    const companyFilter = args.companyId
      ? dsql`AND aa.company_id = ${args.companyId}`
      : dsql``;
    return tx.execute(dsql`
      SELECT aa.id::text AS id, aa.company_id::text AS company_id
      FROM ad_accounts aa
      INNER JOIN fb_accounts fb ON fb.id = aa.fb_account_id
      LEFT JOIN ad_account_sync_state ss
        ON ss.ad_account_id = aa.id
       AND ss.object_type = 'campaign'
       AND ss.parent_meta_id = ''
      WHERE aa.status = 'active'
        AND fb.status = 'active'
        ${companyFilter}
        AND (ss.last_synced_at IS NULL OR ss.last_synced_at < ${staleBefore})
      ORDER BY ss.last_synced_at ASC NULLS FIRST, aa.created_at ASC
      LIMIT ${args.limit}
    `);
  });
  return (rows as unknown as Array<{ id: string; company_id: string }>).map((row) => ({
    id: row.id,
    companyId: row.company_id,
  }));
}

async function ensureSyncCanRun(fbAccountId: string, metaActId: string): Promise<void> {
  const fbBreaker = BreakerKey.fbAccount(fbAccountId);
  const adBreaker = BreakerKey.adAccount(metaActId);
  if (await isOpen(fbBreaker)) {
    throw new HttpError(409, 1003, `breaker open: ${fbBreaker}`);
  }
  if (await isOpen(adBreaker)) {
    throw new HttpError(429, 1002, `breaker open: ${adBreaker}`);
  }
}

async function withMetaRateLimit<T>(metaActId: string, fn: () => Promise<T>): Promise<T> {
  const rate = await acquire([DEFAULT_BUCKETS.app(), DEFAULT_BUCKETS.adAccount(metaActId)]);
  if (!rate.allowed) {
    throw new HttpError(429, 1002, `rate-limited wait ${rate.waitMs}ms`);
  }
  return fn();
}

async function markChildSyncFailed(
  companyId: string,
  adAccountId: string,
  objectType: SyncDepth,
  parentMetaId: string,
  err: unknown,
): Promise<void> {
  try {
    await markSyncFailed({
      companyId,
      adAccountId,
      objectType,
      parentMetaId,
      error: err instanceof Error ? err.message : String(err),
    });
  } catch (writeErr) {
    console.error('[ad-object-sync] mark failed state failed', writeErr);
  }
}

async function handleMetaSyncError(
  err: unknown,
  companyId: string,
  fbAccountId: string,
  metaActId: string,
): Promise<void> {
  if (!(err instanceof MetaApiError)) return;
  if (err.isTokenInvalid) {
    await markTokenInvalid(companyId, fbAccountId, err.message);
    await openFor(BreakerKey.fbAccount(fbAccountId), 0, 'token_invalid');
    throw new HttpError(409, 1003, `token invalid: ${err.message}`);
  }
  if (err.isRateLimited) {
    await openFor(BreakerKey.adAccount(metaActId), 60, 'meta rate limited');
    throw new HttpError(429, 1002, `meta rate limited: ${err.message}`);
  }
  throw new HttpError(502, 1002, `meta error: ${err.message}`);
}
