/**
 * 单消息处理流程。被 consumer 调用。
 *
 * 步骤:
 *   1. 熔断检查 (fb_account / ad_account)
 *   2. 取操作锁 (targetId)
 *   3. item 状态查重 (idempotency)
 *   4. 令牌桶 acquire (账户+全局)
 *   5. 取并解密 token
 *   6. provider 调 Meta (或 fake)
 *   7. 写 item.success + task counter++ + Redis 进度
 *   错误分类:
 *     - 限流  → adjustHeaders + openBreaker(60s) + retry
 *     - token 失效 → markTokenInvalid + open(fbAccount, ∞) + item failed
 *     - 瞬时 → attempts++ + retry
 *     - 达 max → dead + item.status='dead'
 */
import { eq, inArray, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../api/src/lib/db';
import { decryptToken } from '../../api/src/lib/crypto';
import { redis } from '../../api/src/lib/redis';
import { acquire, DEFAULT_BUCKETS } from '../../api/src/lib/rate-limit';
import { BreakerKey, isOpen, openFor } from '../../api/src/lib/breaker';
import { acquireOpLock } from '../../api/src/lib/op-lock';
import { bumpProgress, setRunning } from '../../api/src/lib/progress';
import { metaProvider } from '../../api/src/providers/meta';
import {
  meta,
  MetaApiError,
  type AsyncCopyInput,
  type MetaObjectOwnership,
} from '../../api/src/lib/meta-client';
import { HttpError } from '../../api/src/lib/http-error';
import { env } from '../../api/src/env';
import {
  markLocalBudget,
  markLocalDeleted,
  markLocalStatus,
  upsertLocalCopyPlaceholder,
} from '../../api/src/modules/ad-object/local-store';
import {
  RMQ,
  publishRetry,
  publishDead,
  type OperationCopyBatchItem,
  type OperationMessage,
} from '../../api/src/lib/rabbitmq-topology';
import { isFake, runFake } from './fake-meta';
import { executeJsonbCampaignCopyV2 } from './copy-v2-jsonb';
import {
  assertTaskRunnable,
  TaskCancelledError,
  TaskPausedError,
} from './task-control';

export type Outcome =
  | { kind: 'ack' }
  | { kind: 'retry'; reason: string; bumpAttempt?: boolean }
  | { kind: 'dead'; reason: string };

interface AsyncCopyState {
  kind: 'meta_async_copy';
  requestSetId: string;
  submittedAt: number;
  polls: number;
  requests: AsyncCopyStateRequest[];
}

interface AsyncCopyStateRequest {
  itemId: string;
  requestName: string;
  targetType: 'campaign' | 'adset' | 'ad';
}

const SYNC_COPY_CHILD_AD_LIMIT = 3;
const ASYNC_COPY_CHILD_AD_LIMIT = 51;

interface BatchHandledResult extends Record<string, unknown> {
  __batchHandled: true;
}

class AsyncCopyPending extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsyncCopyPending';
  }
}

function isCopyAction(msg: OperationMessage): boolean {
  return msg.action.endsWith(':copy');
}

function copyItemsForMessage(msg: OperationMessage): OperationCopyBatchItem[] {
  if (msg.copyBatch?.length) return msg.copyBatch;
  return [
    {
      itemId: msg.itemId,
      targetType: msg.targetType,
      targetId: msg.targetId,
      params: msg.params,
      idempotencyKey: msg.idempotencyKey,
    },
  ];
}

function messageForCopyItem(
  msg: OperationMessage,
  item: OperationCopyBatchItem,
): OperationMessage {
  const { copyBatch: _copyBatch, ...base } = msg;
  void _copyBatch;
  return {
    ...base,
    itemId: item.itemId,
    targetType: item.targetType,
    targetId: item.targetId,
    params: item.params,
    idempotencyKey: item.idempotencyKey,
  };
}

function isTerminalStatus(status: string | null | undefined): boolean {
  return status === 'success' || status === 'failed' || status === 'dead';
}

function isBatchHandled(result: Record<string, unknown> | undefined): result is BatchHandledResult {
  return result?.['__batchHandled'] === true;
}

async function readItemStatus(itemId: string): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    const rows = await tx
      .select({ status: schema.operationTaskItems.status })
      .from(schema.operationTaskItems)
      .where(eq(schema.operationTaskItems.id, itemId))
      .limit(1);
    return rows[0]?.status;
  });
}

async function acquireTargetLocks(targetIds: string[]): Promise<Array<{ release(): Promise<void> }> | null> {
  const locks: Array<{ release(): Promise<void> }> = [];
  for (const targetId of Array.from(new Set(targetIds))) {
    const lock = await acquireOpLock(targetId, 30);
    if (!lock) {
      await Promise.allSettled(locks.map((item) => item.release()));
      return null;
    }
    locks.push(lock);
  }
  return locks;
}

