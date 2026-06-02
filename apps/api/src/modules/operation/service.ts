/**
 * M2 同步操作执行 + 三层 list/单 target 操作 + insights。
 * 每个调用: 解析 ad_account → 解密 token → 调 Meta → 写 audit。
 * Meta 错误识别: token 失效 → 熔断个号 + 409;限流 → 429。
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../lib/db';
import { metaProvider } from '../../providers/meta';
import {
  meta,
  MetaApiError,
  type MetaCampaign,
  type MetaAdSet,
  type MetaAd,
  type InsightsSummary,
  type DatePreset,
  type InsightsDateSpec,
  type InsightsDateRange,
  type MetaObjectOwnership,
} from '../../lib/meta-client';
import { FAKE_MODE, fakeMeta } from '../../lib/fake-meta-state';
import { writeAudit } from '../iam/auth-service';
import { resolveAdAccount, markTokenInvalid } from '../account/token-service';
import { checkScope } from '../../middleware/auth';
import { HttpError, Forbidden, NotFound } from '../../lib/http-error';
import type { AuthPrincipal } from '../iam/auth-service';
import type { RenameOptions, CopyInput } from '@ads/shared';
import {
  markLocalBudget,
  markLocalDeleted,
  markLocalStatus,
  hydrateAdsWithLocalAdSetSchedule,
  readFreshAds,
  readFreshAdSets,
  readFreshCampaigns,
  readLocalObjectOwnership,
  upsertAdSetSnapshots,
  upsertAdSnapshots,
  upsertCampaignSnapshots,
  upsertLocalCopyPlaceholder,
} from '../ad-object/local-store';
import {
  archiveAdForUser,
  listArchivedAdsForUser,
  type ArchivedAdDto,
} from '../ad-object/archive-store';

type CampaignStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED';

function assertScope(principal: AuthPrincipal, adAccountId: string) {
  if (!checkScope(principal, 'ad_account', adAccountId)) {
    throw Forbidden('ad_account not in user scope');
  }
}

async function assertTargetOwnership(
  principal: AuthPrincipal,
  ctx: { token: string; metaActId: string; fbAccountId: string },
  adAccountId: string,
  targetType: 'campaign' | 'adset' | 'ad',
  targetId: string,
  parents: { campaignId?: string; adsetId?: string } = {},
): Promise<MetaObjectOwnership> {
  if (FAKE_MODE) {
    const owner = await readLocalObjectOwnership({
      companyId: principal.companyId,
      adAccountId,
      targetType,
      targetId,
    });
    if (!owner) throw NotFound(`${targetType} not found in local snapshot`);
    return validateOwnership(
      { ...owner, actId: ctx.metaActId },
      ctx.metaActId,
      targetType,
      parents,
    );
  }

  try {
    const owner = await meta.getObjectOwnership(ctx.token, targetType, targetId);
    return validateOwnership(owner, ctx.metaActId, targetType, parents);
  } catch (err) {
    await handleMetaError(err, principal.companyId, ctx.fbAccountId);
    throw err;
  }
}

function validateOwnership(
  owner: MetaObjectOwnership,
  metaActId: string,
  targetType: 'campaign' | 'adset' | 'ad',
  parents: { campaignId?: string; adsetId?: string },
): MetaObjectOwnership {
  if (owner.actId !== metaActId) {
    throw Forbidden(`${targetType} not in ad_account`);
  }
  if (parents.campaignId && owner.campaignId !== parents.campaignId) {
    throw Forbidden(`${targetType} not in campaign`);
  }
  if (parents.adsetId && owner.adsetId !== parents.adsetId) {
    throw Forbidden(`${targetType} not in adset`);
  }
  return owner;
}

interface ListOptions {
  force?: boolean;
}

// =================== Campaign list / 单操作 ===================
export async function listCampaigns(
  principal: AuthPrincipal,
  adAccountId: string,
  options: ListOptions = {},
): Promise<MetaCampaign[]> {
  assertScope(principal, adAccountId);
  const cached = options.force ? null : await readFreshCampaigns(principal.companyId, adAccountId);
  if (cached) return cached;
  const ctx = await resolveAdAccount(principal.companyId, adAccountId);
  try {
    const rows = await meta.listCampaigns(ctx.token, ctx.metaActId);
    await upsertCampaignSnapshots(principal.companyId, adAccountId, rows);
    return rows;
  } catch (err) {
    await handleMetaError(err, principal.companyId, ctx.fbAccountId);
    throw err;
  }
}

export async function setCampaignStatus(
  principal: AuthPrincipal,
  args: { adAccountId: string; campaignId: string; status: CampaignStatus; ip?: string },
): Promise<void> {
  assertScope(principal, args.adAccountId);
  const ctx = await resolveAdAccount(principal.companyId, args.adAccountId);
  const owner = await assertTargetOwnership(principal, ctx, args.adAccountId, 'campaign', args.campaignId);
  if (!FAKE_MODE) {
    try {
      await metaProvider.setStatus(ctx.token, {
        adAccountId: ctx.metaActId,
        targetId: args.campaignId,
        targetType: 'campaign',
        status: args.status,
      });
    } catch (err) {
      await handleMetaError(err, principal.companyId, ctx.fbAccountId);
      throw err;
    }
  }
  await writeLocalBestEffort('campaign:status', () => markLocalStatus({
    companyId: principal.companyId,
    adAccountId: args.adAccountId,
    targetType: 'campaign',
    targetId: args.campaignId,
    status: args.status,
    owner,
  }));
  await writeAudit({
    companyId: principal.companyId,
    userId: principal.userId,
    action: 'campaign:status',
    resource: `campaign:${args.campaignId}`,
    detail: { adAccountId: args.adAccountId, metaActId: ctx.metaActId, status: args.status },
    ...(args.ip ? { ip: args.ip } : {}),
  });
}

export async function setCampaignBudget(
  principal: AuthPrincipal,
  args: {
    adAccountId: string;
    campaignId: string;
    dailyBudget?: number;
    lifetimeBudget?: number;
    ip?: string;
  },
): Promise<void> {
  assertScope(principal, args.adAccountId);
  if (args.dailyBudget === undefined && args.lifetimeBudget === undefined) {
    throw new HttpError(422, 422, '至少传 dailyBudget 或 lifetimeBudget');
  }
  if (args.dailyBudget !== undefined && args.lifetimeBudget !== undefined) {
    throw new HttpError(422, 422, 'dailyBudget 与 lifetimeBudget 二选一');
  }
  const ctx = await resolveAdAccount(principal.companyId, args.adAccountId);
  const owner = await assertTargetOwnership(principal, ctx, args.adAccountId, 'campaign', args.campaignId);
  if (!FAKE_MODE) {
    try {
      await metaProvider.setBudget(ctx.token, {
        adAccountId: ctx.metaActId,
        targetId: args.campaignId,
        targetType: 'campaign',
        ...(args.dailyBudget !== undefined ? { dailyBudget: args.dailyBudget } : {}),
        ...(args.lifetimeBudget !== undefined ? { lifetimeBudget: args.lifetimeBudget } : {}),
      });
    } catch (err) {
      await handleMetaError(err, principal.companyId, ctx.fbAccountId);
      throw err;
    }
  }
  await writeLocalBestEffort('campaign:budget', () => markLocalBudget({
    companyId: principal.companyId,
    adAccountId: args.adAccountId,
    targetType: 'campaign',
    targetId: args.campaignId,
    ...(args.dailyBudget !== undefined ? { dailyBudget: args.dailyBudget } : {}),
    ...(args.lifetimeBudget !== undefined ? { lifetimeBudget: args.lifetimeBudget } : {}),
    owner,
  }));
  await writeAudit({
    companyId: principal.companyId,
    userId: principal.userId,
    action: 'campaign:budget',
    resource: `campaign:${args.campaignId}`,
    detail: {
      adAccountId: args.adAccountId,
      metaActId: ctx.metaActId,
      ...(args.dailyBudget !== undefined ? { dailyBudget: args.dailyBudget } : {}),
      ...(args.lifetimeBudget !== undefined ? { lifetimeBudget: args.lifetimeBudget } : {}),
    },
    ...(args.ip ? { ip: args.ip } : {}),
  });
}

// =================== AdSet list / 单操作 ===================
export async function listAdSets(
  principal: AuthPrincipal,
  adAccountId: string,
  campaignId: string,
  options: ListOptions = {},
): Promise<MetaAdSet[]> {
  assertScope(principal, adAccountId);
  const cached = options.force
    ? null
    : await readFreshAdSets(principal.companyId, adAccountId, campaignId);
  if (cached) return cached;
  const ctx = await resolveAdAccount(principal.companyId, adAccountId);
  await assertTargetOwnership(principal, ctx, adAccountId, 'campaign', campaignId);
  try {
    const rows = await meta.listAdSets(ctx.token, campaignId);
    await upsertAdSetSnapshots(principal.companyId, adAccountId, campaignId, rows);
    return rows;
  } catch (err) {
    await handleMetaError(err, principal.companyId, ctx.fbAccountId);
    throw err;
  }
}

export async function setAdSetStatus(
  principal: AuthPrincipal,
  args: { adAccountId: string; adsetId: string; status: CampaignStatus; ip?: string },
): Promise<void> {
  assertScope(principal, args.adAccountId);
  const ctx = await resolveAdAccount(principal.companyId, args.adAccountId);
  const owner = await assertTargetOwnership(principal, ctx, args.adAccountId, 'adset', args.adsetId);
  if (!FAKE_MODE) {
    try {
      await metaProvider.setStatus(ctx.token, {
        adAccountId: ctx.metaActId,
        targetId: args.adsetId,
        targetType: 'adset',
        status: args.status,
      });
    } catch (err) {
      await handleMetaError(err, principal.companyId, ctx.fbAccountId);
      throw err;
    }
  }
  await writeLocalBestEffort('adset:status', () => markLocalStatus({
    companyId: principal.companyId,
    adAccountId: args.adAccountId,
    targetType: 'adset',
    targetId: args.adsetId,
    status: args.status,
    owner,
  }));
  await writeAudit({
    companyId: principal.companyId,
    userId: principal.userId,
    action: 'adset:status',
    resource: `adset:${args.adsetId}`,
    detail: { adAccountId: args.adAccountId, status: args.status },
    ...(args.ip ? { ip: args.ip } : {}),
  });
}

export async function setAdSetBudget(
  principal: AuthPrincipal,
  args: {
    adAccountId: string;
    adsetId: string;
    dailyBudget?: number;
    lifetimeBudget?: number;
    ip?: string;
  },
): Promise<void> {
  assertScope(principal, args.adAccountId);
  if (args.dailyBudget === undefined && args.lifetimeBudget === undefined) {
    throw new HttpError(422, 422, '至少传 dailyBudget 或 lifetimeBudget');
  }
  if (args.dailyBudget !== undefined && args.lifetimeBudget !== undefined) {
    throw new HttpError(422, 422, 'dailyBudget 与 lifetimeBudget 二选一');
  }
  const ctx = await resolveAdAccount(principal.companyId, args.adAccountId);
  const owner = await assertTargetOwnership(principal, ctx, args.adAccountId, 'adset', args.adsetId);
  if (!FAKE_MODE) {
    try {
      await metaProvider.setBudget(ctx.token, {
        adAccountId: ctx.metaActId,
        targetId: args.adsetId,
        targetType: 'adset',
        ...(args.dailyBudget !== undefined ? { dailyBudget: args.dailyBudget } : {}),
        ...(args.lifetimeBudget !== undefined ? { lifetimeBudget: args.lifetimeBudget } : {}),
      });
    } catch (err) {
      await handleMetaError(err, principal.companyId, ctx.fbAccountId);
      throw err;
    }
  }
  await writeLocalBestEffort('adset:budget', () => markLocalBudget({
    companyId: principal.companyId,
    adAccountId: args.adAccountId,
    targetType: 'adset',
    targetId: args.adsetId,
    ...(args.dailyBudget !== undefined ? { dailyBudget: args.dailyBudget } : {}),
    ...(args.lifetimeBudget !== undefined ? { lifetimeBudget: args.lifetimeBudget } : {}),
    owner,
  }));
  await writeAudit({
    companyId: principal.companyId,
    userId: principal.userId,
    action: 'adset:budget',
    resource: `adset:${args.adsetId}`,
    detail: {
      adAccountId: args.adAccountId,
      ...(args.dailyBudget !== undefined ? { dailyBudget: args.dailyBudget } : {}),
      ...(args.lifetimeBudget !== undefined ? { lifetimeBudget: args.lifetimeBudget } : {}),
    },
    ...(args.ip ? { ip: args.ip } : {}),
  });
}

// =================== Ad list / 单操作 ===================
export async function listAds(
  principal: AuthPrincipal,
  adAccountId: string,
  adsetId: string,
  options: ListOptions = {},
): Promise<MetaAd[]> {
  assertScope(principal, adAccountId);
  const cached = options.force ? null : await readFreshAds(principal.companyId, adAccountId, adsetId);
  if (cached) return cached;
  const ctx = await resolveAdAccount(principal.companyId, adAccountId);
  await assertTargetOwnership(principal, ctx, adAccountId, 'adset', adsetId);
  try {
    const rows = await meta.listAds(ctx.token, adsetId);
    await upsertAdSnapshots(principal.companyId, adAccountId, adsetId, rows);
    return await hydrateAdsWithLocalAdSetSchedule(principal.companyId, adAccountId, rows);
  } catch (err) {
    await handleMetaError(err, principal.companyId, ctx.fbAccountId);
    throw err;
  }
}

export async function setAdStatus(
  principal: AuthPrincipal,
  args: { adAccountId: string; adId: string; status: CampaignStatus; ip?: string },
): Promise<void> {
  assertScope(principal, args.adAccountId);
  const ctx = await resolveAdAccount(principal.companyId, args.adAccountId);
  const owner = await assertTargetOwnership(principal, ctx, args.adAccountId, 'ad', args.adId);
  if (!FAKE_MODE) {
    try {
      await metaProvider.setStatus(ctx.token, {
        adAccountId: ctx.metaActId,
        targetId: args.adId,
        targetType: 'ad',
        status: args.status,
      });
    } catch (err) {
      await handleMetaError(err, principal.companyId, ctx.fbAccountId);
      throw err;
    }
  }
  await writeLocalBestEffort('ad:status', () => markLocalStatus({
    companyId: principal.companyId,
    adAccountId: args.adAccountId,
    targetType: 'ad',
    targetId: args.adId,
    status: args.status,
    owner,
  }));
  await writeAudit({
    companyId: principal.companyId,
    userId: principal.userId,
    action: 'ad:status',
    resource: `ad:${args.adId}`,
    detail: { adAccountId: args.adAccountId, status: args.status },
    ...(args.ip ? { ip: args.ip } : {}),
  });
}

// =================== Copy / Delete 三层统一入口 ===================
export interface CopyArgs {
  adAccountId: string;
  targetType: 'campaign' | 'adset' | 'ad';
  sourceId: string;
  count?: number;
  deepCopy?: boolean;
  startTime?: string;
  endTime?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  statusOption?: 'ACTIVE' | 'PAUSED' | 'INHERITED_FROM_SOURCE';
  renameOptions?: RenameOptions;
  ip?: string;
}

/** 单 target 同步复制(可指定 count;count>1 时循环 N 次,每次 suffix 加 #i)。
 *  返回所有新 id。 */
