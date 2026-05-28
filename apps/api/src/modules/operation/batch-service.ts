/**
 * M3 批量入队。
 *   1. 校验 targets 全在租户内 + scope 内 + 对应 fb_account 状态正常
 *   2. 在一个事务里写 operation_tasks + N 个 operation_task_items
 *   3. 初始化 Redis 进度
 *   4. 按 ad_account 分片 publish 到 RabbitMQ
 *   5. 返回 task_id
 */
import { and, eq, inArray, sql as dsql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db, schema } from '../../lib/db';
import {
  RabbitMqPublishError,
  publishOperation,
  type OperationCopyBatchItem,
  type OperationMessage,
} from '../../lib/rabbitmq-topology';
import { bumpProgress, initProgress } from '../../lib/progress';
import { checkScope } from '../../middleware/auth';
import { HttpError } from '../../lib/http-error';
import { FAKE_MODE } from '../../lib/fake-meta-state';
import { writeAudit } from '../iam/auth-service';
import {
  markLocalBudget,
  markLocalDeleted,
  markLocalStatus,
  readLocalObjectOwnership,
  upsertLocalCopyPlaceholder,
} from '../ad-object/local-store';
import type { AuthPrincipal } from '../iam/auth-service';

export type BatchAction =
  | 'campaign:status'
  | 'campaign:budget'
  | 'campaign:copy'
  | 'campaign:delete'
  | 'adset:status'
  | 'adset:budget'
  | 'adset:copy'
  | 'adset:delete'
  | 'ad:status'
  | 'ad:copy'
  | 'ad:delete';

export interface BatchTarget {
  ad_account_id: string;
  target_type: 'campaign' | 'adset' | 'ad';
  target_id: string;
  /** 可选：每个 target 可覆盖 params (M4 复制场景有用)，MVP 空 */
  params?: Record<string, unknown>;
}

export interface BatchEnqueueArgs {
  action: BatchAction;
  params: Record<string, unknown>;
  targets: BatchTarget[];
  principal: AuthPrincipal;
  ip?: string;
}

export interface BatchEnqueueResult {
  taskId: string;
  total: number;
}

// 三层共享权限维度: status/budget/copy/delete (符合 CLAUDE.md 设计)
const ACTION_PERMISSION: Record<BatchAction, string> = {
  'campaign:status': 'campaign:status',
  'campaign:budget': 'campaign:budget',
  'campaign:copy': 'campaign:copy',
  'campaign:delete': 'campaign:delete',
  'adset:status': 'campaign:status',
  'adset:budget': 'campaign:budget',
  'adset:copy': 'campaign:copy',
  'adset:delete': 'campaign:delete',
  'ad:status': 'campaign:status',
  'ad:copy': 'campaign:copy',
  'ad:delete': 'campaign:delete',
};

export function permissionFor(action: BatchAction): string {
  return ACTION_PERMISSION[action];
}

/** target → idempotencyKey。任务 + 资源 + 动作 + 关键参数 → 稳定 hash */
function idempotency(
  taskId: string,
  t: BatchTarget,
  action: BatchAction,
  params: Record<string, unknown>,
): string {
  const h = createHash('sha256');
  const merged = { ...params, ...(t.params ?? {}) };
  h.update(`${taskId}|${t.ad_account_id}|${t.target_id}|${action}|${JSON.stringify(merged)}`);
  return h.digest('hex');
}

/** 把同 ad_account 的 targets 折叠为唯一集合,用一次 DB 查询验所有作用域 */
function uniqueAdAccountIds(targets: BatchTarget[]): string[] {
  return Array.from(new Set(targets.map((t) => t.ad_account_id)));
}

