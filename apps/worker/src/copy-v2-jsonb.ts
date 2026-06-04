import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../api/src/lib/db';
import { acquire, acquireSemaphore, releaseSemaphore } from '../../api/src/lib/rate-limit';
import { env } from '../../api/src/env';
import {
  meta,
  type AsyncCopyInput,
  type CopyOptions,
  MetaApiError,
  type MetaAd,
  type MetaAdRaw,
  type MetaAdSet,
  type MetaAdSetRaw,
  type MetaCampaign,
  type MetaCampaignRaw,
} from '../../api/src/lib/meta-client';
import { HttpError } from '../../api/src/lib/http-error';
import type { OperationMessage } from '../../api/src/lib/rabbitmq-topology';
import {
  upsertAdSetSnapshots,
  upsertAdSnapshots,
  upsertCampaignSnapshots,
} from '../../api/src/modules/ad-object/local-store';
import { isFake } from './fake-meta';
import { assertTaskRunnable, TaskCancelledError, TaskPausedError } from './task-control';

type StepStatus = 'pending' | 'running' | 'success' | 'unknown' | 'failed' | 'skipped' | 'retrying';
type SourceType = 'campaign' | 'adset' | 'ad';

interface WorkflowRow {
  id: string;
  state: Record<string, unknown>;
  version: number;
}

interface StepRow {
  id: string;
  stepKey: string;
  sourceType: SourceType;
  sourceId: string;
  status: StepStatus;
  newId: string | null;
  leaseUntil: Date | null;
  metadata: unknown;
}

interface StepNamePlan {
  finalName: string;
  markerName: string;
}

interface FieldMismatch {
  type: 'campaign' | 'adset' | 'ad' | 'workflow';
  sourceId?: string;
  newId?: string;
  field: string;
  expected: unknown;
  actual: unknown;
  reason?: string;
}

interface CampaignCopyPlan {
  campaign: MetaCampaignRaw;
  adsets: Array<{ adset: MetaAdSetRaw; ads: MetaAdRaw[] }>;
  adsetCount: number;
  adCount: number;
  estimatedRequests: number;
}

interface StepInsert {
  workflowId: string;
  taskId: string;
  taskItemId: string;
  companyId: string;
  stepKey: string;
  sourceType: string;
  sourceId: string;
  parentStepKey?: string;
  metadata: Record<string, unknown>;
}

function allowlisted(msg: OperationMessage): boolean {
  const raw = env.copyV2AccountAllowlist.trim();
  if (!raw) return true;
  const set = new Set(raw.split(',').map((item) => item.trim()).filter(Boolean));
  return set.has(msg.adAccountId) || set.has(msg.metaActId);
}

function shouldTryV2(msg: OperationMessage, input: AsyncCopyInput): boolean {
  if (!env.copyV2JsonbEnabled) return false;
  if (msg.action !== 'campaign:copy' || msg.targetType !== 'campaign' || input.targetType !== 'campaign') return false;
  if (input.deepCopy === false) return false;
  if (input.targetAdAccountId && input.targetAdAccountId !== msg.metaActId) return false;
  return allowlisted(msg);
}

function workflowState(plan: CampaignCopyPlan): Record<string, unknown> {
  return {
    stateVersion: 1,
    preflight: {
      adsetCount: plan.adsetCount,
      adCount: plan.adCount,
      estimatedRequests: plan.estimatedRequests,
    },
    config: {
      adsetConcurrency: env.copyV2AdsetConcurrency,
      adConcurrency: env.copyV2AdConcurrency,
      inspectConcurrency: env.copyV2InspectConcurrency,
      verifyConcurrency: env.copyV2VerifyConcurrency,
      globalQps: env.copyV2GlobalQps,
      globalBurst: env.copyV2GlobalBurst,
      globalConcurrency: env.copyV2GlobalConcurrency,
      adAccountQps: env.copyV2AdAccountQps,
    },
    progress: {
      campaign: 'pending',
      adsetsTotal: plan.adsetCount,
      adsetsSuccess: 0,
      adsTotal: plan.adCount,
      adsSuccess: 0,
      unknownSteps: 0,
    },
    fieldCheck: {
      status: env.copyV2VerifyEnabled ? 'pending' : 'skipped',
      mismatches: [],
    },
    errors: [],
  };
}

function shouldRouteLargeCampaign(plan: CampaignCopyPlan): boolean {
  return plan.adCount >= env.copyV2MinAdCount || plan.adsetCount >= env.copyV2MinAdsetCount;
}

function applyFinalCopyName(
  name: string | undefined,
  renameOptions: CopyOptions['renameOptions'],
  isTopLevel: boolean,
): string {
  const base = name || 'Untitled';
  if (!isTopLevel && renameOptions?.rename_strategy === 'ONLY_TOP_LEVEL_RENAME') return base;
  if (renameOptions?.rename_strategy === 'NO_RENAME') return base;
  const prefix = renameOptions?.rename_prefix ?? '';
  const suffix = renameOptions?.rename_suffix ?? '';
  return prefix || suffix ? `${prefix}${base}${suffix}` : `Copy of ${base}`;
}

function stepNamePlan(
  workflowId: string,
  sourceId: string,
  sourceName: string | undefined,
  renameOptions: CopyOptions['renameOptions'],
  isTopLevel: boolean,
): StepNamePlan {
  const finalName = applyFinalCopyName(sourceName ?? sourceId, renameOptions, isTopLevel);
  void workflowId;
  return {
    finalName,
    markerName: finalName,
  };
}

function markerCreateOptions(opts: CopyOptions & { targetAdAccountId?: string }): CopyOptions & { targetAdAccountId?: string } {
  return {
    ...opts,
    renameOptions: { rename_strategy: 'NO_RENAME' },
    statusOption: opts.statusOption ?? 'INHERITED_FROM_SOURCE',
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryOnlyError(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status === 429 || err.status >= 500 || (err.status === 409 && err.message.includes('leased'));
  }
  if (err instanceof MetaApiError) return err.isRateLimited;
  return false;
}

function isAmbiguousCreateError(err: unknown): boolean {
  if (err instanceof MetaApiError) {
    if (err.isTokenInvalid || err.isRateLimited || err.metaCode === 100) return false;
    return err.httpStatus >= 500 || err.metaCode === 1 || err.metaCode === 2;
  }
  if (err instanceof HttpError) return false;
  if (err instanceof TypeError) return true;
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    return (
      err.name === 'AbortError' ||
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('fetch failed') ||
      message.includes('network') ||
      message.includes('econnreset') ||
      message.includes('socket hang up')
    );
  }
  return false;
}