export async function copyEntity(
  principal: AuthPrincipal,
  args: CopyArgs,
): Promise<{ newIds: string[] }> {
  assertScope(principal, args.adAccountId);
  const count = Math.max(1, args.count ?? 1);
  const ctx = await resolveAdAccount(principal.companyId, args.adAccountId);
  const owner = await assertTargetOwnership(principal, ctx, args.adAccountId, args.targetType, args.sourceId);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const renameForThis: RenameOptions | undefined = args.renameOptions
      ? withIndexedSuffix(args.renameOptions, count > 1 ? i + 1 : undefined)
      : undefined;
    const input: CopyInput = {
      adAccountId: ctx.metaActId,
      sourceId: args.sourceId,
      targetType: args.targetType,
      ...(args.deepCopy !== undefined ? { deepCopy: args.deepCopy } : {}),
      ...(args.startTime ? { startTime: args.startTime } : {}),
      ...(args.endTime ? { endTime: args.endTime } : {}),
      ...(args.dailyBudget !== undefined ? { dailyBudget: args.dailyBudget } : {}),
      ...(args.lifetimeBudget !== undefined ? { lifetimeBudget: args.lifetimeBudget } : {}),
      ...(args.statusOption ? { statusOption: args.statusOption } : {}),
      ...(renameForThis ? { renameOptions: renameForThis } : {}),
    };
    try {
      const r = FAKE_MODE
        ? { newId: localCopyId(args.targetType, args.sourceId, i) }
        : await metaProvider.copy(ctx.token, input);
      out.push(r.newId);
      await writeLocalBestEffort(`${args.targetType}:copy`, () => upsertLocalCopyPlaceholder({
        companyId: principal.companyId,
        adAccountId: args.adAccountId,
        targetType: args.targetType,
        sourceId: args.sourceId,
        newId: r.newId,
        owner,
        ...(renameForThis ? { renameOptions: renameForThis } : {}),
      }));
    } catch (err) {
      await handleMetaError(err, principal.companyId, ctx.fbAccountId);
      throw err;
    }
  }
  await writeAudit({
    companyId: principal.companyId,
    userId: principal.userId,
    action: `${args.targetType}:copy`,
    resource: `${args.targetType}:${args.sourceId}`,
    detail: {
      adAccountId: args.adAccountId,
      count,
      newIds: out,
      ...(args.startTime ? { startTime: args.startTime } : {}),
      ...(args.endTime ? { endTime: args.endTime } : {}),
      ...(args.dailyBudget !== undefined ? { dailyBudget: args.dailyBudget } : {}),
      ...(args.lifetimeBudget !== undefined ? { lifetimeBudget: args.lifetimeBudget } : {}),
      ...(args.renameOptions ? { renameOptions: args.renameOptions } : {}),
    },
    ...(args.ip ? { ip: args.ip } : {}),
  });
  return { newIds: out };
}

