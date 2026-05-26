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

# 数据库操作（根目录快捷方式）
bun run db:migrate          # 跑迁移
bun run db:seed             # 初始种子
bun run db:generate         # 修改 schema 后生成新迁移文件
# mock 种子（演示用：1 个 FB 个号 + 8 个广告账户）
$env:MOCK_AD_ACCOUNT_COUNT='8'; bun --cwd packages/db run src/seed-mock-fb.ts

# 启动 API（终端 1，mock 模式）
cd apps/api
$env:META_FAKE='1'
$env:DATABASE_URL='postgres://ads_app:ads_app@localhost:5432/ads'
$env:DATABASE_ADMIN_URL='postgres://ads:ads@localhost:5432/ads'
$env:REDIS_URL='redis://localhost:6379'
$env:RABBITMQ_URL='amqp://ads:ads@localhost:5672'
$env:JWT_SECRET='devsecret'
bun src/index.ts
# 或根目录：$env:META_FAKE='1'; bun run dev:api

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
# 或根目录：bun run dev:web

# 一键启动 API + Web（Windows，自动开两个终端窗口）
powershell scripts\start-local-dev.ps1

# Typecheck（提交前必跑，任意一个失败都要修）
bun run typecheck

# 重置 mock 环境（回到干净状态）
docker exec -i ads_pg psql -U ads -d ads -c "UPDATE fb_accounts SET status='active' WHERE fb_user_id='mock_fb_user_1';"
docker exec ads_redis redis-cli FLUSHALL
docker exec ads_rabbit rabbitmqctl list_queues name | Select-Object -Skip 3 | ForEach-Object { docker exec ads_rabbit rabbitmqctl purge_queue $_ }
```

### 根目录 package.json 快捷脚本

| 命令 | 等价于 |
|---|---|
| `bun run dev:api` | `bun --cwd apps/api dev` |
| `bun run dev:worker` | `bun --cwd apps/worker dev` |
| `bun run dev:web` | `bun --cwd apps/web dev` |
| `bun run db:generate` | `bun --cwd packages/db generate` |
| `bun run db:migrate` | `bun --cwd packages/db migrate` |
| `bun run db:seed` | `bun --cwd packages/db seed` |
| `bun run typecheck` | 全包并行 typecheck |

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
  copy-v2-jsonb.ts      # 大型 campaign 复制的 JSONB 状态机（copy V2，由 COPY_V2_JSONB_ENABLED 控制）
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

**复制操作实现说明（重要）**：  
当前复制主路径为**自建 create-copy**，**不使用** Meta 的 `/{id}/copies` copy edge（该接口返回 `#3 Application does not have the capability`）。实际调用链：
```
Worker copy branch
  → executeCustomCopyBatchProvider()（批量，同一 copyBatch 内串行）
  → executeProvider() → metaProvider.copy()
  → meta.customCopyCampaign() / customCopyAdSet() / customCopyAd()
  → 读源对象字段 → Meta create 接口（POST /{act_id}/campaigns|adsets|ads）
```
代码中保留了旧的 `executeAsyncCopyBatchProvider()` / `copyCampaign()` 等 async 路径，但**均未接入主路径，属于死代码**，勿误读。

**Copy V2 JSONB 状态机**（`apps/worker/src/copy-v2-jsonb.ts`）：  
处理大型 campaign（广告数 ≥ `COPY_V2_MIN_AD_COUNT` 或广告组数 ≥ `COPY_V2_MIN_ADSET_COUNT`）的有限并发复制，使用持久化表（`operation_copy_workflows` + `operation_copy_steps`）防止进程崩溃后重复创建对象。通过 Redis ZSET 信号量（`COPY_V2_GLOBAL_CONCURRENCY`）跨 Worker 控制全局并发。默认关闭（`COPY_V2_JSONB_ENABLED=0`），通过 `COPY_V2_ACCOUNT_ALLOWLIST` 按广告账户灰度开启。

**任务控制**（pause / resume / stop）：
- `POST /operations/:taskId/pause` → 任务状态改为 `paused`，Worker 在 `assertTaskRunnable()` 处抛 `TaskPausedError` 后停止处理新消息
- `POST /operations/:taskId/resume` → 状态改回 `running`，后续消息可继续消费
- `POST /operations/:taskId/stop` → 状态改为 `cancelled`，Worker 抛 `TaskCancelledError`，已入队消息最终会 nack/dead

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
operation_tasks      (id, company_id, user_id, type, status[pending|running|paused|partial|success|failed|cancelled],
                      total, success, failed, payload jsonb)
