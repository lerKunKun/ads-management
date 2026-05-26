# 大系列复制 V2 DAG 稳定提速计划

更新时间：2026-05-23

## 目标

当前痛点是“大系列复制慢”。多 worker 只能提升多个独立 item 的吞吐，对单个大 campaign 帮助有限。要明显提升单个大系列复制速度，需要把 campaign 内部拆成可编排步骤：

```text
create campaign
  -> create adsets in limited parallel
      -> create ads under each new adset in limited parallel
```

本计划目标：

- 大幅提升大 campaign 深拷贝速度。
- 严格控制在上游 API 限制内。
- 不影响现有复制功能。
- 出错可恢复，不重复创建对象。
- 新对象默认安全状态，避免异常投放。

## 核心结论

推荐做 **V2 DAG 旁路复制**，不要直接改当前复制主链路。

```text
现有复制链路：保持不动，继续作为默认路径
V2 DAG 链路：只对大系列、allowlist 账号、灰度开关开启
异常时：自动降级或提示使用旧链路
```

这样即使 V2 出现问题，也不会让现有复制功能不可用。

## 上游限制

已确认规则：

- 异步方法广告数量不能超过 51。
- 访问频次每小时 100000 次。
- 系统只使用 60%-70%，即 60000-70000 次/小时。

换算：

```text
60000/h = 16.67 req/s
70000/h = 19.44 req/s
```

建议：

```text
灰度期 GLOBAL_META_QPS = 16/s
稳定期 GLOBAL_META_QPS = 18/s
不长期超过 19/s
```

async request_set 由于有 51 ads 限制，不适合作为“大系列复制”的主方案。它适合小 campaign、小 adset 或少量广告复制。大系列主方案应使用 V2 DAG。

## 设计原则

1. **旧链路不动**
   - 当前复制路径继续保留。
   - V2 通过 feature flag 开启。
   - 默认关闭，先 allowlist 灰度。

2. **每一步可恢复**
   - campaign、adset、ad 每个创建步骤都落账。
   - 已成功步骤 retry 时直接复用 `new_id`。
   - 不允许盲目重复 create。

3. **父子关系先落账再继续**
   - campaign 创建成功并写入账本后，才能创建 adset。
   - adset 创建成功并写入账本后，才能创建该 adset 下的 ad。

4. **请求级限流**
   - 所有 Meta `graph()` 请求前都要 acquire token。
   - 不能只在任务入口限流一次。
   - 429 或使用率过高时自动降并发。

5. **默认安全状态**
   - 新 campaign/adset/ad 创建时默认 `PAUSED`。
   - 全部复制和校验完成后，再按用户选择恢复状态。

6. **失败不污染现有功能**
   - V2 异常不修改旧链路。
   - V2 可按任务、账号、对象规模关闭。
   - 保留一键回退到旧复制。

## V2 执行流程

### 1. Preflight

复制前先统计源 campaign 规模：

```text
campaign
  adset_count
  ad_count
  per_adset_ad_count
  source budget/schedule/status fields
  estimated_api_requests
```

用途：

- 判断是否走 V2。
- 计算并发度。
- 预估 API 请求量。
- 检查是否触发 async 51 ads 限制。
- 记录复制前字段快照，用于复制后校验。

### 2. 路由判断

推荐路由：

```text
if V2 disabled:
  old copy path
else if account not in allowlist:
  old copy path
else if target is campaign and estimated large:
  V2 DAG path
else if ads <= 51 and async field fidelity verified:
  async small-copy path
else:
  old copy path or V2 path by config
```

大系列判定建议：

```text
ad_count > 51
or adset_count >= 5
or estimated_api_requests >= 100
```

### 3. 创建 campaign

步骤：

1. 写入 `operation_copy_steps` reservation。
2. 创建新 campaign，默认 `PAUSED`。
3. 写入 `new_id` 和 `success`。
4. 如果 create 返回不确定，标记 `unknown`，进入恢复流程。

### 4. 并发创建 adsets

前提：

- campaign step 已 success。
- 有新 campaign id。

并发策略：

```text
COPY_CHILD_ADSET_CONCURRENCY=2  # 灰度期
COPY_CHILD_ADSET_CONCURRENCY=3  # 稳定期
```

每个 adset step：

1. 查账本，已 success 则跳过。
2. 创建 new adset，挂到 new campaign。
3. 默认 `PAUSED`。
4. 复制预算、排期、出价、投放目标、targeting 等字段。
5. 写入 `new_id`。

### 5. 并发创建 ads

前提：

- 对应 source adset 的 new adset step 已 success。

并发策略：

```text
COPY_CHILD_AD_CONCURRENCY=3  # 灰度期
COPY_CHILD_AD_CONCURRENCY=5  # 稳定期
```

