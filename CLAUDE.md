# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 开工前先读完本文件，所有技术决策已敲定，**不要重新讨论选型**，直接按此实现。

---

## 常用命令

```powershell
# 安装依赖
bun install

# 启动底层服务（postgres / redis / rabbitmq）
docker compose up -d

# 数据库迁移 + 种子（首次或重建时）
bun --cwd packages/db run migrate
bun --cwd packages/db run seed
# mock 种子（演示用：1 个 FB 个号 + 8 个广告账户）
$env:MOCK_AD_ACCOUNT_COUNT='8'; bun --cwd packages/db run src/seed-mock-fb.ts

# 修改 schema 后生成新的迁移文件
bun --cwd packages/db run generate

# 启动 API（终端 1，mock 模式）
cd apps/api
$env:META_FAKE='1'
$env:DATABASE_URL='postgres://ads_app:ads_app@localhost:5432/ads'
$env:DATABASE_ADMIN_URL='postgres://ads:ads@localhost:5432/ads'
$env:REDIS_URL='redis://localhost:6379'
$env:RABBITMQ_URL='amqp://ads:ads@localhost:5672'
$env:JWT_SECRET='devsecret'
bun src/index.ts

# 启动 Worker（终端 2，mock 模式）
cd apps/worker
$env:META_FAKE='1'
$env:FAKE_DELAY_MS='20'
$env:FAKE_FAIL_RATE='0.05'
$env:FAKE_RATELIMIT_RATE='0.03'
$env:DATABASE_URL='postgres://ads_app:ads_app@localhost:5432/ads'
$env:REDIS_URL='redis://localhost:6379'
$env:RABBITMQ_URL='amqp://ads:ads@localhost:5672'
bun src/index.ts

# 启动前端（终端 3）
cd apps/web
bun run vite --port 5173

# Typecheck（提交前必跑，任意一个失败都要修）
bun run typecheck
# 或逐包
bun --cwd apps/api run typecheck
bun --cwd apps/worker run typecheck
bun --cwd apps/web run typecheck
bun --cwd packages/db run typecheck
bun --cwd packages/shared run typecheck

# 重置 mock 环境（回到干净状态）
docker exec -i ads_pg psql -U ads -d ads -c "UPDATE fb_accounts SET status='active' WHERE fb_user_id='mock_fb_user_1';"
docker exec ads_redis redis-cli FLUSHALL
```

端口：API `:3001`，Web `:5173`，RabbitMQ 管理台 `:15672`（`ads`/`ads`），PostgreSQL `:5432`，Redis `:6379`。

默认账号：`admin@demo.local` / `admin123`（同时持有 PlatformAdmin + CompanyAdmin）。

---

## 项目目标

多公司隔离、RBAC + 资源作用域的 FB 广告管理系统。基于外部 CRM API 获取 FB 个号 user token，承载 **1000+ 广告账户** 的批量 **复制 / 开关 / 删除 / 控预算** 操作，要求 API 秒级响应。

业务层级：`公司(租户) → FB 个号/广告账户组(持 token) → 广告账户(Meta act_xxx) → 广告系列 → 广告组 → 广告`。

> 注意：数据库和 API 内部用 `fb_account`，前端/用户文档统一显示为"广告账户组"。

---

## 已敲定的核心决策（不可改）

| 项 | 决策 |
|---|---|
| 语言 | 全 TypeScript。后端 + Worker = Bun + Elysia；前端 = Bun + React 19 |
| 架构形态 | **模块化单体**，模块边界：`iam` / `account` / `operation` / `admin`。后期按模块拆服务，现在不拆 |
| 响应模型 | **API 入队即返回 `task_id`（HTTP 202），Worker 异步执行**。批量操作绝不在请求内同步打 Meta API |
| 租户隔离 | 公司 = 硬隔离边界。所有业务表带 `company_id`，**PG Row-Level Security 兜底** + 应用层 guard |
| CRM 凭证 | **共用一套**：全局唯一 `cid` + `accessToken`，放环境变量，**不入库、不进 `companies` 表** |
| Token | CRM 返回的 FB 用户级长效 token（~60d），AES-256-GCM 加密存 `fb_accounts.access_token_enc`。**严禁入日志、严禁下发前端** |
| 限流 | Meta 限流按广告账户（BUC）维度。RabbitMQ 按 `ad_account_id` 哈希分片串行化 + Redis 原子 Lua 令牌桶 |
| Meta API 版本 | v21.0（CRM 侧锁定，不随意升级） |

### 暂不做（后期扩展，但代码要预留口子）
- **跨账户复制**：当前 MVP 仅同账户/同个号内复制；Provider 接口已预留 `targetAdAccountId`
- 多平台（TikTok/Google）：`operation` 模块用 `AdsProvider` 接口抽象，MVP 只实现 `MetaProvider`
- ClickHouse / Prometheus / MinIO：后期接，现在不引入
- 飞书告警：`lib/notifier` 接口已实现，`NOTIFIER_DRIVER=feishu` 切换即可，默认 console

