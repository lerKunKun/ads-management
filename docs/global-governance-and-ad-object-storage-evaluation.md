# 全局治理与广告对象落库评估

检查范围：

- 全局审计
- 全局错误处理
- 全局权限统一管理
- 广告系列、广告组、广告落库后的数据同步与数据库压力

本次只做静态检查和架构评估，不修改业务代码。

## 总体结论

当前项目已经有基础能力，但还没有形成完整的“全局统一治理”：

- 审计：已有 `writeAudit()` 和 `audit_logs`，但依赖各业务点手动调用，覆盖不完整。
- 错误处理：API 有全局 `onError`，但缺少 requestId、结构化日志、错误审计和前端统一错误体验。
- 权限：权限码集中定义了，但路由里仍有大量手写字符串和散落校验；作用域只统一到 `fb_account` / `ad_account`。
- 广告对象落库：建议落库，1000+ 广告账户不是问题；真正风险是高频全量同步和任务计数热点写入。

广告系列、广告组、广告如果要支撑生产级权限校验、审计、搜索、排序和减少 Meta 实时调用，应该做本地读模型。但同步策略必须是“异步增量 + 操作写穿 + 定期校准”，不能是频繁全量 upsert。

## 全局审计检查

### 现状

审计表结构：

- `packages/db/src/schema/audit.ts`
- 表：`audit_logs`
- 字段：`company_id`、`user_id`、`action`、`resource`、`detail`、`ip`、`created_at`
- 索引：`company_id`、`action`、`created_at`

审计写入口：

- `apps/api/src/modules/iam/auth-service.ts`
- 函数：`writeAudit()`

当前已覆盖：

- 登录
- 创建用户
- 修改用户
- 添加/删除作用域
- 绑定 FB 个号
- 同步单 target 操作：状态、预算、复制、删除
- 批量任务入队
- 管理端熔断重置、Token 扫描

### 问题

1. 审计依赖业务代码手动调用，容易漏。

读接口、权限拒绝、业务失败、系统异常、worker 执行失败没有统一审计。

2. 审计写入和业务返回耦合。

部分业务在成功后 `await writeAudit()`。如果审计写失败，可能导致业务已完成但接口返回失败。

3. 批量任务审计粒度偏粗。

当前批量任务只审计 task 创建。worker 实际执行每个 item 的成功、失败、重试、dead 状态没有进入 `audit_logs`，只在 `operation_task_items` 中体现。

4. 审计查询索引不够贴合后台查询。

后台常见查询是按公司 + 时间倒序，或公司 + action + 时间倒序。当前是单列索引，数据量上来后查询效率不理想。

5. 审计 detail 缺少资源快照。

广告对象操作只记录 ID 和参数，缺少当时的名称、广告账户名、Meta act ID、父级链路，后续排查依赖外部状态。

### 建议

审计分三类：

- 业务审计：用户主动操作成功，如创建用户、授权、改预算、归档。
- 安全审计：登录失败、权限不足、越权访问、Token 失效。
- 系统审计：worker dead、Meta API 异常、熔断打开/关闭、同步失败。

落地建议：

- `writeAudit()` 改成 best-effort，不阻断主业务。
- 高价值审计可以进 outbox，由后台异步写入或投递。
- 增加复合索引：
  - `(company_id, created_at desc)`
  - `(company_id, action, created_at desc)`
  - 必要时 `(company_id, user_id, created_at desc)`
- `detail` 中记录资源名称快照和父级上下文。
- worker 的失败终态不建议每个 item 都写 `audit_logs`，可以先写 `operation_task_items`，任务完成后聚合写一条系统审计。

## 全局错误处理检查

### 现状

API 全局错误处理位于：

- `apps/api/src/index.ts`

现有能力：

- `HttpError` 返回业务状态码和业务 code。
- validation 返回 422。
- not found 返回 404。
- 未知异常返回 500。
- 500 会 `console.error`。

前端错误处理位于：

- `apps/web/src/lib/api.ts`

现有能力：

- 统一 fetch 包装。
- 401 时清 token。
- `body.code !== 0` 转成 `Error`。
- 页面局部展示错误。

### 问题

1. 缺少 requestId。

用户报错后无法用一个 ID 关联前端、API 日志、worker 日志和审计。

2. 错误日志没有结构化。

当前主要是 `console.error`，没有统一字段，例如 method、path、userId、companyId、status、bizCode、duration。

