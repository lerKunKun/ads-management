/**
 * 任务进度 (Redis hash + pubsub)。
 *   key  task:{taskId}:progress  hash{total, success, failed, status, updatedAt}
 *   chan task:{taskId}:event     publish 新快照 JSON,SSE 端订阅
 *
 * 设计:
 *   - DB 写入是真理之源(operation_tasks/items)；Redis 只是为 SSE 推送 +
 *     避免 SSE 每次轮询 DB 的"高频热点"。
 *   - 任务终态后保留 TTL=15 min 供前端拉取确认。
 */
import { redis } from './redis';

export const ProgressKey = (taskId: string) => `task:${taskId}:progress`;
export const ProgressChannel = (taskId: string) => `task:${taskId}:event`;

export type TaskStatus = 'pending' | 'running' | 'partial' | 'success' | 'failed' | 'cancelled';

export interface ProgressSnapshot {
  taskId: string;
  total: number;
  success: number;
  failed: number;
  status: TaskStatus;
  updatedAt: number;
}

export async function initProgress(taskId: string, total: number): Promise<void> {
  const key = ProgressKey(taskId);
  await redis.hmset(key, {
    total,
    success: 0,
    failed: 0,
    status: 'pending',
    updatedAt: Date.now(),
  });
  await redis.expire(key, 60 * 60); // 1h
}

export async function bumpProgress(
  taskId: string,
  delta: { success?: number; failed?: number },
): Promise<ProgressSnapshot> {
  const key = ProgressKey(taskId);
  if (delta.success) await redis.hincrby(key, 'success', delta.success);
  if (delta.failed) await redis.hincrby(key, 'failed', delta.failed);
  const data = await redis.hgetall(key);
  const total = Number(data['total'] ?? 0);
  const success = Number(data['success'] ?? 0);
  const failed = Number(data['failed'] ?? 0);
  let status: TaskStatus = (data['status'] as TaskStatus) ?? 'pending';
  // 仅在未终态时推进
  if (status !== 'success' && status !== 'failed' && status !== 'cancelled') {
    if (success + failed >= total) {
      status = failed === 0 ? 'success' : success === 0 ? 'failed' : 'partial';
    } else if (status === 'pending' && success + failed > 0) {
      status = 'running';
    }
    await redis.hset(key, 'status', status);
  }
  const updatedAt = Date.now();
  await redis.hset(key, 'updatedAt', updatedAt);
  const snap: ProgressSnapshot = { taskId, total, success, failed, status, updatedAt };
  await redis.publish(ProgressChannel(taskId), JSON.stringify(snap));
  if (status === 'success' || status === 'failed' || status === 'partial' || status === 'cancelled') {
    await redis.expire(key, 15 * 60);
  }
  return snap;
}

export async function setRunning(taskId: string): Promise<void> {
  const key = ProgressKey(taskId);
  const cur = await redis.hget(key, 'status');
  if (cur === 'pending') {
    await redis.hset(key, 'status', 'running');
  }
}

export async function readProgress(taskId: string): Promise<ProgressSnapshot | null> {
  const data = await redis.hgetall(ProgressKey(taskId));
  if (!data || Object.keys(data).length === 0) return null;
  return {
    taskId,
    total: Number(data['total'] ?? 0),
    success: Number(data['success'] ?? 0),
    failed: Number(data['failed'] ?? 0),
    status: (data['status'] as TaskStatus) ?? 'pending',
    updatedAt: Number(data['updatedAt'] ?? Date.now()),
  };
}