export async function handle(msg: OperationMessage): Promise<Outcome> {
  // 1. 熔断
  const breakers = [
    BreakerKey.fbAccount(msg.fbAccountId),
    BreakerKey.adAccount(msg.metaActId),
  ];
  for (const k of breakers) {
    if (await isOpen(k)) {
      // 软延后,不计入 attempts
      return { kind: 'retry', reason: `breaker open: ${k}`, bumpAttempt: false };
    }
  }

  // 2. 操作锁
  const lockItems = msg.copyBatch?.length ? msg.copyBatch : [{ targetId: msg.targetId }];
  const locks = await acquireTargetLocks(lockItems.map((item) => item.targetId));
  if (!locks) {
    return { kind: 'retry', reason: 'another op on same target', bumpAttempt: false };
  }

  try {
    // 3. item 查重 (幂等)
    const cur = await db.transaction(async (tx) => {
      await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
      const r = await tx
        .select()
        .from(schema.operationTaskItems)
        .where(eq(schema.operationTaskItems.id, msg.itemId))
        .limit(1);
      return r[0];
    });
    if (!cur) return { kind: 'ack' };
    if (cur.status === 'success' || cur.status === 'failed' || cur.status === 'dead') {
      return { kind: 'ack' };
    }
    try {
      await assertTaskRunnable(msg.taskId);
    } catch (err) {
      if (err instanceof TaskPausedError) {
        return { kind: 'retry', reason: err.message, bumpAttempt: false };
      }
      if (err instanceof TaskCancelledError) {
        return { kind: 'ack' };
      }
      throw err;
    }

    // 4. 令牌桶（fake 模式不打真 Meta，跳过）
    if (!isFake()) {
      const rate = await acquire([
        DEFAULT_BUCKETS.app(),
        DEFAULT_BUCKETS.adAccount(msg.metaActId),
      ]);
      if (!rate.allowed) {
        return { kind: 'retry', reason: `rate-limited wait ${rate.waitMs}ms`, bumpAttempt: false };
      }
    }

    // 5. token (fake 模式跳过)
    let token = '';
    if (!isFake()) {
      const cacheKey = `token:${msg.fbAccountId}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        token = cached;
      } else {
        const fbRow = await db.transaction(async (tx) => {
          await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
          const r = await tx
            .select({
              enc: schema.fbAccounts.accessTokenEnc,
              status: schema.fbAccounts.status,
            })
            .from(schema.fbAccounts)
            .where(eq(schema.fbAccounts.id, msg.fbAccountId))
            .limit(1);
          return r[0];
        });
        if (!fbRow) {
          await failItem(msg, 'fb_account not found');
          return { kind: 'dead', reason: 'fb_account missing' };
        }
        if (fbRow.status !== 'active') {
          await failItem(msg, `fb_account status ${fbRow.status}`);
          await openFor(BreakerKey.fbAccount(msg.fbAccountId), 0, fbRow.status);
          return { kind: 'dead', reason: `fb_account ${fbRow.status}` };
        }
        token = decryptToken(fbRow.enc);
        await redis.set(cacheKey, token, 'EX', 300);
      }
    }

    // mark running
    await setRunning(msg.taskId);

    // 6. provider 调用
    let result: Record<string, unknown> | undefined;
    try {
      if (isFake()) {
        await runFake(msg.action);
        // fake 模式产出假 result 让前端能看到新 id
        if (msg.action.endsWith(':copy')) {
          const layer = msg.action.split(':')[0];
          result = { newId: `fake_copy_of_${msg.targetId}`, layer };
        }
      } else if (msg.copyBatch && msg.copyBatch.length > 1) {
        result = await executeCustomCopyBatchProvider(
          msg,
          token,
          copyItemsForMessage(msg),
        );
      } else {
        result = await executeProvider(msg, token);
      }
    } catch (err) {
      if (err instanceof AsyncCopyPending) {
        return { kind: 'retry', reason: err.message, bumpAttempt: false };
      }
      if (err instanceof TaskPausedError) {
        return { kind: 'retry', reason: err.message, bumpAttempt: false };
      }
      if (err instanceof TaskCancelledError) {
        return { kind: 'ack' };
      }
      return await handleErr(msg, err, msg.copyBatch);
    }

    if (isBatchHandled(result)) return { kind: 'ack' };

    await writeLocalBestEffort(msg, token, result);

    // 7. 成功
    await markSuccess(msg, result);
    await bumpProgress(msg.taskId, { success: 1 });
    return { kind: 'ack' };
  } finally {
    await Promise.allSettled(locks.map((lock) => lock.release()));
  }
}

async function executeProvider(
  msg: OperationMessage,
  token: string,
): Promise<Record<string, unknown> | undefined> {
  const [layer, op] = msg.action.split(':') as [
    'campaign' | 'adset' | 'ad',
    'status' | 'budget' | 'copy' | 'delete',
  ];

  await assertMessageTargetOwnership(msg, token);

  if (op === 'status') {
    const status = msg.params['status'] as 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETED';
    await metaProvider.setStatus(token, {
      adAccountId: msg.metaActId,
      targetId: msg.targetId,
      targetType: layer,
      status,
    });
    return undefined;
  }

  if (op === 'budget') {
    if (layer === 'ad') throw new Error('ad 层无 budget 操作');
    const daily = msg.params['dailyBudget'];
    const life = msg.params['lifetimeBudget'];
    await metaProvider.setBudget(token, {
      adAccountId: msg.metaActId,
      targetId: msg.targetId,
      targetType: layer,
      ...(typeof daily === 'number' ? { dailyBudget: daily } : {}),
      ...(typeof life === 'number' ? { lifetimeBudget: life } : {}),
    });
    return undefined;
  }

  if (op === 'copy') {
    const deepCopy = msg.params['deepCopy'];
    const startTime = msg.params['startTime'];
    const endTime = msg.params['endTime'];
    const dailyBudget = msg.params['dailyBudget'];
    const lifetimeBudget = msg.params['lifetimeBudget'];
    const statusOption = msg.params['statusOption'];
    const targetAdAccountId = msg.params['targetAdAccountId'];
    const targetCampaignId = msg.params['targetCampaignId'];
    const targetAdSetId = msg.params['targetAdSetId'];
    const renameOptionsRaw = msg.params['renameOptions'] as
      | Record<string, string>
      | undefined;
    const copyIndex = msg.params['_copyIndex'];
    // 把 _copyIndex 附加到 rename_suffix(让 N 份命名不冲突)
    let renameOptions = renameOptionsRaw;
    if (typeof copyIndex === 'number' && copyIndex > 0) {
      const baseSuffix = renameOptionsRaw?.['rename_suffix'] ?? '';
      renameOptions = {
        ...(renameOptionsRaw ?? {}),
        rename_suffix: `${baseSuffix}-${String(copyIndex).padStart(2, '0')}`,
      };
    }
    const input: AsyncCopyInput = {
      sourceId: msg.targetId,
      targetType: layer,
      ...(typeof deepCopy === 'boolean' ? { deepCopy } : {}),
      ...(typeof startTime === 'string' ? { startTime } : {}),
      ...(typeof endTime === 'string' ? { endTime } : {}),
      ...(typeof dailyBudget === 'number' ? { dailyBudget } : {}),
      ...(typeof lifetimeBudget === 'number' ? { lifetimeBudget } : {}),
      ...(typeof statusOption === 'string'
        ? { statusOption: statusOption as 'ACTIVE' | 'PAUSED' | 'INHERITED_FROM_SOURCE' }
        : {}),
      ...(typeof targetAdAccountId === 'string' ? { targetAdAccountId } : {}),
      ...(typeof targetCampaignId === 'string' ? { targetCampaignId } : {}),
      ...(typeof targetAdSetId === 'string' ? { targetAdSetId } : {}),
      ...(renameOptions ? { renameOptions } : {}),
      requestName: `${msg.taskId}_${msg.itemId}`,
    };
    return await executeCustomCopyProvider(msg, token, input);
  }

  if (op === 'delete') {
    const hard = msg.params['hard'] === true;
    await metaProvider.remove(token, {
      adAccountId: msg.metaActId,
      targetId: msg.targetId,
      targetType: layer,
      hard,
    });
    return undefined;
  }

  throw new Error(`unknown action: ${msg.action}`);
}

function asyncCopyRequestName(itemId: string): string {
  return `copy_${itemId.replace(/-/g, '')}`;
}

function buildAsyncCopyInput(msg: OperationMessage, requestName?: string): AsyncCopyInput {
  const [layer] = msg.action.split(':') as ['campaign' | 'adset' | 'ad', string];
  const deepCopy = msg.params['deepCopy'];
  const startTime = msg.params['startTime'];
  const endTime = msg.params['endTime'];
  const dailyBudget = msg.params['dailyBudget'];
  const lifetimeBudget = msg.params['lifetimeBudget'];
  const statusOption = msg.params['statusOption'];
  const targetAdAccountId = msg.params['targetAdAccountId'];
  const targetCampaignId = msg.params['targetCampaignId'];
  const targetAdSetId = msg.params['targetAdSetId'];
  const renameOptionsRaw = msg.params['renameOptions'] as Record<string, string> | undefined;
  const copyIndex = msg.params['_copyIndex'];
  let renameOptions = renameOptionsRaw;
  if (typeof copyIndex === 'number' && copyIndex > 0) {
    const baseSuffix = renameOptionsRaw?.['rename_suffix'] ?? '';
    renameOptions = {
      ...(renameOptionsRaw ?? {}),
      rename_suffix: `${baseSuffix}-${String(copyIndex).padStart(2, '0')}`,
    };
  }
  return {
    sourceId: msg.targetId,
    targetType: layer,
    ...(typeof deepCopy === 'boolean' ? { deepCopy } : {}),
    ...(typeof startTime === 'string' ? { startTime } : {}),
    ...(typeof endTime === 'string' ? { endTime } : {}),
    ...(typeof dailyBudget === 'number' ? { dailyBudget } : {}),
    ...(typeof lifetimeBudget === 'number' ? { lifetimeBudget } : {}),
    ...(typeof statusOption === 'string'
      ? { statusOption: statusOption as 'ACTIVE' | 'PAUSED' | 'INHERITED_FROM_SOURCE' }
      : {}),
    ...(typeof targetAdAccountId === 'string' ? { targetAdAccountId } : {}),
    ...(typeof targetCampaignId === 'string' ? { targetCampaignId } : {}),
    ...(typeof targetAdSetId === 'string' ? { targetAdSetId } : {}),
    ...(renameOptions ? { renameOptions } : {}),
    ...(requestName ? { requestName } : {}),
  };
}

async function executeAsyncCopyProvider(
  msg: OperationMessage,
  token: string,
  input: AsyncCopyInput,
): Promise<Record<string, unknown>> {
  const existing = await readAsyncCopyState(msg.itemId);
  let state = existing;
  if (!state) {
    try {
      state = await submitAsyncCopy(msg, token, input);
    } catch (err) {
      if (isAdbatchTooFewError(err)) {
        return await executeSyncCopyFallback(msg, token, input);
      }
      throw err;
    }
  }

  if (Date.now() - state.submittedAt > env.metaAsyncCopyTimeoutMs) {
    await clearAsyncCopyState(msg.itemId);
    throw new HttpError(
      409,
      409,
      `Meta async copy timeout: request_set=${state.requestSetId}`,
    );
  }

  const requestName = state.requests[0]?.requestName ?? input.requestName ?? 'copy';
  const result = await meta.pollAsyncCopy(
    token,
    state.requestSetId,
    input.targetType,
    requestName,
  );
  if (result.status === 'pending') {
    await saveAsyncCopyState(msg, { ...state, polls: state.polls + 1 });
    throw new AsyncCopyPending(`meta async copy pending: request_set=${state.requestSetId}`);
  }

  await clearAsyncCopyState(msg.itemId);
  if (result.status === 'failed') {
    throw new HttpError(
      409,
      409,
      result.error ?? `Meta async copy failed: request_set=${state.requestSetId}`,
    );
  }
  if (!result.newId) {
    throw new MetaApiError(
      500,
      undefined,
      undefined,
      undefined,
      undefined,
      `Meta async copy completed without copied id: request_set=${state.requestSetId}`,
    );
  }
  return {
    newId: result.newId,
    layer: input.targetType,
    asyncRequestSetId: state.requestSetId,
  };
}

function isAdbatchTooFewError(err: unknown): boolean {
  return (
    err instanceof MetaApiError &&
    err.metaCode === 194 &&
    err.message.toLowerCase().includes('adbatch') &&
    err.message.toLowerCase().includes('too few')
  );
}

function isAsyncRelativeUrlInvalid(err: unknown): boolean {
  return (
    err instanceof MetaApiError &&
    err.message.toLowerCase().includes('relative_url')
  );
}

function isMetaPermanentParameterError(err: MetaApiError): boolean {
  return err.metaCode === 100;
}

function copyChildLimitExceededMessage(
  mode: 'sync' | 'async',
  input: AsyncCopyInput,
  childAdCount: number,
): string {
  const limit = mode === 'async' ? ASYNC_COPY_CHILD_AD_LIMIT : SYNC_COPY_CHILD_AD_LIMIT;
  return [
    `Meta ${mode} copy limit exceeded for ${input.targetType} ${input.sourceId}:`,
    `deep copy would copy ${childAdCount} child ads, limit is ${limit}.`,
  ].join(' ');
}

async function assertAsyncCopyChildAdLimit(
  token: string,
  input: AsyncCopyInput,
): Promise<void> {
  const childAdCount = await meta.countCopiedChildAds(
    token,
    input,
    ASYNC_COPY_CHILD_AD_LIMIT + 1,
  );
  if (childAdCount > ASYNC_COPY_CHILD_AD_LIMIT) {
    throw new HttpError(422, 422, copyChildLimitExceededMessage('async', input, childAdCount));
  }
}

async function assertAsyncCopyInputsChildAdLimit(
  token: string,
  inputs: AsyncCopyInput[],
): Promise<void> {
  const checked = new Map<string, number>();
  for (const input of inputs) {
    const key = `${input.targetType}:${input.sourceId}:${input.deepCopy !== false}`;
    const childAdCount = checked.get(key) ?? await meta.countCopiedChildAds(
      token,
      input,
      ASYNC_COPY_CHILD_AD_LIMIT + 1,
    );
    checked.set(key, childAdCount);
    if (childAdCount > ASYNC_COPY_CHILD_AD_LIMIT) {
      throw new HttpError(422, 422, copyChildLimitExceededMessage('async', input, childAdCount));
    }
  }
}

async function canFallbackToSyncCopy(
  token: string,
  input: AsyncCopyInput,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const childAdCount = await meta.countCopiedChildAds(
    token,
    input,
    SYNC_COPY_CHILD_AD_LIMIT + 1,
  );
  if (childAdCount > SYNC_COPY_CHILD_AD_LIMIT) {
    return {
      ok: false,
      reason: [
        'Meta rejected async copy, and sync fallback is unsafe:',
        copyChildLimitExceededMessage('sync', input, childAdCount),
      ].join(' '),
    };
  }
  return { ok: true };
}

async function executeSyncCopyFallback(
  msg: OperationMessage,
  token: string,
  input: AsyncCopyInput,
): Promise<Record<string, unknown>> {
  const syncFallback = await canFallbackToSyncCopy(token, input);
  if (!syncFallback.ok) {
    throw new HttpError(409, 409, syncFallback.reason);
  }
  console.warn(
    `[meta-async-copy] single request rejected by async batch; falling back to sync copy task=${msg.taskId} item=${msg.itemId}`,
  );
  const result = await metaProvider.copy(token, {
    adAccountId: msg.metaActId,
    sourceId: input.sourceId,
    targetType: input.targetType,
    ...(input.targetAdAccountId ? { targetAdAccountId: input.targetAdAccountId } : {}),
    ...(input.targetCampaignId ? { targetCampaignId: input.targetCampaignId } : {}),
    ...(input.targetAdSetId ? { targetAdSetId: input.targetAdSetId } : {}),
    ...(input.deepCopy !== undefined ? { deepCopy: input.deepCopy } : {}),
    ...(input.startTime ? { startTime: input.startTime } : {}),
    ...(input.endTime ? { endTime: input.endTime } : {}),
    ...(input.dailyBudget !== undefined ? { dailyBudget: input.dailyBudget } : {}),
    ...(input.lifetimeBudget !== undefined ? { lifetimeBudget: input.lifetimeBudget } : {}),
    ...(input.statusOption ? { statusOption: input.statusOption } : {}),
    ...(input.renameOptions ? { renameOptions: input.renameOptions } : {}),
  });
  return {
    newId: result.newId,
    layer: input.targetType,
    fallback: 'sync_copy',
  };
}

async function executeCustomCopyProvider(
  msg: OperationMessage,
  token: string,
  input: AsyncCopyInput,
): Promise<Record<string, unknown>> {
  const v2Result = await executeJsonbCampaignCopyV2(msg, token, input);
  if (v2Result) return v2Result;

  const result = await metaProvider.copy(token, {
    adAccountId: msg.metaActId,
    sourceId: input.sourceId,
    targetType: input.targetType,
    ...(input.targetAdAccountId ? { targetAdAccountId: input.targetAdAccountId } : {}),
    ...(input.targetCampaignId ? { targetCampaignId: input.targetCampaignId } : {}),
    ...(input.targetAdSetId ? { targetAdSetId: input.targetAdSetId } : {}),
    ...(input.deepCopy !== undefined ? { deepCopy: input.deepCopy } : {}),
    ...(input.startTime ? { startTime: input.startTime } : {}),
    ...(input.endTime ? { endTime: input.endTime } : {}),
    ...(input.dailyBudget !== undefined ? { dailyBudget: input.dailyBudget } : {}),
    ...(input.lifetimeBudget !== undefined ? { lifetimeBudget: input.lifetimeBudget } : {}),
    ...(input.statusOption ? { statusOption: input.statusOption } : {}),
    ...(input.renameOptions ? { renameOptions: input.renameOptions } : {}),
  });
  return {
    newId: result.newId,
    layer: input.targetType,
    fallback: 'custom_create_copy',
  };
}

async function executeCustomCopyBatchProvider(
  msg: OperationMessage,
  token: string,
  copyItems: OperationCopyBatchItem[],
): Promise<BatchHandledResult> {
  console.warn(`[meta-custom-copy-batch] sequential copy task=${msg.taskId} count=${copyItems.length}`);
  for (const item of copyItems) {
    const itemMsg = messageForCopyItem(msg, item);
    const status = await readItemStatus(item.itemId);
    if (isTerminalStatus(status)) continue;

    try {
      const result = await executeProvider(itemMsg, token);
      await writeLocalBestEffort(itemMsg, token, result);
      await markSuccess(itemMsg, result);
      await bumpProgress(itemMsg.taskId, { success: 1 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failItem(itemMsg, message);
      await bumpProgress(itemMsg.taskId, { failed: 1 });
    }
  }
  return { __batchHandled: true };
}

async function executeAsyncCopyBatchProvider(
  msg: OperationMessage,
  token: string,
  copyItems: OperationCopyBatchItem[],
  activeItems: OperationCopyBatchItem[],
): Promise<BatchHandledResult> {
  for (const item of activeItems) {
    await assertMessageTargetOwnership(messageForCopyItem(msg, item), token);
  }

  const itemIds = activeItems.map((item) => item.itemId);
  const existing = await readAsyncCopyStateForItems(itemIds);
  let state = existing;
  if (!state) {
    try {
      state = await submitAsyncCopyBatch(msg, token, activeItems);
    } catch (err) {
      if (isAsyncRelativeUrlInvalid(err)) {
        return await executeGraphBatchCopyProvider(msg, token, activeItems);
      }
      throw err;
    }
  }

  if (Date.now() - state.submittedAt > env.metaAsyncCopyTimeoutMs) {
    await clearAsyncCopyStateForItems(itemIds);
    throw new HttpError(
      409,
      409,
      `Meta async copy timeout: request_set=${state.requestSetId}`,
    );
  }

  const poll = await meta.pollAsyncCopyBatch(
    token,
    state.requestSetId,
    state.requests.map((request) => ({
      requestName: request.requestName,
      targetType: request.targetType,
    })),
  );
  if (Object.values(poll).some((result) => result.status === 'pending')) {
    await saveAsyncCopyStateForItems(msg, itemIds, { ...state, polls: state.polls + 1 });
    throw new AsyncCopyPending(`meta async copy pending: request_set=${state.requestSetId}`);
  }

  await clearAsyncCopyStateForItems(itemIds);
  const itemById = new Map(copyItems.map((item) => [item.itemId, item]));
  const activeIds = new Set(itemIds);
  for (const request of state.requests) {
    if (!activeIds.has(request.itemId)) continue;
    const item = itemById.get(request.itemId);
    if (!item) continue;
    const itemMsg = messageForCopyItem(msg, item);
    const result = poll[request.requestName];
    if (result?.status === 'success' && result.newId) {
      const payload = {
        newId: result.newId,
        layer: request.targetType,
        asyncRequestSetId: state.requestSetId,
      };
      await writeLocalBestEffort(itemMsg, token, payload);
      await markSuccess(itemMsg, payload);
      await bumpProgress(itemMsg.taskId, { success: 1 });
    } else {
      await failItem(
        itemMsg,
        result?.error ?? `Meta async copy failed: request_set=${state.requestSetId}`,
      );
      await bumpProgress(itemMsg.taskId, { failed: 1 });
    }
  }
  return { __batchHandled: true };
}

async function executeGraphBatchCopyProvider(
  msg: OperationMessage,
  token: string,
  activeItems: OperationCopyBatchItem[],
): Promise<BatchHandledResult> {
  console.warn(
    `[meta-copy-batch] async request set rejected relative_url; falling back to Graph batch task=${msg.taskId} count=${activeItems.length}`,
  );
  const syncEligibleItems: OperationCopyBatchItem[] = [];
  for (const item of activeItems) {
    const itemMsg = messageForCopyItem(msg, item);
    const input = buildAsyncCopyInput(itemMsg, asyncCopyRequestName(item.itemId));
    const syncFallback = await canFallbackToSyncCopy(token, input);
    if (syncFallback.ok) {
      syncEligibleItems.push(item);
      continue;
    }
    await failItem(itemMsg, syncFallback.reason);
    await bumpProgress(itemMsg.taskId, { failed: 1 });
  }

  const chunkSize = 3;
  for (let offset = 0; offset < syncEligibleItems.length; offset += chunkSize) {
    const chunk = syncEligibleItems.slice(offset, offset + chunkSize);
    const inputs = chunk.map((item) => {
      const itemMsg = messageForCopyItem(msg, item);
      return buildAsyncCopyInput(itemMsg, asyncCopyRequestName(item.itemId));
    });
    const results = await meta.copyBatch(token, inputs);
    for (const [index, item] of chunk.entries()) {
      const input = inputs[index]!;
      const requestName = input.requestName ?? asyncCopyRequestName(item.itemId);
      const itemMsg = messageForCopyItem(msg, item);
      const result = results[requestName];
      if (result?.status === 'success' && result.newId) {
        const payload = {
          newId: result.newId,
          layer: input.targetType,
          fallback: 'graph_batch_copy',
        };
        await writeLocalBestEffort(itemMsg, token, payload);
        await markSuccess(itemMsg, payload);
        await bumpProgress(itemMsg.taskId, { success: 1 });
      } else {
        await failItem(itemMsg, result?.error ?? 'Meta Graph batch copy failed');
        await bumpProgress(itemMsg.taskId, { failed: 1 });
      }
    }
  }
  return { __batchHandled: true };
}

async function submitAsyncCopy(
  msg: OperationMessage,
  token: string,
  input: AsyncCopyInput,
): Promise<AsyncCopyState> {
  await assertAsyncCopyChildAdLimit(token, input);
  const submitted = await meta.submitAsyncCopy(token, msg.metaActId, input);
  const state: AsyncCopyState = {
    kind: 'meta_async_copy',
    requestSetId: submitted.requestSetId,
    submittedAt: Date.now(),
    polls: 0,
    requests: [
      {
        itemId: msg.itemId,
        requestName: input.requestName ?? 'copy',
        targetType: input.targetType,
      },
    ],
  };
  await saveAsyncCopyState(msg, state);
  return state;
}

async function submitAsyncCopyBatch(
  msg: OperationMessage,
  token: string,
  items: OperationCopyBatchItem[],
): Promise<AsyncCopyState> {
  const inputs = items.map((item) => {
    const itemMsg = messageForCopyItem(msg, item);
    return buildAsyncCopyInput(itemMsg, asyncCopyRequestName(item.itemId));
  });
  await assertAsyncCopyInputsChildAdLimit(token, inputs);
  const submitted = await meta.submitAsyncCopyBatch(token, msg.metaActId, inputs);
  const state: AsyncCopyState = {
    kind: 'meta_async_copy',
    requestSetId: submitted.requestSetId,
    submittedAt: Date.now(),
    polls: 0,
    requests: items.map((item, index) => ({
      itemId: item.itemId,
      requestName: inputs[index]?.requestName ?? asyncCopyRequestName(item.itemId),
      targetType: item.targetType,
    })),
  };
  await saveAsyncCopyStateForItems(msg, items.map((item) => item.itemId), state);
  return state;
}

function asyncCopyStateKey(itemId: string): string {
  return `operation:item:${itemId}:meta_async_copy`;
}

function parseAsyncCopyState(raw: string | null | undefined): AsyncCopyState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AsyncCopyState>;
    if (
      parsed.kind === 'meta_async_copy' &&
      typeof parsed.requestSetId === 'string' &&
      typeof parsed.submittedAt === 'number'
    ) {
      const requests = Array.isArray(parsed.requests)
        ? parsed.requests
          .filter((request): request is AsyncCopyStateRequest => (
            !!request &&
            typeof request === 'object' &&
            typeof (request as AsyncCopyStateRequest).itemId === 'string' &&
            typeof (request as AsyncCopyStateRequest).requestName === 'string' &&
            (
              (request as AsyncCopyStateRequest).targetType === 'campaign' ||
              (request as AsyncCopyStateRequest).targetType === 'adset' ||
              (request as AsyncCopyStateRequest).targetType === 'ad'
            )
          ))
        : [];
      return {
        kind: 'meta_async_copy',
        requestSetId: parsed.requestSetId,
        submittedAt: parsed.submittedAt,
        polls: typeof parsed.polls === 'number' ? parsed.polls : 0,
        requests,
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function readAsyncCopyState(itemId: string): Promise<AsyncCopyState | null> {
  const cached = parseAsyncCopyState(await redis.get(asyncCopyStateKey(itemId)));
  if (cached) return cached;
  const row = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    const r = await tx
      .select({ error: schema.operationTaskItems.error })
      .from(schema.operationTaskItems)
      .where(eq(schema.operationTaskItems.id, itemId))
      .limit(1);
    return r[0];
  });
  return parseAsyncCopyState(row?.error);
}

async function readAsyncCopyStateForItems(itemIds: string[]): Promise<AsyncCopyState | null> {
  for (const itemId of itemIds) {
    const cached = parseAsyncCopyState(await redis.get(asyncCopyStateKey(itemId)));
    if (cached) return cached;
  }
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    return tx
      .select({
        id: schema.operationTaskItems.id,
        error: schema.operationTaskItems.error,
      })
      .from(schema.operationTaskItems)
      .where(inArray(schema.operationTaskItems.id, itemIds));
  });
  for (const row of rows) {
    const parsed = parseAsyncCopyState(row.error);
    if (parsed) return parsed;
  }
  return null;
}

async function saveAsyncCopyState(
  msg: OperationMessage,
  state: AsyncCopyState,
): Promise<void> {
  await saveAsyncCopyStateForItems(msg, [msg.itemId], state);
}

async function saveAsyncCopyStateForItems(
  msg: OperationMessage,
  itemIds: string[],
  state: AsyncCopyState,
): Promise<void> {
  const value = JSON.stringify(state);
  await Promise.all(itemIds.map((itemId) => redis.set(asyncCopyStateKey(itemId), value, 'EX', 60 * 60 * 24)));
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationTaskItems)
      .set({
        status: 'running',
        attempts: msg.attempt,
        error: value,
      })
      .where(inArray(schema.operationTaskItems.id, itemIds));
  });
}

async function clearAsyncCopyState(itemId: string): Promise<void> {
  await redis.del(asyncCopyStateKey(itemId));
}

async function clearAsyncCopyStateForItems(itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  await redis.del(...itemIds.map((itemId) => asyncCopyStateKey(itemId)));
}

async function assertMessageTargetOwnership(
  msg: OperationMessage,
  token: string,
): Promise<MetaObjectOwnership> {
  const owner = await meta.getObjectOwnership(token, msg.targetType, msg.targetId);
  if (owner.actId !== msg.metaActId) {
    throw new HttpError(403, 403, `${msg.targetType} not in ad_account`);
  }
  return owner;
}

async function writeLocalObjectState(
  msg: OperationMessage,
  token: string,
  result?: Record<string, unknown>,
): Promise<void> {
  const [layer, op] = msg.action.split(':') as [
    'campaign' | 'adset' | 'ad',
    'status' | 'budget' | 'copy' | 'delete',
  ];
  const owner = await resolveMessageOwner(msg, token);

  if (op === 'status') {
    const status = msg.params['status'];
    if (
      status === 'ACTIVE' ||
      status === 'PAUSED' ||
      status === 'ARCHIVED' ||
      status === 'DELETED'
    ) {
      await markLocalStatus({
        companyId: msg.companyId,
        adAccountId: msg.adAccountId,
        targetType: layer,
        targetId: msg.targetId,
        status,
        owner,
      });
    }
    return;
  }

  if (op === 'budget') {
    if (layer === 'ad') return;
    const daily = msg.params['dailyBudget'];
    const lifetime = msg.params['lifetimeBudget'];
    await markLocalBudget({
      companyId: msg.companyId,
      adAccountId: msg.adAccountId,
      targetType: layer,
      targetId: msg.targetId,
      ...(typeof daily === 'number' ? { dailyBudget: daily } : {}),
      ...(typeof lifetime === 'number' ? { lifetimeBudget: lifetime } : {}),
      owner,
    });
    return;
  }

  if (op === 'copy') {
    const newId = typeof result?.['newId'] === 'string' ? result['newId'] : undefined;
    if (!newId) return;
    const renameOptionsRaw = msg.params['renameOptions'] as Record<string, string> | undefined;
    const copyIndex = msg.params['_copyIndex'];
    let renameOptions = renameOptionsRaw;
    if (typeof copyIndex === 'number' && copyIndex > 0) {
      const baseSuffix = renameOptionsRaw?.['rename_suffix'] ?? '';
      renameOptions = {
        ...(renameOptionsRaw ?? {}),
        rename_suffix: `${baseSuffix}-${String(copyIndex).padStart(2, '0')}`,
      };
    }
    await upsertLocalCopyPlaceholder({
      companyId: msg.companyId,
      adAccountId: msg.adAccountId,
      targetType: layer,
      sourceId: msg.targetId,
      newId,
      owner,
      ...(renameOptions ? { renameOptions } : {}),
    });
    return;
  }

  if (op === 'delete') {
    await markLocalDeleted({
      companyId: msg.companyId,
      adAccountId: msg.adAccountId,
      targetType: layer,
      targetId: msg.targetId,
      hard: msg.params['hard'] === true,
      owner,
    });
  }
}

async function writeLocalBestEffort(
  msg: OperationMessage,
  token: string,
  result?: Record<string, unknown>,
): Promise<void> {
  try {
    await writeLocalObjectState(msg, token, result);
  } catch (err) {
    console.error(`[local-ad-object] ${msg.action} write failed`, err);
  }
}

async function resolveMessageOwner(
  msg: OperationMessage,
  token: string,
): Promise<MetaObjectOwnership> {
  if (isFake()) return meta.getObjectOwnership('', msg.targetType, msg.targetId);
  return meta.getObjectOwnership(token, msg.targetType, msg.targetId);
}

async function handleErr(
  msg: OperationMessage,
  err: unknown,
  batchItems?: OperationCopyBatchItem[],
): Promise<Outcome> {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof HttpError && err.status < 500 && err.status !== 429) {
    await failMessages(msg, batchItems, message);
    return { kind: 'dead', reason: message };
  }
  if (err instanceof MetaApiError) {
    if (err.isTokenInvalid) {
      // 熔断个号
      await db.transaction(async (tx) => {
        await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
        await tx
          .update(schema.fbAccounts)
          .set({ status: 'token_invalid' })
          .where(eq(schema.fbAccounts.id, msg.fbAccountId));
      });
      await redis.del(`token:${msg.fbAccountId}`);
      await openFor(BreakerKey.fbAccount(msg.fbAccountId), 0, 'token_invalid');
      await failMessages(msg, batchItems, `token invalid: ${message}`);
      return { kind: 'dead', reason: 'token invalid' };
    }
    if (err.isRateLimited) {
      await openFor(BreakerKey.adAccount(msg.metaActId), 60, 'meta rate limited');
      return { kind: 'retry', reason: 'meta rate limited', bumpAttempt: false };
      // 限流命中时让该账户挂 60s breaker；本消息走短 retry（attempt 不增）
      return { kind: 'retry', reason: 'meta rate limited', bumpAttempt: false };
    }
    if (isMetaPermanentParameterError(err)) {
      await failMessages(msg, batchItems, message);
      return { kind: 'dead', reason: message };
    }
  }
  // 瞬时错误 → attempts++
  if (msg.attempt >= RMQ.maxAttempts) {
    await failMessages(msg, batchItems, message);
    return { kind: 'dead', reason: message };
  }
  await incAttemptsForMessages(msg, batchItems);
  return { kind: 'retry', reason: message };
}

async function failMessages(
  msg: OperationMessage,
  batchItems: OperationCopyBatchItem[] | undefined,
  message: string,
): Promise<void> {
  const messages = batchItems?.length
    ? batchItems.map((item) => messageForCopyItem(msg, item))
    : [msg];
  for (const itemMsg of messages) {
    await failItem(itemMsg, message);
    await bumpProgress(itemMsg.taskId, { failed: 1 });
  }
}

async function incAttemptsForMessages(
  msg: OperationMessage,
  batchItems?: OperationCopyBatchItem[],
): Promise<void> {
  const messages = batchItems?.length
    ? batchItems.map((item) => messageForCopyItem(msg, item))
    : [msg];
  for (const itemMsg of messages) {
    await incAttempts(itemMsg);
  }
}

async function markSuccess(
  msg: OperationMessage,
  result?: Record<string, unknown>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationTaskItems)
      .set({
        status: 'success',
        attempts: msg.attempt,
        // MVP: 复用 error 列存 result(JSON);需要 result 的 action(copy) 写,其它清空。
        error: result ? JSON.stringify(result) : null,
      })
      .where(eq(schema.operationTaskItems.id, msg.itemId));
    await tx.execute(
      dsql`UPDATE operation_tasks
           SET success = success + 1,
               status = CASE WHEN success + 1 + failed >= total
                             THEN CASE WHEN failed > 0 THEN 'partial'::operation_status
                                       ELSE 'success'::operation_status END
                             ELSE 'running'::operation_status END
           WHERE id = ${msg.taskId}`,
    );
  });
}

async function failItem(msg: OperationMessage, error: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationTaskItems)
      .set({
        status: msg.attempt >= RMQ.maxAttempts ? 'dead' : 'failed',
        attempts: msg.attempt,
        error,
      })
      .where(eq(schema.operationTaskItems.id, msg.itemId));
    await tx.execute(
      dsql`UPDATE operation_tasks
           SET failed = failed + 1,
               status = CASE WHEN success + failed + 1 >= total
                             THEN CASE WHEN success > 0 THEN 'partial'::operation_status
                                       ELSE 'failed'::operation_status END
                             ELSE 'running'::operation_status END
           WHERE id = ${msg.taskId}`,
    );
  });
}

async function incAttempts(msg: OperationMessage): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    await tx
      .update(schema.operationTaskItems)
      .set({ status: 'retrying', attempts: msg.attempt })
      .where(eq(schema.operationTaskItems.id, msg.itemId));
  });
}

export { publishRetry, publishDead };
