# 大系列复制 JSONB 状态机 V2 计划

更新时间：2026-05-23

## 目标

当前核心痛点是单个大 campaign 复制慢。多 worker 只能提升多个独立 item 的吞吐，对单个大 campaign 效果有限。Temporal/Inngest/Trigger.dev 可以做编排，但会引入额外运维系统。

本计划采用 **PostgreSQL JSONB workflow snapshot + relational step ledger** 的原生状态机方案：

```text
旧复制链路：保持不动，继续作为默认路径
V2 JSONB 状态机：只对大 campaign 旁路启用
步骤账本：保证每个 campaign/adset/ad create step 可恢复、可幂等
请求级限流：控制在上游 60%-70% 配额内
```

目标：

- 大幅提升大 campaign 深拷贝速度。
- 不引入 Temporal/Inngest/Trigger.dev，降低运维复杂度。
- 不影响现有复制功能。
- 出错可恢复，不重复创建对象。
- 新对象默认 `PAUSED`，避免异常投放。
- 可灰度、可回退、可观测。

## 方案结论

推荐方案：

```text
JSONB workflow snapshot
+ relational step ledger
+ DB lease / optimistic version
+ remote marker recovery
+ request-level rate limit
+ old copy path fallback
```

不建议把所有内容都塞进 JSONB。原因：

- workflow 总状态适合 JSONB。
- campaign/adset/ad 每个 create step 需要唯一约束、lease、恢复查询，适合独立表。
- 大 campaign 可能有几百个 ads，全部塞 JSONB 会导致更新膨胀和并发冲突。

## 上游限制

已确认：

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
长期不要超过 19/s
```

async request_set 不作为大系列主方案。大 campaign 主要走 JSONB V2 DAG；async 只作为小对象优化路径。

## 数据模型

### operation_copy_workflows

记录一个大 campaign 复制 workflow 的整体快照。

```text
operation_copy_workflows
  id
  task_id
  task_item_id
  company_id
  fb_account_id
  ad_account_id
  meta_act_id
  source_campaign_id
  new_campaign_id
  status
  phase
  state JSONB
  version
  lease_owner
  lease_until
  error
  created_at
  updated_at
```

状态建议：

```text
pending
running
waiting
success
partial
failed
canceled
paused
```

phase 建议：

```text
preflight
create_campaign
create_adsets
create_ads
verify
repair
restore_status
done
```

`state JSONB` 示例：

```json
{
  "stateVersion": 1,
  "preflight": {
    "adsetCount": 20,
    "adCount": 200,
    "estimatedRequests": 260
  },
  "config": {
    "adsetConcurrency": 2,
    "adConcurrency": 3,
    "globalQps": 16
  },
  "progress": {
    "campaign": "success",
    "adsetsTotal": 20,
    "adsetsSuccess": 12,
    "adsTotal": 200,
    "adsSuccess": 83,
    "unknownSteps": 0
  },
  "fieldCheck": {
    "status": "pending",
    "mismatches": []
  },
  "errors": []
}
```

### operation_copy_steps

记录每个可恢复 create/verify/repair step。

```text
operation_copy_steps
  id
  workflow_id
  task_id
  task_item_id
  company_id
  step_key
  source_type
  source_id
  parent_step_key
  new_id
  status
  attempt
  lease_owner
  lease_until
  error
  metadata JSONB
  created_at
  updated_at
```

唯一约束：

```text
UNIQUE(workflow_id, step_key)
```

step key 示例：

```text
campaign:<sourceCampaignId>
adset:<sourceAdSetId>
ad:<sourceAdId>
verify:campaign:<sourceCampaignId>
repair:adset:<sourceAdSetId>:budget
restore-status:ad:<sourceAdId>
```

step 状态：

```text
pending
running
success
unknown
failed
skipped
retrying
```

## 执行模型

使用现有 worker 增加一个 V2 orchestrator loop，不新增外部系统。

```text
copy_orchestrator tick:
  1. claim 一个 workflow
  2. 根据 phase/state 查询下一批可执行 steps
  3. 按并发和限流执行 steps
  4. 更新 step 状态
  5. 汇总更新 workflow JSONB
  6. 未完成则延迟重新入队
