# 广告管理系统

> 多公司隔离、RBAC + 资源作用域的 Facebook 广告管理系统。基于外部 CRM API 获取授权账号 token；前端统一将授权账号展示为 **广告账户组**，承载 **1000+ 广告账户** 的批量 **复制 / 开关 / 删除 / 控预算** 操作，API 秒级响应。

业务层级: `公司 (租户) → 广告账户组 → 广告账户 → 广告系列 → 广告组 → 广告`。

> 说明：数据库和 API 内部仍沿用历史命名 `fb_account`，前端和用户文档统一称为“广告账户组”。

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Bun |
| 后端 | Elysia (TypeScript) — 模块化单体 |
| Worker | Bun 进程,消费 RabbitMQ,横向扩 |
| 前端 | React 19 + Vite + TanStack Router/Query + Tailwind |
| 数据库 | PostgreSQL 16 + Row-Level Security |
| ORM | Drizzle |
| 队列 | RabbitMQ 3.13(分片 + 阶梯重试 + DLQ) |
| 缓存/锁/限流 | Redis 7(原子 Lua 令牌桶) |
| 实时进度 | SSE |
| Meta API | v21.0(CRM 锁定版本) |
| 告警 | `lib/notifier` 接口(默认 console;`NOTIFIER_DRIVER=feishu` 切换飞书 Webhook) |

## 信息架构

登录后默认进入首页总览:
```
登录
  └─ / (首页仪表盘：公司、账户组、广告账户、后台任务概览)
       ├─ /fb-accounts (广告账户组列表)
       │    └─ /fb-accounts/$id (该账户组下广告账户)
       └─ /ad-accounts (完整广告管理入口)
            └─ /ad-accounts/$id (广告系列)
                  └─ /ad-accounts/$id/campaigns/$cid (广告组)
                        └─ /ad-accounts/$id/campaigns/$cid/adsets/$asid (广告)
```

完整广告管理页支持:
- 名称左侧 **Switch toggle**(开/关)
- 多选 + 批量(暂停/启用/改预算/复制/归档)
- `spend / orders / CPA / CPC / 加购 / 结账 / CPM` 列(可切换日期范围: today/yesterday/last_7d/last_30d/lifetime)
- 复制 Dialog: 排期起始时间 + N 份 + 前缀 + 国家后缀 + 日期后缀 + 测试编号
- 操作后列表不强制刷新，保留当前分页、滚动位置和筛选上下文

管理端入口:
- `/admin/company`: 公司新增、改名、人员分配、公司资产概览，并可跳转 IAM 做权限管理
- `/admin/iam`: 用户 / 广告账户组 / 广告账户三栏联动授权；PlatformAdmin 可切换公司，其他角色不可切换
- `/admin/users`: 用户目录、角色和启停
- `/admin/operations`: 熔断、Token 健康、广告对象同步、后台任务
- `/admin/audit`: 全局审计日志

## 快速开始(本地 mock 模式)

### 1. 准备依赖
```powershell
# Bun >= 1.3
bun install

# 起底层服务(postgres / redis / rabbitmq)
docker compose up -d
```

### 2. 数据库初始化
```powershell
# 迁移 schema + RLS 策略 + 建 ads_app 角色
bun --cwd packages/db migrate

# 种子: 1 个 Demo Co. 公司 + 4 个角色 + admin@demo.local/admin123
# admin@demo.local 同时拥有 PlatformAdmin + CompanyAdmin，方便本地演示跨公司管理
bun --cwd packages/db seed

# (mock 模式可选)演示用假广告账户组 + 8 个广告账户
$env:MOCK_AD_ACCOUNT_COUNT='8'; bun --cwd packages/db src/seed-mock-fb.ts
```

### 3. 启动三个进程

终端 1 — API:
```powershell
cd apps/api
$env:META_FAKE='1'   # 演示用,真接入后去掉
$env:DATABASE_URL='postgres://ads_app:ads_app@localhost:5432/ads'
$env:DATABASE_ADMIN_URL='postgres://ads:ads@localhost:5432/ads'
$env:REDIS_URL='redis://localhost:6379'
$env:RABBITMQ_URL='amqp://ads:ads@localhost:5672'
$env:JWT_SECRET='devsecret'
bun src/index.ts
```

终端 2 — Worker:
```powershell
cd apps/worker
$env:META_FAKE='1'
$env:FAKE_DELAY_MS='20'
$env:FAKE_FAIL_RATE='0.05'
$env:FAKE_RATELIMIT_RATE='0.03'
$env:DATABASE_URL='postgres://ads_app:ads_app@localhost:5432/ads'
$env:REDIS_URL='redis://localhost:6379'
$env:RABBITMQ_URL='amqp://ads:ads@localhost:5672'
bun src/index.ts
```

终端 3 — Web:
```powershell
cd apps/web
bun run vite --port 5173
```

浏览器打开 **http://localhost:5173**,登录 `admin@demo.local` / `admin123`(PlatformAdmin + CompanyAdmin)。

## 真实接入步骤(去掉 mock)

线上测试配置、第三方资料清单和 mock 清理说明见 [docs/online-meta-test-config.md](./docs/online-meta-test-config.md)。

### 配置 CRM 凭证(必须)
```powershell
$env:CRM_BASE_URL='https://adtool-api.gimc-hk.com'
$env:CRM_CID='<你的 cid>'
$env:CRM_ACCESS_TOKEN='<你的 accessToken>'
```
启动后在前端"绑定广告账户组" → CRM 给授权链接 → Meta 用户授权回调 → API 用 code 换 token → AES-GCM 加密入库 + 拉取该账户组下广告账户。