function comparable(value: unknown, field: string): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (field.endsWith('_time') || field === 'start_time' || field === 'stop_time' || field === 'end_time') {
    const ts = Date.parse(String(value));
    if (Number.isFinite(ts)) return new Date(ts).toISOString();
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    const numeric = Number(value);
    return Number.isFinite(numeric) && value.trim() !== '' ? String(numeric) : value;
  }
  return JSON.stringify(value);
}

function expectedBudgetValue(
  source: { daily_budget?: string; lifetime_budget?: string },
  opts: CopyOptions,
  field: 'daily_budget' | 'lifetime_budget',
  allowOverride: boolean,
): unknown {
  if (allowOverride && opts.dailyBudget !== undefined) {
    return field === 'daily_budget' ? opts.dailyBudget : undefined;
  }
  if (allowOverride && opts.lifetimeBudget !== undefined) {
    return field === 'lifetime_budget' ? opts.lifetimeBudget : undefined;
  }
  return source[field];
}

function expectedStartTime(sourceStartTime: string | undefined, opts: CopyOptions): string | undefined {
  if (opts.startTime) return opts.startTime;
  if (!sourceStartTime) return undefined;
  const ts = Date.parse(sourceStartTime);
  if (!Number.isFinite(ts)) return sourceStartTime;
  return ts > Date.now() ? sourceStartTime : undefined;
}

function expectedCopiedStatus(sourceStatus: string | undefined, opts: CopyOptions): 'ACTIVE' | 'PAUSED' {
  if (opts.statusOption === 'ACTIVE') return 'ACTIVE';
  if (opts.statusOption === 'PAUSED') return 'PAUSED';
  return sourceStatus === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
}

function expectedCopiedAdStatus(sourceStatus: string | undefined): 'ACTIVE' | 'PAUSED' {
  return sourceStatus === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function stepFinalName(step: StepRow | undefined, fallback: string): string {
  const metadata = stepMetadataRecord(step);
  return typeof metadata['finalName'] === 'string' ? metadata['finalName'] : fallback;
}

function pushMismatch(
  mismatches: FieldMismatch[],
  input: Omit<FieldMismatch, 'expected' | 'actual'> & { expected: unknown; actual: unknown },
): void {
  const expected = comparable(input.expected, input.field);
  const actual = comparable(input.actual, input.field);
  if (expected === actual) return;
  mismatches.push({ ...input, expected, actual });
}

function pushStartTimeMismatch(
  mismatches: FieldMismatch[],
  input: {
    type: 'campaign' | 'adset';
    sourceId: string;
    newId?: string;
    sourceStartTime?: string;
    opts: CopyOptions;
    actual: unknown;
  },
): void {
  const expected = expectedStartTime(input.sourceStartTime, input.opts);
  if (!expected) return;
  pushMismatch(mismatches, {
    type: input.type,
    sourceId: input.sourceId,
    ...(input.newId ? { newId: input.newId } : {}),
    field: 'start_time',
    expected,
    actual: input.actual,
  });
}

async function tryAcquireMetaRate(metaActId: string): Promise<{ allowed: boolean; waitMs: number }> {
  if (isFake()) return { allowed: true, waitMs: 0 };
  return acquire([
    {
      key: 'ratelimit:copy-v2:global',
      capacity: env.copyV2GlobalBurst,
      refillPerSec: env.copyV2GlobalQps,
    },
    {
      key: `ratelimit:copy-v2:adacct:${metaActId}`,
      capacity: env.copyV2AdAccountBurst,
      refillPerSec: env.copyV2AdAccountQps,
    },
  ]);
}

async function withMetaBudget<T>(metaActId: string, run: () => Promise<T>): Promise<T> {
  if (isFake()) return run();
  const key = 'concurrency:copy-v2:global';
  const deadline = Date.now() + 120_000;
  for (;;) {
    const lease = await acquireSemaphore(
      key,
      env.copyV2GlobalConcurrency,
      env.copyV2GlobalLeaseTtlMs,
    );
    if (!lease.allowed) {
      if (Date.now() + lease.waitMs > deadline) {
        throw new HttpError(429, 1002, 'copy v2 global concurrency saturated');
      }
      await sleep(Math.min(1000, Math.max(25, lease.waitMs)));
      continue;
    }
    const rate = await tryAcquireMetaRate(metaActId);
    if (!rate.allowed) {
      await releaseSemaphore(key, lease.token);
      if (Date.now() + rate.waitMs > deadline) {
        throw new HttpError(429, 1002, `copy v2 rate-limited wait ${rate.waitMs}ms`);
      }
      const jitter = Math.floor(Math.random() * 25);
      await sleep(Math.min(1000, Math.max(25, rate.waitMs + 10 + jitter)));
      continue;
    }
    try {
      return await run();
    } finally {
      await releaseSemaphore(key, lease.token);
    }
  }
}

async function buildPlan(msg: OperationMessage, token: string): Promise<CampaignCopyPlan> {
  const inspected = await meta.inspectCampaignForCopy(token, msg.targetId, {
    adConcurrency: env.copyV2InspectConcurrency,
    runRequest: (run) => withMetaBudget(msg.metaActId, run),
  });
  const adsetCount = inspected.adsets.length;
  const adCount = inspected.adsets.reduce((sum, item) => sum + item.ads.length, 0);
  const adsetPages = Math.max(1, Math.ceil(adsetCount / 100));
  const adPages = Math.max(1, Math.ceil(adCount / 100));
  const inspectRequests = 1 + adsetPages + adPages;
  const createRequests = 1 + adsetCount + adCount;
  const verifyRequests = env.copyV2VerifyEnabled ? inspectRequests : 0;
  return {
    ...inspected,
    adsetCount,
    adCount,
    estimatedRequests: inspectRequests + createRequests + verifyRequests,
  };
}

async function ensureWorkflow(msg: OperationMessage, plan: CampaignCopyPlan): Promise<WorkflowRow> {
  const state = workflowState(plan);
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    const inserted = await tx
      .insert(schema.operationCopyWorkflows)
      .values({
        taskId: msg.taskId,
        taskItemId: msg.itemId,
        companyId: msg.companyId,
        fbAccountId: msg.fbAccountId,
        adAccountId: msg.adAccountId,
        metaActId: msg.metaActId,
        sourceCampaignId: msg.targetId,
        status: 'running',
        phase: 'preflight',
        state,
        version: 0,
      })
      .onConflictDoUpdate({
        target: schema.operationCopyWorkflows.taskItemId,
        set: {
          status: 'running',
          phase: 'preflight',
          updatedAt: dsql`now()`,
        },
      })
      .returning({
        id: schema.operationCopyWorkflows.id,
        state: schema.operationCopyWorkflows.state,
        version: schema.operationCopyWorkflows.version,
      });
    return inserted;
  });
  const row = rows[0];
  if (!row) throw new Error('copy v2 workflow upsert returned no row');
  await ensureSteps(msg, row.id, plan);
  return {
    id: row.id,
    state: row.state as Record<string, unknown>,
    version: row.version,
  };
}

