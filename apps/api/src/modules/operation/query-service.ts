/**
 * 任务详情查询 + 实时进度合并(Redis 进度优先,fall back DB)。
 * 跨租户/作用域守卫: 仅当 task.company_id == principal.companyId 才放行。
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../lib/db';
import { readProgress, setProgressStatus, type ProgressSnapshot } from '../../lib/progress';
import { HttpError } from '../../lib/http-error';
import type { AuthPrincipal } from '../iam/auth-service';

export interface TaskDetail extends ProgressSnapshot {
  type: string;
  payload: unknown;
  createdAt: string;
  userId: string;
  layerProgress: LayerProgress[];
  /** 失败/未完成 item 抽样 (M3 简化: 最多 50 条) */
  failures: Array<{ id: string; targetId: string; error: string | null; attempts: number }>;
}

export interface LayerProgress {
  targetType: 'campaign' | 'adset' | 'ad';
  label: string;
  total: number;
  success: number;
  failed: number;
  running: number;
  pending: number;
  successItems: TaskLayerProgressItem[];
  failedItems: TaskLayerProgressItem[];
}

export interface TaskLayerProgressItem {
  id: string;
  targetId: string;
  status: string;
  attempts: number;
  detail: string | null;
}

export async function getTask(
  principal: AuthPrincipal,
  taskId: string,
): Promise<TaskDetail> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    const r = await tx
      .select()
      .from(schema.operationTasks)
      .where(
        and(
          eq(schema.operationTasks.id, taskId),
          eq(schema.operationTasks.companyId, principal.companyId),
        ),
      )
      .limit(1);
    return r[0];
  });
  if (!row) throw new HttpError(404, 404, 'task not found');

  // Redis 进度优先(可能比 DB 计数更新)
  const progress = await readProgress(taskId);
  const persistedUpdatedAt = progress ? null : await readTaskWorkflowUpdatedAt(principal.companyId, taskId);
  const snap = progress ?? {
    taskId,
    total: row.total,
    success: row.success,
    failed: row.failed,
    status: row.status,
    updatedAt: persistedUpdatedAt ?? row.createdAt.getTime(),
  };

  const failures = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    return tx
      .select({
        id: schema.operationTaskItems.id,
        targetId: schema.operationTaskItems.targetId,
        error: schema.operationTaskItems.error,
        attempts: schema.operationTaskItems.attempts,
      })
      .from(schema.operationTaskItems)
      .where(
        and(
          eq(schema.operationTaskItems.taskId, taskId),
          // failed 或 dead
          dsql`${schema.operationTaskItems.status} IN ('failed','dead')`,
        ),
      )
      .limit(100);
  });
  const layerProgress = await readLayerProgress(principal.companyId, taskId);

  return {
    ...snap,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    userId: row.userId,
    layerProgress,
    failures,
  };
}

async function readTaskWorkflowUpdatedAt(companyId: string, taskId: string): Promise<number | null> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
    return tx
      .select({
        updatedAt: dsql<Date | null>`max(${schema.operationCopyWorkflows.updatedAt})`,
      })
      .from(schema.operationCopyWorkflows)
      .where(eq(schema.operationCopyWorkflows.taskId, taskId));
  });
  const value = rows[0]?.updatedAt;
  return value ? new Date(value).getTime() : null;
}

