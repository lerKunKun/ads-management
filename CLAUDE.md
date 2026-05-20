# CLAUDE.md — FB 广告管理系统

> 给 Claude Code 的项目上下文与执行规范。开工前先读完本文件,所有决策已敲定,**不要重新讨论选型**,直接按此实现。

---

## 项目目标

多公司隔离、RBAC + 资源作用域的 FB 广告管理系统。基于外部 CRM API 获取 FB 个号 user token,承载 **1000+ 广告账户** 的批量 **复制 / 开关 / 删除 / 控预算** 操作,要求 API 秒级响应。

业务层级:`公司(租户) → FB 个号(持 token) → 广告账户(Meta act_xxx)`。用户被授予某些 FB 个号/广告账户的作用域。

---

## 已敲定的核心决策(不可改)

| 项 | 决策 |
|---|---|
| 语言 | **全 TypeScript**。后端 + Worker = Bun + Elysia;前端 = Bun + React。 |
| 架构形态 | **模块化单体**(modular monolith),模块边界:`iam` / `account` / `operation`。后期按模块拆服务,现在不拆。 |
| 响应模型 | **API 入队即返回 `task_id` (HTTP 202),Worker 异步执行**。批量操作绝不在请求内同步打 Meta API。 |
| 租户隔离 | 公司 = 硬隔离边界。所有业务表带 `company_id`,**PG Row-Level Security 兜底** + 应用层 guard。 |
| CRM 凭证 | **共用一套**:全局唯一 `cid` + `accessToken`,放环境变量,**不入库、不进 `companies` 表**。多租户隔离完全由本系统的 `company_id` + RLS 负责,CRM 侧不区分公司。 |
| Token | CRM 返回的是 FB 用户级长效 token(~60d),AES-GCM 加密存 `fb_accounts.access_token_enc`。**严禁入日志、严禁下发前端。** |
| 限流 | Meta 限流按广告账户(BUC)维度。RabbitMQ 按 `ad_account_id` 哈希分片串行化 + Redis 自适应令牌桶。 |

### MVP 暂不做(后期扩展,但代码要预留口子)
- **复制操作**:MVP 只做同账户/同个号内复制;Provider 接口预留 `targetAdAccountId`,跨账户/跨个号复制后期再加素材搬运。
- 多平台(TikTok/Google):`operation` 模块用 Provider 接口抽象,MVP 只实现 `MetaProvider`。
- ClickHouse / Prometheus / MinIO:后期接,现在不引入。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Bun |
| 后端框架 | Elysia(API/BFF + Worker 同仓) |
| 前端 | React 19 + Vite + TanStack Router/Query + shadcn/ui |
| 类型打通 | Elysia **Eden**(前端直接吃后端类型,不手写 API client) |
| 数据库 | PostgreSQL 16 + Row-Level Security,JSONB 存 Meta 元数据 |
| ORM | Drizzle(迁移用 drizzle-kit) |
| 队列 | RabbitMQ(`amqplib`) |
| 缓存/锁/限流/进度 | Redis(`ioredis`) |
| 实时进度 | SSE |
| 校验 | Elysia 内置 TypeBox |
| 告警 | **MVP 暂不接入**;`lib/notifier` 抽象接口,仅 console 实现,后期再接飞书 Webhook |

---

## 目录结构

```
.
├── apps/
│   ├── api/                 # Elysia API/BFF
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── iam/          # 认证/RBAC/作用域/审计
│   │       │   ├── account/      # FB个号 OAuth、token、广告账户同步
│   │       │   └── operation/    # 批量操作入队、任务查询、SSE
│   │       ├── middleware/       # auth guard、tenant context、rate-limit
│   │       ├── lib/              # redis、rabbitmq、crypto、crm-client、meta-client
│   │       └── index.ts
│   ├── worker/              # 消费 RabbitMQ,执行 Meta 操作
│   └── web/                 # React 前端
├── packages/
│   ├── db/                  # Drizzle schema + 迁移
│   ├── shared/              # 共享类型、常量、Provider 接口
│   └── eden/                # Eden 客户端导出
└── docker-compose.yml       # postgres + redis + rabbitmq(本地)
```