function withIndexedSuffix(opts: RenameOptions, idx: number | undefined): RenameOptions {
  const out: RenameOptions = { ...opts };
  if (idx === undefined) return out;
  const suffix = opts.rename_suffix ?? '';
  // 用户的"测试编号后缀"自增,从 #1 开始;若用户已自带 #,保留用户的并 append #idx
  out.rename_suffix = `${suffix}-${String(idx).padStart(2, '0')}`;
  return out;
}

function localCopyId(targetType: 'campaign' | 'adset' | 'ad', sourceId: string, index: number): string {
  const safeSource = sourceId.replace(/[^a-zA-Z0-9_]/g, '_').slice(-48);
  return `local_${targetType}_copy_${safeSource}_${Date.now()}_${index + 1}`;
}

export async function deleteEntity(
  principal: AuthPrincipal,
  args: {
    adAccountId: string;
    targetType: 'campaign' | 'adset' | 'ad';
    targetId: string;
    hard?: boolean;
    ip?: string;
  },
): Promise<void> {
  assertScope(principal, args.adAccountId);
  const ctx = await resolveAdAccount(principal.companyId, args.adAccountId);
  const owner = await assertTargetOwnership(principal, ctx, args.adAccountId, args.targetType, args.targetId);
  if (!FAKE_MODE) {
    try {
      await metaProvider.remove(ctx.token, {
        adAccountId: ctx.metaActId,
        targetId: args.targetId,
        targetType: args.targetType,
        hard: args.hard === true,
      });
    } catch (err) {
      await handleMetaError(err, principal.companyId, ctx.fbAccountId);
      throw err;
    }
  }
  if (args.targetType === 'ad' && args.hard !== true) {
    try {
      await archiveAdForUser({
        companyId: principal.companyId,
        userId: principal.userId,
        adAccountId: args.adAccountId,
        adId: args.targetId,
        token: ctx.token,
        owner,
      });
    } catch (err) {
      console.error('[archive-ad] single delete archive failed', err);
    }
  }
  await writeLocalBestEffort(`${args.targetType}:delete`, () => markLocalDeleted({
    companyId: principal.companyId,
    adAccountId: args.adAccountId,
    targetType: args.targetType,
    targetId: args.targetId,
    hard: args.hard === true,
    owner,
  }));
  await writeAudit({
    companyId: principal.companyId,
    userId: principal.userId,
    action: `${args.targetType}:delete`,
    resource: `${args.targetType}:${args.targetId}`,
    detail: { adAccountId: args.adAccountId, hard: args.hard === true },
    ...(args.ip ? { ip: args.ip } : {}),
  });
}