async function readLayerProgress(companyId: string, taskId: string): Promise<LayerProgress[]> {
  const v2 = await readCopyV2LayerProgress(companyId, taskId);
  if (v2) return v2;

  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
    return tx.execute(dsql`
      SELECT
        target_type,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success,
        COUNT(*) FILTER (WHERE status IN ('failed','dead'))::int AS failed,
        COUNT(*) FILTER (WHERE status IN ('running','retrying'))::int AS running,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
      FROM operation_task_items
      WHERE task_id = ${taskId}
      GROUP BY target_type
    `);
  }) as unknown as Array<{
    target_type: string;
    total: number;
    success: number;
    failed: number;
    running: number;
    pending: number;
  }>;
  const items = await readLayerProgressItems(companyId, taskId);

  const byType = new Map(rows.map((row) => [row.target_type, row]));
  const itemsByType = new Map<string, { successItems: TaskLayerProgressItem[]; failedItems: TaskLayerProgressItem[] }>();
  for (const item of items) {
    const bucket = itemsByType.get(item.targetType) ?? { successItems: [], failedItems: [] };
    if (item.status === 'success') bucket.successItems.push(item);
    if (item.status === 'failed' || item.status === 'dead') bucket.failedItems.push(item);
    itemsByType.set(item.targetType, bucket);
  }
  return ([
    ['campaign', '广告系列'],
    ['adset', '广告组'],
    ['ad', '广告'],
  ] as const).map(([targetType, label]) => {
    const row = byType.get(targetType);
    const itemBucket = itemsByType.get(targetType);
    return {
      targetType,
      label: taskLayerLabel(targetType),
      total: Number(row?.total ?? 0),
      success: Number(row?.success ?? 0),
      failed: Number(row?.failed ?? 0),
      running: Number(row?.running ?? 0),
      pending: Number(row?.pending ?? 0),
      successItems: itemBucket?.successItems ?? [],
      failedItems: itemBucket?.failedItems ?? [],
    };
  });
}

async function readCopyV2LayerProgress(companyId: string, taskId: string): Promise<LayerProgress[] | null> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
    return tx.execute(dsql`
      SELECT
        source_type,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status IN ('running','retrying','unknown'))::int AS running,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
      FROM operation_copy_steps
      WHERE task_id = ${taskId}
      GROUP BY source_type
    `);
  }) as unknown as Array<{
    source_type: string;
    total: number;
    success: number;
    failed: number;
    running: number;
    pending: number;
  }>;
  if (rows.length === 0) return null;

  const items = await readCopyV2LayerProgressItems(companyId, taskId);
  const byType = new Map(rows.map((row) => [row.source_type, row]));
  const itemsByType = new Map<string, { successItems: TaskLayerProgressItem[]; failedItems: TaskLayerProgressItem[] }>();
  for (const item of items) {
    const bucket = itemsByType.get(item.targetType) ?? { successItems: [], failedItems: [] };
    if (item.status === 'success') bucket.successItems.push(item);
    if (item.status === 'failed' || item.status === 'unknown') bucket.failedItems.push(item);
    itemsByType.set(item.targetType, bucket);
  }

  return ([
    ['campaign', '广告系列'],
    ['adset', '广告组'],
    ['ad', '广告'],
  ] as const).map(([targetType]) => {
    const row = byType.get(targetType);
    const itemBucket = itemsByType.get(targetType);
    return {
      targetType,
      label: taskLayerLabel(targetType),
      total: Number(row?.total ?? 0),
      success: Number(row?.success ?? 0),
      failed: Number(row?.failed ?? 0),
      running: Number(row?.running ?? 0),
      pending: Number(row?.pending ?? 0),
      successItems: itemBucket?.successItems ?? [],
      failedItems: itemBucket?.failedItems ?? [],
    };
  });
}

async function readCopyV2LayerProgressItems(
  companyId: string,
  taskId: string,
): Promise<Array<TaskLayerProgressItem & { targetType: string }>> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
    return tx.execute(dsql`
      SELECT
        id::text,
        source_type,
        source_id,
        new_id,
        status,
        attempt,
        error
      FROM operation_copy_steps
      WHERE task_id = ${taskId}
        AND status IN ('success','failed','unknown')
      ORDER BY
        CASE source_type WHEN 'campaign' THEN 1 WHEN 'adset' THEN 2 WHEN 'ad' THEN 3 ELSE 4 END,
        CASE status WHEN 'success' THEN 1 ELSE 2 END,
        updated_at ASC,
        id ASC
      LIMIT 500
    `);
  }) as unknown as Array<{
    id: string;
    source_type: string;
    source_id: string;
    new_id: string | null;
    status: string;
    attempt: number;
    error: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    targetType: row.source_type,
    targetId: row.source_id,
    status: row.status,
    attempts: Number(row.attempt ?? 0),
    detail: row.status === 'success'
      ? (row.new_id ? `新对象 ${row.new_id}` : null)
      : row.error,
  }));
}