### Token 加密(生产必填)
```powershell
$env:TOKEN_ENC_KEY='<32 字节, base64>'  # 例: openssl rand -base64 32
```
未设时 dev 模式自动用临时 key(重启后旧 token 解不出);prod 模式直接拒启动。

### 关掉 mock
启动 API 和 Worker 时**都去掉 `META_FAKE='1'`**。

### 飞书告警(可选,默认关)
```powershell
$env:NOTIFIER_DRIVER='feishu'
$env:FEISHU_WEBHOOK_URL='https://open.feishu.cn/open-apis/bot/v2/hook/xxx'
```

## 权限模型

按 `角色 (action) × 资源作用域 (scope)`:

| 角色 | 范围 |
|---|---|
| PlatformAdmin | 跨公司运维 |
| CompanyAdmin | 本公司全权(scope.bypass=true) |
| Operator | 仅作用域内可写 |
| Viewer | 仅作用域内只读 |

权限码 `resource:action`:`ad_account:read` / `campaign:status` / `campaign:budget` / `campaign:copy` / `campaign:delete` / `iam:manage` / `fb_account:bind`。

管理后台 `/admin/iam` 给员工分配广告账户组 / 广告账户。修改后 5 分钟 Redis 权限缓存自动失效(写入立即 invalidate)。

`admin@demo.local` 默认拥有 PlatformAdmin，可在 `/admin/iam` 顶部切换公司；非 PlatformAdmin 只能管理自己所属公司。公司新增、改名和人员分配在 `/admin/company` 完成。

## 异步流水线(M3)

```
前端 ─POST /operations/batch─▶ API
                                ├─ 校验作用域 + 租户隔离
                                ├─ 写 operation_tasks + N 个 items
                                ├─ 按 hash(ad_account_id) 分片 → 16 个 shard 队列
                                └─ 立即返 task_id(202)

Worker(16 个分片 consumer)
  ├─ 熔断检查 → 操作锁 → 幂等查重
  ├─ 令牌桶(账户级 + 全局, 原子 Lua)
  ├─ 取/解密 token → metaProvider 调 Meta
  ├─ 写 item 结果 + DB counter + Redis 进度
  └─ 错误分类:
       token 失效(190) → 永久熔断广告账户组 + dead
       限流(17/4/32/80004) → 账户级 60s 熔断 + 短 retry
       瞬时 → 5s/30s/2m 阶梯 retry,maxAttempts=6 入 ad.ops.failed

前端 ─GET /operations/:taskId/stream─▶ SSE 实时进度
```

## 数据同步与落库

- 广告系列、广告组、广告支持同步落库，表结构位于 `packages/db/src/schema/ad-objects.ts`。
- 管理端 `/admin/operations` 可触发广告对象同步，支持按广告账户或到期账户批量同步，深度可选 `广告系列 / 广告组 / 广告`。
- mock 模式下批量操作会在 API 进程内执行并写入本地广告对象快照，方便前端列表立即看到状态和预算变化。

## 项目结构

```
.
├── apps/
│   ├── api/                Elysia API + 账户/操作/IAM/admin 模块
│   ├── worker/             RabbitMQ consumer
│   └── web/                React 前端
├── packages/
│   ├── db/                 Drizzle schema + RLS + 迁移 + 种子 + 广告对象快照
│   ├── shared/             权限码 / 角色 / Provider 接口
│   └── eden/               Elysia Eden 客户端导出
├── docker-compose.yml      pg / redis / rabbitmq
├── CLAUDE.md               设计决策与执行规范
├── PROGRESS.md             已完成功能与后续计划
└── fb-ads-管理系统-设计.md  原始架构设计
```

## 开发

```powershell
# 全 workspace typecheck
bun --cwd apps/api      run typecheck
bun --cwd apps/worker   run typecheck
bun --cwd apps/web      run typecheck
bun --cwd packages/db   typecheck
bun --cwd packages/shared run typecheck

# 重置 mock 环境
docker exec -i ads_pg psql -U ads -d ads -c "UPDATE fb_accounts SET status='active' WHERE fb_user_id='mock_fb_user_1';"
docker exec ads_redis redis-cli FLUSHALL
docker exec ads_rabbit rabbitmqctl list_queues name | Select-Object -Skip 3 | ForEach-Object { docker exec ads_rabbit rabbitmqctl purge_queue $_ }
```

## 端口

| 服务 | 地址 |
|---|---|
| Web | http://localhost:5173 |
| API | http://localhost:3001 |
| PostgreSQL | localhost:5432 |
| Redis | localhost:6379 |
| RabbitMQ AMQP | localhost:5672 |
| RabbitMQ 管理台 | http://localhost:15672 (`ads`/`ads`) |

## 已知限制

- mock 模式 Meta 进程内状态不持久(`META_FAKE=1` 的 Meta 假数据重启清零)，已同步落库的广告对象快照仍在数据库中
- 复制操作 MVP 仅同账户(跨账户涉及素材搬运,在 M5 实现)
- 广告账户组 token 永久熔断需在 /admin 手动重置(管理员 reset + 用户重新走 OAuth)
- 内置定时器单实例(多副本部署需上分布式锁)

详细的"已完成 / 后续计划 / 限制",见 [PROGRESS.md](./PROGRESS.md)。

## License

Private.