---

## 数据库 Schema(Drizzle)

```
companies        (id, name, status, created_at)

users            (id, company_id, email, pwd_hash, status, created_at)
roles            (id, company_id NULL=平台级, code, name)
permissions      (id, code, resource, action)
role_permissions (role_id, permission_id)
user_roles       (user_id, role_id)

fb_accounts      (id, company_id, fb_user_id, name,
                  access_token_enc, token_expires_at, status, created_at)
ad_accounts      (id, fb_account_id, company_id, meta_act_id,
                  name, currency, status, last_synced_at)

user_resource_grants (id, user_id, resource_type['fb_account'|'ad_account'],
                      resource_id, granted_by, created_at)

operation_tasks      (id, company_id, user_id, type, status,
                      total, success, failed, payload jsonb, created_at)
operation_task_items (id, task_id, ad_account_id, target_type, target_id,
                      action, idempotency_key, status, error, attempts)
audit_logs           (id, company_id, user_id, action, resource, detail, ip, created_at)
```

要求:
- 所有业务表带 `company_id`,启用 PG RLS,连接时 `SET app.current_company_id`。
- 钱/状态相关字段不用浮点,预算用整数(分/最小货币单位)。

---

## 权限模型

- 权限 = **角色(action)** × **资源作用域(scope)**,两者都过才放行。
- 权限项 code 格式 `resource:action`:`ad_account:read`、`campaign:status`、`campaign:budget`、`campaign:copy`、`campaign:delete`、`iam:manage`、`fb_account:bind`。
- 内置角色:`PlatformAdmin`(跨公司)、`CompanyAdmin`(本公司全权)、`Operator`(作用域内可操作)、`Viewer`(作用域内只读)。
- 鉴权顺序:`AuthN(解 JWT 得 user+company)` → `角色含 action?` → `目标资源同 company?` → `资源在 user grant 作用域内?(CompanyAdmin 跳过)` → 放行 + 写审计。
- 用户有效权限+作用域缓存 Redis `perm:{user_id}`,TTL 5min,授权变更主动失效。

---

## 异步操作流水线

**RabbitMQ**
- Exchange `ad.ops`(direct),routing key `shard.{hash(ad_account_id)%N}`,**同一广告账户落同一队列**。
- 队列开 `x-max-priority`:`budget`/`status` 高优,`copy` 低优。
- 失败 → DLX `ad.ops.dlx` → `ad.ops.retry`(消息 TTL 阶梯退避 5s/30s/2m)→ 回主队列;超 maxAttempts → `ad.ops.failed`。
- 子项带 `idempotency_key`,执行前查重防重复。

**Redis key**
- `token:{fb_account_id}` token 缓存;`lock:token-refresh:{id}` 刷新锁。
- `ratelimit:adacct:{act_id}` 账户令牌桶;`ratelimit:app` App 全局桶。
- `lock:target:{campaign_id}` 操作锁。
- `task:{task_id}:progress` 进度(total/success/failed),供 SSE。

**Worker 执行**
1. 取 Redis 令牌桶 → 拿 fb 个号 token → 调 Meta Graph API。
2. 解析响应头 `X-Business-Use-Case-Usage` / `X-Ad-Account-Usage`,逼近阈值则降速/暂停该分片(熔断,状态共享于 Redis)。
3. 写回 `operation_task_items` 结果 + 更新进度。
4. token 失效(190/OAuthException)→ 标记个号 `token_invalid` + 熔断该个号任务 + 调 `lib/notifier`(MVP console,飞书后期接)。

**Meta 操作映射**
- 开关:`POST /{campaign_id}` `status=ACTIVE|PAUSED`
- 控预算:`POST /{campaign_id 或 adset_id}` `daily_budget`/`lifetime_budget`
- 删除:`status=ARCHIVED|DELETED` 或 `DELETE /{id}`
- 复制:`POST /{campaign_id}/copies`

