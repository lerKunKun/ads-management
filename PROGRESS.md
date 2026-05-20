# FB 广告管理系统 · 进度与计划

> 对应设计文档 `fb-ads-管理系统-设计.md`,执行规范 `CLAUDE.md`。
> 三个开工确认项已落地:**React 前端、CRM 共用一套凭证、复制操作 MVP 仅同账户**;按你要求**飞书暂不接入**(notifier 留接口、driver 默认 console)。

---

## 已完成 (M1 → M4)

### M1 多租户 + IAM + OAuth + 广告账户同步
- Bun workspaces monorepo:`apps/{api,worker,web}` + `packages/{db,shared,eden}`
- `docker-compose`: pg16 / redis7 / rabbitmq3.13
- PostgreSQL 12 张表 + RLS 强制(`FORCE ROW LEVEL SECURITY`):公司硬隔离边界由 `app.current_company_id` 注入、超管 `app.bypass_rls` 绕行
- 非 SUPERUSER `ads_app` 角色专给运行时使用,迁移/seed 走超管 `ads`
- `iam` 模块:邮箱密码登录 + HS256 JWT + Redis 5min 权限缓存 + RBAC + 作用域校验 + 审计
- `account` 模块:CRM OAuth(`POST /oauth/fb/authorize-url`、`POST /oauth/fb/callback`)、AES-256-GCM 加密 token、广告账户同步、`GET /ad-accounts` 走作用域过滤
- 前端:登录页、广告账户列表(shadcn 表格)、TanStack Router/Query + Vite 代理 `/api/*`

### M2 单 target 状态/预算同步执行 + 审计
- `lib/meta-client` 扩展 `listCampaigns / setCampaignStatus / setBudget`,`MetaApiError` 区分 token 失效(code=190) / 限流(17/4/32/80004)
- `MetaProvider` 抽象(`@ads/shared`),MVP 实现 Meta
- 单 target 端点:`POST /campaigns/:id/status`、`POST /campaigns/:id/budget`
- token 服务:Redis 缓存 + 失效自动熔断
- 前端详情页:campaign 列表 + 暂停/启用 + 改日预算 Dialog

### M3 RabbitMQ + Redis 异步流水线
- 拓扑:`ad.ops` direct + 16 个 shard 队列(按 `hash(adAccountId)` 分片→账户级串行)
- 重试:per-shard 三档 retry queue(5s/30s/2m),`x-dead-letter-routing-key` 保证回投到正确 shard;超 `maxAttempts=6` → `ad.ops.failed`
- 优先级:status/budget=8、copy/delete=3(`x-max-priority=10`)
- Redis:原子 Lua 令牌桶(账户 `ratelimit:adacct:*` + 全局 `ratelimit:app`)、熔断 `breaker:*`、操作锁 `lock:target:*`、进度 `task:{id}:progress` + pubsub `task:{id}:event`
- `POST /operations/batch` 入库 + 入队,202 立返 `taskId`(500 个 target ~160ms);幂等键 `sha256(taskId|adAccount|target|action|params)`
- `GET /operations/:taskId`(DB+Redis 合并) + `GET /operations/:taskId/stream`(SSE,?token=query 兼容 EventSource,25s 心跳,终态自动断流)
- Worker(`apps/worker`):16 个分片 consumer,`prefetch=5`;熔断检查 → op-lock → 幂等查重 → 令牌桶 → token → metaProvider → 写库 + bumpProgress
- 错误分类:token 失效永久熔断个号 + dead;限流账户级 60s 熔断 + 短 retry;瞬时按 ladder 阶梯;**breaker/限流命中走"短 retry 不计 attempt"**(避免雪崩)
- 前端:多选 + 批量启用/暂停/改预算 + SSE 进度对话框(进度条 + 实时计数)

