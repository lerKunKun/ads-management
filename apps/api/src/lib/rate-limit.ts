/**
 * Redis 原子令牌桶(token bucket)。
 *   - 账户级: ratelimit:adacct:{act_id}  capacity=20  refill=2/s
 *   - 全局级: ratelimit:app              capacity=200 refill=20/s
 *
 * 上面的容量是 MVP 起步值;Worker 会根据 Meta 响应头(X-Business-Use-Case-Usage /
 * X-Ad-Account-Usage)在 adjustRateLimit() 里动态收紧。
 *
 * Lua 脚本保证 read-modify-write 原子,避免多 Worker 并发突破容量。
 */
import { redis } from './redis';

const SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now_ms
end
local delta = (now_ms - ts) / 1000.0 * refill_per_sec
tokens = math.min(capacity, tokens + delta)
local allowed = 0
local wait_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait_ms = math.ceil((cost - tokens) / refill_per_sec * 1000)
end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now_ms)
-- TTL 设置成 桶填满所需时间 + 60s buffer，闲置桶自动回收
local ttl = math.ceil(capacity / refill_per_sec) + 60
redis.call('EXPIRE', key, ttl)
return { allowed, wait_ms }
`;

let scriptSha: string | null = null;
async function loadScript(): Promise<string> {
  if (scriptSha) return scriptSha;
  scriptSha = await redis.script('LOAD', SCRIPT) as string;
  return scriptSha;
}

export interface BucketSpec {
  key: string;
  capacity: number;
  refillPerSec: number;
}

export const DEFAULT_BUCKETS = {
  adAccount: (metaActId: string): BucketSpec => ({
    key: `ratelimit:adacct:${metaActId}`,
    capacity: 20,
    refillPerSec: 2,
  }),
  app: (): BucketSpec => ({
    key: 'ratelimit:app',
    capacity: 200,
    refillPerSec: 20,
  }),
};

/**
 * 尝试一次性消耗多桶的 cost；任一不足返回 { allowed:false, waitMs:max(...) }。
 */
export async function acquire(
  buckets: BucketSpec[],
  cost = 1,
): Promise<{ allowed: boolean; waitMs: number }> {
  const sha = await loadScript();
  const now = Date.now();
  let maxWait = 0;
  // 简化: 顺序尝试。第一个不通过即 return,避免半提交。
  // (强一致需要 multi-key Lua;MVP 这里粒度够。)
  const acquired: BucketSpec[] = [];
  for (const b of buckets) {
    const r = (await redis.evalsha(
      sha,
      1,
      b.key,
      b.capacity,
      b.refillPerSec,
      now,
      cost,
    )) as [number, number];
    if (r[0] === 1) {
      acquired.push(b);
    } else {
      // 已 acquire 的桶把令牌退回（best-effort，非严格事务）
      for (const back of acquired) {
        await redis.hincrbyfloat(back.key, 'tokens', cost);
      }
      return { allowed: false, waitMs: r[1] };
    }
    if (r[1] > maxWait) maxWait = r[1];
  }
  return { allowed: true, waitMs: 0 };
}

/**
 * 根据 Meta 响应头(Business-Use-Case-Usage / Ad-Account-Usage)动态调整桶容量。
 * Meta 返回的是百分比，逼近 100 就降速。
 */
export async function adjustFromMetaHeaders(
  metaActId: string,
  headers: Headers,
): Promise<void> {
  const bucKey = `ratelimit:adacct:${metaActId}`;
  const usagePct = parseUsagePct(headers);
  if (usagePct === null) return;
  // 当 usage >= 90: 把当前 tokens 砸到 0；>= 75: 减半。
  if (usagePct >= 90) {
    await redis.hset(bucKey, 'tokens', 0);
  } else if (usagePct >= 75) {
    const cur = Number((await redis.hget(bucKey, 'tokens')) ?? '0');
    if (cur > 0) await redis.hset(bucKey, 'tokens', cur / 2);
  }
}

function parseUsagePct(headers: Headers): number | null {
  let max = -1;
  // X-Ad-Account-Usage: {"acc_id_util_pct":83, ...}
  const ad = headers.get('x-ad-account-usage');
  if (ad) {
    try {
      const j = JSON.parse(ad) as { acc_id_util_pct?: number };
      if (typeof j.acc_id_util_pct === 'number') {
        max = Math.max(max, j.acc_id_util_pct);
      }
    } catch {
      /* */
    }
  }
  // X-Business-Use-Case-Usage: {"<bizId>": [{"call_count":1,"total_cputime":2,"total_time":3,"type":"ads_management","estimated_time_to_regain_access":0}]}
  const buc = headers.get('x-business-use-case-usage');
  if (buc) {
    try {
      const j = JSON.parse(buc) as Record<
        string,
        Array<{ call_count?: number; total_cputime?: number; total_time?: number }>
      >;
      for (const list of Object.values(j)) {
        for (const entry of list) {
          const v = Math.max(
            entry.call_count ?? 0,
            entry.total_cputime ?? 0,
            entry.total_time ?? 0,
          );
          if (v > max) max = v;
        }
      }
    } catch {
      /* */
    }
  }
  return max >= 0 ? max : null;
}
