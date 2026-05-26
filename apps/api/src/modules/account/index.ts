import { Elysia, t } from 'elysia';
import { authGuard, requirePermission } from '../../middleware/auth';
import * as svc from './service';

export const account = new Elysia({ name: 'account' })
  // ---- 公共：本模块自检 ----
  .get('/_account/ping', () => ({ code: 0, msg: 'ok', data: 'account' }))

  // ---- 需要登录的路由 ----
  .group('', (g) =>
    g
      .use(authGuard)
      // 拿授权链接(代理 CRM)
      .post(
        '/oauth/fb/authorize-url',
        async () => {
          const url = await svc.getAuthorizeUrl();
          return { code: 0, msg: 'ok', data: { authorize_url: url } };
        },
        {
          beforeHandle: requirePermission('fb_account:bind'),
        },
      )
      // OAuth 回调：换 token + 同步广告账户
      .post(
        '/oauth/fb/callback',
        async ({ principal, body }) => {
          const result = await svc.bindFbAccount({ principal, code: body.code });
          return { code: 0, msg: 'ok', data: result };
        },
        {
          body: t.Object({
            code: t.String({ minLength: 1 }),
          }),
          beforeHandle: requirePermission('fb_account:bind'),
        },
      )
      // FB 个号列表(登录后默认入口)
      .get(
        '/fb-accounts',
        async ({ principal }) => {
          const data = await svc.listFbAccounts(principal);
          return { code: 0, msg: 'ok', data };
        },
        { beforeHandle: requirePermission('ad_account:read') },
      )
      // 广告账户列表(可选 ?fb_account_id= 过滤)
      .get(
        '/ad-accounts',
        async ({ principal, query }) => {
          if (query.paged === '1') {
            const data = await svc.listAdAccountsPage(principal, {
              ...(query.fb_account_id ? { fbAccountId: query.fb_account_id } : {}),
              ...(query.search ? { search: query.search } : {}),
              ...(query.status ? { status: query.status } : {}),
              ...(query.currency ? { currency: query.currency } : {}),
              ...(query.timezone_name ? { timezoneName: query.timezone_name } : {}),
              ...(query.business_country_code ? { businessCountryCode: query.business_country_code } : {}),
              ...(query.page ? { page: Number(query.page) } : {}),
              ...(query.page_size ? { pageSize: Number(query.page_size) } : {}),
            });
            return { code: 0, msg: 'ok', data };
          }
          const data = await svc.listAdAccounts(
            principal,
            query.fb_account_id ? { fbAccountId: query.fb_account_id } : {},
          );
          return { code: 0, msg: 'ok', data };
        },
        {
          query: t.Object({
            fb_account_id: t.Optional(t.String({ format: 'uuid' })),
            paged: t.Optional(t.String()),
            search: t.Optional(t.String()),
            status: t.Optional(
              t.Union([
                t.Literal('active'),
                t.Literal('pending'),
                t.Literal('disabled'),
                t.Literal('closed'),
              ]),
            ),
            currency: t.Optional(t.String()),
            timezone_name: t.Optional(t.String()),
            business_country_code: t.Optional(t.String()),
            page: t.Optional(t.String()),
            page_size: t.Optional(t.String()),
          }),
          beforeHandle: requirePermission('ad_account:read'),
        },
      ),
  );