export async function listMyArchivedAds(
  principal: AuthPrincipal,
  limit = 200,
): Promise<ArchivedAdDto[]> {
  return listArchivedAdsForUser({
    companyId: principal.companyId,
    userId: principal.userId,
    limit,
  });
}

// =================== Insights ===================
export async function getInsightsByLevel(
  principal: AuthPrincipal,
  adAccountId: string,
  level: 'campaign' | 'adset' | 'ad',
  dateSpec: InsightsDateSpec,
  parentId?: string,
): Promise<Record<string, InsightsSummary>> {
  assertScope(principal, adAccountId);
  const localMock = await resolveLocalMockAdAccount(principal.companyId, adAccountId);
  if (localMock) return getLocalMockInsightsByLevel(localMock, level, dateSpec, parentId);
  const ctx = await resolveAdAccount(principal.companyId, adAccountId);
  try {
    const objectId = await resolveInsightsObjectId(
      principal,
      ctx,
      adAccountId,
      level,
      parentId,
    );
    return await meta.getInsightsByChild(ctx.token, objectId, level, dateSpec);
  } catch (err) {
    await handleMetaError(err, principal.companyId, ctx.fbAccountId);
    throw err;
  }
}

async function resolveInsightsObjectId(
  principal: AuthPrincipal,
  ctx: { token: string; metaActId: string; fbAccountId: string },
  adAccountId: string,
  level: 'campaign' | 'adset' | 'ad',
  parentId?: string,
): Promise<string> {
  if (!parentId || level === 'campaign') return ctx.metaActId;
  if (level === 'adset') {
    await assertTargetOwnership(principal, ctx, adAccountId, 'campaign', parentId);
    return parentId;
  }
  await assertTargetOwnership(principal, ctx, adAccountId, 'adset', parentId);
  return parentId;
}