export async function batchEnqueue(
  args: BatchEnqueueArgs,
): Promise<BatchEnqueueResult> {
  const { action, params, principal } = args;
  let { targets } = args;

  if (targets.length === 0) throw new HttpError(422, 422, 'targets 不能为空');
  if (targets.length > 5000) throw new HttpError(422, 422, 'targets 单次不超过 5000');

  // copy 类 action 支持 params.count 展开:把每个 target 复制 N 份,每份注入 copyIndex 让 idempotency 唯一
  if (action.endsWith(':copy')) {
    const count = Math.max(1, Math.min(200, Number(params['count'] ?? 1)));
    if (count > 1) {
      const expanded: BatchTarget[] = [];
      for (const t of targets) {
        for (let i = 0; i < count; i++) {
          expanded.push({
            ...t,
            params: { ...(t.params ?? {}), _copyIndex: i + 1 },
          });
        }
      }
      if (expanded.length > 5000) {
        throw new HttpError(422, 422, `展开后任务数 ${expanded.length} 超 5000 上限`);
      }
      targets = expanded;
    }
  }

  // budget 必须二选一 (campaign / adset 都受此约束)
  if (action === 'campaign:budget' || action === 'adset:budget') {
    const hasDaily = typeof params['dailyBudget'] === 'number';
    const hasLife = typeof params['lifetimeBudget'] === 'number';
    if (hasDaily === hasLife) {
      throw new HttpError(422, 422, 'dailyBudget 与 lifetimeBudget 二选一');
    }
  }
  // status 三层共用 ACTIVE/PAUSED/ARCHIVED
  if (action.endsWith(':status')) {
    const s = params['status'];
    if (s !== 'ACTIVE' && s !== 'PAUSED' && s !== 'ARCHIVED') {
      throw new HttpError(422, 422, 'status 必须为 ACTIVE/PAUSED/ARCHIVED');
    }
  }

  // 作用域 (CompanyAdmin/PlatformAdmin bypass)
  if (!principal.scope.bypass) {
    for (const t of targets) {
      if (!checkScope(principal, 'ad_account', t.ad_account_id)) {
        throw new HttpError(403, 403, `ad_account ${t.ad_account_id} 不在作用域内`);
      }
    }
  }

  // 一次 DB 查询验所有 ad_account 在本租户且状态正常,同时拿 meta_act_id + fb_account_id
  const adIds = uniqueAdAccountIds(targets);
  const adRows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    return tx
      .select({
        id: schema.adAccounts.id,
        metaActId: schema.adAccounts.metaActId,
        status: schema.adAccounts.status,
        fbAccountId: schema.adAccounts.fbAccountId,
        fbStatus: schema.fbAccounts.status,
      })
      .from(schema.adAccounts)
      .innerJoin(schema.fbAccounts, eq(schema.fbAccounts.id, schema.adAccounts.fbAccountId))
      .where(
        and(
          inArray(schema.adAccounts.id, adIds),
          eq(schema.adAccounts.companyId, principal.companyId),
        ),
      );
  });

  const adMap = new Map(adRows.map((r) => [r.id, r]));
  for (const id of adIds) {
    const r = adMap.get(id);
    if (!r) throw new HttpError(404, 404, `ad_account ${id} 不存在`);
    if (r.status !== 'active') throw new HttpError(409, 409, `ad_account ${id} 状态 ${r.status}`);
    if (r.fbStatus !== 'active') {
      throw new HttpError(409, 1003, `fb_account ${r.fbAccountId} 状态 ${r.fbStatus}`);
    }
  }

  // 写库 + 入队
  const taskId = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    const ins = await tx
      .insert(schema.operationTasks)
      .values({
        companyId: principal.companyId,
        userId: principal.userId,
        type: action,
        status: 'pending',
        total: targets.length,
        success: 0,
        failed: 0,
        payload: { action, params, targetCount: targets.length },
      })
      .returning({ id: schema.operationTasks.id });
    const tid = ins[0]!.id;
    // 子项分批 insert (避免 1 SQL 太长)
    const CHUNK = 500;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const slice = targets.slice(i, i + CHUNK).map((t) => ({
        taskId: tid,
        adAccountId: t.ad_account_id,
        targetType: t.target_type,
        targetId: t.target_id,
        action,
        idempotencyKey: idempotency(tid, t, action, params),
        status: 'pending' as const,
        attempts: 0,
      }));
      await tx.insert(schema.operationTaskItems).values(slice);
    }
    return tid;
  });

  await initProgress(taskId, targets.length);

  const paramsByIdempotency = new Map<string, Record<string, unknown>>();
  for (const target of targets) {
    paramsByIdempotency.set(
      idempotency(taskId, target, action, params),
      { ...params, ...(target.params ?? {}) },
    );
  }

  // 拉所有刚 insert 的 item id 以放入消息
  const items = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    return tx
      .select({
        id: schema.operationTaskItems.id,
        adAccountId: schema.operationTaskItems.adAccountId,
        targetType: schema.operationTaskItems.targetType,
        targetId: schema.operationTaskItems.targetId,
        idempotencyKey: schema.operationTaskItems.idempotencyKey,
      })
      .from(schema.operationTaskItems)
      .where(eq(schema.operationTaskItems.taskId, taskId));
  });

  const messages: OperationMessage[] = [];
  for (const it of items) {
    const ad = adMap.get(it.adAccountId)!;
    messages.push({
      taskId,
      itemId: it.id,
      companyId: principal.companyId,
      userId: principal.userId,
      fbAccountId: ad.fbAccountId,
      adAccountId: it.adAccountId,
      metaActId: ad.metaActId,
      targetType: it.targetType as 'campaign' | 'adset' | 'ad',
      targetId: it.targetId,
      action,
      params: paramsByIdempotency.get(it.idempotencyKey) ?? params,
      idempotencyKey: it.idempotencyKey,
      attempt: 1,
    });
  }

  for (const msg of FAKE_MODE ? messages : publishMessages(messages, action)) {
    if (FAKE_MODE) {
      await executeFakeBatchItem(msg);
    } else {
      try {
        await publishOperation(msg);
      } catch (err) {
        if (err instanceof RabbitMqPublishError) {
          throw new HttpError(503, 1006, 'queue service unavailable, please retry');
        }
        throw err;
      }
    }
  }

  if (FAKE_MODE) {
    await finalizeFakeTask(taskId);
  }

  await writeAudit({
    companyId: principal.companyId,
    userId: principal.userId,
    action: `${action}:batch`,
    resource: `task:${taskId}`,
    detail: { total: targets.length, params },
    ...(args.ip ? { ip: args.ip } : {}),
  });

  return { taskId, total: targets.length };
}

