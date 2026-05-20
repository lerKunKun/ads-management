/**
 * 操作锁: 同一 target 短时间内并发改 → 用 SETNX 抢锁,防双写。
 * 锁粒度 = (targetId)。TTL 默认 30s,覆盖 Meta 调用 + DB 写入时间。
 */
import { redis } from './redis';
import { randomUUID } from 'node:crypto';

export const OpLockKey = (targetId: string) => `lock:target:${targetId}`;

export interface AcquiredLock {
  key: string;
  token: string;
  release: () => Promise<void>;
}

export async function acquireOpLock(
  targetId: string,
  ttlSec = 30,
): Promise<AcquiredLock | null> {
  const key = OpLockKey(targetId);
  const token = randomUUID();
  const ok = await redis.set(key, token, 'EX', ttlSec, 'NX');
  if (ok !== 'OK') return null;
  return {
    key,
    token,
    release: async () => {
      // 只删自己持有的锁
      const lua = `if redis.call('GET', KEYS[1])==ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
      await redis.eval(lua, 1, key, token);
    },
  };
}