function taskLayerLabel(targetType: 'campaign' | 'adset' | 'ad'): string {
  if (targetType === 'campaign') return '广告系列';
  if (targetType === 'adset') return '广告组';
  return '广告';
}

async function readLayerProgressItems(
  companyId: string,
  taskId: string,
): Promise<Array<TaskLayerProgressItem & { targetType: string }>> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${companyId}, true)`);
    return tx.execute(dsql`
      SELECT id::text, target_type, target_id, status, attempts, error
      FROM operation_task_items
      WHERE task_id = ${taskId}
        AND status IN ('success','failed','dead')
      ORDER BY
        CASE target_type WHEN 'campaign' THEN 1 WHEN 'adset' THEN 2 WHEN 'ad' THEN 3 ELSE 4 END,
        CASE status WHEN 'success' THEN 1 ELSE 2 END,
        created_at ASC,
        id ASC
    `);
  }) as unknown as Array<{
    id: string;
    target_type: string;
    target_id: string;
    status: string;
    attempts: number;
    error: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    detail: row.error,
  }));
}

/** 用于 SSE 端校验任务归属(不返实体) */
export async function assertTaskOwned(
  principal: AuthPrincipal,
  taskId: string,
): Promise<void> {
  const r = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    return tx
      .select({ id: schema.operationTasks.id })
      .from(schema.operationTasks)
      .where(
        and(
          eq(schema.operationTasks.id, taskId),
          eq(schema.operationTasks.companyId, principal.companyId),
        ),
      )
      .limit(1);
  });
  if (!r[0]) throw new HttpError(404, 404, 'task not found');
}

export async function pauseTask(principal: AuthPrincipal, taskId: string): Promise<void> {
  if (await updateTaskStatus(principal, taskId, 'paused')) {
    await db.transaction(async (tx) => {
      await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
      await tx.execute(dsql`
        UPDATE operation_copy_workflows
        SET status = 'paused',
            lease_owner = NULL,
            lease_until = NULL,
            error = 'task paused by user',
            updated_at = now()
        WHERE task_id = ${taskId}
          AND status NOT IN ('success','partial','failed','canceled')
      `);
    });
    await setProgressStatus(taskId, 'paused');
  }
}

export async function resumeTask(principal: AuthPrincipal, taskId: string): Promise<void> {
  if (await updateTaskStatus(principal, taskId, 'running')) {
    await db.transaction(async (tx) => {
      await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
      await tx.execute(dsql`
        UPDATE operation_copy_workflows
        SET status = 'waiting',
            error = NULL,
            updated_at = now()
        WHERE task_id = ${taskId}
          AND status = 'paused'
      `);
    });
    await setProgressStatus(taskId, 'running');
  }
}

export async function stopTask(principal: AuthPrincipal, taskId: string): Promise<void> {
  if (!await updateTaskStatus(principal, taskId, 'cancelled')) return;
  await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    await tx.execute(dsql`
      UPDATE operation_copy_workflows
      SET status = 'canceled',
          lease_owner = NULL,
          lease_until = NULL,
          error = 'task cancelled by user',
          updated_at = now()
      WHERE task_id = ${taskId}
    `);
  });
  await setProgressStatus(taskId, 'cancelled');
}

async function updateTaskStatus(
  principal: AuthPrincipal,
  taskId: string,
  status: 'paused' | 'running' | 'cancelled',
): Promise<boolean> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.current_company_id', ${principal.companyId}, true)`);
    return tx.execute(dsql`
      UPDATE operation_tasks
      SET status = ${status}::operation_status
      WHERE id = ${taskId}
        AND company_id = ${principal.companyId}
        AND status NOT IN ('success','failed','partial','cancelled')
      RETURNING id
    `);
  }) as unknown as Array<{ id: string }>;
  if (rows.length === 0) {
    await assertTaskOwned(principal, taskId);
    return false;
  }
  return true;
}
