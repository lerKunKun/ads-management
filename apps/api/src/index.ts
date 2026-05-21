/**
 * Elysia API 入口。模块挂载在下方。Eden 通过 `export type App` 传到 packages/eden。
 */
import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { randomUUID } from 'node:crypto';
import { env } from './env';
import { iam } from './modules/iam';
import { account } from './modules/account';
import { operation } from './modules/operation';
import { admin } from './modules/admin';
import { HttpError } from './lib/http-error';
import { assertTopology } from './lib/rabbitmq-topology';
import { startScheduler } from './lib/scheduler';

function ensureRequestId(
  request: Request,
  set: { headers: Record<string, string | number> },
): string {
  const existing = request.headers.get('x-request-id') ?? set.headers['x-request-id'];
  const requestId = existing ? String(existing) : randomUUID();
  set.headers['x-request-id'] = requestId;
  return requestId;
}

export const app = new Elysia()
  .use(cors())
  .onRequest(({ request, set }) => {
    ensureRequestId(request, set);
  })
  .onError(({ code, error, request, set }) => {
    const requestId = ensureRequestId(request, set);
    if (error instanceof HttpError) {
      set.status = error.status;
      return { code: error.bizCode, msg: error.message, data: null, requestId };
    }
    if (code === 'VALIDATION') {
      set.status = 422;
      return {
        code: 422,
        msg: 'validation failed',
        data: String((error as Error).message),
        requestId,
      };
    }
    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { code: 404, msg: 'not found', data: null, requestId };
    }
    console.error('[api:error]', {
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      error,
    });
    set.status = 500;
    return { code: 500, msg: 'internal error', data: null, requestId };
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