3. 错误未进入安全审计。

权限拒绝、越权访问、token 失效、Meta 限流等关键事件没有统一审计策略。

4. 前端没有全局错误体验。

页面各自处理 error，没有统一 toast、403 页面、401 自动跳登录、ErrorBoundary。

5. 权限错误风格不一致。

有些路由通过 `requirePermission()` 返回对象，有些业务函数 throw `HttpError`，错误来源不统一。

### 建议

API：

- 增加 requestId 中间件，读取 `x-request-id` 或生成 UUID。
- 所有响应 envelope 增加 `requestId`。
- `onError` 写结构化日志。
- 对 401、403、409 token invalid、429 rate limited 做安全/系统审计。
- 为 `HttpError` 增加 `meta` 字段，便于携带资源 ID、action、scope。

前端：

- `api.call()` 识别 401，清 token 后全局跳 `/login`。
- 403 展示统一无权限状态。
- 409 token invalid 展示“需要重新绑定 FB 个号”。
- 增加全局 toast 或 notification。
- 增加 React ErrorBoundary。

## 全局权限统一管理检查

### 现状

权限定义：

- `packages/shared/src/permissions.ts`

权限校验：

- `apps/api/src/middleware/auth.ts`
- `requirePermission(code)`
- `checkScope(principal, resourceType, resourceId)`

批量权限映射：

- `apps/api/src/modules/operation/batch-service.ts`
- `ACTION_PERMISSION`

### 问题

1. 路由中仍大量手写权限字符串。

例如 `requirePermission('campaign:status')`、`requirePermission('iam:manage')` 分散在多个模块。

2. 批量接口绕开统一中间件。

`/operations/batch` 根据 body action 手动 `principal.permissions.includes(perm)`。

3. `campaign:*` 权限复用于广告组和广告。

当前 `adset:status`、`ad:status` 都映射到 `campaign:status`。短期可用，但语义不准确，后续无法做细粒度授权。

4. 作用域解析没有统一服务。

FB 个号授权、广告账户授权、bypass 的有效作用域分散在 `listFbAccounts`、`listAdAccounts`、operation service、batch service 中。

5. 下级对象没有统一归属校验。

campaign/adset/ad 的操作只校验广告账户 ID 是否在作用域内，不校验目标对象是否真的属于该广告账户。

### 建议

新增统一权限策略层：

```ts
type RoutePolicy = {
  permission: PermissionCode;
  scope?: {
    type: 'fb_account' | 'ad_account';
    from: 'params.id' | 'body.adAccountId' | 'query.ad_account_id';
  };
  auditAction?: string;
};
```

路由只声明 policy，不手写权限字符串。

新增统一作用域服务：

```ts
resolveEffectiveScope(principal):
  - bypass: 公司下全部 FB 个号和广告账户
  - fb grants: FB 个号 + 其下全部广告账户
  - ad grants: 广告账户 + 所属 FB 个号
```

权限命名建议二选一：

- 粗粒度：改成 `ad_object:status`、`ad_object:budget`、`ad_object:copy`、`ad_object:delete`。
- 细粒度：补齐 `campaign:*`、`adset:*`、`ad:*`。

## 广告对象落库评估

### 是否应该落库

建议落库。

原因：

- 支撑下级对象归属校验。
- 支撑广告对象搜索、排序、筛选和分页。
- 降低页面实时访问 Meta 的频率。
- 支撑权限、审计、任务结果回放。
- 支撑后续 ClickHouse/报表/自动化策略。

但落库应定位为“本地读模型”，Meta 仍是最终外部事实源。不能假设本地库永远强一致。

### 数据规模粗估

如果接入 1000+ 广告账户，可能的数据量：

- 每账户 100 个 campaign：10 万 campaign。
- 每 campaign 5 个 adset：50 万 adset。
- 每 adset 2-5 个 ad：100 万到 250 万 ad。

这个规模 PostgreSQL 可以承受。

真正压力来自写入方式：

- 每分钟全量同步所有账户不可取。
- 每次页面访问都全量拉 Meta 再 upsert 不可取。
- 每个广告对象状态变化都同步写多张表、再写审计、再更新任务计数，会造成热点。

### 当前任务写入压力

当前 worker 每个 item 成功至少会：

- 更新 `operation_task_items` 一行。
- 更新 `operation_tasks` 的 success/failed 计数。
- 更新 Redis 进度。