```

### workflow claim

```sql
UPDATE operation_copy_workflows
SET status = 'running',
    lease_owner = :workerId,
    lease_until = now() + interval '2 minutes',
    version = version + 1
WHERE id = :workflowId
  AND status IN ('pending', 'waiting', 'running')
  AND (lease_until IS NULL OR lease_until < now())
RETURNING *;
```

### step claim

```sql
UPDATE operation_copy_steps
SET status = 'running',
    lease_owner = :workerId,
    lease_until = now() + interval '5 minutes',
    attempt = attempt + 1
WHERE id = :stepId
  AND status IN ('pending', 'retrying', 'unknown')
  AND (lease_until IS NULL OR lease_until < now())
RETURNING *;
```

### optimistic update

workflow JSONB 更新必须带 version 条件：

```sql
UPDATE operation_copy_workflows
SET state = :nextState,
    phase = :nextPhase,
    version = version + 1,
    updated_at = now()
WHERE id = :workflowId
  AND version = :currentVersion;
```

失败说明有其他 worker 更新过，当前 worker 重新读取状态。

## V2 DAG 流程

### Phase 1：preflight

读取源 campaign 结构：

```text
campaign fields
adsets
ads per adset
budget/schedule/status fields
creative references
estimated request count
```

产出：

- workflow state summary。
- campaign/adset/ad step rows。
- 源字段快照，用于 verify。

### Phase 2：create campaign

步骤：

1. 查 `campaign:<sourceCampaignId>` step。
2. 如果已有 `success + new_id`，直接进入下一 phase。
3. 如果 `unknown`，先远端恢复。
4. 如果未创建，带 marker 创建新 campaign。
5. 新 campaign 默认 `PAUSED`。
6. 写入 `new_id`，step 标记 success。

### Phase 3：create adsets

前提：

- campaign step success。
- 有 new campaign id。

并发：

```text
灰度期 COPY_CHILD_ADSET_CONCURRENCY=2
稳定期 COPY_CHILD_ADSET_CONCURRENCY=3
```

每个 adset：

1. 查 step。
2. 查父 campaign new_id。
3. 创建 new adset，挂到 new campaign。
4. 默认 `PAUSED`。
5. 写入 budget、schedule、targeting、optimization、bid 等字段。
6. step success 后才允许该 adset 下 ads 执行。

### Phase 4：create ads

前提：

- 对应 adset step success。
- 有 new adset id。

并发：

```text
灰度期 COPY_CHILD_AD_CONCURRENCY=3
稳定期 COPY_CHILD_AD_CONCURRENCY=5
```

每个 ad：

1. 查 step。
2. 查父 adset new_id。
3. 创建 new ad，挂到正确 new adset。
4. 默认 `PAUSED`。
5. 复制 creative、tracking、status 相关字段。
6. step success。

### Phase 5：verify

校验：

- campaign/adset/ad 数量一致。
- 父子关系正确。
- budget 字段一致：
  - `daily_budget`
  - `lifetime_budget`
  - `daily_min_spend_target`
  - `daily_spend_cap`
  - `lifetime_min_spend_target`
  - `lifetime_spend_cap`
- schedule 字段一致：
  - `start_time`
  - `end_time`
- targeting / promoted_object / optimization / billing / bid 字段一致。
- naming strategy 正确。
- status 符合用户选择。

校验失败：

- 可修复字段进入 repair phase。
- 不可修复字段标记 partial。
- 不自动删除已创建对象。

### Phase 6：restore status

如果用户选择“复制后保持原状态”：

```text
全部 create 成功
verify 通过
repair 完成
  -> restore campaign/adset/ad status
```

任何异常：

- 新对象保持 `PAUSED`。
- workflow 标记 partial/failed。
- 展示已创建对象和错误详情。

## 业务 exactly-once 设计

不能依赖 worker “只执行一次”。最终目标是业务语义上的 exactly-once：

```text
Business Exactly-Once =
  DB workflow/step lease
  + step unique constraint
  + Activity read-before-write
  + remote marker/idempotency
  + unknown recovery
  + settle-once task counter