async function ensureSteps(
  msg: OperationMessage,
  workflowId: string,
  plan: CampaignCopyPlan,
): Promise<void> {
  const campaignStepKey = campaignStep(plan.campaign.id);
  const steps: StepInsert[] = [
    {
      workflowId,
      taskId: msg.taskId,
      taskItemId: msg.itemId,
      companyId: msg.companyId,
      stepKey: campaignStepKey,
      sourceType: 'campaign',
      sourceId: plan.campaign.id,
      metadata: { source: plan.campaign },
    },
  ];
  for (const item of plan.adsets) {
    const adsetKey = adsetStep(item.adset.id);
    steps.push({
      workflowId,
      taskId: msg.taskId,
      taskItemId: msg.itemId,
      companyId: msg.companyId,
      stepKey: adsetKey,
      sourceType: 'adset',
      sourceId: item.adset.id,
      parentStepKey: campaignStepKey,
      metadata: { source: item.adset, adCount: item.ads.length },
    });
    for (const ad of item.ads) {
      steps.push({
        workflowId,
        taskId: msg.taskId,
        taskItemId: msg.itemId,
        companyId: msg.companyId,
        stepKey: adStep(ad.id),
        sourceType: 'ad',
        sourceId: ad.id,
        parentStepKey: adsetKey,
        metadata: { source: ad },
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    for (let i = 0; i < steps.length; i += 500) {
      await tx
        .insert(schema.operationCopySteps)
        .values(steps.slice(i, i + 500))
        .onConflictDoNothing();
    }
  });
}

async function readStep(workflowId: string, stepKey: string): Promise<StepRow | undefined> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    return tx
      .select({
        id: schema.operationCopySteps.id,
        stepKey: schema.operationCopySteps.stepKey,
        sourceType: schema.operationCopySteps.sourceType,
        sourceId: schema.operationCopySteps.sourceId,
        status: schema.operationCopySteps.status,
        newId: schema.operationCopySteps.newId,
        leaseUntil: schema.operationCopySteps.leaseUntil,
        metadata: schema.operationCopySteps.metadata,
      })
      .from(schema.operationCopySteps)
      .where(and(
        eq(schema.operationCopySteps.workflowId, workflowId),
        eq(schema.operationCopySteps.stepKey, stepKey),
      ))
      .limit(1);
  });
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    stepKey: row.stepKey,
    sourceType: row.sourceType as SourceType,
    sourceId: row.sourceId,
    status: row.status,
    newId: row.newId,
    leaseUntil: row.leaseUntil,
    metadata: row.metadata,
  };
}

async function claimStep(stepId: string, workerId: string): Promise<boolean> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    return tx.execute(dsql`
      UPDATE operation_copy_steps
      SET status = 'running',
          lease_owner = ${workerId},
          lease_until = now() + interval '5 minutes',
          attempt = attempt + 1,
          updated_at = now()
      WHERE id = ${stepId}
        AND status IN ('pending','retrying','unknown','running')
        AND (lease_until IS NULL OR lease_until < now())
      RETURNING id
    `);
  }) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

async function markStepSuccess(stepId: string, newId: string, metadataPatch: Record<string, unknown> = {}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationCopySteps)
      .set({
        status: 'success',
        newId,
        metadata: dsql`${schema.operationCopySteps.metadata} || ${JSON.stringify(metadataPatch)}::jsonb`,
        leaseOwner: null,
        leaseUntil: null,
        error: null,
        updatedAt: dsql`now()`,
      })
      .where(eq(schema.operationCopySteps.id, stepId));
  });
}

async function markStepUnknown(stepId: string, error: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationCopySteps)
      .set({
        status: 'unknown',
        leaseOwner: null,
        leaseUntil: null,
        error,
        updatedAt: dsql`now()`,
      })
      .where(eq(schema.operationCopySteps.id, stepId));
  });
}

async function markStepRetrying(stepId: string, error: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationCopySteps)
      .set({
        status: 'retrying',
        leaseOwner: null,
        leaseUntil: null,
        error,
        updatedAt: dsql`now()`,
      })
      .where(eq(schema.operationCopySteps.id, stepId));
  });
}

async function markStepFailed(stepId: string, error: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationCopySteps)
      .set({
        status: 'failed',
        leaseOwner: null,
        leaseUntil: null,
        error,
        updatedAt: dsql`now()`,
      })
      .where(eq(schema.operationCopySteps.id, stepId));
  });
}

async function patchStepMetadata(stepId: string, metadataPatch: Record<string, unknown>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationCopySteps)
      .set({
        metadata: dsql`${schema.operationCopySteps.metadata} || ${JSON.stringify(metadataPatch)}::jsonb`,
        updatedAt: dsql`now()`,
      })
      .where(eq(schema.operationCopySteps.id, stepId));
  });
}

async function readWorkflowSteps(workflowId: string): Promise<StepRow[]> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    return tx
      .select({
        id: schema.operationCopySteps.id,
        stepKey: schema.operationCopySteps.stepKey,
        sourceType: schema.operationCopySteps.sourceType,
        sourceId: schema.operationCopySteps.sourceId,
        status: schema.operationCopySteps.status,
        newId: schema.operationCopySteps.newId,
        leaseUntil: schema.operationCopySteps.leaseUntil,
        metadata: schema.operationCopySteps.metadata,
      })
      .from(schema.operationCopySteps)
      .where(eq(schema.operationCopySteps.workflowId, workflowId));
  });
  return rows.map((row) => ({
    id: row.id,
    stepKey: row.stepKey,
    sourceType: row.sourceType as SourceType,
    sourceId: row.sourceId,
    status: row.status,
    newId: row.newId,
    leaseUntil: row.leaseUntil,
    metadata: row.metadata,
  }));
}

