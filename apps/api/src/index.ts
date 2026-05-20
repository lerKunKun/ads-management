/**
 * Elysia API 入口。模块挂载在下方。Eden 通过 `export type App` 传到 packages/eden。
 */
import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { env } from './env';
import { iam } from './modules/iam';
import { account } from './modules/account';
import { operation } from './modules/operation';
import { admin } from './modules/admin';
import { HttpError } from './lib/http-error';
import { assertTopology } from './lib/rabbitmq-topology';
import { startScheduler } from './lib/scheduler';

export const app = new Elysia()
  .use(cors())
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { code: error.bizCode, msg: error.message, data: null };
    }
    if (code === 'VALIDATION') {
      set.status = 422;
      return { code: 422, msg: 'validation failed', data: String((error as Error).message) };
    }
    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { code: 404, msg: 'not found', data: null };
    }
    console.error('[api:error]', error);
    set.status = 500;
    return { code: 500, msg: 'internal error', data: null };
  })
  .get('/health', () => ({ code: 0, msg: 'ok', data: { ts: Date.now() } }))
  .use(iam)
  .use(account)
  .use(operation)
  .use(admin);

export type App = typeof app;

if (import.meta.main) {
  assertTopology()
    .then(() => console.log('[api] rabbitmq topology asserted'))
    .catch((e) => console.error('[api] rabbitmq topology failed:', e.message));
  startScheduler();
  app.listen(env.apiPort, () => {
    console.log(`[api] listening on http://localhost:${env.apiPort}`);
  });
}