```

### read-before-write 顺序

每个 create step 必须按这个顺序：

```text
1. 查本地 step success，有 new_id 直接返回。
2. 查本地 step unknown/running 过期，先做远端恢复。
3. 用 marker 查询远端对象，找到唯一对象则补账。
4. 仍未找到，才执行 create。
5. create 成功后立即写 step success。
6. create 结果不确定，写 unknown，不盲目重试 create。
```

### marker 设计

如果 Meta create API 没有可靠 idempotency key，使用 marker name：

```text
<desiredName>__copy_marker_<workflowShortId>_<sourceIdShort>
```

流程：

1. 创建时使用 marker name。
2. create 成功写 step success。
3. verify/repair 阶段再 rename 成最终名称。
4. 如果 timeout/5xx，retry 时按 marker 查询远端。

注意：

- marker 查询会消耗 API 配额。
- 查询可能有一致性延迟。
- 找到多个对象时不能自动选择，进入人工确认。

## 请求级限流

所有 Meta API 请求前都要 acquire token：

```text
global app bucket
copy module bucket
ad account bucket
```

建议初始配置：

```text
META_GLOBAL_REFILL_PER_SEC=16
META_GLOBAL_BURST=32
META_COPY_REFILL_PER_SEC=10
META_COPY_BURST=20
META_AD_ACCOUNT_REFILL_PER_SEC=2
META_AD_ACCOUNT_BURST=8
```

稳定后：

```text
META_GLOBAL_REFILL_PER_SEC=18
META_COPY_REFILL_PER_SEC=12
```

动态降级：

```text
usage >= 70%:
  不再提升并发

usage >= 75% or continuous 429:
  adset concurrency -> 1
  ad concurrency -> 1
  暂停新 V2 workflow

5xx/timeout 增多:
  step retry with backoff
  不确定 create 进入 unknown
```

## 配置开关

建议环境变量：

```text
COPY_V2_JSONB_ENABLED=0
COPY_V2_ACCOUNT_ALLOWLIST=
COPY_V2_MIN_AD_COUNT=52
COPY_V2_MIN_ADSET_COUNT=5

COPY_V2_ADSET_CONCURRENCY=2
COPY_V2_AD_CONCURRENCY=3
COPY_V2_ACCOUNT_CONCURRENCY=1

COPY_V2_DEFAULT_STATUS=PAUSED
COPY_V2_VERIFY_ENABLED=1
COPY_V2_REPAIR_ENABLED=1
```

路由规则：

```text
if COPY_V2_JSONB_ENABLED != 1:
  old copy path
else if account not allowlisted:
  old copy path
else if campaign ad_count >= COPY_V2_MIN_AD_COUNT:
  V2 JSONB path
else if adset_count >= COPY_V2_MIN_ADSET_COUNT:
  V2 JSONB path
else:
  old copy path
```

## 与现有复制链路的关系

必须保持旧链路可用：

```text
旧链路:
  当前 executeCustomCopyBatchProvider / executeProvider 继续工作

新链路:
  只在 route 命中 V2 时创建 operation_copy_workflows
  V2 失败不修改旧链路代码路径
