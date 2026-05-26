import { eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../../api/src/lib/db';

export class TaskPausedError extends Error {
  constructor(taskId: string) {
    super(`task paused: ${taskId}`);
    this.name = 'TaskPausedError';
  }
}

export class TaskCancelledError extends Error {
  constructor(taskId: string) {
    super(`task cancelled: ${taskId}`);
    this.name = 'TaskCancelledError';
  }
}

export async function readTaskStatus(taskId: string): Promise<string | undefined> {
  return db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.bypass_rls', '1', true)`);
    const rows = await tx
      .select({ status: schema.operationTasks.status })
      .from(schema.operationTasks)
      .where(eq(schema.operationTasks.id, taskId))
      .limit(1);
    return rows[0]?.status;
  });
}

export async function assertTaskRunnable(taskId: string): Promise<void> {
  const status = await readTaskStatus(taskId);
  if (status === 'paused') throw new TaskPausedError(taskId);
  if (status === 'cancelled') throw new TaskCancelledError(taskId);
}
