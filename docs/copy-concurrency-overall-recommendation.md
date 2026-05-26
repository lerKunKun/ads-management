# 复制任务效率优化整体建议与评估

更新时间：2026-05-23

## 结论

当前复制效率低的根因不是单一的“串行循环”，而是复制执行缺少按任务形态分流、缺少请求级配额调度、缺少可恢复的复制步骤账本。直接把当前串行 `copyBatch` 改成 `Promise.all()` 能提升部分速度，但风险很高，容易产生重复创建、状态错乱、进度超计数和 Meta 限流。

推荐采用“智能路由 + 有限并发 + 配额感知调度”的整体方案：

1. 先补齐 item 原子 claim、settle-once 结算、复制步骤账本和请求级限流。
2. 对满足上游规则的小型复制，优先走 Meta async request_set，按“总广告数 <= 51”切分。
3. 对超过 async 限制、或需要强字段保真的复制，走自建 create-copy DAG，并在父子依赖内做有限并发。
4. 所有 Meta 请求统一纳入小时配额，按 100000 次/小时的 60%-70% 使用，即目标 60000-70000 次/小时。
5. 并发度不要固定写死，使用环境变量和运行时指标灰度调节，默认从小并发开始。

这比“只并行当前循环”更稳，也更有机会把效率提升到接近或超过手动复制。

## 当前实现和瓶颈

当前生产主路径在 Worker 中：

- Worker 入口：`apps/worker/src/handler.ts`
- copyBatch 分支：`executeCustomCopyBatchProvider()`
- 单 item 复制：`executeProvider()` -> `executeCustomCopyProvider()` -> `metaProvider.copy()`
- Meta create-copy 实现：`apps/api/src/lib/meta-client.ts`

当前 `copyBatch` 内部仍是串行：

```ts
for (const item of copyItems) {
  const itemMsg = messageForCopyItem(msg, item);
  const status = await readItemStatus(item.itemId);
  if (isTerminalStatus(status)) continue;

  try {
    const result = await executeProvider(itemMsg, token);
    await writeLocalBestEffort(itemMsg, token, result);
    await markSuccess(itemMsg, result);
    await bumpProgress(itemMsg.taskId, { success: 1 });
  } catch (err) {
    await failItem(itemMsg, message);
    await bumpProgress(itemMsg.taskId, { failed: 1 });
  }
}
```

主要瓶颈：

- 同一个 `copyBatch` 内每个 item 串行执行，慢任务会阻塞后续 item。
- 复制 campaign 时需要读取源对象、创建 campaign、读取 adsets、创建 adsets、读取 ads、创建 ads，单 item 本身也可能很慢。
- 当前限流在消息入口 acquire 一次，不是每个 Meta 请求 acquire，一旦并行会失控。
- 当前 item 状态不是原子 claim，成功/失败结算不是 settle-once，并行后不能保证状态正确。
- 现有 async request_set 相关代码存在，但当前主路径没有作为主要复制执行策略使用。

## 上游规则和容量预算

已确认上游规则：

- 异步方法广告数量不能超过 51。
- 访问频次每小时 100000 次。
- 系统只使用 60%-70%，即 60000-70000 次/小时。

换算成请求速率：

```text
60000 / 3600 = 16.67 requests/s
70000 / 3600 = 19.44 requests/s
```

建议系统硬目标：

```text
GLOBAL_META_QPS_SOFT = 16/s     # 约 57600/h，灰度期使用
GLOBAL_META_QPS_TARGET = 18/s   # 约 64800/h，稳定期使用
GLOBAL_META_QPS_HARD = 19/s     # 约 68400/h，不能长期超过
```

当前 `DEFAULT_BUCKETS.app()` 是 `refillPerSec=20`，约 72000/h，略高于 70% 目标，且 `capacity=200` 允许瞬时突发。并行改造时应改成可配置，并按 16-18/s 起步。

## 更好的并发方案

### 总体架构

不要把复制看成一个固定实现，而是先做预估，再按任务形态路由：

```text
copy task
  -> preflight 统计对象规模和复制要求
  -> route A: async request_set
  -> route B: custom create-copy DAG
  -> route C: 保守串行/低并发 fallback
```

推荐路由：

| 路由 | 适用场景 | 优点 | 风险 |
| --- | --- | --- | --- |
| A. Meta async request_set | 总复制广告数 <= 51，字段保真已验证，批量复制多个小对象 | 上游异步执行，客户端等待少，适合提速 | 需要严格按 51 广告切分，需确认预算上限等字段是否完整保留 |
| B. 自建 create-copy DAG | 广告数 > 51，或必须保留自定义字段、预算上限、排期等 | 可控、字段保真强、可恢复 | API 调用多，必须做好限流和步骤账本 |
| C. 低并发 fallback | Meta 限流、异常率高、账号风险高、未知对象类型 | 稳定，便于回退 | 速度提升有限 |

