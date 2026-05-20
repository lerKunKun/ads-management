/**
 * 测试模式: META_FAKE=1 时直接绕过真实 Meta 调用。
 * 用于 M3 集成冒烟：在没有真实 token 的情况下端到端验流水线/限流/进度/重试。
 *
 * 行为:
 *   FAKE_FAIL_RATE  ∈ [0..1]    随机失败概率
 *   FAKE_RATELIMIT_RATE  ∈ [0..1] 抛 MetaApiError(限流)
 *   FAKE_DELAY_MS  动作耗时
 */
import { MetaApiError } from '../../api/src/lib/meta-client';

export function isFake(): boolean {
  return process.env['META_FAKE'] === '1';
}

const f = (k: string, d: number) => {
  const v = process.env[k];
  if (!v) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export async function runFake(action: string): Promise<void> {
  const fail = f('FAKE_FAIL_RATE', 0);
  const rl = f('FAKE_RATELIMIT_RATE', 0);
  const delay = f('FAKE_DELAY_MS', 20);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  const r = Math.random();
  if (r < rl) {
    // code=17 = User request limit reached
    throw new MetaApiError(429, 17, undefined, 'OAuthException', 'fake-trace', `fake rate-limited (${action})`);
  }
  if (r < rl + fail) {
    // code=2 = service unavailable / generic transient
    throw new MetaApiError(500, 2, undefined, 'GraphMethodException', 'fake-trace', `fake transient (${action})`);
  }
}