```

回退：

```text
COPY_V2_JSONB_ENABLED=0
COPY_V2_ADSET_CONCURRENCY=1
COPY_V2_AD_CONCURRENCY=1
```

回退后：

- 新任务走旧复制。
- 已创建 V2 workflow 可暂停或继续低并发恢复。
- 不删除已创建对象。
- 保留账本用于排查。

## 提速预期

对单个大 campaign：

| 场景 | 当前串行 | V2 灰度并发 | V2 稳定并发 |
| --- | ---: | ---: | ---: |
| 5 adsets / 50 ads | 1x | 2-3x | 3-4x |
| 10 adsets / 100 ads | 1x | 3-5x | 4-6x |
| 20 adsets / 200 ads | 1x | 4-6x | 5-8x |
| 1 adset / 100 ads | 1x | 2-3x | 3-4x |

如果 adset 分布越均匀，DAG 并发收益越明显。如果只有一个 adset、很多 ads，收益主要来自 ad 并发。

## 分阶段落地

### Phase 0：基线观测

不改变复制行为。

记录：

- 大 campaign 源 adset/ad 数。
- 当前复制耗时。
- Meta 请求数。
- 429/5xx/timeout。
- 字段差异，重点是预算上限。

### Phase 1：表结构和安全底座

内容：

- 新增 `operation_copy_workflows`。
- 新增 `operation_copy_steps`。
- item claim。
- settle-once。
- workflow lease。
- step lease。
- 请求级限流基础。

上线方式：

```text
COPY_V2_JSONB_ENABLED=0
```

验收：

- 旧复制功能正常。
- task counter 不重复。
- 无 `success + failed > total`。

### Phase 2：V2 dry-run / preflight

内容：

- 对大 campaign 执行 preflight。
- 写 workflow state 和 step plan。
- 不调用 Meta create。

验收：

- adset/ad 数统计准确。
- estimated request 合理。
- step plan 正确。

### Phase 3：V2 DAG 创建，内部账号灰度

配置：

```text
COPY_V2_JSONB_ENABLED=1
COPY_V2_ACCOUNT_ALLOWLIST=<internal account>
COPY_V2_ADSET_CONCURRENCY=2
COPY_V2_AD_CONCURRENCY=3
META_GLOBAL_REFILL_PER_SEC=16
```

验收：

- 大 campaign 复制达到 3x 以上。
- 无重复创建。
- unknown 可恢复。
- 新对象默认 PAUSED。
- 字段校验通过或可 repair。

### Phase 4：repair/status/自动恢复

内容：

- 字段差异 repair。
- restore status。
- unknown 恢复任务。
- 前端任务详情展示 phase/steps/progress。

验收：

- 预算上限、排期、状态字段正确。
- 失败任务有明确错误和已创建对象列表。
- 不自动删除对象。

### Phase 5：扩大灰度和自动路由

条件：

- 连续 3 天无重复创建。
- 无 task counter 错乱。
- 429 可控。
- unknown 不持续堆积。
- 字段校验稳定。

配置：

```text
COPY_V2_ADSET_CONCURRENCY=3
COPY_V2_AD_CONCURRENCY=5
META_GLOBAL_REFILL_PER_SEC=18
```

## 监控和报警

指标：

```text
copy.v2.workflow.created
copy.v2.workflow.running
copy.v2.workflow.success
copy.v2.workflow.partial
copy.v2.workflow.failed
copy.v2.step.pending
copy.v2.step.running
copy.v2.step.success
copy.v2.step.unknown
copy.v2.step.failed
copy.v2.meta.requests
copy.v2.meta.429
copy.v2.meta.5xx
copy.v2.duration.p50
copy.v2.duration.p95
copy.v2.field_mismatch
copy.v2.repair.success
copy.v2.repair.failed
```

报警：

- `success + failed > total`。
- 同一 step 出现多个 `new_id`。
- unknown 持续增长。
- 429 连续出现。
- usage >= 70% 持续 5 分钟。
- 字段校验失败率超过阈值。
- workflow lease 过期数量持续增长。

## 风险和控制

| 风险 | 影响 | 控制 |
| --- | --- | --- |
| 重复创建 | Meta 侧出现重复对象 | step unique、marker、unknown 恢复 |
| 状态错乱 | 任务进度不准 | settle-once、counter 跟随 DB 状态迁移 |
| API 限流 | 复制失败或长时间 retry | 请求级限流、动态降并发 |
| 字段丢失 | 新对象与源对象不一致 | verify/repair，预算上限重点校验 |
| JSONB 膨胀 | DB 更新慢、锁冲突 | JSONB 只存汇总，大列表放 step 表 |
| workflow 卡死 | 任务停在 running | lease_until watchdog |
| V2 影响旧复制 | 现有功能不可用 | 旁路、feature flag、allowlist、旧链路默认 |

## 最终建议

这版方案比 Temporal/Inngest/Trigger.dev 运维更轻，比直接多 worker 更能解决单个大 campaign 慢的问题。

推荐最终形态：

```text
旧复制链路继续作为默认安全路径
大 campaign 走 JSONB V2 状态机旁路
workflow JSONB 存总状态
step 表存每个 create/verify/repair 步骤
DB lease 控制并发
marker/unknown 处理外部副作用
请求级限流控制 Meta API
默认 PAUSED 保证投放安全
verify/repair 保证字段保真
```

这是当前最务实的稳定提速方案。
