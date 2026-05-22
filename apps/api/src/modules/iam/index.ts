import { Elysia, t } from 'elysia';
import { sign } from '../../lib/jwt';
import { authenticate, loadPrincipal, writeAudit } from './auth-service';
import { authGuard, requirePermission } from '../../middleware/auth';
import * as users from './user-service';

function ipOf(request: Request): string | undefined {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    undefined
  );
}

export const iam = new Elysia({ name: 'iam', prefix: '/iam' })
  .get('/_ping', () => ({ code: 0, msg: 'ok', data: 'iam' }))
  .post(
    '/login',
    async ({ body, request, set }) => {
      const p = await authenticate(body.email, body.password);
      if (!p) {
        set.status = 401;
        return { code: 401, msg: 'invalid credentials', data: null };
      }
      const token = sign({ sub: p.userId, cid: p.companyId });
      await writeAudit({
        companyId: p.companyId,
        userId: p.userId,
        action: 'iam:login',
        resource: `user:${p.userId}`,
        ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
      });
      return {
        code: 0,
        msg: 'ok',
        data: {
          token,
          user: {
            id: p.userId,
            email: p.email,
            companyId: p.companyId,
            companyName: p.companyName,
            roles: p.roles,
            permissions: p.permissions,
          },
        },
      };
    },
    {
      body: t.Object({
        email: t.String({ format: 'email' }),
        password: t.String({ minLength: 6, maxLength: 128 }),
      }),
    },
  )
  .group('', (g) =>
    g
      .use(authGuard)
      .get('/me', ({ principal }) => ({
        code: 0,
        msg: 'ok',
        data: {
          id: principal.userId,
          email: principal.email,
          companyId: principal.companyId,
          companyName: principal.companyName,
          roles: principal.roles,
          permissions: principal.permissions,
          scope: principal.scope,
        },
      }))
      .post(
        '/switch-company',
        async ({ principal, body, request, set }) => {
          if (!principal.roles.includes('PlatformAdmin')) {
            set.status = 403;
            return { code: 403, msg: 'only PlatformAdmin can switch company', data: null };
          }
          const switched = await loadPrincipal(principal.userId, body.companyId);
          if (!switched || !switched.roles.includes('PlatformAdmin')) {
            set.status = 404;
            return { code: 404, msg: 'company not found or unavailable', data: null };
          }
          const token = sign({ sub: switched.userId, cid: switched.companyId });
          await writeAudit({
            companyId: switched.companyId,
            userId: switched.userId,
            action: 'iam:company:switch',
            resource: `company:${switched.companyId}`,
            detail: { fromCompanyId: principal.companyId },
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return {
            code: 0,
            msg: 'ok',
            data: {
              token,
              user: {
                id: switched.userId,
                email: switched.email,
                companyId: switched.companyId,
                companyName: switched.companyName,
                roles: switched.roles,
                permissions: switched.permissions,
              },
            },
          };
        },
        {
          body: t.Object({ companyId: t.String({ format: 'uuid' }) }),
          beforeHandle: requirePermission('iam:manage'),
        },
      )
      // ===== 用户管理(iam:manage) =====
      .get(
        '/users',
        async ({ principal }) => ({
          code: 0,
          msg: 'ok',
          data: await users.listUsers(principal),
        }),
        { beforeHandle: requirePermission('iam:manage') },
      )
      .post(
        '/users',
        async ({ principal, body, request }) => {
          const r = await users.createUser(principal, body);
          await writeAudit({
            companyId: principal.companyId,
            userId: principal.userId,
            action: 'iam:user:create',
            resource: `user:${r.id}`,
            detail: { email: body.email, roleCode: body.roleCode },
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: r };
        },
        {
          body: t.Object({
            email: t.String({ format: 'email' }),
            password: t.String({ minLength: 6, maxLength: 128 }),
            roleCode: t.String({ minLength: 1 }),
          }),
          beforeHandle: requirePermission('iam:manage'),
        },
      )
      .patch(
        '/users/:id',
        async ({ principal, params, body, request }) => {
          await users.updateUser(principal, params.id, body);
          await writeAudit({
            companyId: principal.companyId,
            userId: principal.userId,
            action: 'iam:user:update',
            resource: `user:${params.id}`,
            detail: body,
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: null };
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          body: t.Object({
            roleCode: t.Optional(t.String()),
            status: t.Optional(t.Union([t.Literal('active'), t.Literal('disabled')])),
          }),
          beforeHandle: requirePermission('iam:manage'),
        },
      )
      .get(
        '/roles',
        async ({ principal }) => ({
          code: 0,
          msg: 'ok',
          data: await users.listRoles(principal),
        }),
        { beforeHandle: requirePermission('iam:manage') },
      )
      // ===== 作用域 / Grants =====
      .get(
        '/users/:id/grants',
        async ({ principal, params }) => ({
          code: 0,
          msg: 'ok',
          data: await users.listGrants(principal, params.id),
        }),
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          beforeHandle: requirePermission('iam:manage'),
        },
      )
      .post(
        '/users/:id/grants',
        async ({ principal, params, body, request }) => {
          const r = await users.addGrant(principal, params.id, body);
          await writeAudit({
            companyId: principal.companyId,
            userId: principal.userId,
            action: 'iam:grant:add',
            resource: `user:${params.id}`,
            detail: body,
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: r };
        },
        {
          params: t.Object({ id: t.String({ format: 'uuid' }) }),
          body: t.Object({
            resourceType: t.Union([t.Literal('fb_account'), t.Literal('ad_account')]),
            resourceId: t.String({ format: 'uuid' }),
          }),
          beforeHandle: requirePermission('iam:manage'),
        },
      )
      .delete(
        '/users/:id/grants/:grantId',
        async ({ principal, params, request }) => {
          await users.removeGrant(principal, params.id, params.grantId);
          await writeAudit({
            companyId: principal.companyId,
            userId: principal.userId,
            action: 'iam:grant:remove',
            resource: `user:${params.id}`,
            detail: { grantId: params.grantId },
            ...(ipOf(request) ? { ip: ipOf(request)! } : {}),
          });
          return { code: 0, msg: 'ok', data: null };
        },
        {
          params: t.Object({
            id: t.String({ format: 'uuid' }),
            grantId: t.String({ format: 'uuid' }),
          }),
          beforeHandle: requirePermission('iam:manage'),
        },
      )
      // 给授权 Dialog 用的资源列表
      .get(
        '/grant-resources',
        async ({ principal }) => ({
          code: 0,
          msg: 'ok',
          data: await users.listResourcesForGrant(principal),
        }),
        { beforeHandle: requirePermission('iam:manage') },
      ),
  );