operation_task_items (id, task_id, ad_account_id, target_type, target_id, action,
                      idempotency_key, status, error, attempts)
operation_copy_workflows  # Copy V2 状态机（每个大型 campaign copy item 对应一行）
  (id, task_id, task_item_id, company_id, fb_account_id, ad_account_id, meta_act_id,
   source_campaign_id, new_campaign_id, status, phase, state jsonb, version,
   lease_owner, lease_until, error)
operation_copy_steps      # Copy V2 每个创建步骤（campaign/adset/ad 各一行）
  (id, workflow_id, task_id, task_item_id, company_id, step_key, source_type, source_id,
   parent_step_key, new_id, status, attempt, lease_owner, lease_until, error, metadata jsonb)
campaigns / adsets / ads  # 广告对象快照（packages/db/src/schema/ad-objects.ts）
audit_logs       (id, company_id, user_id, action, resource, detail, ip, created_at)
```

- 预算字段用整数（分/最小货币单位），不用浮点
- 广告对象快照表用于 `META_FAKE=1` 模式和减少 Meta API 调用
- `operation_copy_workflows` / `operation_copy_steps` 是 Copy V2 的持久化状态机，用于防止进程崩溃或 Worker 重启后重复创建对象；通过 `lease_owner` + `lease_until` + `version` 乐观锁协调并发 Worker

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
| Copy V2 JSONB 状态机（大型 campaign） | `apps/worker/src/copy-v2-jsonb.ts` |
| 任务暂停/恢复/停止控制 | `apps/worker/src/task-control.ts` |
| 当前复制链路文档 | `docs/copy-flow-serial-current.md` |
| 批量复制旧链路（历史文档） | `docs/batch-copy-flow-current.md` |

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
| `COPY_V2_JSONB_ENABLED` | `0` | 设为 `1` 启用大型 campaign JSONB 状态机复制路径 |
| `COPY_V2_ACCOUNT_ALLOWLIST` | `` | 逗号分隔的 ad account UUID 或 meta_act_id，为空则全量开放 |
| `COPY_V2_MIN_AD_COUNT` | `52` | 广告数达到此阈值时路由到 V2 |
| `COPY_V2_MIN_ADSET_COUNT` | `5` | 广告组数达到此阈值时路由到 V2 |
| `COPY_V2_ADSET_CONCURRENCY` | `2` | V2 广告组并发数 |
| `COPY_V2_AD_CONCURRENCY` | `3` | V2 广告并发数 |
| `COPY_V2_GLOBAL_QPS` | `27` | V2 全局 Meta API QPS 限制 |
| `COPY_V2_GLOBAL_BURST` | `100` | V2 全局突发容量 |
| `COPY_V2_GLOBAL_CONCURRENCY` | `120` | V2 全局并发 worker 信号量上限 |
| `COPY_V2_GLOBAL_LEASE_TTL_MS` | `120000` | V2 信号量租约超时（毫秒） |
| `COPY_V2_AD_ACCOUNT_QPS` | `6` | V2 单广告账户 QPS |
| `COPY_V2_AD_ACCOUNT_BURST` | `24` | V2 单广告账户突发容量 |
| `COPY_V2_INSPECT_CONCURRENCY` | `32` | V2 预检并发数 |
| `COPY_V2_VERIFY_CONCURRENCY` | `32` | V2 字段校验并发数 |
| `COPY_V2_VERIFY_ENABLED` | `1` | 复制后字段校验 |
| `COPY_V2_REPAIR_ENABLED` | `1` | 字段不匹配时自动修复 |
| `COPY_BATCH_CONCURRENCY` | `16` | 小型 campaign 批量复制全局并发数 |
| `COPY_BATCH_CAMPAIGN_CONCURRENCY` | `2` | 批量 campaign 并发数 |
| `COPY_BATCH_ADSET_CONCURRENCY` | `16` | 批量 adset 并发数（默认同 `COPY_BATCH_CONCURRENCY`） |
| `COPY_BATCH_AD_CONCURRENCY` | `16` | 批量 ad 并发数（默认同 `COPY_BATCH_CONCURRENCY`） |

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
- **复制代码有死代码残留**：`meta-client.ts` 中仍保留旧的 `executeAsyncCopyBatchProvider()` / `meta.copyCampaign()` 等函数，当前 copy 主路径调用的是 `executeCustomCopyProvider()` / `customCopyCampaign()` 等。修改复制逻辑时认准 `custom*` 前缀的函数。
- **Campaign 深拷贝耗时与广告数成正比**：`customCopyCampaign()` 按 campaign → adset → ad 逐层串行创建；源 campaign 层级越深耗时越长。大型 campaign 使用 Copy V2（`COPY_V2_JSONB_ENABLED=1`）有限并发执行。
- **幂等检查仅覆盖主 item（Copy V1 路径）**：`copyBatch` 内只对聚合消息的主 `itemId` 做前置幂等过滤，batch 内其他 item 无前置过滤。极端半完成状态下主 item 已终态可能导致整条 batch 被跳过。Copy V2 通过 `operation_copy_steps` 逐步幂等，不受此限制。
- **`bindFbAccount` 自动授权**：绑定 FB 个号时会自动给操作用户自身添加 `fb_account` 资源 grant（`user_resource_grants`）并立即刷新 Redis 权限缓存，无需手动分配。
- **`operation_tasks.status` 有 `paused`/`cancelled` 两个新状态**：Worker 会在每条消息处理前调 `assertTaskRunnable()` 检查，`paused` 会 nack 消息等待恢复，`cancelled` 会 dead 消息。注意已在 retry queue 中的消息仍会被尝试消费，需等重试耗尽才彻底停止。

---

## 生产部署

```powershell
# 部署（Windows → 远程服务器）
# 需要 SSH 密钥：~/.ssh/meta_ads_deploy
scripts\deploy-production.ps1

