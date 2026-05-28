import { Elysia, t } from 'elysia';
import { authGuard, requirePermission } from '../../middleware/auth';
import * as svc from './service';
import * as batchSvc from './batch-service';
import * as q from './query-service';
import { progressStream } from './sse';
import type { DatePreset } from '../../lib/meta-client';

function ipOf(request: Request): string | undefined {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    undefined
  );
}

const datePresetSchema = t.Union([
  t.Literal('today'),
  t.Literal('yesterday'),
  t.Literal('last_7d'),
  t.Literal('last_30d'),
  t.Literal('maximum'),
]);

const renameOptionsSchema = t.Optional(
  t.Object({
    rename_strategy: t.Optional(
      t.Union([
        t.Literal('DEEP_COPY_RENAME'),
        t.Literal('NO_RENAME'),
        t.Literal('ONLY_TOP_LEVEL_RENAME'),
      ]),
    ),
    rename_prefix: t.Optional(t.String({ maxLength: 200 })),
    rename_suffix: t.Optional(t.String({ maxLength: 200 })),
  }),
);

const statusOptionSchema = t.Optional(
  t.Union([
    t.Literal('ACTIVE'),
    t.Literal('PAUSED'),
    t.Literal('INHERITED_FROM_SOURCE'),
  ]),
);