function progressState(plan: CampaignCopyPlan, steps: StepRow[]): Record<string, unknown> {
  const campaignStepRow = steps.find((step) => step.sourceType === 'campaign');
  return {
    campaign: campaignStepRow?.status ?? 'pending',
    adsetsTotal: plan.adsetCount,
    adsetsSuccess: steps.filter((step) => step.sourceType === 'adset' && step.status === 'success').length,
    adsTotal: plan.adCount,
    adsSuccess: steps.filter((step) => step.sourceType === 'ad' && step.status === 'success').length,
    unknownSteps: steps.filter((step) => step.status === 'unknown').length,
  };
}

function isLeaseExpired(leaseUntil: Date | null): boolean {
  if (!leaseUntil) return true;
  return new Date(leaseUntil).getTime() <= Date.now();
}

function shouldRecoverStepOutcome(step: StepRow): boolean {
  return step.status === 'unknown' || (step.status === 'running' && isLeaseExpired(step.leaseUntil));
}

async function updateWorkflowState(
  workflowId: string,
  plan: CampaignCopyPlan,
  phase: 'preflight' | 'create_campaign' | 'create_adsets' | 'create_ads' | 'verify' | 'repair' | 'restore_status' | 'done',
  patch: {
    status?: 'running' | 'waiting' | 'success' | 'partial' | 'failed' | 'paused' | 'canceled';
    newCampaignId?: string;
    fieldCheck?: Record<string, unknown>;
    errors?: string[];
    clearLease?: boolean;
  } = {},
): Promise<void> {
  const steps = await readWorkflowSteps(workflowId);
  const state = workflowState(plan);
  state['progress'] = progressState(plan, steps);
  if (patch.fieldCheck) state['fieldCheck'] = patch.fieldCheck;
  if (patch.errors) state['errors'] = patch.errors;

  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationCopyWorkflows)
      .set({
        ...(patch.newCampaignId ? { newCampaignId: patch.newCampaignId } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        phase,
        state,
        ...(patch.clearLease ? { leaseOwner: null, leaseUntil: null } : {}),
        ...(patch.status === 'success' ? { error: null } : {}),
        version: dsql`${schema.operationCopyWorkflows.version} + 1`,
        updatedAt: dsql`now()`,
      })
      .where(and(
        eq(schema.operationCopyWorkflows.id, workflowId),
        dsql`${schema.operationCopyWorkflows.status} <> 'canceled'`,
      ));
  });
}

async function executeCreateStep(
  workflowId: string,
  stepKey: string,
  workerId: string,
  namePlan: StepNamePlan,
  recover: (() => Promise<string | undefined>) | undefined,
  create: () => Promise<string>,
  finalize: (newId: string) => Promise<void> = async () => {},
): Promise<string> {
  const current = await readStep(workflowId, stepKey);
  if (!current) throw new Error(`copy v2 step missing: ${stepKey}`);
  if (current.status === 'success' && current.newId) {
    await finalize(current.newId);
    return current.newId;
  }

  if (current.status === 'unknown' && !recover) {
    throw new HttpError(409, 409, `copy v2 step outcome unknown, manual repair required: ${stepKey}`);
  }

  const shouldRecover = recover ? shouldRecoverStepOutcome(current) : false;
  const recoveredBeforeClaim = shouldRecover && recover ? await recover() : undefined;
  if (recoveredBeforeClaim) {
    await finalize(recoveredBeforeClaim);
    await markStepSuccess(current.id, recoveredBeforeClaim, {
      finalName: namePlan.finalName,
      markerName: namePlan.markerName,
      recovered: true,
    });
    return recoveredBeforeClaim;
  }

  if (current.status === 'failed') {
    throw new HttpError(409, 409, `copy v2 step failed: ${stepKey}`);
  }

  if (!await claimStep(current.id, workerId)) {
    const latest = await readStep(workflowId, stepKey);
    if (latest?.status === 'success' && latest.newId) {
      await finalize(latest.newId);
      return latest.newId;
    }
    throw new HttpError(429, 1002, `copy v2 step is leased: ${stepKey}`);
  }
  try {
    const recoveredAfterClaim = shouldRecover && recover ? await recover() : undefined;
    if (recoveredAfterClaim) {
      await finalize(recoveredAfterClaim);
      await markStepSuccess(current.id, recoveredAfterClaim, {
        finalName: namePlan.finalName,
        markerName: namePlan.markerName,
        recovered: true,
      });
      return recoveredAfterClaim;
    }
    const newId = await create();
    await finalize(newId);
    await markStepSuccess(current.id, newId, {
      finalName: namePlan.finalName,
      markerName: namePlan.markerName,
      recovered: false,
    });
    return newId;
  } catch (err) {
    if (isAmbiguousCreateError(err)) {
      await markStepUnknown(current.id, errorMessage(err));
    } else if (isRetryOnlyError(err)) {
      await markStepRetrying(current.id, errorMessage(err));
    } else {
      await markStepFailed(current.id, errorMessage(err));
    }
    throw err;
  }
}

async function updateWorkflowDone(
  workflowId: string,
  newCampaignId: string,
  plan: CampaignCopyPlan,
): Promise<void> {
  const state = workflowState(plan);
  state['progress'] = {
    campaign: 'success',
    adsetsTotal: plan.adsetCount,
    adsetsSuccess: plan.adsetCount,
    adsTotal: plan.adCount,
    adsSuccess: plan.adCount,
    unknownSteps: 0,
  };
  state['fieldCheck'] = {
    status: env.copyV2VerifyEnabled ? 'passed' : 'skipped',
    checkedAt: new Date().toISOString(),
    mismatches: [],
  };
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationCopyWorkflows)
      .set({
        newCampaignId,
        status: 'success',
        phase: 'done',
        state,
        leaseOwner: null,
        leaseUntil: null,
        error: null,
        version: dsql`${schema.operationCopyWorkflows.version} + 1`,
        updatedAt: dsql`now()`,
      })
      .where(and(
        eq(schema.operationCopyWorkflows.id, workflowId),
        dsql`${schema.operationCopyWorkflows.status} <> 'canceled'`,
      ));
  });
}