每个 ad step：

1. 查账本，已 success 则跳过。
2. 创建 new ad，挂到正确 new adset。
3. 默认 `PAUSED`。
4. 复制 creative、tracking、status 等字段。
5. 写入 `new_id`。

### 6. 复制后校验

校验内容：

- campaign/adset/ad 数量一致。
- 父子关系正确。
- adset 预算字段一致：
  - `daily_budget`
  - `lifetime_budget`
  - `daily_min_spend_target`
  - `daily_spend_cap`
  - `lifetime_min_spend_target`
  - `lifetime_spend_cap`
- 排期字段一致：
  - `start_time`
  - `end_time`
- 状态符合用户选择。
- 命名策略正确。

校验失败处理：

- 可修复字段进入 repair step。
- 不可修复字段标记 partial，需要人工确认。
- 不自动删除已创建对象，避免误删。

### 7. 状态恢复

如果用户选择复制后保持原状态：

```text
全部步骤成功
  -> 校验通过
  -> 按源状态或用户选择恢复 campaign/adset/ad 状态
```

如果任何步骤失败：

- 新对象保持 `PAUSED`。
- item 标记 partial/failed。
- 提供错误详情和已创建对象列表。

## 数据模型

新增复制步骤账本：

```text
operation_copy_steps
  id
  task_id
  task_item_id
  step_key
  source_type
  source_id
  parent_step_key
  new_id
  status              pending/running/success/unknown/failed/skipped
  attempt
  lease_until
  error
  metadata
  created_at
  updated_at
```

唯一约束：

```text
UNIQUE(task_item_id, step_key)
```

step key 示例：

```text
campaign:<sourceCampaignId>
adset:<sourceAdSetId>
ad:<sourceAdId>
repair:adset:<sourceAdSetId>:budget
restore-status:ad:<sourceAdId>
```

## 幂等和恢复

### item claim

每个 task item 执行前原子 claim：

```sql
UPDATE operation_task_items
SET status = 'running', attempts = :attempt
WHERE id = :itemId
  AND status IN ('pending', 'retrying')
RETURNING id;
```

没有返回行就跳过，避免重复执行。

### settle-once

成功/失败只允许结算一次：

```sql
UPDATE operation_task_items
SET status = 'success', attempts = :attempt, error = :resultJson
WHERE id = :itemId
  AND status NOT IN ('success', 'failed', 'dead')
RETURNING id;
```

只有返回行时才更新 task counter 和 Redis progress。

### step lease

每个 step 执行前加 lease：

```sql
UPDATE operation_copy_steps
SET status = 'running',
    lease_until = now() + interval '5 minutes'
WHERE id = :stepId
  AND status IN ('pending', 'unknown', 'failed')
  AND (lease_until IS NULL OR lease_until < now())
RETURNING id;
```

避免两个 worker 同时创建同一对象。

### unknown 恢复

Meta create 已成功但本地写账本失败时，step 进入 `unknown`。

恢复策略：

1. 如果支持远端幂等 key，优先用远端幂等恢复。
2. 如果不支持，创建时加 marker name，retry 时按 marker 查找。
3. 找到唯一对象则补写 `new_id`。
4. 找不到或找到多个，进入人工确认，不盲目再次 create。

## 并发和限流配置

建议环境变量：

```text
COPY_DAG_ENABLED=0
COPY_DAG_ACCOUNT_ALLOWLIST=
COPY_DAG_MIN_AD_COUNT=52
COPY_DAG_MIN_ADSET_COUNT=5

COPY_CHILD_ADSET_CONCURRENCY=2
COPY_CHILD_AD_CONCURRENCY=3
COPY_ACCOUNT_CONCURRENCY=1

META_GLOBAL_REFILL_PER_SEC=16
META_GLOBAL_BURST=32
META_COPY_REFILL_PER_SEC=10
META_COPY_BURST=20
META_AD_ACCOUNT_REFILL_PER_SEC=2
META_AD_ACCOUNT_BURST=8
```

稳定后可调整：

```text
COPY_CHILD_ADSET_CONCURRENCY=3
COPY_CHILD_AD_CONCURRENCY=5
META_GLOBAL_REFILL_PER_SEC=18
META_COPY_REFILL_PER_SEC=12
```

动态降级规则：

```text
Meta usage >= 70%:
  停止提升并发

Meta usage >= 75% or continuous 429:
  COPY_CHILD_ADSET_CONCURRENCY -> 1
  COPY_CHILD_AD_CONCURRENCY -> 1
  暂停新 DAG 任务

Meta 5xx/timeout 增多:
  step 标记 retrying/unknown
  使用指数退避
```