### Route A：async request_set 优先处理小型复制

async request_set 应作为小型批量复制的提速主路径，但必须按“总广告数”切分，而不是只按 item 数切分。

切分规则建议：

```text
每个 request_set:
  request 数 <= 50
  总复制广告数 <= 51
  同 fbAccountId / metaActId / action / 兼容参数
```

广告数量估算规则：

- 复制单个 ad：计 1 个广告。
- 复制 adset 且 deepCopy=true：计该 adset 下 ads 数。
- 复制 campaign 且 deepCopy=true：计该 campaign 下所有 ads 数。
- deepCopy=false：子广告数计 0，但 request 本身仍计入 request 数。
- 同一个 source 复制多份时，广告数按份数累加。

例子：

```text
campaign A 有 30 个 ads，复制 2 份 => 60 ads，不能放在同一个 request_set。
adset B 有 10 个 ads，复制 5 份 => 50 ads，可以放在同一个 request_set。
单 ad 复制 50 个 => 50 ads，可以放在同一个 request_set。
```

async 路径的关键控制：

- submit request_set 前写本地 async state，避免重复 submit。
- request_set polling 使用退避，不能高频轮询。
- pending 只保持 running/retrying，不增加 failed。
- async 完成后逐 item settle-once。
- async 被 Meta 拒绝时，只对受影响 item 降级到 Route B 或 C，不能整批失败。

字段保真风险：

之前复制中出现过“广告组预算上限未保留”的问题。async/native copy 是否完整保留 `daily_min_spend_target`、`daily_spend_cap`、`lifetime_min_spend_target`、`lifetime_spend_cap` 等字段必须用线上影子任务验证。如果不能保证，Route A 需要增加“复制后校验/修复”步骤，或者只对字段要求不敏感的任务启用。

### Route B：自建 create-copy DAG 处理大对象和字段保真

对超过 51 个广告的 campaign/adset，或字段保真要求高的复制，推荐走自建 DAG：

```text
create campaign
  -> list source adsets
  -> create adsets with limited concurrency
      -> list source ads for each adset
      -> create ads under mapped new adset with limited concurrency
```

DAG 并发边界：

- campaign 必须先创建并落账，才能创建 adset。
- 每个 source adset 创建出 new adset 后，才能创建该 adset 下的 ads。
- 不同 source adset 之间可以有限并发。
- 同一 new adset 下的 ads 可以有限并发，但必须挂到正确 new adset。

建议初始并发：

```text
COPY_BATCH_ITEM_CONCURRENCY=2
COPY_CHILD_ADSET_CONCURRENCY=2
COPY_CHILD_AD_CONCURRENCY=3
COPY_ACCOUNT_CONCURRENCY=2
```

大对象并发不要只看数量，还要看请求预算。一个 campaign 如果有 10 个 adset、100 个 ads，自建 DAG 至少会产生读取和创建合计百级请求。并发提高后，瓶颈很快会转为配额和 Meta 429。

### Route C：保守 fallback

以下情况应自动降级：

- 当前 app 或 ad account 使用率接近 70%。
- 过去 5-15 分钟 Meta 429、5xx、timeout 明显上升。
- 当前账号 breaker 打开。
- preflight 无法可靠统计广告数。
- 复制参数包含未验证字段，或字段保真要求高但没有修复策略。

fallback 行为：

- item 并发降到 1。
- child DAG 并发降到 1。
- polling 间隔增加。
- 可重试错误只标记 retrying，不结算 failed。

## 配额感知调度

并发控制必须同时有三层：

1. 本进程信号量：控制同时执行多少 item、adset、ad。
2. Redis 全局令牌桶：控制全系统 Meta 请求速率。
3. ad account 令牌桶：控制单账号请求速率，避免一个账号拖垮整体。

建议新增或调整配置：

```text
META_GLOBAL_REFILL_PER_SEC=18
META_GLOBAL_BURST=36
META_COPY_REFILL_PER_SEC=12
META_COPY_BURST=24
META_AD_ACCOUNT_REFILL_PER_SEC=2
META_AD_ACCOUNT_BURST=10

COPY_BATCH_ITEM_CONCURRENCY=2
COPY_BATCH_ITEM_CONCURRENCY_MAX=5
COPY_CHILD_ADSET_CONCURRENCY=2
COPY_CHILD_AD_CONCURRENCY=3
COPY_PARALLEL_ENABLED=0/1
```

说明：

