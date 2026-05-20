/**
 * 极简内置定时器。MVP: 进程内 setInterval, 单实例足够。
 *   - 多实例部署后需要分布式锁(Redis SETNX 占主),M5+ 抽 cron 服务。
 */
import { scanTokenHealth } from '../modules/account/service';

const SIX_HOURS = 6 * 3600 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (timer) return;
  // 启动后 30s 跑一次首扫(等 db/redis warm-up),之后每 6h
  setTimeout(() => {
    runTokenHealth();
    timer = setInterval(runTokenHealth, SIX_HOURS);
  }, 30_000);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function runTokenHealth(): Promise<void> {
  try {
    const r = await scanTokenHealth();
    console.log(`[scheduler] tokenHealth scanned=${r.scanned} notified=${r.notified}`);
  } catch (e) {
    console.error('[scheduler] tokenHealth failed', e);
  }
}
