/**
 * RabbitMQ 拓扑声明 + publish helper。
 *
 * 设计目标:
 *   - 同一广告账户的操作落同一 shard 队列 → 账户级串行,避 BUC 触限
 *   - 失败按阶梯延迟(5s/30s/2m)重投回 *相同 shard*,通过 per-shard retry queue 实现
 *     (用 x-dead-letter-routing-key 锁定回投 shard,不会混到其他分片)
 *   - 超过 maxAttempts → ad.ops.failed 终态死信队列
 *   - 高优(status/budget)/低优(copy/delete) 通过 x-max-priority 区分
 *
 * 拓扑(N=shardCount):
 *   ad.ops          (direct, durable)
 *     ├─ shard.0      [main, prio]    bind RK=shard.0
 *     ├─ ...
 *     └─ shard.{N-1}
 *
 *   ad.ops.dlx      (direct, durable)
 *     ├─ shard.0.retry.5s   TTL 5s    DLX=ad.ops, DLRK=shard.0
 *     ├─ shard.0.retry.30s  TTL 30s   DLX=ad.ops, DLRK=shard.0
 *     ├─ shard.0.retry.2m   TTL 120s  DLX=ad.ops, DLRK=shard.0
 *     ├─ ...                          (per shard × 3)
 *     └─ ad.ops.failed                终态死信(无 DLX)
 */
import amqp from 'amqplib';
import { env } from '../env';

export const RMQ = {
  exchange: 'ad.ops',
  dlx: 'ad.ops.dlx',
  shardCount: 16,
  retryLadders: [
    { suffix: 'retry.5s', ttl: 5_000 },
    { suffix: 'retry.30s', ttl: 30_000 },
    { suffix: 'retry.2m', ttl: 120_000 },
  ] as const,
  failedQueue: 'ad.ops.failed',
  maxPriority: 10,
  maxAttempts: 6,
} as const;

export interface OperationMessage {
  taskId: string;
  itemId: string;
  companyId: string;
  fbAccountId: string;
  adAccountId: string;      // 业务 uuid (用于 shard 哈希 + DB 关联)
  metaActId: string;        // act_xxx (Meta 实际 id)
  targetType: 'campaign' | 'adset' | 'ad';
  targetId: string;
  action:
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
  params: Record<string, unknown>;
  idempotencyKey: string;
  attempt: number;
}

type Channel = Awaited<ReturnType<Awaited<ReturnType<typeof amqp.connect>>['createConfirmChannel']>>;
type ChannelModel = Awaited<ReturnType<typeof amqp.connect>>;

let conn: ChannelModel | null = null;
let ch: Channel | null = null;

export async function getChannel(): Promise<Channel> {
  if (ch) return ch;
  const c = await amqp.connect(env.rabbitmqUrl);
  conn = c;
  ch = await c.createConfirmChannel();
  c.on('close', () => {
    conn = null;
    ch = null;
  });
  c.on('error', (e) => console.error('[rmq] connection error', e.message));
  return ch;
}

export function shardKey(adAccountId: string): string {
  let h = 0;
  for (let i = 0; i < adAccountId.length; i++) {
    h = (h * 31 + adAccountId.charCodeAt(i)) | 0;
  }
  return `shard.${Math.abs(h) % RMQ.shardCount}`;
}

export function priorityFor(action: OperationMessage['action']): number {
  if (action === 'campaign:status' || action === 'campaign:budget') return 8;
  return 3;
}

let asserted = false;
export async function assertTopology(): Promise<void> {
  if (asserted) return;
  const c = await getChannel();

  await c.assertExchange(RMQ.exchange, 'direct', { durable: true });
  await c.assertExchange(RMQ.dlx, 'direct', { durable: true });

  for (let i = 0; i < RMQ.shardCount; i++) {
    const main = `shard.${i}`;
    await c.assertQueue(main, {
      durable: true,
      maxPriority: RMQ.maxPriority,
      arguments: {
        'x-dead-letter-exchange': RMQ.dlx,
      },
    });
    await c.bindQueue(main, RMQ.exchange, main);

    for (const ladder of RMQ.retryLadders) {
      const rq = `${main}.${ladder.suffix}`;
      await c.assertQueue(rq, {
        durable: true,
        maxPriority: RMQ.maxPriority,
        arguments: {
          'x-message-ttl': ladder.ttl,
          'x-dead-letter-exchange': RMQ.exchange,
          'x-dead-letter-routing-key': main,
        },
      });
      await c.bindQueue(rq, RMQ.dlx, rq);
    }
  }

  await c.assertQueue(RMQ.failedQueue, {
    durable: true,
    maxPriority: RMQ.maxPriority,
  });
  await c.bindQueue(RMQ.failedQueue, RMQ.dlx, RMQ.failedQueue);

  asserted = true;
}

/** attempt 越高延迟越长。attempt 1→5s, 2→30s, ≥3→2m */
export function ladderFor(attempt: number): (typeof RMQ.retryLadders)[number] {
  if (attempt <= 1) return RMQ.retryLadders[0];
  if (attempt === 2) return RMQ.retryLadders[1];
  return RMQ.retryLadders[2];
}

export async function publishOperation(msg: OperationMessage): Promise<void> {
  await assertTopology();
  const c = await getChannel();
  const rk = shardKey(msg.adAccountId);
  const buf = Buffer.from(JSON.stringify(msg));
  c.publish(RMQ.exchange, rk, buf, {
    persistent: true,
    priority: priorityFor(msg.action),
    messageId: msg.itemId,
    headers: {
      'x-task-id': msg.taskId,
      'x-attempt': msg.attempt,
    },
  });
}

/** 入 per-shard retry queue. TTL 到期后 dead-letter 回主 shard 队列。 */
export async function publishRetry(msg: OperationMessage): Promise<void> {
  await assertTopology();
  const c = await getChannel();
  const ladder = ladderFor(msg.attempt);
  const rq = `${shardKey(msg.adAccountId)}.${ladder.suffix}`;
  const buf = Buffer.from(JSON.stringify(msg));
  c.publish(RMQ.dlx, rq, buf, {
    persistent: true,
    priority: priorityFor(msg.action),
    messageId: msg.itemId,
    headers: {
      'x-task-id': msg.taskId,
      'x-attempt': msg.attempt,
    },
  });
}

/** 终态死信。Worker 在 attempt 达到 maxAttempts 时调用。 */
export async function publishDead(msg: OperationMessage, reason: string): Promise<void> {
  await assertTopology();
  const c = await getChannel();
  const buf = Buffer.from(JSON.stringify({ ...msg, deadReason: reason }));
  c.publish(RMQ.dlx, RMQ.failedQueue, buf, {
    persistent: true,
    priority: priorityFor(msg.action),
    messageId: msg.itemId,
    headers: {
      'x-task-id': msg.taskId,
      'x-attempt': msg.attempt,
      'x-dead-reason': reason,
    },
  });
}

export async function waitConfirms(): Promise<void> {
  if (!ch) return;
  await ch.waitForConfirms();
}