- `META_GLOBAL_REFILL_PER_SEC=18` 对应约 64800/h，落在 60%-70% 区间。
- `META_COPY_REFILL_PER_SEC=12` 给复制模块单独预算，避免复制把列表同步、状态操作、账户刷新全部挤掉。
- burst 不建议太大。大 burst 会让瞬时请求超过上游水位，即使小时总量没超，也更容易触发 429。
- 所有 `graph()` 请求前都应 acquire，而不是只在 `handle()` 入口 acquire 一次。

动态调节规则：

```text
usage < 50%, 429=0, p95 正常，持续 15 分钟 -> 并发 +1
usage 60%-70% -> 保持当前并发，不再提升
usage >= 70% 或出现连续 429 -> 暂停新 submit，降低并发
usage >= 75% -> 打开账号或 app cooldown，仅保留 polling/retry 的低频处理
```

## 状态正确性前置要求

并行前必须完成以下改造，否则会影响现有复制可用性。

### 1. item 原子 claim

每个 item 执行前先抢占：

```sql
UPDATE operation_task_items
SET status = 'running', attempts = :attempt
WHERE id = :itemId
  AND status IN ('pending', 'retrying')
RETURNING id;
```

没有返回行说明 item 已被其他 worker 处理，当前执行器跳过。

### 2. settle-once 结算

成功/失败只能从非终态迁移一次。只有 DB 状态真实迁移成功，才允许更新 task counter 和 Redis progress。

```sql
UPDATE operation_task_items
SET status = 'success', attempts = :attempt, error = :resultJson
WHERE id = :itemId
  AND status NOT IN ('success', 'failed', 'dead')
RETURNING id;
```

失败同理。

### 3. 复制步骤账本

新增 `operation_copy_steps`，记录每个复制步骤：

```text
operation_copy_steps
  id
  task_item_id
  step_key
  source_type
  source_id
  parent_step_key
  new_id
  status
  lease_until
  error
  created_at
  updated_at
```

唯一约束：

```text
UNIQUE(task_item_id, step_key)
```

作用：

- Worker 重启后能恢复已创建对象。
- 父子对象映射有地方落账。
- retry 时能跳过已成功步骤，不重复 create。
- 前端任务详情可以显示真实步骤进度。

### 4. unknown 状态和恢复

Meta create 已成功但 Worker 写 DB 前崩溃，是最难完全规避的窗口。建议引入 `unknown` 状态：

```text
pending -> running -> success
pending -> running -> unknown -> recovered success
pending -> running -> failed
```

恢复方式：

- 如果使用 marker name，retry 时先按 marker 查询远端对象。
- 如果确认 Meta 支持可靠 idempotency 参数，则优先使用远端幂等。
- 找不到唯一对象时，不要盲目重复 create，应进入人工确认或低频恢复任务。

## 效率收益评估

### 只做 copyBatch item 并发

适用：多个独立 ad/adset/campaign 复制。

预期收益：

- 并发 2：通常可达到 1.5-2 倍吞吐。
- 并发 3-5：在 Meta 响应稳定、请求预算充足时继续提升。

限制：

- 单个大 campaign 仍慢，因为一个 item 内部仍要串行处理父子关系。
- 如果请求级限流没有做好，并发提升会被 429 抵消。

### async request_set

适用：总广告数 <= 51 的小型批量复制。

预期收益：

- 对 10-50 个小对象复制，效率提升最明显。
- 客户端只负责 submit 和 poll，减少本地逐对象等待。

限制：

- 必须按总广告数切分。
- 字段保真要验证，必要时做复制后修复。
- polling 也消耗请求频次。

### 自建 DAG 内部并发

适用：单个大 campaign 或大 adset。

预期收益：

- 对“一个 campaign 下多个 adset、多个 ads”的场景，能明显快于当前逐层串行。
- 比 async 更可控，适合字段保真。

限制：

- 改动最大。
- 需要完整步骤账本、父子映射、恢复逻辑。
- 请求量高，必须严格受配额调度控制。

## 分阶段落地建议

### Phase 1：正确性和限流前置

目标：不上大并发，先保证状态正确。

内容：

- item 原子 claim。
- settle-once 成功/失败结算。
- batch 内错误隔离，避免一个 item 异常覆盖整批。
- 请求级 rate limit，统一接入 `graph()`。
- app bucket 调整到 16-18/s，可配置。
- 保留当前复制主路径，并发默认 1。

上线风险：低到中。需要停旧 worker 后统一升级，避免新旧结算逻辑混跑。

### Phase 2：小并发 copyBatch item

目标：快速改善多 item 批量复制速度。

内容：

- `COPY_BATCH_ITEM_CONCURRENCY=2` 灰度。
- 每个 item 独立 claim、独立 settle、独立 retry。
- 429/5xx/timeout 只影响单 item 或单账号，不影响整批已完成 item。
- 监控 `success + failed <= total`、重复 newId、429 比例。