### M4 复制/删除 + token 健康监控 + 熔断管理 + notifier
- meta-client + MetaProvider 实装 `copyCampaign` / `removeCampaign`(MVP 仅同账户复制;targetAdAccountId 不同会抛 422)
- 单 target 端点:`POST /campaigns/:id/copy`、`POST /campaigns/:id/delete`(默认归档,`?hard=true` 真删)
- Worker `executeProvider` 支持 copy/delete;copy 的新 id 通过 `markSuccess(msg, result)` 写入 `operation_task_items.error` 列(MVP 复用列,M5+ 加 `result jsonb`)
- `scanTokenHealth`:跨租户扫描 `token_expires_at < NOW()+7d` + Redis 同 fb 同日去重;按剩余天数选 warn/error
- 内置定时器:启动 30s 后首扫、之后每 6h
- `lib/notifier`:`ConsoleNotifier` 默认 + `FeishuNotifier` 完整实现(interactive card,按 level 红/橙/蓝);切换只改 `NOTIFIER_DRIVER=feishu` + `FEISHU_WEBHOOK_URL=...`
- `admin` 模块(权限 `iam:manage`):
  - `GET /_admin/breakers` 列开口熔断(CompanyAdmin 仅看本公司)
  - `POST /_admin/breakers/reset` 批量重置,fb 类熔断同时把 `fb_accounts.status` 改回 active
  - `POST /_admin/scan-token-health` 手动触发扫描
- 前端:单行复制/归档 + 批量复制/批量归档(走 M3 流水线 + SSE)

---

## 启动 & 测试指南

### 一次性准备(已完成,无需重做)
```powershell
# 1) 起底层服务
docker compose up -d

# 2) 跑数据库迁移 + RLS + 种子(超级用户连接)
bun --cwd packages/db run migrate
bun --cwd packages/db run seed

# 3) mock seed(M3+M4 演示用,在 demo 公司下建 1 个假 FB 个号 + 8 个广告账户)
$env:MOCK_AD_ACCOUNT_COUNT='8'; bun --cwd packages/db run src/seed-mock-fb.ts | Tee-Object /tmp/mock-ids.txt
```

### 日常启动(每次开 3 个终端)

终端 1 — API:
```powershell
cd apps\api
$env:DATABASE_URL='postgres://ads_app:ads_app@localhost:5432/ads'
$env:DATABASE_ADMIN_URL='postgres://ads:ads@localhost:5432/ads'
$env:REDIS_URL='redis://localhost:6379'
$env:RABBITMQ_URL='amqp://ads:ads@localhost:5672'
$env:JWT_SECRET='devsecret'
$env:META_FAKE='1'   # 演示用,真接入后去掉
bun src/index.ts
```

终端 2 — Worker:
```powershell
cd apps\worker
$env:META_FAKE='1'
$env:FAKE_DELAY_MS='20'
$env:FAKE_FAIL_RATE='0.05'      # 5% 真实瞬时失败
$env:FAKE_RATELIMIT_RATE='0.03' # 3% 限流
$env:DATABASE_URL='postgres://ads_app:ads_app@localhost:5432/ads'
$env:REDIS_URL='redis://localhost:6379'
$env:RABBITMQ_URL='amqp://ads:ads@localhost:5672'
bun src/index.ts
```

终端 3 — Web:
```powershell
cd apps\web
bun run vite --port 5173
```

打开浏览器:**http://localhost:5173**
登录:`admin@demo.local` / `admin123`(CompanyAdmin 角色,有所有权限)

### 推荐测试路径(mock 模式下都能跑通)

1. **登录** → 进入广告账户列表,看到 mock 种的 8 个广告账户
2. 点任一个广告账户名 → 进入详情页,看到 6 个 mock campaign
3. **单 target 操作**(走 M2 同步):
   - 点"暂停/启用" → 状态切换
   - 点"改预算" → 改完后表里 dailyBudget 更新
   - 点"复制" → 列表增加一个 `Copy of ...` 行
   - 点"归档" → 状态变 ARCHIVED
4. **批量操作**(走 M3 流水线):
   - 勾选多个 campaign(包括表头 checkbox 全选)
   - 点"批量暂停"/"批量启用"/"批量改预算"/"批量复制"/"批量归档"
   - 弹出 SSE 进度对话框,看进度条 + total/success/failed 实时变化
   - 终态后点"完成",列表 invalidate 自动刷新
