/**
 * 任务详情查询 + 实时进度合并(Redis 进度优先,fall back DB)。
 * 跨租户/作用域守卫: 仅当 task.company_id == principal.companyId 才放行。
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../lib/db';
import { readProgress, type ProgressSnapshot } from '../../lib/progress';
import { HttpError } from '../../lib/http-error';
import type { AuthPrincipal } from '../iam/auth-service';

export interface TaskDetail extends ProgressSnapshot {
  type: string;
  payload: unknown;
  createdAt: string;
  userId: string;
  /** 失败/未完成 item 抽样 (M3 简化: 最多 50 条) */
  failures: Array<{ id: string; targetId: string; error: string | null; attempts: number }>;
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
  const snap = (await readProgress(taskId)) ?? {
    taskId,
    total: row.total,
    success: row.success,
    failed: row.failed,
    status: row.status,
    updatedAt: row.createdAt.getTime(),
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
      .limit(50);
  });

  return {
    ...snap,
    type: row.type,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    userId: row.userId,
    failures,
  };
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