export const operation = new Elysia({ name: 'operation' })
  .get('/_operation/ping', () => ({ code: 0, msg: 'ok', data: 'operation' }))
  .group('', (g) =>
    g
      .use(authGuard)

      // ===== Ad account summary =====
      .get(
        '/ad-accounts/:id/summary',
        async ({ principal, params }) => {
          const data = await svc.getAdAccountSummary(principal, params.id);
          return { code: 0, msg: 'ok', data };
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          beforeHandle: requirePermission('ad_account:read'),
        },
      )

      // ===== Campaign list / 单操作 =====
      .get(
        '/ad-accounts/:id/campaigns',
        async ({ principal, params }) => {
          const data = await svc.listCampaigns(principal, params.id);
          return { code: 0, msg: 'ok', data };
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          beforeHandle: requirePermission('ad_account:read'),
        },
      )
      .post(
        '/campaigns/:id/status',
        async ({ principal, params, body, request }) => {
          await svc.setCampaignStatus(principal, {
            adAccountId: body.adAccountId,
            campaignId: params.id,
            status: body.status,
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: null };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: t.Object({
            adAccountId: t.String({ format: 'uuid' }),
            status: t.Union([t.Literal('ACTIVE'), t.Literal('PAUSED'), t.Literal('ARCHIVED')]),
          }),
          beforeHandle: requirePermission('campaign:status'),
        },
      )
      .post(
        '/campaigns/:id/budget',
        async ({ principal, params, body, request }) => {
          await svc.setCampaignBudget(principal, {
            adAccountId: body.adAccountId,
            campaignId: params.id,
            ...(body.dailyBudget !== undefined ? { dailyBudget: body.dailyBudget } : {}),
            ...(body.lifetimeBudget !== undefined ? { lifetimeBudget: body.lifetimeBudget } : {}),
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: null };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: t.Object({
            adAccountId: t.String({ format: 'uuid' }),
            dailyBudget: t.Optional(t.Integer({ minimum: 1 })),
            lifetimeBudget: t.Optional(t.Integer({ minimum: 1 })),
          }),
          beforeHandle: requirePermission('campaign:budget'),
        },
      )
      .post(
        '/campaigns/:id/copy',
        async ({ principal, params, body, request }) => {
          const r = await svc.copyEntity(principal, {
            adAccountId: body.adAccountId,
            targetType: 'campaign',
            sourceId: params.id,
            ...(body.count !== undefined ? { count: body.count } : {}),
            ...(body.deepCopy !== undefined ? { deepCopy: body.deepCopy } : {}),
            ...(body.startTime ? { startTime: body.startTime } : {}),
            ...(body.endTime ? { endTime: body.endTime } : {}),
            ...(body.dailyBudget !== undefined ? { dailyBudget: body.dailyBudget } : {}),
            ...(body.lifetimeBudget !== undefined ? { lifetimeBudget: body.lifetimeBudget } : {}),
            ...(body.statusOption ? { statusOption: body.statusOption } : {}),
            ...(body.renameOptions ? { renameOptions: body.renameOptions } : {}),
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: r };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: t.Object({
            adAccountId: t.String({ format: 'uuid' }),
            count: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
            deepCopy: t.Optional(t.Boolean()),
            startTime: t.Optional(t.String()),
            endTime: t.Optional(t.String()),
            dailyBudget: t.Optional(t.Integer({ minimum: 1 })),
            lifetimeBudget: t.Optional(t.Integer({ minimum: 1 })),
            statusOption: statusOptionSchema,
            renameOptions: renameOptionsSchema,
          }),
          beforeHandle: requirePermission('campaign:copy'),
        },
      )
      .post(
        '/campaigns/:id/delete',
        async ({ principal, params, body, request }) => {
          await svc.deleteEntity(principal, {
            adAccountId: body.adAccountId,
            targetType: 'campaign',
            targetId: params.id,
            ...(body.hard !== undefined ? { hard: body.hard } : {}),
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: null };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: t.Object({
            adAccountId: t.String({ format: 'uuid' }),
            hard: t.Optional(t.Boolean()),
          }),
          beforeHandle: requirePermission('campaign:delete'),
        },
      )

      // ===== AdSet =====
      .get(
        '/ad-accounts/:id/campaigns/:cid/adsets',
        async ({ principal, params }) => {
          const data = await svc.listAdSets(principal, params.id, params.cid);
          return { code: 0, msg: 'ok', data };
        },
        {
          params: t.Object({
            id: t.String({ format: 'uuid' }),
            cid: t.String({ minLength: 1 }),
          }),
          beforeHandle: requirePermission('ad_account:read'),
        },
      )
      .post(
        '/adsets/:id/status',
        async ({ principal, params, body, request }) => {
          await svc.setAdSetStatus(principal, {
            adAccountId: body.adAccountId,
            adsetId: params.id,
            status: body.status,
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: null };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: t.Object({
            adAccountId: t.String({ format: 'uuid' }),
            status: t.Union([t.Literal('ACTIVE'), t.Literal('PAUSED'), t.Literal('ARCHIVED')]),
          }),
          beforeHandle: requirePermission('campaign:status'),
        },
      )
      .post(
        '/adsets/:id/budget',
        async ({ principal, params, body, request }) => {
          await svc.setAdSetBudget(principal, {
            adAccountId: body.adAccountId,
            adsetId: params.id,
            ...(body.dailyBudget !== undefined ? { dailyBudget: body.dailyBudget } : {}),
            ...(body.lifetimeBudget !== undefined ? { lifetimeBudget: body.lifetimeBudget } : {}),
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: null };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: t.Object({
            adAccountId: t.String({ format: 'uuid' }),
            dailyBudget: t.Optional(t.Integer({ minimum: 1 })),
            lifetimeBudget: t.Optional(t.Integer({ minimum: 1 })),
          }),
          beforeHandle: requirePermission('campaign:budget'),
        },
      )
      .post(
        '/adsets/:id/copy',
        async ({ principal, params, body, request }) => {
          const r = await svc.copyEntity(principal, {
            adAccountId: body.adAccountId,
            targetType: 'adset',
            sourceId: params.id,
            ...(body.count !== undefined ? { count: body.count } : {}),
            ...(body.deepCopy !== undefined ? { deepCopy: body.deepCopy } : {}),
            ...(body.startTime ? { startTime: body.startTime } : {}),
            ...(body.endTime ? { endTime: body.endTime } : {}),
            ...(body.dailyBudget !== undefined ? { dailyBudget: body.dailyBudget } : {}),
            ...(body.lifetimeBudget !== undefined ? { lifetimeBudget: body.lifetimeBudget } : {}),
            ...(body.statusOption ? { statusOption: body.statusOption } : {}),
            ...(body.renameOptions ? { renameOptions: body.renameOptions } : {}),
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: r };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: t.Object({
            adAccountId: t.String({ format: 'uuid' }),
            count: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
            deepCopy: t.Optional(t.Boolean()),
            startTime: t.Optional(t.String()),
            endTime: t.Optional(t.String()),
            dailyBudget: t.Optional(t.Integer({ minimum: 1 })),
            lifetimeBudget: t.Optional(t.Integer({ minimum: 1 })),
            statusOption: statusOptionSchema,
            renameOptions: renameOptionsSchema,
          }),
          beforeHandle: requirePermission('campaign:copy'),
        },
      )
      .post(
        '/adsets/:id/delete',
        async ({ principal, params, body, request }) => {
          await svc.deleteEntity(principal, {
            adAccountId: body.adAccountId,
            targetType: 'adset',
            targetId: params.id,
            ...(body.hard !== undefined ? { hard: body.hard } : {}),
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: null };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: t.Object({
            adAccountId: t.String({ format: 'uuid' }),
            hard: t.Optional(t.Boolean()),
          }),
          beforeHandle: requirePermission('campaign:delete'),
        },
      )

      // ===== Ad =====
      .get(
        '/ad-accounts/:id/adsets/:asid/ads',
        async ({ principal, params }) => {
          const data = await svc.listAds(principal, params.id, params.asid);
          return { code: 0, msg: 'ok', data };
        },
        {
          params: t.Object({
            id: t.String({ format: 'uuid' }),
            asid: t.String({ minLength: 1 }),
          }),
          beforeHandle: requirePermission('ad_account:read'),
        },
      )
      .post(
        '/ads/:id/status',
        async ({ principal, params, body, request }) => {
          await svc.setAdStatus(principal, {
            adAccountId: body.adAccountId,
            adId: params.id,
            status: body.status,
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: null };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: t.Object({
            adAccountId: t.String({ format: 'uuid' }),
            status: t.Union([t.Literal('ACTIVE'), t.Literal('PAUSED'), t.Literal('ARCHIVED')]),
          }),
          beforeHandle: requirePermission('campaign:status'),
        },
      )
      .post(
        '/ads/:id/copy',
        async ({ principal, params, body, request }) => {
          const r = await svc.copyEntity(principal, {
            adAccountId: body.adAccountId,
            targetType: 'ad',
            sourceId: params.id,
            ...(body.count !== undefined ? { count: body.count } : {}),
            ...(body.statusOption ? { statusOption: body.statusOption } : {}),
            ...(body.renameOptions ? { renameOptions: body.renameOptions } : {}),
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: r };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: t.Object({
            adAccountId: t.String({ format: 'uuid' }),
            count: t.Optional(t.Integer({ minimum: 1, maximum: 200 })),
            statusOption: statusOptionSchema,
            renameOptions: renameOptionsSchema,
          }),
          beforeHandle: requirePermission('campaign:copy'),
        },
      )
      .post(
        '/ads/:id/delete',
        async ({ principal, params, body, request }) => {
          await svc.deleteEntity(principal, {
            adAccountId: body.adAccountId,
            targetType: 'ad',
            targetId: params.id,
            ...(body.hard !== undefined ? { hard: body.hard } : {}),
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: null };
        },
        {
          params: t.Object({ id: t.String({ minLength: 1 }) }),
          body: t.Object({
            adAccountId: t.String({ format: 'uuid' }),
            hard: t.Optional(t.Boolean()),
          }),
          beforeHandle: requirePermission('campaign:delete'),
        },
      )

      // ===== Insights (by level) =====
      .get(
        '/ad-accounts/:id/insights',
        async ({ principal, params, query }) => {
          const level = (query.level ?? 'campaign') as 'campaign' | 'adset' | 'ad';
          const preset = (query.preset ?? 'yesterday') as DatePreset;
          const data = await svc.getInsightsByLevel(principal, params.id, level, preset, query.parentId);
          return { code: 0, msg: 'ok', data };
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          query: t.Object({
            level: t.Optional(
              t.Union([t.Literal('campaign'), t.Literal('adset'), t.Literal('ad')]),
            ),
            preset: t.Optional(datePresetSchema),
            parentId: t.Optional(t.String({ minLength: 1 })),
          }),
          beforeHandle: requirePermission('ad_account:read'),
        },
      )

      // ===== 任务详情 / SSE =====
      .get(
        '/operations/tasks',
        async ({ principal, query }) => {
          const limit = Math.min(Math.max(Number(query.limit ?? '50'), 1), 200);
          const data = await q.listMyTasks(principal, limit);
          return { code: 0, msg: 'ok', data };
        },
        { query: t.Object({ limit: t.Optional(t.String()) }) },
      )
      .get(
        '/operations/:taskId',
        async ({ principal, params }) => {
          const data = await q.getTask(principal, params.taskId);
          return { code: 0, msg: 'ok', data };
        },
        { params: t.Object({ taskId: t.String({ format: 'uuid' }) }) },
      )
      .get(
        '/operations/:taskId/stream',
        async ({ principal, params, set }) => {
          await q.assertTaskOwned(principal, params.taskId);
          set.headers['content-type'] = 'text/event-stream; charset=utf-8';
          set.headers['cache-control'] = 'no-cache, no-transform';
          set.headers['connection'] = 'keep-alive';
          set.headers['x-accel-buffering'] = 'no';
          const taskId = params.taskId;
          return new ReadableStream({
            async start(controller) {
              const enc = new TextEncoder();
              try {
                for await (const chunk of progressStream(taskId)) {
                  controller.enqueue(enc.encode(chunk));
                }
              } finally {
                controller.close();
              }
            },
          });
        },
        { params: t.Object({ taskId: t.String({ format: 'uuid' }) }) },
      )
      .post(
        '/operations/:taskId/pause',
        async ({ principal, params }) => {
          await q.pauseTask(principal, params.taskId);
          return { code: 0, msg: 'ok', data: null };
        },
        { params: t.Object({ taskId: t.String({ format: 'uuid' }) }) },
      )
      .post(
        '/operations/:taskId/resume',
        async ({ principal, params }) => {
          await q.resumeTask(principal, params.taskId);
          return { code: 0, msg: 'ok', data: null };
        },
        { params: t.Object({ taskId: t.String({ format: 'uuid' }) }) },
      )
      .post(
        '/operations/:taskId/stop',
        async ({ principal, params }) => {
          await q.stopTask(principal, params.taskId);
          return { code: 0, msg: 'ok', data: null };
        },
        { params: t.Object({ taskId: t.String({ format: 'uuid' }) }) },
      )

      // ===== 批量入队 (M3 扩 action) =====
      .post(
        '/operations/batch',
        async ({ principal, body, request, set }) => {
          const perm = batchSvc.permissionFor(body.action);
          if (!principal.permissions.includes(perm)) {
            set.status = 403;
            return { code: 403, msg: `forbidden: ${perm}`, data: null };
          }
          const result = await batchSvc.batchEnqueue({
            action: body.action,
            params: body.params,
            targets: body.targets,
            principal,
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          set.status = 202;
          return { code: 0, msg: 'accepted', data: result };
        },
        {
          body: t.Object({
            action: t.Union([
              t.Literal('campaign:status'),
              t.Literal('campaign:budget'),
              t.Literal('campaign:copy'),
              t.Literal('campaign:delete'),
              t.Literal('adset:status'),
              t.Literal('adset:budget'),
              t.Literal('adset:copy'),
              t.Literal('adset:delete'),
              t.Literal('ad:status'),
              t.Literal('ad:copy'),
              t.Literal('ad:delete'),
            ]),
            params: t.Record(t.String(), t.Unknown()),
            targets: t.Array(
              t.Object({
                ad_account_id: t.String({ format: 'uuid' }),
                target_type: t.Union([
                  t.Literal('campaign'),
                  t.Literal('adset'),
                  t.Literal('ad'),
                ]),
                target_id: t.String({ minLength: 1 }),
                params: t.Optional(t.Record(t.String(), t.Unknown())),
              }),
              { minItems: 1, maxItems: 5000 },
            ),
          }),
        },
      ),
  );
