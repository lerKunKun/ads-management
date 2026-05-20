/**
 * Redis 熔断器 (账户级 + 个号级)。
 *   - openFor(key, seconds): SETEX 标记熔断
 *   - isOpen(key):           判定
 *   - close(key):            手动解除
 *
 * Worker 调 Meta 触发限流(error code 17/4/32) → openFor(adAccount) 60s。
 * Token 失效(190) → openFor(fbAccount) 永久(直到管理员重新授权)。
 */
import { redis } from './redis';

export const BreakerKey = {
  adAccount: (metaActId: string) => `breaker:adacct:${metaActId}`,
  fbAccount: (fbAccountId: string) => `breaker:fb:${fbAccountId}`,
};

export async function openFor(key: string, seconds: number, reason = ''): Promise<void> {
  if (seconds <= 0) {
    await redis.set(key, reason || '1');
  } else {
    await redis.set(key, reason || '1', 'EX', seconds);
  }
}

export async function isOpen(key: string): Promise<boolean> {
  return (await redis.exists(key)) === 1;
}

export async function close(key: string): Promise<void> {
  await redis.del(key);
}

/** 并发检查多 key, 任一打开返回原因 */
export async function checkAll(
  keys: string[],
): Promise<{ open: boolean; key?: string; reason?: string }> {
  for (const k of keys) {
    const v = await redis.get(k);
    if (v !== null) return { open: true, key: k, reason: v };
  }
  return { open: false };
}