---

## 外部 CRM API(OAuth 换 token)

全局凭证:env `CRM_CID`、`CRM_ACCESS_TOKEN`、`CRM_BASE_URL=https://adtool-api.gimc-hk.com`。

1. 取授权链接:`GET /api/custom/security/accounts/meta/oauth/authorize-url?redirect_uri=...`,header `cid` + `accessToken` → 返回 `data.authorize_url`。
2. 换 token:`POST /api/custom/security/accounts/meta/oauth/access-token`,body `{redirect_uri, code}` → 返回 `data.access_token`(及 `expires_in`)。
3. 拿到后加密落 `fb_accounts`,并拉取该个号下广告账户写 `ad_accounts`。

> Token 续期:CRM 未提供 refresh 端点。MVP 用定时任务扫 `token_expires_at`,**到期前 7 天通过 `lib/notifier` 发告警**(MVP console;飞书 Webhook 后期再接)引导重授权。

---

## API 约定(节选)

| Method | Path | 说明 |
|---|---|---|
| POST | `/oauth/fb/authorize-url` | 代理 CRM 接口1 |
| POST | `/oauth/fb/callback` | 提 code 换 token 并入库 |
| GET | `/ad-accounts` | 当前用户作用域内广告账户 |
| POST | `/operations/batch` | 批量操作,**返回 task_id(202)** |
| GET | `/operations/:taskId` | 任务状态 |
| GET | `/operations/:taskId/stream` | SSE 进度 |
| POST | `/iam/users/:id/grants` | 授予作用域 |

`POST /operations/batch` body:
```json
{
  "action": "campaign:status",
  "params": { "status": "PAUSED" },
  "targets": [
    { "ad_account_id": "...", "target_type": "campaign", "target_id": "23851..." }
  ]
}
```

---

## 编码规范

- 严格 TS,禁 `any`(必要处用 `unknown` + 收窄)。
- 校验用 Elysia TypeBox schema,前端经 Eden 复用,**不手写 DTO**。
- 所有写操作必须经 tenant guard,DB 查询不得绕过 `company_id`。
- 密钥/token 只走 `lib/crypto`,禁止 `console.log` token 或凭证。
- 错误统一结构 `{ code, msg, data }`(对齐 CRM 风格)。
- 提交前 `bun run typecheck && bun run lint`。

---

## M1 任务清单(先做这个,只读为主)

目标:能登录、绑 FB 个号、看到广告账户。**不做操作执行。**

1. 初始化 monorepo(Bun workspaces)+ `docker-compose`(pg/redis/rabbitmq)。
2. `packages/db`:Drizzle 建上面全部表 + RLS 策略 + 种子数据(1 个 company + PlatformAdmin/CompanyAdmin 角色与权限)。
3. `apps/api` 骨架:Elysia + Eden 导出;`lib/redis`、`lib/rabbitmq`(先建连接,M3 用)、`lib/crypto`、`lib/crm-client`。
4. `iam` 模块:邮箱密码登录(JWT)、tenant context 中间件、RBAC guard、作用域校验、审计写入。
5. `account` 模块:`/oauth/fb/*` 接 CRM 换 token + 加密入库;拉取并同步广告账户;`/ad-accounts` 列表(走作用域过滤)。
6. `apps/web`:登录页 + 广告账户列表页(Eden + TanStack Query),shadcn 表格。

完成 M1 后再进 M2(单账户操作)→ M3(RabbitMQ+Redis 异步流水线)。**不要跳着做异步流水线。**

---

## 给 Claude Code 的执行原则

- 一次只推进一个 M 阶段,小步提交。
- 涉及"共用一套凭证 / 模块化单体 / 异步入队"这三条主线时,严格按本文件,有疑问先问再写。
- 复制/多平台/监控等 MVP 不做的功能,只预留接口,不实现。