5. **熔断管理**(用 curl/Postman):
   - `GET /api/_admin/breakers` 列当前熔断
   - 手塞一个:`docker exec ads_redis redis-cli SET 'breaker:adacct:act_mock_1' 'manual' EX 600`
   - 再次 GET 看到
   - `POST /api/_admin/breakers/reset` body `{"keys":["breaker:adacct:act_mock_1"]}` 重置
6. **审计日志**:每个操作都写 `audit_logs`,可查:
   ```powershell
   docker exec -i ads_pg psql -U ads -d ads -c "SELECT action, resource, LEFT(detail::text, 80) FROM audit_logs ORDER BY created_at DESC LIMIT 20;"
   ```
7. **RabbitMQ 管理台**:http://localhost:15672 (`ads`/`ads`) 看队列堆积/重试/死信

### 重置环境(回到干净状态)
```powershell
docker exec -i ads_pg psql -U ads -d ads -c "UPDATE fb_accounts SET status='active' WHERE fb_user_id='mock_fb_user_1';"
docker exec ads_redis redis-cli FLUSHALL
docker exec ads_rabbit rabbitmqctl list_queues name | Select-Object -Skip 3 | ForEach-Object { docker exec ads_rabbit rabbitmqctl purge_queue $_ }
```

---

## 真实接入步骤(去掉 mock,接生产)

### 1. 配置 CRM 凭证(必须)
在启动 API 前设置:
```powershell
$env:CRM_BASE_URL='https://adtool-api.gimc-hk.com'
$env:CRM_CID='<你的 cid>'
$env:CRM_ACCESS_TOKEN='<你的 accessToken>'
```
启动后:
- 在前端"绑定 FB 个号"按钮触发 → CRM 给授权链接 → Meta 用户授权回调 → API 用 code 换 token → AES-GCM 加密入库 + 自动拉取该个号下所有广告账户
- 此后该 FB 用户下的真实 ad_accounts 就出现在列表里,真实 campaign 可在详情页操作

### 2. 关掉 mock 模式
两个终端启动时**都去掉 `META_FAKE='1'`**;API 端口/Worker 端口不变。
注意:`mock_fb_user_1` 那条假 fb_account 可以保留(也可以 `UPDATE ... SET status='disabled'` 隐藏)。

### 3. token 加密 key(生产必填)
```powershell
$env:TOKEN_ENC_KEY='<32 字节, base64>'  # 例: openssl rand -base64 32
```
未设时 dev 模式自动用临时 key(重启后旧 token 解不出);prod 模式直接拒启动。

### 4. 飞书(暂缓接入)
你确认 MVP 不接,接口已就绪。需要时:
```powershell
$env:NOTIFIER_DRIVER='feishu'
$env:FEISHU_WEBHOOK_URL='https://open.feishu.cn/open-apis/bot/v2/hook/xxx'
```
代码 `apps/api/src/lib/notifier.ts` 里 `FeishuNotifier` 用 interactive card 模板,可直接联调。

---

## 待办 & M5+ 计划

按 CLAUDE.md 第 9 章"MVP 迭代路线",M5 之前是 MVP,M5 是生产化。

### 立即要做(MVP 收尾,~半天)
- [ ] **生产化 secret**:从环境变量切到 KMS/Secret Manager(`TOKEN_ENC_KEY` / `JWT_SECRET` / `CRM_ACCESS_TOKEN`)
- [ ] **CompanyAdmin 授权 UI**:`/iam/users/:id/grants` 现在是占位 not-implemented;需要前端管理页给员工绑 fb_account / ad_account 作用域
- [ ] **operation_task_items 加 `result jsonb` 列**:copy 的新 id 现在复用 `error` 列,clean up

### M5 (CLAUDE.md 提及,生产化阶段)
- [ ] **拆服务**:模块边界已经清(iam / account / operation / admin),按需拆 `iam-service` / `account-service` / `operation-service` + worker 独立部署;Eden 已经能跨进程
- [ ] **Prometheus + Grafana**:加 `/metrics` 端点,埋点
  - rabbitmq 队列堆积
  - Redis 令牌桶剩余/命中率
  - 任务时延(p50/p95/p99)
  - Meta API 错误率分类