---

## 代码架构

### monorepo 结构

```
apps/api/src/
  index.ts              # Elysia app 入口，export type App（Eden 用）
  env.ts                # 环境变量集中管理，启动期 fail-fast
  modules/
    iam/                # 登录(JWT HS256)、用户管理、角色/权限、作用域 grants、审计
    account/            # FB 个号 OAuth、AES-GCM token 加密入库、广告账户同步
    operation/          # 批量操作入队(202)、任务查询、SSE 进度流、单 target 操作
    admin/              # 熔断管理、token 健康扫描、广告对象同步、公司管理（iam:manage 权限）
    ad-object/          # 广告系列/广告组/广告 本地快照读写（local-store + sync-service）
  middleware/
    auth.ts             # authGuard(Elysia derive)、requirePermission、checkScope、invalidatePrincipal
  lib/
    redis.ts / rabbitmq.ts / rabbitmq-topology.ts
    crypto.ts           # AES-256-GCM，token 加解密唯一入口
    meta-client.ts      # Meta Graph API v21.0，MetaApiError 含 isTokenInvalid/isRateLimit
    crm-client.ts       # CRM OAuth 代理（取授权链接 / 换 token）
    rate-limit.ts       # 原子 Lua 令牌桶（账户级 + 全局）
    breaker.ts          # Redis 熔断（fbAccount / adAccount）
    op-lock.ts          # Redis SET NX 操作锁（目标级）
    progress.ts         # Redis Hash 进度 + pubsub（供 SSE）
    notifier.ts         # ConsoleNotifier / FeishuNotifier，NOTIFIER_DRIVER 切换
    scheduler.ts        # 内置定时器（token 健康扫描：启动 30s 后首扫，之后每 6h）
    fake-meta-state.ts  # META_FAKE=1 时的内存 mock 状态（供 API 进程）
  providers/
    meta.ts             # MetaProvider 实现 AdsProvider 接口

apps/worker/src/
  index.ts              # 启动 16 个 shard consumer，prefetch=5
  handler.ts            # 单消息处理：熔断→操作锁→幂等→令牌桶→token→provider→写库+进度
  fake-meta.ts          # Worker 侧 fake 逻辑

apps/web/src/
  main.tsx / routeTree.gen.ts   # TanStack Router（路由文件自动生成）
  routes/               # 文件即路由（TanStack Router 约定）
  lib/api.ts            # 手写 fetch 客户端（Envelope<T> 封装）+ 所有接口类型定义
  components/           # shadcn/ui 基础组件 + 业务组件（EntityListView、CopyDialog 等）

packages/db/src/
  schema/               # Drizzle 表定义（companies / iam / fb / operations / audit / ad-objects）
  migrate.ts / seed.ts / seed-mock-fb.ts
  client.ts             # postgres 连接，运行时用 ads_app 角色，迁移用超管 ads

packages/shared/src/
  permissions.ts        # 权限 code 常量、内置角色列表
  provider.ts           # AdsProvider 接口（SetStatusInput / SetBudgetInput / CopyInput / DeleteInput）

packages/eden/          # Elysia Eden 客户端导出（从 apps/api export type App）
```

### 关键数据流

**批量操作（异步流水线）**：
```
前端 POST /operations/batch
  → API: 写 operation_tasks + operation_task_items → publishOperation(RMQ shard.N) → 202 返回 taskId
  → Worker: handle(msg): 熔断→锁→幂等→令牌桶→token→MetaProvider→写DB+bumpProgress
  → Redis pubsub task:{id}:event
  → 前端 GET /operations/:taskId/stream (SSE) 实时收进度
```

**单 target 操作（同步，M2）**：直接在 API 进程内调 `MetaProvider`，不经 RabbitMQ，适用于单行操作。

**RabbitMQ 拓扑**：
- Exchange `ad.ops`（direct）+ 16 个 shard 主队列（`shard.0`…`shard.15`）
- 同一广告账户的消息固定落同一 shard（`hash(adAccountId) % 16`）
- 失败 → per-shard retry queue（TTL 5s/30s/2m）→ DLX 回主 shard；超 `maxAttempts=6` → `ad.ops.failed`
- 优先级：status/budget=8，copy/delete=3（`x-max-priority=10`）

### 鉴权流程

```
JWT Bearer → authGuard(derive) → Redis perm:{userId}:{companyId} cache(5min)
  → requirePermission(code) → checkScope(resourceType, resourceId)
  → CompanyAdmin/PlatformAdmin 跳过 scope 检查
授权变更时调 invalidatePrincipal(userId) 主动失效缓存
```