function getLocalMockInsightsByLevel(
  metaActId: string,
  level: 'campaign' | 'adset' | 'ad',
  dateSpec: InsightsDateSpec,
  parentId?: string,
): Record<string, InsightsSummary> {
  if (!parentId || level === 'campaign') {
    return fakeMeta.getInsightsByChild(metaActId, level, dateSpec);
  }
  const out: Record<string, InsightsSummary> = {};
  if (level === 'adset') {
    for (const adset of fakeMeta.listAdSets(parentId)) {
      out[adset.id] = fakeMeta.getInsights(adset.id, dateSpec);
    }
    return out;
  }
  for (const ad of fakeMeta.listAds(parentId)) {
    out[ad.id] = fakeMeta.getInsights(ad.id, dateSpec);
  }
  return out;
}

export function parseInsightsDateSpec(args: {
  preset?: DatePreset;
  since?: string;
  until?: string;
}): InsightsDateSpec {
  const hasSince = !!args.since;
  const hasUntil = !!args.until;
  if (hasSince || hasUntil) {
    if (!args.since || !args.until) {
      throw new HttpError(422, 422, 'since 与 until 必须同时传');
    }
    const range: InsightsDateRange = {
      since: assertIsoDate(args.since, 'since'),
      until: assertIsoDate(args.until, 'until'),
    };
    if (range.since > range.until) {
      throw new HttpError(422, 422, 'since 不能晚于 until');
    }
    return range;
  }
  return args.preset ?? 'today';
}

function assertIsoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(422, 422, `${field} 必须为 YYYY-MM-DD`);
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms)) {
    throw new HttpError(422, 422, `${field} 日期无效`);
  }
  const normalized = new Date(ms).toISOString().slice(0, 10);
  if (normalized !== value) {
    throw new HttpError(422, 422, `${field} 日期无效`);
  }
  return value;
}

async function resolveLocalMockAdAccount(
  companyId: string,
  adAccountId: string,
): Promise<string | null> {
  if (FAKE_MODE) return null;
  return db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
    const rows = await tx
      .select({ metaActId: schema.adAccounts.metaActId })
      .from(schema.adAccounts)
      .where(
        and(
          eq(schema.adAccounts.id, adAccountId),
          eq(schema.adAccounts.companyId, companyId),
        ),
      )
      .limit(1);
    const metaActId = rows[0]?.metaActId;
    return metaActId?.startsWith('act_mock_') ? metaActId : null;
  });
}

// =================== 工具 ===================
async function handleMetaError(
  err: unknown,
  companyId: string,
  fbAccountId: string,
): Promise<never | void> {
  if (err instanceof MetaApiError) {
    if (err.isTokenInvalid) {
      await markTokenInvalid(companyId, fbAccountId, err.message);
      throw new HttpError(409, 1003, `token invalid: ${err.message}`);
    }
    if (err.isRateLimited) {
      throw new HttpError(429, 1002, `meta rate limited: ${err.message}`);
    }
    throw new HttpError(502, 1002, `meta error: ${err.message}`);
  }
}