上线风险：中。具备一键回退到并发 1 后可控。

### Phase 3：async request_set 路由

目标：小型复制使用上游异步能力提速。

内容：

- preflight 统计每个 item 的广告数。
- 按 request 数 <= 50、总广告数 <= 51 切分 request_set。
- async submit/poll 状态持久化。
- async 字段保真影子校验，确认预算上限、排期、状态、命名策略。
- async 失败按 item 降级到 Route B/C。

上线风险：中。主要风险是字段保真和上游返回差异。

### Phase 4：自建 DAG 内部并发

目标：解决单个大 campaign 仍很慢的问题。

内容：

- `operation_copy_steps` 完整落地。
- campaign/adset/ad 步骤化创建和父子 ID 映射。
- adset 并发、ad 并发受信号量和请求级限流控制。
- unknown/recover 机制。

上线风险：中到高。建议只对部分账号、部分任务类型灰度。

## 风险矩阵

| 风险 | 触发场景 | 影响 | 控制措施 |
| --- | --- | --- | --- |
| 重复创建 | 消息重投、worker 重启、锁过期、并发执行同一 item | Meta 侧产生重复对象 | item claim、copy step 唯一约束、marker/idempotency |
| 进度错乱 | 同一 item 重复 success/fail | `success + failed > total`，前端显示错误 | settle-once，counter 跟随 DB 状态迁移 |
| 整批误失败 | batch 内单 item 抛错冒泡 | 已完成/未执行 item 被覆盖失败 | `Promise.allSettled`，单 item 错误隔离 |
| Meta 限流 | 并发后请求瞬时放大 | 429、breaker、任务长时间 retry | 请求级令牌桶、动态降并发、60%-70% 配额 |
| async 超广告数 | request_set 总广告数超过 51 | 上游拒绝，整组失败 | preflight 统计，按总广告数切分 |
| 字段丢失 | async/native copy 未保留部分字段 | 新对象与源对象不一致 | 字段保真校验，复制后修复，必要时走 custom DAG |
| 大任务卡死 | 单个 campaign 内部仍串行 | 效率仍低于手动 | DAG 内部有限并发 |
| 恢复不确定 | create 成功但本地未落账 | retry 可能重复 create | unknown 状态、marker 查询、人工确认队列 |

## 监控指标

必须新增或确认以下指标：

```text
copy.items.claimed
copy.items.skipped_terminal
copy.items.settled_success
copy.items.settled_failed
copy.items.retrying
copy.steps.success
copy.steps.unknown
copy.meta.requests
copy.meta.429
copy.meta.5xx
copy.async.request_sets.submitted
copy.async.request_sets.completed
copy.async.request_sets.failed
copy.async.ads_per_request_set
copy.concurrency.current
copy.quota.usage_pct
```

关键报警：

- `success + failed > total` 必须报警。
- 同一个 task_item 出现多个 top-level new_id 必须报警。
- `copy.steps.unknown` 持续增长必须报警。
- 429 连续出现或 usage >= 70% 必须自动降并发。
- async request_set 广告数接近 51 时记录采样日志。

## 测试建议

最低测试集：

- 同一 `copyBatch` 重复投递，验证每个 item 只 claim/settle 一次。
- 并发 2/3/5 下，验证 `success + failed <= total`。
- 一个 item 失败，其他 item 成功，不互相覆盖状态。
- request_set 切分：30 ads * 2 份不能进同组，10 ads * 5 份可以进同组。
- 单 ad 复制 50 个可以进一个 request_set，52 个必须拆分。
- Meta 429 模拟：自动降并发，item 进入 retrying，不直接 failed。
- Worker 在 create 成功后、写 DB 前崩溃，验证 unknown/recover 流程。
- 字段保真：预算上限、排期、状态、命名策略、父子归属。

## 推荐最终方案

建议不要选择单一方案，而是采用三层组合：

1. **基础安全层**：item claim、settle-once、copy step、请求级限流。这是任何并发方案的前提。
2. **小型高吞吐层**：async request_set，按总广告数 <= 51 和 60%-70% 配额调度。
3. **大型高保真层**：自建 create-copy DAG，父子关系严格落账，adset/ad 有限并发。

推荐上线顺序：

```text
Phase 1: 正确性 + 请求级限流，并发仍为 1
Phase 2: copyBatch item 并发 2
Phase 3: async request_set 路由，小流量灰度
Phase 4: custom DAG 内部并发，解决大 campaign
```

这样既能先快速改善“批量复制多个对象太慢”的问题，又不会因为激进并发导致现有复制不可用。真正要超过手动复制效率，核心不只是提高并发数，而是让小任务走 async、大任务走 DAG，并且所有请求都被统一配额调度。