问题是同一个大任务下所有 item 都会更新同一行 `operation_tasks`。当批量任务很大、多个 shard 并发时，这一行会成为数据库行锁热点。

建议：

- Redis 作为实时计数，DB 定期 flush 或任务完成时汇总。
- 或用分片计数表 `operation_task_counters(task_id, shard, success, failed)`，最终汇总。
- `operation_task_items` 批量状态更新可保持，但避免额外每 item 写 audit。

### 推荐表设计

```text
campaigns
  id
  company_id
  ad_account_id
  meta_campaign_id
  name
  status
  effective_status
  objective
  daily_budget
  lifetime_budget
  created_time
  updated_time
  last_synced_at
  sync_hash

adsets
  id
  company_id
  ad_account_id
  campaign_id
  meta_adset_id
  name
  status
  effective_status
  daily_budget
  lifetime_budget
  optimization_goal
  created_time
  updated_time
  last_synced_at
  sync_hash

ads
  id
  company_id
  ad_account_id
  campaign_id
  adset_id
  meta_ad_id
  name
  status
  effective_status
  creative_id
  created_time
  updated_time
  last_synced_at
  sync_hash

ad_account_sync_state
  ad_account_id
  level
  last_synced_at
  cursor
  status
  error
```

关键索引：

- `campaigns unique(company_id, meta_campaign_id)`
- `adsets unique(company_id, meta_adset_id)`
- `ads unique(company_id, meta_ad_id)`
- `(company_id, ad_account_id, status)`
- `(ad_account_id, updated_time desc)`
- `adsets(campaign_id)`
- `ads(adset_id)`

### 推荐同步策略

采用四层策略：

1. 操作写穿

通过本系统修改状态、预算、复制、归档成功后，立即更新本地对象表。

2. 增量同步

后台按广告账户和层级定时拉取变更，只 upsert 有变化的行。通过 `updated_time`、`last_synced_at`、`sync_hash` 减少无效写。

3. 活跃账户优先

最近有操作、最近被查看、正在跑任务的账户高频同步；长期未访问账户低频同步。

4. 定期校准

每天或每几小时做低优先级全量校准，修复外部系统直接修改导致的不一致。

### 同步频率建议

初始建议：

- 活跃广告账户：5-15 分钟增量同步。
- 非活跃广告账户：1-6 小时同步。
- 异常账户：指数退避。
- 全量校准：每天一次或按账户分摊。

不要让 1000+ 广告账户同时同步。应使用队列按账户分片，平滑调度。

### 是否会对数据库造成很大压力

如果设计正确，不会。

1000+ 广告账户 + 百万级广告对象，PostgreSQL 足够承载查询和增量写入。压力可控的关键是：

- 不做高频全量 upsert。
- 只写变化数据。
- 批量 upsert。
- 控制同步并发。
- 避免任务计数单行热点。
- 审计不按每个 item 无脑写一行。

如果设计错误，会很快压垮：

- 每分钟全账户全量同步。
- 页面访问触发全量同步。
- 每个对象每次同步都 update，即使内容没变。
- 每个 worker item 同时更新同一 task 行。
- 每个 item 都写 audit log。

## 推荐优先级

### P0

- 增加 requestId 和结构化错误日志。
- 整理统一权限 policy，减少路由手写权限字符串。
- 增加 `resolveEffectiveScope()`。
- 补 campaign/adset/ad 归属校验。
- 修复大批量任务的 `operation_tasks` 计数热点。

### P1

- 设计并落地 campaign/adset/ad 本地读模型。
- 操作成功后写穿本地表。
- 后台增量同步队列按广告账户分片调度。
- 审计增加复合索引和资源快照。
- 前端统一错误处理和权限不足状态。

### P2

- outbox 式审计和系统事件。
- 任务失败聚合审计。
- 同步任务分层调度和退避策略。
- 长期归档历史任务和审计，避免主表无限增长。

## 最终判断

广告系列、广告组、广告落库是正确方向，尤其对 1000+ 广告账户接入后的查询、权限、审计和稳定性有价值。

不要把落库理解为“Meta 全量镜像实时同步”。合理模型是：

```text
本地库负责读、筛选、权限、审计、归属校验
Meta 负责最终执行和外部事实源
操作成功后本地写穿
后台增量同步负责校准
```

在这个模型下，数据库压力可控。真正需要优先处理的是全局治理统一化和同步写入策略，而不是担心“1000+ 广告账户”这个数量本身。