async function materializeCopyV2LocalSnapshots(
  msg: OperationMessage,
  workflowId: string,
  newCampaignId: string,
  plan: CampaignCopyPlan,
  opts: CopyOptions,
): Promise<void> {
  const steps = await readWorkflowSteps(workflowId);
  const stepByKey = new Map(steps.map((step) => [step.stepKey, step]));
  const now = new Date().toISOString();

  const campaignRow = stepByKey.get(campaignStep(plan.campaign.id));
  if (campaignRow?.status !== 'success' || campaignRow.newId !== newCampaignId) {
    throw new Error(`copy v2 local snapshot missing campaign step: ${plan.campaign.id}`);
  }

  const campaignStatus = expectedCopiedStatus(plan.campaign.status, opts);
  const campaignDailyBudget = optionalNumber(
    expectedBudgetValue(plan.campaign, opts, 'daily_budget', true),
  );
  const campaignLifetimeBudget = optionalNumber(
    expectedBudgetValue(plan.campaign, opts, 'lifetime_budget', true),
  );
  const campaignSnapshot: MetaCampaign = {
    id: newCampaignId,
    name: stepFinalName(
      campaignRow,
      stepNamePlan(workflowId, plan.campaign.id, plan.campaign.name, opts.renameOptions, true).finalName,
    ),
    status: campaignStatus,
    effectiveStatus: campaignStatus,
    ...(plan.campaign.objective ? { objective: plan.campaign.objective } : {}),
    ...(campaignDailyBudget !== undefined ? { dailyBudget: campaignDailyBudget } : {}),
    ...(campaignLifetimeBudget !== undefined ? { lifetimeBudget: campaignLifetimeBudget } : {}),
    ...(expectedStartTime(plan.campaign.start_time, opts)
      ? { startTime: expectedStartTime(plan.campaign.start_time, opts) }
      : {}),
    ...(opts.endTime ?? plan.campaign.stop_time ? { stopTime: opts.endTime ?? plan.campaign.stop_time } : {}),
    createdTime: now,
    updatedTime: now,
  };

  const adsetSnapshots: MetaAdSet[] = [];
  const adsByNewAdSet = new Map<string, MetaAd[]>();

  for (const { adset, ads } of plan.adsets) {
    const adsetRow = stepByKey.get(adsetStep(adset.id));
    if (adsetRow?.status !== 'success' || !adsetRow.newId) {
      throw new Error(`copy v2 local snapshot missing adset step: ${adset.id}`);
    }

    const adsetStatus = expectedCopiedStatus(adset.status, opts);
    const adsetDailyBudget = optionalNumber(expectedBudgetValue(adset, opts, 'daily_budget', false));
    const adsetLifetimeBudget = optionalNumber(expectedBudgetValue(adset, opts, 'lifetime_budget', false));
    const adsetStartTime = expectedStartTime(adset.start_time, opts);
    adsetSnapshots.push({
      id: adsetRow.newId,
      name: stepFinalName(
        adsetRow,
        stepNamePlan(workflowId, adset.id, adset.name, opts.renameOptions, false).finalName,
      ),
      status: adsetStatus,
      effectiveStatus: adsetStatus,
      campaignId: newCampaignId,
      ...(adsetDailyBudget !== undefined ? { dailyBudget: adsetDailyBudget } : {}),
      ...(adsetLifetimeBudget !== undefined ? { lifetimeBudget: adsetLifetimeBudget } : {}),
      ...(adset.optimization_goal ? { optimizationGoal: adset.optimization_goal } : {}),
      ...(adset.billing_event ? { billingEvent: adset.billing_event } : {}),
      ...(optionalNumber(adset.bid_amount) !== undefined ? { bidAmount: optionalNumber(adset.bid_amount)! } : {}),
      ...(adsetStartTime ? { startTime: adsetStartTime } : {}),
      ...(opts.endTime ?? adset.end_time ? { endTime: opts.endTime ?? adset.end_time } : {}),
      updatedTime: now,
    });

    const adSnapshots: MetaAd[] = [];
    for (const ad of ads) {
      const adRow = stepByKey.get(adStep(ad.id));
      if (adRow?.status !== 'success' || !adRow.newId) {
        throw new Error(`copy v2 local snapshot missing ad step: ${ad.id}`);
      }
      const adStatus = expectedCopiedAdStatus(ad.status);
      adSnapshots.push({
        id: adRow.newId,
        name: stepFinalName(
          adRow,
          stepNamePlan(workflowId, ad.id, ad.name, opts.renameOptions, false).finalName,
        ),
        status: adStatus,
        effectiveStatus: adStatus,
        adsetId: adsetRow.newId,
        campaignId: newCampaignId,
        ...(ad.creative?.id ? { creativeId: ad.creative.id } : {}),
        updatedTime: now,
      });
    }
    adsByNewAdSet.set(adsetRow.newId, adSnapshots);
  }

  await upsertCampaignSnapshots(msg.companyId, msg.adAccountId, [campaignSnapshot]);
  await upsertAdSetSnapshots(msg.companyId, msg.adAccountId, newCampaignId, adsetSnapshots);
  for (const [newAdSetId, rows] of adsByNewAdSet.entries()) {
    await upsertAdSnapshots(msg.companyId, msg.adAccountId, newAdSetId, rows);
  }
}