# 跳过 typecheck 和 web 构建（快速部署）
scripts\deploy-production.ps1 -SkipLocalChecks

# 回滚到上一个版本
scripts\rollback-production.ps1
```

**部署流程**（`scripts/deploy-production.ps1` → `scripts/server-install-release.sh`）：
1. 本地 typecheck + `bun --cwd apps/web build`
2. 打包代码为 `tar.gz`（排除 `node_modules` / `.git` / `.env`）
3. scp 上传到服务器 `/opt/ads-management/.deploy/incoming/`
4. 服务器侧：备份当前版本 → 备份数据库（pg_dump）→ 解压新版本 → `bun install --frozen-lockfile` → `db migrate` → 重启服务（systemd 优先，fallback pm2）→ `/health` 健康检查
5. 健康检查失败自动输出回滚命令

服务器上手动回滚：`cd /opt/ads-management && ./rollback-last.sh`

**服务器环境文件**：`/etc/ads-management/ads.env`（部署时自动读取，不会被代码覆盖）

---

## 设计文档（docs/）

| 文件 | 内容 |
|---|---|
| `copy-flow-serial-current.md` | **当前**复制链路说明（串行自建 create-copy，主要参考文档） |
| `batch-copy-flow-current.md` | 历史版本批量复制链路（Meta async_batch_requests，已废弃） |
| `copy-parallel-async-plan.md` | 批量复制并行异步改造计划（设计草稿） |
| `copy-parallel-async-risk-analysis.md` | 并行异步改造风险分析 |
| `copy-parallel-task-evaluation.md` | 并行任务评估 |
| `copy-concurrency-overall-recommendation.md` | 并发方案综合推荐 |
| `large-campaign-copy-v2-dag-plan.md` | 大型 campaign Copy V2 DAG 计划 |
| `large-campaign-copy-jsonb-state-machine-plan.md` | Copy V2 JSONB 状态机设计 |
| `overall-optimization-execution-roadmap.md` | 整体优化执行优先级排序（权限→IAM→工作台→广告对象落库→审计） |
| `access-chain-permission-audit.md` | 权限与选择链路审计 |
| `global-governance-and-ad-object-storage-evaluation.md` | 全局治理底座与广告对象存储评估 |
| `ui-optimization-iam-and-home-workspace.md` | IAM 三栏联动 + 广告管理工作台 UI 设计 |
| `ui-optimization-suggestions.md` | UI 优化建议汇总 |
| `online-meta-test-config.md` | 线上 Meta API 真实测试配置指南 |
