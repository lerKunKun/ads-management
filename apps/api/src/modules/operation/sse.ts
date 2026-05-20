/**
 * 任务进度 SSE: 订阅 Redis pubsub `task:{taskId}:event`，把快照推给前端。
 *   - 进入时先 emit 当前 Redis 快照(若有)
 *   - 终态(success/failed/partial/cancelled) 自动断开
 *   - 客户端 disconnect 自动取消订阅
 *
 * 注意: ioredis 的 subscribe 必须用独立连接（subscriber 模式禁止其他命令）。
 */
import Redis from 'ioredis';
import { env } from '../../env';
import { ProgressChannel, readProgress, type ProgressSnapshot } from '../../lib/progress';

const TERMINAL = new Set(['success', 'failed', 'partial', 'cancelled']);

export async function* progressStream(taskId: string): AsyncGenerator<string> {
  const channel = ProgressChannel(taskId);

  // 1) 初始快照
  const initial = await readProgress(taskId);
  if (initial) {
    yield formatEvent(initial);
    if (TERMINAL.has(initial.status)) return;
  }

  // 2) 订阅 Redis pubsub
  const sub = new Redis(env.redisUrl, { maxRetriesPerRequest: 3 });
  const queue: string[] = [];
  let resolveNext: ((v: string | null) => void) | null = null;
  let closed = false;

  sub.on('message', (chan, msg) => {
    if (chan !== channel) return;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(msg);
    } else {
      queue.push(msg);
    }
  });

  await sub.subscribe(channel);

  // 3) heartbeat 每 25s 一次(防中间代理超时;浏览器 EventSource 默认 5s 重连无问题)
  const hb = setInterval(() => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(':hb\n\n');
    } else {
      queue.push(':hb\n\n');
    }
  }, 25_000);

  try {
    while (!closed) {
      let payload: string | null;
      if (queue.length) {
        payload = queue.shift()!;
      } else {
        payload = await new Promise<string | null>((res) => (resolveNext = res));
      }
      if (payload === null) break;
      if (payload.startsWith(':hb')) {
        yield payload;
        continue;
      }
      // 是真实事件
      yield formatEvent(JSON.parse(payload) as ProgressSnapshot);
      try {
        const snap = JSON.parse(payload) as ProgressSnapshot;
        if (TERMINAL.has(snap.status)) {
          closed = true;
        }
      } catch {
        /* skip */
      }
    }
  } finally {
    clearInterval(hb);
    try {
      await sub.unsubscribe(channel);
    } catch {
      /* */
    }
    sub.disconnect();
  }
}

function formatEvent(snap: ProgressSnapshot): string {
  return `event: progress\ndata: ${JSON.stringify(snap)}\n\n`;
}