### DB 访问规则

- 运行时连接用 `ads_app` 角色（非 SUPERUSER），受 RLS 约束
- 每个业务 query 前通过 `SET app.current_company_id = '...'` 注入租户上下文
- Worker 跨租户查询需 `SET app.bypass_rls = '1'`（显式绕行，仅 worker 内部使用）
- 迁移和 seed 走超管 `ads`（`DATABASE_ADMIN_URL`）

---

## 数据库 Schema

```
companies        (id, name, status, created_at)
users            (id, company_id, email, pwd_hash, status, created_at)
roles            (id, company_id NULL=平台级, code, name)
permissions      (id, code, resource, action)
role_permissions / user_roles
fb_accounts      (id, company_id, fb_user_id, name, access_token_enc, token_expires_at, status)
ad_accounts      (id, fb_account_id, company_id, meta_act_id, name, currency, timezone_name,
                  business_country_code, status, last_synced_at)
user_resource_grants (id, user_id, resource_type['fb_account'|'ad_account'], resource_id, granted_by)
operation_tasks      (id, company_id, user_id, type, status, total, success, failed, payload jsonb)
operation_task_items (id, task_id, ad_account_id, target_type, target_id, action,
                      idempotency_key, status, error, attempts)
campaigns / adsets / ads  # 广告对象快照（packages/db/src/schema/ad-objects.ts）
audit_logs       (id, company_id, user_id, action, resource, detail, ip, created_at)
```

- 预算字段用整数（分/最小货币单位），不用浮点
- 广告对象快照表用于 `META_FAKE=1` 模式和减少 Meta API 调用

---

## 权限模型

- 权限 code 格式：`resource:action`，例：`ad_account:read`、`campaign:status`、`campaign:budget`、`campaign:copy`、`campaign:delete`、`iam:manage`、`fb_account:bind`
- 内置角色：`PlatformAdmin`（跨公司）、`CompanyAdmin`（本公司全权，bypass scope）、`Operator`（scope 内可操作）、`Viewer`（scope 内只读）
- 鉴权顺序：`AuthN` → `角色含 action?` → `目标资源同 company?` → `资源在 user grant scope 内?（CompanyAdmin/PlatformAdmin bypass）` → 放行 + 写 audit_log

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `META_FAKE` | - | 设为 `1` 启用内存 mock，跳过真实 Meta API |
| `DATABASE_URL` | `postgres://ads_app:ads_app@localhost:5432/ads` | 运行时连接（受 RLS） |
| `DATABASE_ADMIN_URL` | `postgres://ads:ads@localhost:5432/ads` | 迁移/seed 超管连接 |
| `JWT_SECRET` | `dev-only-replace-me` | 生产必须替换 |
| `TOKEN_ENC_KEY` | - | 32 字节 base64；缺省时 dev 用临时 key，prod 拒绝启动 |
| `CRM_BASE_URL` | `https://adtool-api.gimc-hk.com` | CRM API 地址 |
| `CRM_CID` / `CRM_ACCESS_TOKEN` | - | CRM 全局凭证，不入库 |
| `NOTIFIER_DRIVER` | `console` | 改为 `feishu` 并设 `FEISHU_WEBHOOK_URL` 启用飞书告警 |
| `FAKE_DELAY_MS` / `FAKE_FAIL_RATE` / `FAKE_RATELIMIT_RATE` | `20` / `0.05` / `0.03` | Worker fake 模式参数 |

---

## 编码规范

- 严格 TS，禁 `any`（必要处用 `unknown` + 收窄）
- 校验用 Elysia TypeBox schema（`t.Object(...)` 内联），不手写独立 DTO 类型
- 所有写操作必须经 tenant guard，DB query 不得绕过 `company_id`
- 密钥/token 只走 `lib/crypto`，任何地方都不得 `console.log` token 或凭证
- 错误统一结构 `{ code, msg, data }`（对齐 CRM 风格），`HttpError` 类统一抛出
- 提交前运行 `bun run typecheck`

---

## 外部 CRM API

全局凭证：env `CRM_CID`、`CRM_ACCESS_TOKEN`，header 名也是 `cid` / `accessToken`。

1. 取授权链接：`GET /api/custom/security/accounts/meta/oauth/authorize-url?redirect_uri=...` → `data.authorize_url`
2. 换 token：`POST /api/custom/security/accounts/meta/oauth/access-token`，body `{redirect_uri, code}` → `data.access_token`（含 `expires_in`）
3. token 落库加密，并同步拉取该个号下广告账户写入 `ad_accounts`

Token 续期：CRM 无 refresh 端点。定时扫 `token_expires_at < NOW()+7d`，通过 `lib/notifier` 告警引导重授权。

---

