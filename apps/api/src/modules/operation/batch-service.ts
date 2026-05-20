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
import { publishOperation, type OperationMessage } from '../../lib/rabbitmq-topology';
import { initProgress } from '../../lib/progress';
import { checkScope } from '../../middleware/auth';
import { HttpError } from '../../lib/http-error';
import { writeAudit } from '../iam/auth-service';
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

  for (const it of items) {
    const ad = adMap.get(it.adAccountId)!;
    const msg: OperationMessage = {
      taskId,
      itemId: it.id,
      companyId: principal.companyId,
      fbAccountId: ad.fbAccountId,
      adAccountId: it.adAccountId,
      metaActId: ad.metaActId,
      targetType: it.targetType as 'campaign' | 'adset' | 'ad',
      targetId: it.targetId,
      action,
      params: { ...params, ...(targets.find((t) => t.target_id === it.targetId)?.params ?? {}) },
      idempotencyKey: it.idempotencyKey,
      attempt: 1,
    };
    await publishOperation(msg);
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
