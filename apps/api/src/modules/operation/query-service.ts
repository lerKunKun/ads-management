/**
 * 任务详情查询 + 实时进度合并(Redis 进度优先,fall back DB)。
 * 个人入口只放行自己的任务；管理入口按管理范围放行任务。
 */
import { and, desc, eq, inArray, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../lib/db';
import { readProgress, setProgressStatus, type ProgressSnapshot } from '../../lib/progress';
import { HttpError } from '../../lib/http-error';
import type { AuthPrincipal } from '../iam/auth-service';

export interface TaskSummary {
  id: string;
  companyId: string;
  type: string;
  status: string;
  total: number;
  success: number;
  failed: number;
  userId: string;
  createdAt: string;
  updatedAt: number | null;
  payload: unknown;
}

export interface TaskDetail extends ProgressSnapshot {
  companyId: string;
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
  resultId?: string | null;
  resultName?: string | null;
}

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type TaskReadScope = {
  companyId: string;
  bypassRls?: boolean;
};

type TaskAccess = 'own' | 'admin';

type TaskRow = {
  id: string;
  companyId: string;
  type: string;
  status: ProgressSnapshot['status'];
  total: number;
  success: number;
  failed: number;
  userId: string;
  createdAt: Date;
  payload: unknown;
};

const taskSummaryColumns = {
  id: schema.operationTasks.id,
  companyId: schema.operationTasks.companyId,
  type: schema.operationTasks.type,
  status: schema.operationTasks.status,
  total: schema.operationTasks.total,
  success: schema.operationTasks.success,
  failed: schema.operationTasks.failed,
  userId: schema.operationTasks.userId,
  createdAt: schema.operationTasks.createdAt,
  payload: schema.operationTasks.payload,
};

const MAX_TASK_LIST_LIMIT = 100;
const IN_QUERY_CHUNK_SIZE = 1000;

function clampTaskLimit(limit: number): number {
  return Math.min(Math.max(limit, 1), MAX_TASK_LIST_LIMIT);
}

function chunks<T>(rows: T[], size: number): T[][] {
  if (rows.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}

function isPlatformAdmin(principal: AuthPrincipal): boolean {
  return principal.roles.includes('PlatformAdmin');
}

function adminReadScope(principal: AuthPrincipal): TaskReadScope {
  return {
    companyId: principal.companyId,
    bypassRls: isPlatformAdmin(principal),
  };
}

async function applyTaskReadScope(tx: DbTx, scope: TaskReadScope): Promise<void> {
  if (scope.bypassRls) {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    return;
  }
  await tx.execute(dsql`SELECT set_config('app.current_company_id', ${scope.companyId}, true)`);
}

export async function listMyTasks(
  principal: AuthPrincipal,
  limit: number,
): Promise<TaskSummary[]> {
  const cappedLimit = clampTaskLimit(limit);
  const rows = await db.transaction(async (tx) => {
    await applyTaskReadScope(tx, { companyId: principal.companyId });
    return tx
      .select(taskSummaryColumns)
      .from(schema.operationTasks)
      .where(
        and(
          eq(schema.operationTasks.companyId, principal.companyId),
          eq(schema.operationTasks.userId, principal.userId),
        ),
      )
      .orderBy(desc(schema.operationTasks.createdAt))
      .limit(cappedLimit);
  });

  return enrichTaskRows(rows, { companyId: principal.companyId });
}

export async function listAdminTasks(
  principal: AuthPrincipal,
  limit: number,
): Promise<TaskSummary[]> {
  const cappedLimit = clampTaskLimit(limit);
  const scope = adminReadScope(principal);
  const rows = await db.transaction(async (tx) => {
    await applyTaskReadScope(tx, scope);
    if (scope.bypassRls) {
      return tx
        .select(taskSummaryColumns)
        .from(schema.operationTasks)
        .orderBy(desc(schema.operationTasks.createdAt))
        .limit(cappedLimit);
    }
    return tx
      .select(taskSummaryColumns)
      .from(schema.operationTasks)
      .where(eq(schema.operationTasks.companyId, principal.companyId))
      .orderBy(desc(schema.operationTasks.createdAt))
      .limit(cappedLimit);
  });

  return enrichTaskRows(rows, scope);
}

async function enrichTaskRows(
  rows: TaskRow[],
  scope: TaskReadScope,
): Promise<TaskSummary[]> {
  const taskIds = rows.map((row) => row.id);
  const workflowRows = taskIds.length
    ? await db.transaction(async (tx) => {
        await applyTaskReadScope(tx, scope);
        return tx
          .select({
            taskId: schema.operationCopyWorkflows.taskId,
            updatedAt: dsql<Date | null>`max(${schema.operationCopyWorkflows.updatedAt})`,
          })
          .from(schema.operationCopyWorkflows)
          .where(inArray(schema.operationCopyWorkflows.taskId, taskIds))
          .groupBy(schema.operationCopyWorkflows.taskId);
      })
    : [];
  const workflowUpdatedAtByTask = new Map(
    workflowRows.map((row) => [
      row.taskId,
      row.updatedAt ? new Date(row.updatedAt).getTime() : null,
    ]),
  );
  const progressEntries = await Promise.all(
    rows.map(async (row) => [row.id, await readProgress(row.id)] as const),
  );
  const progressByTask = new Map(progressEntries);

  return rows.map((row) => {
    const snap = progressByTask.get(row.id);
    return {
      ...row,
      status: snap?.status ?? row.status,
      total: snap?.total ?? row.total,
      success: snap?.success ?? row.success,
      failed: snap?.failed ?? row.failed,
      createdAt: row.createdAt.toISOString(),
      updatedAt: snap?.updatedAt ?? workflowUpdatedAtByTask.get(row.id) ?? null,
    };
  });
}

export async function getTask(
  principal: AuthPrincipal,
  taskId: string,
): Promise<TaskDetail> {
  return getTaskDetail(principal, taskId, 'own');
}

export async function getAdminTask(
  principal: AuthPrincipal,
  taskId: string,
): Promise<TaskDetail> {
  return getTaskDetail(principal, taskId, 'admin');
}

async function getTaskDetail(
  principal: AuthPrincipal,
  taskId: string,
  access: TaskAccess,
): Promise<TaskDetail> {
  const row = await readTaskRow(principal, taskId, access);
  if (!row) throw new HttpError(404, 404, 'task not found');

  // Redis 进度优先(可能比 DB 计数更新)
  const progress = await readProgress(taskId);
  const persistedUpdatedAt = progress ? null : await readTaskWorkflowUpdatedAt(row.companyId, taskId);
  const snap = progress ?? {
    taskId,
    total: row.total,
    success: row.success,
    failed: row.failed,
    status: row.status,
    updatedAt: persistedUpdatedAt ?? row.createdAt.getTime(),
  };

  const failures = await db.transaction(async (tx) => {
    await applyTaskReadScope(tx, { companyId: row.companyId });
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
  const layerProgress = await readLayerProgress(row.companyId, taskId);

  return {
    ...snap,
    companyId: row.companyId,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    userId: row.userId,
    layerProgress,
    failures,
  };
}

async function readTaskRow(
  principal: AuthPrincipal,
  taskId: string,
  access: TaskAccess,
): Promise<TaskRow | undefined> {
  return db.transaction(async (tx) => {
    if (access === 'admin') {
      const scope = adminReadScope(principal);
      await applyTaskReadScope(tx, scope);
      const where = scope.bypassRls
        ? eq(schema.operationTasks.id, taskId)
        : and(
            eq(schema.operationTasks.id, taskId),
            eq(schema.operationTasks.companyId, principal.companyId),
          );
      const rows = await tx
        .select(taskSummaryColumns)
        .from(schema.operationTasks)
        .where(where)
        .limit(1);
      return rows[0];
    }

    await applyTaskReadScope(tx, { companyId: principal.companyId });
    const rows = await tx
      .select(taskSummaryColumns)
      .from(schema.operationTasks)
      .where(
        and(
          eq(schema.operationTasks.id, taskId),
          eq(schema.operationTasks.companyId, principal.companyId),
          eq(schema.operationTasks.userId, principal.userId),
        ),
      )
      .limit(1);
    return rows[0];
  });
}

async function readTaskWorkflowUpdatedAt(companyId: string, taskId: string): Promise<number | null> {
  const rows = await db.transaction(async (tx) => {
    await applyTaskReadScope(tx, { companyId });
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
    await applyTaskReadScope(tx, { companyId });
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
    await applyTaskReadScope(tx, { companyId });
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
    await applyTaskReadScope(tx, { companyId });
    return tx.execute(dsql`
      SELECT
        id::text,
        source_type,
        source_id,
        new_id,
        status,
        attempt,
        error,
        metadata
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
    metadata: unknown;
  }>;

  return enrichCopyResultNames(companyId, rows.map((row) => ({
    id: row.id,
    targetType: row.source_type,
    targetId: row.source_id,
    status: row.status,
    attempts: Number(row.attempt ?? 0),
    ...(row.new_id ? { resultId: row.new_id } : {}),
    ...(metadataFinalName(row.metadata) ? { resultName: metadataFinalName(row.metadata) } : {}),
    detail: row.status === 'success'
      ? (row.new_id ? `新对象 ${row.new_id}` : null)
      : row.error,
  })));
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
    await applyTaskReadScope(tx, { companyId });
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

  return enrichCopyResultNames(companyId, rows.map((row) => {
    const resultId = parseCopyResultNewId(row.error);
    return {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      status: row.status,
      attempts: Number(row.attempts ?? 0),
      ...(resultId ? { resultId } : {}),
      detail: row.status === 'success'
        ? (resultId ? copyResultDetail(resultId) : row.error)
        : row.error,
    };
  }));
}

function parseCopyResultNewId(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const newId = (parsed as Record<string, unknown>)['newId'];
    return typeof newId === 'string' && newId ? newId : undefined;
  } catch {
    return undefined;
  }
}

function metadataFinalName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const finalName = (value as Record<string, unknown>)['finalName'];
  return typeof finalName === 'string' && finalName ? finalName : undefined;
}

async function enrichCopyResultNames<T extends TaskLayerProgressItem & { targetType: string }>(
  companyId: string,
  items: T[],
): Promise<T[]> {
  const resultItems = items.filter((item) => item.status === 'success' && item.resultId);
  if (resultItems.length === 0) return items;

  const names = await readLocalResultNames(companyId, resultItems);
  return items.map((item) => {
    if (item.status !== 'success' || !item.resultId) return item;
    const resultName = item.resultName ?? names.get(resultNameKey(item.targetType, item.resultId));
    return {
      ...item,
      ...(resultName ? { resultName } : {}),
      detail: copyResultDetail(item.resultId, resultName) ?? item.detail,
    };
  });
}

async function readLocalResultNames(
  companyId: string,
  items: Array<TaskLayerProgressItem & { targetType: string }>,
): Promise<Map<string, string>> {
  const idsByType = new Map<'campaign' | 'adset' | 'ad', Set<string>>([
    ['campaign', new Set<string>()],
    ['adset', new Set<string>()],
    ['ad', new Set<string>()],
  ]);

  for (const item of items) {
    const targetType = normalizeTargetType(item.targetType);
    if (targetType && item.resultId) idsByType.get(targetType)!.add(item.resultId);
  }

  const names = new Map<string, string>();
  await db.transaction(async (tx) => {
    await applyTaskReadScope(tx, { companyId });

    const campaignIds = Array.from(idsByType.get('campaign')!);
    for (const chunk of chunks(campaignIds, IN_QUERY_CHUNK_SIZE)) {
      const rows = await tx
        .select({ metaId: schema.adCampaigns.metaId, name: schema.adCampaigns.name })
        .from(schema.adCampaigns)
        .where(and(
          eq(schema.adCampaigns.companyId, companyId),
          inArray(schema.adCampaigns.metaId, chunk),
        ));
      for (const row of rows) names.set(resultNameKey('campaign', row.metaId), row.name);
    }

    const adsetIds = Array.from(idsByType.get('adset')!);
    for (const chunk of chunks(adsetIds, IN_QUERY_CHUNK_SIZE)) {
      const rows = await tx
        .select({ metaId: schema.adSetObjects.metaId, name: schema.adSetObjects.name })
        .from(schema.adSetObjects)
        .where(and(
          eq(schema.adSetObjects.companyId, companyId),
          inArray(schema.adSetObjects.metaId, chunk),
        ));
      for (const row of rows) names.set(resultNameKey('adset', row.metaId), row.name);
    }

    const adIds = Array.from(idsByType.get('ad')!);
    for (const chunk of chunks(adIds, IN_QUERY_CHUNK_SIZE)) {
      const rows = await tx
        .select({ metaId: schema.adObjects.metaId, name: schema.adObjects.name })
        .from(schema.adObjects)
        .where(and(
          eq(schema.adObjects.companyId, companyId),
          inArray(schema.adObjects.metaId, chunk),
        ));
      for (const row of rows) names.set(resultNameKey('ad', row.metaId), row.name);
    }
  });

  return names;
}

function normalizeTargetType(value: string): 'campaign' | 'adset' | 'ad' | null {
  if (value === 'campaign' || value === 'adset' || value === 'ad') return value;
  return null;
}

function resultNameKey(targetType: string, resultId: string): string {
  return `${targetType}:${resultId}`;
}

function copyResultDetail(resultId: string | null | undefined, resultName?: string): string | null {
  if (resultName && resultId) return `复制结果: ${resultName} (${resultId})`;
  if (resultName) return `复制结果: ${resultName}`;
  if (resultId) return `复制结果: ${resultId}`;
  return null;
}

/** 用于 SSE 端校验任务归属(不返实体) */
export async function assertTaskOwned(
  principal: AuthPrincipal,
  taskId: string,
): Promise<void> {
  const row = await readTaskRow(principal, taskId, 'own');
  if (!row) throw new HttpError(404, 404, 'task not found');
}

export async function assertAdminTaskVisible(
  principal: AuthPrincipal,
  taskId: string,
): Promise<void> {
  const row = await readTaskRow(principal, taskId, 'admin');
  if (!row) throw new HttpError(404, 404, 'task not found');
}

export async function pauseTask(principal: AuthPrincipal, taskId: string): Promise<void> {
  await pauseTaskWithAccess(principal, taskId, 'own', 'task paused by user');
}

export async function pauseAdminTask(principal: AuthPrincipal, taskId: string): Promise<void> {
  await pauseTaskWithAccess(principal, taskId, 'admin', 'task paused by admin');
}

async function pauseTaskWithAccess(
  principal: AuthPrincipal,
  taskId: string,
  access: TaskAccess,
  reason: string,
): Promise<void> {
  const updated = await updateTaskStatus(principal, taskId, 'paused', access);
  if (!updated) return;
  await db.transaction(async (tx) => {
    await applyTaskReadScope(tx, { companyId: updated.companyId });
    await tx.execute(dsql`
      UPDATE operation_copy_workflows
      SET status = 'paused',
          lease_owner = NULL,
          lease_until = NULL,
          error = ${reason},
          updated_at = now()
      WHERE task_id = ${taskId}
        AND status NOT IN ('success','partial','failed','canceled')
    `);
  });
  await setProgressStatus(taskId, 'paused');
}

export async function resumeTask(principal: AuthPrincipal, taskId: string): Promise<void> {
  await resumeTaskWithAccess(principal, taskId, 'own');
}

export async function resumeAdminTask(principal: AuthPrincipal, taskId: string): Promise<void> {
  await resumeTaskWithAccess(principal, taskId, 'admin');
}

async function resumeTaskWithAccess(
  principal: AuthPrincipal,
  taskId: string,
  access: TaskAccess,
): Promise<void> {
  const updated = await updateTaskStatus(principal, taskId, 'running', access);
  if (!updated) return;
  await db.transaction(async (tx) => {
    await applyTaskReadScope(tx, { companyId: updated.companyId });
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

export async function stopTask(principal: AuthPrincipal, taskId: string): Promise<void> {
  await stopTaskWithAccess(principal, taskId, 'own', 'task cancelled by user');
}

export async function stopAdminTask(principal: AuthPrincipal, taskId: string): Promise<void> {
  await stopTaskWithAccess(principal, taskId, 'admin', 'task cancelled by admin');
}

async function stopTaskWithAccess(
  principal: AuthPrincipal,
  taskId: string,
  access: TaskAccess,
  reason: string,
): Promise<void> {
  const updated = await updateTaskStatus(principal, taskId, 'cancelled', access);
  if (!updated) return;
  await db.transaction(async (tx) => {
    await applyTaskReadScope(tx, { companyId: updated.companyId });
    await tx.execute(dsql`
      UPDATE operation_copy_workflows
      SET status = 'canceled',
          lease_owner = NULL,
          lease_until = NULL,
          error = ${reason},
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
  access: TaskAccess,
): Promise<{ id: string; companyId: string } | null> {
  const scope = access === 'admin' ? adminReadScope(principal) : { companyId: principal.companyId };
  const visibilityCondition = access === 'admin'
    ? (scope.bypassRls ? dsql`` : dsql`AND company_id = ${principal.companyId}`)
    : dsql`AND company_id = ${principal.companyId} AND user_id = ${principal.userId}`;
  const rows = await db.transaction(async (tx) => {
    await applyTaskReadScope(tx, scope);
    return tx.execute(dsql`
      UPDATE operation_tasks
      SET status = ${status}::operation_status
      WHERE id = ${taskId}
        ${visibilityCondition}
        AND status NOT IN ('success','failed','partial','cancelled')
      RETURNING id, company_id
    `);
  }) as unknown as Array<{ id: string; company_id: string }>;
  if (rows.length === 0) {
    if (access === 'admin') {
      await assertAdminTaskVisible(principal, taskId);
    } else {
      await assertTaskOwned(principal, taskId);
    }
    return null;
  }
  return { id: rows[0]!.id, companyId: rows[0]!.company_id };
}
