import { treaty } from '@elysiajs/eden';
import type { App } from '@ads/api/src/index';

export type { App };

export function createClient(baseUrl: string, token?: string) {
  return treaty<App>(baseUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}

export type AdsClient = ReturnType<typeof createClient>;