## 当前进度

**M1–M4 已完成**，详见 `PROGRESS.md`。下一阶段参考 PROGRESS.md 中的后续计划。

---

## 关键文件速查

| 关注点 | 位置 |
|---|---|
| 全局配置 / 环境变量 | `apps/api/src/env.ts` |
| RLS 策略 | `packages/db/src/rls.sql` |
| RBAC 权限/角色常量 | `packages/shared/src/permissions.ts` + `packages/db/src/seed.ts` |
| Meta API 封装 | `apps/api/src/lib/meta-client.ts` |
| Provider 抽象接口 | `packages/shared/src/provider.ts` |
| Meta 实现 | `apps/api/src/providers/meta.ts` |
| RabbitMQ 拓扑 | `apps/api/src/lib/rabbitmq-topology.ts` |
| 令牌桶 / 熔断 / 操作锁 | `apps/api/src/lib/rate-limit.ts` / `breaker.ts` / `op-lock.ts` |
| 任务进度 / SSE | `apps/api/src/lib/progress.ts` / `modules/operation/sse.ts` |
| Worker 消息处理主循环 | `apps/worker/src/handler.ts` + `index.ts` |
| 告警 / 通知 | `apps/api/src/lib/notifier.ts` |
| 定时任务（token 健康扫描） | `apps/api/src/lib/scheduler.ts` |
| Mock Meta 内存状态 | `apps/api/src/lib/fake-meta-state.ts` |
| 广告对象本地快照读写 | `apps/api/src/modules/ad-object/local-store.ts` |
| 广告对象后台同步 | `apps/api/src/modules/ad-object/sync-service.ts` |
| 前端接口类型 + fetch 客户端 | `apps/web/src/lib/api.ts` |
| 前端路由树（**自动生成，禁止手动修改**） | `apps/web/src/routeTree.gen.ts` |

---

## 补充环境变量

以下变量未在主表中列出，但在 `apps/api/src/env.ts` 中已定义：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `API_PORT` | `3001` | API 监听端口 |
| `JWT_EXPIRES_IN` | `12h` | JWT 有效期 |
| `META_API_VERSION` | `v21.0` | Meta Graph API 版本（锁定，禁止随意改） |
| `FB_OAUTH_REDIRECT_URI` | `http://localhost:5173/oauth/fb/callback` | OAuth 回调 URI |
| `AD_OBJECT_CACHE_TTL_MS` | `30000` | 广告对象本地快照缓存时效（毫秒） |
| `AD_OBJECT_SYNC_ENABLED` | `0` | 设为 `1` 启用后台定时同步广告对象快照 |
| `AD_OBJECT_SYNC_INTERVAL_MS` | `300000` | 后台同步间隔（毫秒） |
| `AD_OBJECT_SYNC_DEPTH` | `campaign` | 同步深度：`campaign` / `adset` / `ad` |
| `META_ASYNC_COPY_TIMEOUT_MS` | `1800000` | 异步复制轮询超时（毫秒） |

---

## 已知限制 & 坑

- **Mock 状态不持久**：`META_FAKE=1` 下 campaign/adset/ad 状态存进程内 Map，API 重启即重置。
- **PG RLS 必须有 `SET LOCAL`**：任何直接调 `db.execute()` 不走事务不设 `app.current_company_id` 都拿不到数据；业务层统一用 `withTenant(companyId, tx => ...)` 封装，缺此上下文会静默返回空集。
- **Worker 跨租户 bypass**：Worker 内查询需 `SET app.bypass_rls = '1'`，仅限 worker 使用，API 模块禁止使用。
- **`fb_account` 熔断需手动重置**：token 失效后熔断永久生效，管理员通过 `POST /_admin/breakers/reset` 解除，但 token 本身仍是旧的，需引导用户重新走 OAuth re-bind。
- **令牌桶默认值偏保守**：`ratelimit:adacct` 容量 20、补充 2/s；接真实 token 后根据 Meta 返回的 `X-Ad-Account-Usage` 头调整。
- **SSE 鉴权走 `?token=` query**：浏览器原生 `EventSource` 不支持自定义 header，`GET /operations/:taskId/stream` 用 query 参数传 token；生产若走同源代理建议改 cookie。
- **Windows 开发注意**：`bun --hot` 与 amqplib 长连接同用会出现僵尸连接，脚本中一律用 `bun src/index.ts`，不加 `--hot`。
- **`operation_task_items.error` 列复用**：copy 操作生成的新对象 ID 暂存于 `error` 列（MVP 复用），M5 前需加 `result jsonb` 列并迁移。
- **前端 `routeTree.gen.ts` 禁止手动修改**：由 `vite` + TanStack Router 插件在启动时自动从 `routes/` 目录生成，手动改会在下次启动时被覆盖。
