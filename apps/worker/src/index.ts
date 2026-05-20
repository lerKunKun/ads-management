/**
 * Worker 入口: 起 N 个 shard 消费者，prefetch=5。
 * 调度: handler.handle(msg) → ack / retry(publishRetry) / dead(publishDead)
 */
import {
  assertTopology,
  getChannel,
  publishRetry,
  publishDead,
  RMQ,
  type OperationMessage,
} from '../../api/src/lib/rabbitmq-topology';
import { handle } from './handler';

const PREFETCH = Number(process.env['WORKER_PREFETCH'] ?? '5');

async function main() {
  await assertTopology();
  const ch = await getChannel();
  await ch.prefetch(PREFETCH);

  for (let i = 0; i < RMQ.shardCount; i++) {
    const q = `shard.${i}`;
    await ch.consume(
      q,
      async (raw) => {
        if (!raw) return;
        let msg: OperationMessage;
        try {
          msg = JSON.parse(raw.content.toString()) as OperationMessage;
        } catch (e) {
          console.error('[worker] bad message dropped', e);
          ch.ack(raw);
          return;
        }
        // attempt 增量在 retry path 里加
        try {
          const out = await handle(msg);
          if (out.kind === 'ack') {
            ch.ack(raw);
            return;
          }
          if (out.kind === 'retry') {
            const bump = out.bumpAttempt !== false;
            const nextAttempt = bump ? msg.attempt + 1 : msg.attempt;
            await publishRetry({ ...msg, attempt: nextAttempt });
            ch.ack(raw);
            if (bump) {
              console.warn(
                `[worker] retry task=${msg.taskId} item=${msg.itemId} attempt=${msg.attempt} -> ${nextAttempt}: ${out.reason}`,
              );
            }
            return;
          }
          // dead
          await publishDead(msg, out.reason);
          ch.ack(raw);
          console.error(
            `[worker] dead task=${msg.taskId} item=${msg.itemId}: ${out.reason}`,
          );
        } catch (e) {
          console.error('[worker] unhandled', e);
          // 让 broker 重发,不要丢
          ch.nack(raw, false, true);
        }
      },
      { noAck: false, consumerTag: `${q}.worker` },
    );
    console.log(`[worker] consuming ${q}`);
  }
}

main().catch((e) => {
  console.error('[worker] fatal', e);
  process.exit(1);
});