async function mapLimited<T, R>(
  items: T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, concurrency);
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let firstError: unknown;
  async function worker(): Promise<void> {
    for (;;) {
      if (firstError) return;
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await run(items[index]!, index);
      } catch (err) {
        firstError = err;
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function stepMetadataRecord(step: StepRow | undefined): Record<string, unknown> {
  return step?.metadata && typeof step.metadata === 'object'
    ? step.metadata as Record<string, unknown>
    : {};
}

function shouldRestoreStepName(step: StepRow | undefined, finalName: string): boolean {
  if (!step?.newId) return false;
  const metadata = stepMetadataRecord(step);
  const markerName = typeof metadata['markerName'] === 'string' ? metadata['markerName'] : '';
  const storedFinalName = typeof metadata['finalName'] === 'string' ? metadata['finalName'] : finalName;
  return Boolean(markerName && markerName !== storedFinalName);
}

async function restoreFinalNames(
  workflowId: string,
  token: string,
  metaActId: string,
  plan: CampaignCopyPlan,
  opts: CopyOptions,
): Promise<FieldMismatch[]> {
  const mismatches: FieldMismatch[] = [];
  const steps = await readWorkflowSteps(workflowId);
  const stepByKey = new Map(steps.map((step) => [step.stepKey, step]));
  const renameJobs: Array<{ stepId: string; type: SourceType; sourceId: string; newId: string; finalName: string }> = [];

  const campaignNames = stepNamePlan(workflowId, plan.campaign.id, plan.campaign.name, opts.renameOptions, true);
  const campaignRow = stepByKey.get(campaignStep(plan.campaign.id));
  if (shouldRestoreStepName(campaignRow, campaignNames.finalName)) {
    renameJobs.push({
      stepId: campaignRow!.id,
      type: 'campaign',
      sourceId: plan.campaign.id,
      newId: campaignRow!.newId!,
      finalName: campaignNames.finalName,
    });
  }

  for (const { adset, ads } of plan.adsets) {
    const adsetNames = stepNamePlan(workflowId, adset.id, adset.name, opts.renameOptions, false);
    const adsetRow = stepByKey.get(adsetStep(adset.id));
    if (shouldRestoreStepName(adsetRow, adsetNames.finalName)) {
      renameJobs.push({
        stepId: adsetRow!.id,
        type: 'adset',
        sourceId: adset.id,
        newId: adsetRow!.newId!,
        finalName: adsetNames.finalName,
      });
    }
    for (const ad of ads) {
      const adNames = stepNamePlan(workflowId, ad.id, ad.name, opts.renameOptions, false);
      const adRow = stepByKey.get(adStep(ad.id));
      if (shouldRestoreStepName(adRow, adNames.finalName)) {
        renameJobs.push({
          stepId: adRow!.id,
          type: 'ad',
          sourceId: ad.id,
          newId: adRow!.newId!,
          finalName: adNames.finalName,
        });
      }
    }
  }

  await mapLimited(renameJobs, env.copyV2AdConcurrency, async (job) => {
    try {
      await withMetaBudget(metaActId, () => meta.setObjectName(token, job.newId, job.finalName));
      await patchStepMetadata(job.stepId, {
        markerName: job.finalName,
        finalName: job.finalName,
        restoredNameAt: new Date().toISOString(),
      });
    } catch (err) {
      mismatches.push({
        type: job.type,
        sourceId: job.sourceId,
        newId: job.newId,
        field: 'name',
        expected: job.finalName,
        actual: undefined,
        reason: `rename failed: ${errorMessage(err)}`,
      });
    }
  });

  return mismatches;
}

function verifyCampaignFields(
  mismatches: FieldMismatch[],
  source: MetaCampaignRaw,
  target: MetaCampaignRaw,
  opts: CopyOptions,
  names: StepNamePlan,
): void {
  pushMismatch(mismatches, {
    type: 'campaign',
    sourceId: source.id,
    newId: target.id,
    field: 'name',
    expected: names.finalName,
    actual: target.name,
  });
  pushMismatch(mismatches, {
    type: 'campaign',
    sourceId: source.id,
    newId: target.id,
    field: 'status',
    expected: expectedCopiedStatus(source.status, opts),
    actual: target.status,
  });
  for (const field of ['daily_budget', 'lifetime_budget'] as const) {
    pushMismatch(mismatches, {
      type: 'campaign',
      sourceId: source.id,
      newId: target.id,
      field,
      expected: expectedBudgetValue(source, opts, field, true),
      actual: target[field],
    });
  }
  pushStartTimeMismatch(mismatches, {
    type: 'campaign',
    sourceId: source.id,
    newId: target.id,
    sourceStartTime: source.start_time,
    opts,
    actual: target.start_time,
  });
  pushMismatch(mismatches, {
    type: 'campaign',
    sourceId: source.id,
    newId: target.id,
    field: 'stop_time',
    expected: opts.endTime ?? source.stop_time,
    actual: target.stop_time,
  });
}

function verifyAdSetFields(
  mismatches: FieldMismatch[],
  source: MetaAdSetRaw,
  target: MetaAdSetRaw,
  opts: CopyOptions,
  names: StepNamePlan,
): void {
  pushMismatch(mismatches, {
    type: 'adset',
    sourceId: source.id,
    newId: target.id,
    field: 'name',
    expected: names.finalName,
    actual: target.name,
  });
  pushMismatch(mismatches, {
    type: 'adset',
    sourceId: source.id,
    newId: target.id,
    field: 'status',
    expected: expectedCopiedStatus(source.status, opts),
    actual: target.status,
  });
  for (const field of ['daily_budget', 'lifetime_budget'] as const) {
    pushMismatch(mismatches, {
      type: 'adset',
      sourceId: source.id,
      newId: target.id,
      field,
      expected: expectedBudgetValue(source, opts, field, false),
      actual: target[field],
    });
  }
  for (const field of [
    'daily_min_spend_target',
    'daily_spend_cap',
    'lifetime_min_spend_target',
    'lifetime_spend_cap',
    'optimization_goal',
    'billing_event',
    'bid_strategy',
    'bid_amount',
    'bid_constraints',
  ] as const) {
    pushMismatch(mismatches, {
      type: 'adset',
      sourceId: source.id,
      newId: target.id,
      field,
      expected: source[field],
      actual: target[field],
    });
  }
  pushStartTimeMismatch(mismatches, {
    type: 'adset',
    sourceId: source.id,
    newId: target.id,
    sourceStartTime: source.start_time,
    opts,
    actual: target.start_time,
  });
  pushMismatch(mismatches, {
    type: 'adset',
    sourceId: source.id,
    newId: target.id,
    field: 'end_time',
    expected: opts.endTime ?? source.end_time,
    actual: target.end_time,
  });
}

function verifyAdFields(
  mismatches: FieldMismatch[],
  source: MetaAdRaw,
  target: MetaAdRaw,
  names: StepNamePlan,
): void {
  const expectedStatus = source.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
  pushMismatch(mismatches, {
    type: 'ad',
    sourceId: source.id,
    newId: target.id,
    field: 'name',
    expected: names.finalName,
    actual: target.name,
  });
  pushMismatch(mismatches, {
    type: 'ad',
    sourceId: source.id,
    newId: target.id,
    field: 'status',
    expected: expectedStatus,
    actual: target.status,
  });
  pushMismatch(mismatches, {
    type: 'ad',
    sourceId: source.id,
    newId: target.id,
    field: 'bid_amount',
    expected: source.bid_amount,
    actual: target.bid_amount,
  });
}

async function verifyCreatedWorkflow(
  workflowId: string,
  token: string,
  metaActId: string,
  newCampaignId: string,
  plan: CampaignCopyPlan,
  opts: CopyOptions,
): Promise<FieldMismatch[]> {
  if (!env.copyV2VerifyEnabled) return [];

  const mismatches: FieldMismatch[] = [];
  const steps = await readWorkflowSteps(workflowId);
  const stepByKey = new Map(steps.map((step) => [step.stepKey, step]));
  const target = await meta.inspectCampaignForCopy(token, newCampaignId, {
    adConcurrency: env.copyV2VerifyConcurrency,
    runRequest: (run) => withMetaBudget(metaActId, run),
  });
  const targetAdsetsById = new Map(target.adsets.map((item) => [item.adset.id, item]));
  const targetAdsById = new Map<string, { adsetId: string; ad: MetaAdRaw }>();
  for (const item of target.adsets) {
    for (const ad of item.ads) {
      targetAdsById.set(ad.id, { adsetId: item.adset.id, ad });
    }
  }

  if (target.adsets.length !== plan.adsetCount) {
    mismatches.push({
      type: 'workflow',
      field: 'adset_count',
      expected: plan.adsetCount,
      actual: target.adsets.length,
    });
  }
  const targetAdCount = target.adsets.reduce((sum, item) => sum + item.ads.length, 0);
  if (targetAdCount !== plan.adCount) {
    mismatches.push({
      type: 'workflow',
      field: 'ad_count',
      expected: plan.adCount,
      actual: targetAdCount,
    });
  }

  verifyCampaignFields(
    mismatches,
    plan.campaign,
    target.campaign,
    opts,
    stepNamePlan(workflowId, plan.campaign.id, plan.campaign.name, opts.renameOptions, true),
  );

  for (const { adset, ads } of plan.adsets) {
    const adsetRow = stepByKey.get(adsetStep(adset.id));
    if (adsetRow?.status !== 'success' || !adsetRow.newId) {
      mismatches.push({
        type: 'adset',
        sourceId: adset.id,
        field: 'step_status',
        expected: 'success',
        actual: adsetRow?.status ?? 'missing',
      });
      continue;
    }
    const targetAdset = targetAdsetsById.get(adsetRow.newId);
    if (!targetAdset) {
      mismatches.push({
        type: 'adset',
        sourceId: adset.id,
        newId: adsetRow.newId,
        field: 'parent_campaign',
        expected: newCampaignId,
        actual: undefined,
        reason: 'new adset not found under new campaign',
      });
      continue;
    }
    verifyAdSetFields(
      mismatches,
      adset,
      targetAdset.adset,
      opts,
      stepNamePlan(workflowId, adset.id, adset.name, opts.renameOptions, false),
    );

    for (const ad of ads) {
      const adRow = stepByKey.get(adStep(ad.id));
      if (adRow?.status !== 'success' || !adRow.newId) {
        mismatches.push({
          type: 'ad',
          sourceId: ad.id,
          field: 'step_status',
          expected: 'success',
          actual: adRow?.status ?? 'missing',
        });
        continue;
      }
      const targetAd = targetAdsById.get(adRow.newId);
      if (!targetAd) {
        mismatches.push({
          type: 'ad',
          sourceId: ad.id,
          newId: adRow.newId,
          field: 'parent_adset',
          expected: adsetRow.newId,
          actual: undefined,
          reason: 'new ad not found under new campaign',
        });
        continue;
      }
      pushMismatch(mismatches, {
        type: 'ad',
        sourceId: ad.id,
        newId: adRow.newId,
        field: 'parent_adset',
        expected: adsetRow.newId,
        actual: targetAd.adsetId,
      });
      verifyAdFields(
        mismatches,
        ad,
        targetAd.ad,
        stepNamePlan(workflowId, ad.id, ad.name, opts.renameOptions, false),
      );
    }
  }

  return mismatches;
}

async function verifyCreatedWorkflowWithRetry(
  workflowId: string,
  token: string,
  metaActId: string,
  newCampaignId: string,
  plan: CampaignCopyPlan,
  opts: CopyOptions,
  taskId: string,
): Promise<FieldMismatch[]> {
  const attempts = Math.max(1, env.copyV2VerifyAttempts);
  const baseDelayMs = Math.max(0, env.copyV2VerifyRetryDelayMs);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const mismatches = await verifyCreatedWorkflow(workflowId, token, metaActId, newCampaignId, plan, opts);
    if (mismatches.length === 0) return [];
    if (attempt >= attempts || !shouldRetryVerifyMismatches(mismatches)) return mismatches;

    const delayMs = Math.min(30_000, baseDelayMs * attempt);
    console.warn(
      `[copy-v2-verify] retry workflow=${workflowId} attempt=${attempt}/${attempts} delayMs=${delayMs} mismatches=${mismatches.length}`,
    );
    if (delayMs > 0) await sleep(delayMs);
    await assertTaskRunnable(taskId);
  }

  return [];
}

function shouldRetryVerifyMismatches(mismatches: FieldMismatch[]): boolean {
  if (mismatches.length === 0) return false;
  if (mismatches.length > 25) return false;
  return mismatches.every(isEventuallyConsistentMismatch);
}

function isEventuallyConsistentMismatch(mismatch: FieldMismatch): boolean {
  if (mismatch.type === 'workflow' && (mismatch.field === 'adset_count' || mismatch.field === 'ad_count')) {
    const expected = Number(mismatch.expected);
    const actual = Number(mismatch.actual);
    return Number.isFinite(expected) && Number.isFinite(actual) && actual < expected;
  }
  if (
    (mismatch.field === 'parent_campaign' || mismatch.field === 'parent_adset') &&
    mismatch.actual === undefined
  ) {
    return true;
  }
  return false;
}

function v2CopyOptions(input: AsyncCopyInput): CopyOptions & { targetAdAccountId?: string } {
  return {
    deepCopy: false,
    ...(input.startTime ? { startTime: input.startTime } : {}),
    ...(input.endTime ? { endTime: input.endTime } : {}),
    ...(input.dailyBudget !== undefined ? { dailyBudget: input.dailyBudget } : {}),
    ...(input.lifetimeBudget !== undefined ? { lifetimeBudget: input.lifetimeBudget } : {}),
    statusOption: input.statusOption ?? 'INHERITED_FROM_SOURCE',
    ...(input.renameOptions ? { renameOptions: input.renameOptions } : {}),
    ...(input.targetAdAccountId ? { targetAdAccountId: input.targetAdAccountId } : {}),
  };
}

function campaignStep(sourceId: string): string {
  return `campaign:${sourceId}`;
}

function adsetStep(sourceId: string): string {
  return `adset:${sourceId}`;
}

function adStep(sourceId: string): string {
  return `ad:${sourceId}`;
}

export async function executeJsonbCampaignCopyV2(
  msg: OperationMessage,
  token: string,
  input: AsyncCopyInput,
): Promise<Record<string, unknown> | null> {
  if (!shouldTryV2(msg, input)) return null;

  const plan = await buildPlan(msg, token);
  if (!shouldRouteLargeCampaign(plan)) return null;

  const workflow = await ensureWorkflow(msg, plan);
  const workerId = `${process.pid}:${msg.itemId}`;
  const opts = v2CopyOptions(input);
  let phase: Parameters<typeof updateWorkflowState>[2] = 'create_campaign';
  let workflowSettled = false;

  try {
    await assertTaskRunnable(msg.taskId);
    await updateWorkflowState(workflow.id, plan, phase, { status: 'running' });
    const campaignNames = stepNamePlan(
      workflow.id,
      plan.campaign.id,
      plan.campaign.name,
      opts.renameOptions,
      true,
    );

    const newCampaignId = await executeCreateStep(
      workflow.id,
      campaignStep(plan.campaign.id),
      workerId,
      campaignNames,
      async () => {
        const found = await withMetaBudget(
          msg.metaActId,
          () => meta.findCampaignByName(token, opts.targetAdAccountId ?? msg.metaActId, campaignNames.markerName),
        );
        return found?.id;
      },
      async () => {
        const created = await withMetaBudget(msg.metaActId, () => meta.createCampaignFromSource(
          token,
          msg.metaActId,
          { ...plan.campaign, name: campaignNames.markerName },
          markerCreateOptions(opts),
        ));
        return created.newCampaignId;
      },
    );
    await updateWorkflowState(workflow.id, plan, phase, { status: 'running', newCampaignId });

    phase = 'create_adsets';
    await assertTaskRunnable(msg.taskId);
    await updateWorkflowState(workflow.id, plan, phase, { status: 'running', newCampaignId });
    const adsetIdBySource = new Map<string, string>();
    await mapLimited(plan.adsets, env.copyV2AdsetConcurrency, async ({ adset }) => {
      await assertTaskRunnable(msg.taskId);
      const adsetNames = stepNamePlan(workflow.id, adset.id, adset.name, opts.renameOptions, false);
      const newAdSetId = await executeCreateStep(
        workflow.id,
        adsetStep(adset.id),
        workerId,
        adsetNames,
        async () => {
          const found = await withMetaBudget(
            msg.metaActId,
            () => meta.findAdSetByName(token, newCampaignId, adsetNames.markerName),
          );
          return found?.id;
        },
        async () => {
          const created = await withMetaBudget(msg.metaActId, () => meta.createAdSetFromSource(
            token,
            msg.metaActId,
            { ...adset, name: adsetNames.markerName },
            newCampaignId,
            markerCreateOptions(opts),
            false,
          ));
          return created.newAdSetId;
        },
      );
      adsetIdBySource.set(adset.id, newAdSetId);
      return newAdSetId;
    });
    await updateWorkflowState(workflow.id, plan, phase, { status: 'running', newCampaignId });

    phase = 'restore_status';
    await assertTaskRunnable(msg.taskId);
    await updateWorkflowState(workflow.id, plan, phase, { status: 'running', newCampaignId });
    const adsetRenameMismatches = await restoreFinalNames(workflow.id, token, msg.metaActId, plan, opts);

    phase = 'create_ads';
    await assertTaskRunnable(msg.taskId);
    await updateWorkflowState(workflow.id, plan, phase, { status: 'running', newCampaignId });
    const adJobs = plan.adsets.flatMap(({ adset, ads }) => ads.map((ad) => ({ adset, ad })));
    await mapLimited(adJobs, env.copyV2AdConcurrency, async ({ adset, ad }) => {
      await assertTaskRunnable(msg.taskId);
      const parentAdSetId = adsetIdBySource.get(adset.id);
      if (!parentAdSetId) throw new Error(`copy v2 missing new adset id for ${adset.id}`);
      const adNames = stepNamePlan(workflow.id, ad.id, ad.name, opts.renameOptions, false);
      const newAdId = await executeCreateStep(
        workflow.id,
        adStep(ad.id),
        workerId,
        adNames,
        async () => {
          const found = await withMetaBudget(
            msg.metaActId,
            () => meta.findAdByName(token, parentAdSetId, adNames.markerName),
          );
          return found?.id;
        },
        async () => {
          const created = await withMetaBudget(msg.metaActId, () => meta.createAdFromSource(
            token,
            msg.metaActId,
            { ...ad, name: adNames.markerName },
            parentAdSetId,
            markerCreateOptions(opts),
            false,
          ));
          return created.newAdId;
        },
      );
      return newAdId;
    });
    await updateWorkflowState(workflow.id, plan, phase, { status: 'running', newCampaignId });

    phase = 'restore_status';
    await assertTaskRunnable(msg.taskId);
    await updateWorkflowState(workflow.id, plan, phase, { status: 'running', newCampaignId });
    const renameMismatches = [
      ...adsetRenameMismatches,
      ...await restoreFinalNames(workflow.id, token, msg.metaActId, plan, opts),
    ];

    phase = 'verify';
    await assertTaskRunnable(msg.taskId);
    await updateWorkflowState(workflow.id, plan, phase, { status: 'running', newCampaignId });
    const verifyMismatches = await verifyCreatedWorkflowWithRetry(
      workflow.id,
      token,
      msg.metaActId,
      newCampaignId,
      plan,
      opts,
      msg.taskId,
    );
    const mismatches = [...renameMismatches, ...verifyMismatches];
    if (mismatches.length > 0) {
      await updateWorkflowState(workflow.id, plan, 'verify', {
        status: 'partial',
        newCampaignId,
        fieldCheck: {
          status: 'failed',
          checkedAt: new Date().toISOString(),
          mismatches,
        },
        errors: [`copy v2 verification failed: ${mismatches.length} mismatches`],
        clearLease: true,
      });
      workflowSettled = true;
      throw new HttpError(
        409,
        409,
        `copy v2 verification failed: workflow=${workflow.id} mismatches=${mismatches.length}`,
      );
    }

    await materializeCopyV2LocalSnapshots(msg, workflow.id, newCampaignId, plan, opts);
    await updateWorkflowDone(workflow.id, newCampaignId, plan);
    workflowSettled = true;

    return {
      newId: newCampaignId,
      layer: 'campaign',
      fallback: 'jsonb_copy_v2',
      workflowId: workflow.id,
      adsetCount: plan.adsetCount,
      adCount: plan.adCount,
    };
  } catch (err) {
    if (workflowSettled) throw err;
    const status = err instanceof TaskCancelledError
      ? 'canceled'
      : err instanceof TaskPausedError
        ? 'paused'
        : isAmbiguousCreateError(err) || isRetryOnlyError(err)
          ? 'waiting'
          : 'failed';
    await updateWorkflowState(workflow.id, plan, phase, {
      status,
      errors: [errorMessage(err)],
      clearLease: true,
    });
    throw err;
  }
}