async function writeLocalBestEffort(label: string, fn: () => Promise<void>): Promise<void> {
  if (FAKE_MODE) {
    await fn();
    return;
  }
  try {
    await fn();
  } catch (err) {
    console.error(`[local-ad-object] ${label} write failed`, err);
  }
}

export async function getAdAccountSummary(
  principal: AuthPrincipal,
  adAccountId: string,
): Promise<{
  id: string;
  metaActId: string;
  name: string;
  currency: string | null;
  timezoneName: string | null;
  businessCountryCode: string | null;
  status: string;
  fbAccountId: string;
  fbAccountName: string;
}> {
  assertScope(principal, adAccountId);
  return db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    const rows = await tx
      .select({
        id: schema.adAccounts.id,
        metaActId: schema.adAccounts.metaActId,
        name: schema.adAccounts.name,
        currency: schema.adAccounts.currency,
        timezoneName: schema.adAccounts.timezoneName,
        businessCountryCode: schema.adAccounts.businessCountryCode,
        status: schema.adAccounts.status,
        fbAccountId: schema.adAccounts.fbAccountId,
        fbAccountName: schema.fbAccounts.name,
      })
      .from(schema.adAccounts)
      .innerJoin(schema.fbAccounts, eq(schema.fbAccounts.id, schema.adAccounts.fbAccountId))
      .where(
        and(
          eq(schema.adAccounts.id, adAccountId),
          eq(schema.adAccounts.companyId, principal.companyId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw NotFound('ad_account not found');
    return rows[0];
  });
}