## 提速预期

对单个大 campaign：

| 场景 | 当前串行 | V2 DAG 灰度并发 | V2 DAG 稳定并发 |
| --- | ---: | ---: | ---: |
| 5 adsets / 50 ads | 1x | 2-3x | 3-4x |
| 10 adsets / 100 ads | 1x | 3-5x | 4-6x |
| 20 adsets / 200 ads | 1x | 4-6x | 5-8x |
| 1 adset / 100 ads | 1x | 2-3x | 3-4x |

实际上限受这些因素限制：

- Meta API 60%-70% 配额目标。
- 单账号限流。
- source 对象读取耗时。
- creative 创建耗时。
- 失败重试和校验修复耗时。

## 分阶段实施

### Phase 0：现状基线

不改代码或只加日志。

记录：

- 大 campaign 复制平均耗时。
- adset/ad 数量。
- Meta 请求数。
- 429/5xx/timeout 比例。
- 字段差异，特别是预算上限。

### Phase 1：安全底座

目标：不提升并发，先确保并发前置正确。

内容：

- item 原子 claim。
- settle-once。
- operation_copy_steps 表。
- 请求级限流。
- step lease。
- unknown 状态。
- 旧链路保持默认。

上线方式：

- 停旧 worker，统一升级。
- `COPY_DAG_ENABLED=0`。
- 验证旧复制功能不受影响。

### Phase 2：V2 DAG 旁路

目标：新增能力但默认关闭。

内容：

- preflight。
- V2 route。
- campaign/adset/ad step 编排。
- 新对象默认 `PAUSED`。
- 复制后校验。
- 错误详情展示。

上线方式：

- `COPY_DAG_ENABLED=0` 上线。
- 后台或内部账号手动触发 V2。

### Phase 3：小流量灰度

目标：指定账号启用。

配置：

```text
COPY_DAG_ENABLED=1
COPY_DAG_ACCOUNT_ALLOWLIST=<test accounts>
COPY_CHILD_ADSET_CONCURRENCY=2
COPY_CHILD_AD_CONCURRENCY=3
META_GLOBAL_REFILL_PER_SEC=16
```

观察：

- 是否重复创建。
- 是否出现 unknown 堆积。
- 是否有字段差异。
- 是否触发 429。
- 复制耗时是否达到 3x 以上。

### Phase 4：扩大并发

条件：

- 连续 3 天无重复创建。
- `success + failed <= total` 无异常。
- unknown 可恢复。
- 429 比例可控。
- 字段校验通过。

配置：

```text
COPY_CHILD_ADSET_CONCURRENCY=3
COPY_CHILD_AD_CONCURRENCY=5
META_GLOBAL_REFILL_PER_SEC=18
```

### Phase 5：自动路由

目标：大系列自动走 V2。

路由：

```text
ad_count > 51 or adset_count >= 5 -> V2 DAG
ads <= 51 and async verified -> async small-copy
otherwise -> old copy path
```

## 回滚方案

快速回滚：

```text
COPY_DAG_ENABLED=0
COPY_CHILD_ADSET_CONCURRENCY=1
COPY_CHILD_AD_CONCURRENCY=1
```

行为：

- 新任务回到旧复制链路。
- 已在 V2 中的任务继续按账本恢复或暂停。
- 不删除已创建对象。
- 不影响旧复制功能。

数据库回滚原则：

- 不删除 `operation_copy_steps`。
- 即使关闭 V2，也保留账本用于排查和恢复。

## 必须监控

指标：

```text
copy.v2.tasks.started
copy.v2.tasks.completed
copy.v2.tasks.failed
copy.v2.steps.created
copy.v2.steps.success
copy.v2.steps.unknown
copy.v2.steps.retrying
copy.v2.meta.requests
copy.v2.meta.429
copy.v2.meta.5xx
copy.v2.duration.p50/p95
copy.v2.field_mismatch
copy.v2.duplicate_marker_found
```

报警：

- 出现重复创建。
- `success + failed > total`。
- unknown 持续增长。
- 429 连续出现。
- usage >= 70% 持续 5 分钟。
- 字段校验失败率超过阈值。

## 最终建议

为了稳定、安全、明显提升大系列复制速度，推荐路线是：

```text
旧链路不动
  + V2 DAG 旁路
  + step 账本
  + 请求级限流
  + 默认 PAUSED
  + 字段校验
  + allowlist 灰度
  + 一键回退
```

不要直接把当前复制循环改成无界并发，也不要只依赖多 worker。多 worker 对单个大 campaign 提升有限。真正能解决大系列慢的问题，是在 campaign 内部做 DAG 编排，并且把每一步做成可恢复、可限流、可回滚。
