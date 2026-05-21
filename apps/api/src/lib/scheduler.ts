/**
 * Minimal in-process scheduler. Multi-instance deployments should move this to
 * a dedicated cron worker with a distributed lock.
 */
import { scanTokenHealth } from '../modules/account/service';
import { syncDueAdAccounts } from '../modules/ad-object/sync-service';
import { env } from '../env';

const SIX_HOURS = 6 * 3600 * 1000;

let tokenTimer: NodeJS.Timeout | null = null;
let adObjectTimer: NodeJS.Timeout | null = null;
let adObjectSyncRunning = false;

export function startScheduler(): void {
  if (tokenTimer || adObjectTimer) return;

  setTimeout(() => {
    runTokenHealth();
    tokenTimer = setInterval(runTokenHealth, SIX_HOURS);
  }, 30_000);

  if (env.adObjectSyncEnabled) {
    const interval = Math.max(env.adObjectSyncIntervalMs, 60_000);
    setTimeout(() => {
      runAdObjectSync();
      adObjectTimer = setInterval(runAdObjectSync, interval);
    }, 90_000);
  }
}

export function stopScheduler(): void {
  if (tokenTimer) clearInterval(tokenTimer);
  if (adObjectTimer) clearInterval(adObjectTimer);
  tokenTimer = null;
  adObjectTimer = null;
}

async function runTokenHealth(): Promise<void> {
  try {
    const r = await scanTokenHealth();
    console.log(`[scheduler] tokenHealth scanned=${r.scanned} notified=${r.notified}`);
  } catch (e) {
    console.error('[scheduler] tokenHealth failed', e);
  }
}

async function runAdObjectSync(): Promise<void> {
  if (adObjectSyncRunning) return;
  adObjectSyncRunning = true;
  try {
    const r = await syncDueAdAccounts();
    console.log(
      `[scheduler] adObjectSync candidates=${r.candidates} synced=${r.synced} skipped=${r.skipped} failed=${r.failed}`,
    );
  } catch (e) {
    console.error('[scheduler] adObjectSync failed', e);
  } finally {
    adObjectSyncRunning = false;
  }
}