function publishMessages(messages: OperationMessage[], action: BatchAction): OperationMessage[] {
  if (!action.endsWith(':copy')) return messages;

  const groups = new Map<string, OperationMessage[]>();
  for (const message of messages) {
    const key = `${message.fbAccountId}:${message.adAccountId}:${message.metaActId}:${message.action}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(message);
    else groups.set(key, [message]);
  }

  const out: OperationMessage[] = [];
  const chunkSize = 50;
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += chunkSize) {
      const chunk = group.slice(i, i + chunkSize);
      const first = chunk[0];
      if (!first) continue;
      if (chunk.length === 1) {
        out.push(first);
        continue;
      }
      const copyBatch: OperationCopyBatchItem[] = chunk.map((item) => ({
        itemId: item.itemId,
        targetType: item.targetType,
        targetId: item.targetId,
        params: item.params,
        idempotencyKey: item.idempotencyKey,
      }));
      out.push({ ...first, copyBatch });
    }
  }
  return out;
}

async function executeFakeBatchItem(msg: OperationMessage): Promise<void> {
  try {
    const result = await executeFakeProvider(msg);
    await writeLocalFakeStateOrThrow(msg, result);
    await markFakeItemSuccess(msg, result);
    await bumpProgress(msg.taskId, { success: 1 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFakeItemFailed(msg, message);
    await bumpProgress(msg.taskId, { failed: 1 });
  }
}

async function requireLocalOwner(msg: OperationMessage) {
  const owner = await readLocalObjectOwnership({
    companyId: msg.companyId,
    adAccountId: msg.adAccountId,
    targetType: msg.targetType,
    targetId: msg.targetId,
  });
  if (!owner) {
    throw new HttpError(404, 404, `${msg.targetType} not found in local snapshot`);
  }
  return { ...owner, actId: msg.metaActId };
}

function localBatchCopyId(
  targetType: 'campaign' | 'adset' | 'ad',
  sourceId: string,
  copyIndex: number,
): string {
  const safeSource = sourceId.replace(/[^a-zA-Z0-9_]/g, '_').slice(-48);
  return `local_${targetType}_copy_${safeSource}_${Date.now()}_${copyIndex}`;
}

async function executeFakeProvider(
  msg: OperationMessage,
): Promise<Record<string, unknown> | undefined> {
  const [layer, op] = msg.action.split(':') as [
    'campaign' | 'adset' | 'ad',
    'status' | 'budget' | 'copy' | 'delete',
  ];
  await requireLocalOwner(msg);

  if (op === 'status') {
    const status = msg.params['status'];
    if (status !== 'ACTIVE' && status !== 'PAUSED' && status !== 'ARCHIVED') {
      throw new HttpError(422, 422, 'status 必须为 ACTIVE/PAUSED/ARCHIVED');
    }
    return undefined;
  }

  if (op === 'budget') {
    if (layer === 'ad') throw new HttpError(422, 422, 'ad 层无 budget 操作');
    const daily = msg.params['dailyBudget'];
    const lifetime = msg.params['lifetimeBudget'];
    if (typeof daily !== 'number' && typeof lifetime !== 'number') {
      throw new HttpError(422, 422, '至少传 dailyBudget 或 lifetimeBudget');
    }
    return undefined;
  }

  if (op === 'copy') {
    const copyIndex = msg.params['_copyIndex'];
    return {
      newId: localBatchCopyId(layer, msg.targetId, typeof copyIndex === 'number' ? copyIndex : 1),
      layer,
    };
  }

  if (op === 'delete') {
    return undefined;
  }

  throw new HttpError(422, 422, `unknown action: ${msg.action}`);
}

async function writeLocalFakeState(
  msg: OperationMessage,
  result?: Record<string, unknown>,
): Promise<void> {
  const [layer, op] = msg.action.split(':') as [
    'campaign' | 'adset' | 'ad',
    'status' | 'budget' | 'copy' | 'delete',
  ];
  const owner = await requireLocalOwner(msg);

  if (op === 'status') {
    const status = msg.params['status'];
    if (status === 'ACTIVE' || status === 'PAUSED' || status === 'ARCHIVED') {
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
    await upsertLocalCopyPlaceholder({
      companyId: msg.companyId,
      adAccountId: msg.adAccountId,
      targetType: layer,
      sourceId: msg.targetId,
      newId,
      owner,
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

async function writeLocalFakeStateOrThrow(
  msg: OperationMessage,
  result?: Record<string, unknown>,
): Promise<void> {
  await writeLocalFakeState(msg, result);
}

async function markFakeItemSuccess(
  msg: OperationMessage,
  result?: Record<string, unknown>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${msg.companyId}, true)`);
    await tx
      .update(schema.operationTaskItems)
      .set({
        status: 'success',
        attempts: 1,
        error: result ? JSON.stringify(result) : null,
      })
      .where(eq(schema.operationTaskItems.id, msg.itemId));
  });
}

async function markFakeItemFailed(
  msg: OperationMessage,
  error: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${msg.companyId}, true)`);
    await tx
      .update(schema.operationTaskItems)
      .set({
        status: 'failed',
        attempts: 1,
        error,
      })
      .where(eq(schema.operationTaskItems.id, msg.itemId));
  });
}

async function finalizeFakeTask(taskId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    const rows = await tx
      .select({
        status: schema.operationTaskItems.status,
      })
      .from(schema.operationTaskItems)
      .where(eq(schema.operationTaskItems.taskId, taskId));
    const success = rows.filter((row) => row.status === 'success').length;
    const failed = rows.filter((row) => row.status === 'failed' || row.status === 'dead').length;
    const status = failed === 0 ? 'success' : success === 0 ? 'failed' : 'partial';
    await tx
      .update(schema.operationTasks)
      .set({ success, failed, status })
      .where(eq(schema.operationTasks.id, taskId));
  });
}