- [ ] **ClickHouse 花费分析**:每天定时拉 `/{act}/insights`,落 ClickHouse,前端加报表
- [ ] **跨账户复制 + 素材搬运**:`copyCampaign` 当前 MVP 限同账户;跨账户需:
  1. 用源账户 token 拉 campaign + adset + ad + creative 完整树
  2. 下载创意素材(图/视频)到 MinIO/S3
  3. 用目标账户 token 上传素材 + 创建对应对象
  4. 失败回滚 已建对象
- [ ] **多平台 Provider**:`@ads/shared/provider.ts` 接口已抽象,实现 `TikTokProvider`/`GoogleProvider`,operation 模块根据 ad_account 的平台分发
- [ ] **导出审计**:`audit_logs` 按租户 + 时间段导出 CSV/Excel

### 长期(超 M5)
- [ ] **多区域部署**:Meta API 在不同区域响应差异大;考虑按 ad_account 区域亲和性路由
- [ ] **可视化操作回放**:operation_task_items 完整时序,做"任务结果详情页"
- [ ] **预算策略引擎**:基于 CPA/ROAS 自动调预算/暂停 campaign(配合花费分析数据)

---

## 已知限制 & 备注

- **mock 模式数据不持久**:`META_FAKE=1` 下 campaign 状态用进程内 Map,API 重启即重置(刷新 web 会重新看到初始 6 个 ACTIVE/PAUSED 半半的 campaign)
- **PG RLS 必须有 SET LOCAL**:任何直接用 `db.execute()` 不开事务不设 `app.current_company_id` 都拿不到数据(已通过 `withTenant` 封装,有错都是缺这个上下文)
- **Windows curl --data-binary @file**:Windows git-bash 的 curl 解析 `@/tmp/x` 经常失败,集成测试统一用 `bun -e` + `fetch`
- **Bun --hot 注意**:`bun --hot` 在 worker 这种长连接(amqplib)上偶发反复 reload 导致僵尸连接;脚本里都直接 `bun src/index.ts` 不开 --hot
- **EventSource 鉴权**:浏览器原生 EventSource 不支持自定义 header,SSE 端点改为 query `?token=` 兼容;生产环境若过同源代理,改走 cookie 更安全
- **`fb_account` 永久熔断需手动重置**:token 失效后熔断是永久的,管理员通过 `/_admin/breakers/reset` 解除并需要重新走 OAuth(目前 reset 把状态改回 active,但 token 还是旧的;真接入后让用户重新点"绑定 FB 个号"做 re-bind)
- **令牌桶默认值偏保守**:`ratelimit:adacct` 容量 20、补充 2/s;Meta 实际能接更高,接真 token 后看 `X-Ad-Account-Usage` 头反馈再调

---

## 关键文件位置(供查阅 / 改动)

| 关注点 | 位置 |
|---|---|
| 全局配置 | `apps/api/src/env.ts` + `.env.example` |
| RLS 策略 | `packages/db/src/rls.sql` |
| RBAC 权限/角色 | `packages/db/src/seed.ts` + `packages/shared/src/permissions.ts` |
| Meta API 封装 | `apps/api/src/lib/meta-client.ts` |
| Provider 抽象 | `packages/shared/src/provider.ts` |
| Meta 实现 | `apps/api/src/providers/meta.ts` |
| RabbitMQ 拓扑 | `apps/api/src/lib/rabbitmq-topology.ts` |
| 令牌桶 / 熔断 / 锁 | `apps/api/src/lib/rate-limit.ts` / `breaker.ts` / `op-lock.ts` |
| 任务进度 / SSE | `apps/api/src/lib/progress.ts` / `modules/operation/sse.ts` |
| Worker 主循环 | `apps/worker/src/handler.ts` + `index.ts` |
| 飞书 / 告警 | `apps/api/src/lib/notifier.ts` |
| 定时任务 | `apps/api/src/lib/scheduler.ts` |
| Mock Meta 状态 | `apps/api/src/lib/fake-meta-state.ts` |
