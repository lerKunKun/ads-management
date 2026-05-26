# 复制任务并行改造评估

更新时间：2026-05-23

## 结论

复制任务可以改为并行，但不建议直接把当前 `for...of await executeProvider()` 改成 `Promise.all()`。当前串行实现依赖“同一批次内顺序执行”规避了一些竞态；一旦并行，必须先补齐 item 级 claim、幂等结算、请求级限流、复制步骤账本和可恢复状态，否则会出现重复创建、进度计数超过总数、部分 item 被错误覆盖为失败、父子关系错乱等问题。

推荐路线：

1. 第一阶段只做安全前置，不提升并发度：item 原子 claim、settle-once、锁 TTL 或锁粒度修正、异常隔离。
2. 第二阶段引入复制步骤账本，保证每个 task item 的顶层对象只落账一次。
3. 第三阶段把 `copyBatch` 内 item 做有限并发，默认并发 2，可通过环境变量回退到 1。
4. 第四阶段再评估 campaign 深拷贝内部的 adset/ad DAG 并发。这个阶段改动最大，不建议和 batch item 并发一起上。

## 当前实现概况

当前生产主路径已经不是 Meta `/{object_id}/copies` 作为主方案，而是自建 create-copy：

- Worker 入口：`apps/worker/src/handler.ts`
- 批量复制分支：`executeCustomCopyBatchProvider()`
- 单 item 复制：`executeProvider()` -> `executeCustomCopyProvider()` -> `metaProvider.copy()`
- Provider：`apps/api/src/providers/meta.ts`
- Meta create-copy：`apps/api/src/lib/meta-client.ts`

当前 `copyBatch` 内部是串行：

```ts
for (const item of copyItems) {
  const itemMsg = messageForCopyItem(msg, item);
  const result = await executeProvider(itemMsg, token);
  await writeLocalBestEffort(itemMsg, token, result);
  await markSuccess(itemMsg, result);
  await bumpProgress(itemMsg.taskId, { success: 1 });
}
```

需要注意：这不是全局串行。RabbitMQ shard、consumer、不同消息之间仍可能并发；现在串行只发生在同一个聚合 `copyBatch` 消息内部。

## 现有并发风险

### 1. item 没有原子 claim

当前逻辑会先读 item 状态，再决定是否执行。读状态和真正执行之间有窗口。RabbitMQ 是 at-least-once，消息重投、worker 重启、锁过期后都可能让同一个 item 被两个执行器同时处理。

并行后必须改为原子 claim：

```sql
UPDATE operation_task_items
SET status = 'running', attempts = :attempt
WHERE id = :itemId
  AND status IN ('pending', 'retrying')
RETURNING id;
```

没有返回行就说明这个 item 已被其他执行器处理或已终态，当前分支直接跳过。

### 2. `markSuccess()` / `failItem()` 不是幂等结算

当前 `markSuccess()` 和 `failItem()` 会直接更新 item，并对 task counter 做 `success + 1` 或 `failed + 1`。如果同一个 item 被重复结算，`operation_tasks.success + failed` 可能超过 `total`。

必须改为 settle-once：

```sql
UPDATE operation_task_items
SET status = 'success', attempts = :attempt, error = :resultJson
WHERE id = :itemId
  AND status NOT IN ('success', 'failed', 'dead')
RETURNING id;
```

只有返回行时，才允许：

- `operation_tasks.success = success + 1`
- Redis `bumpProgress({ success: 1 })`

失败同理。可重试错误只进入 `retrying`，不增加 failed。

### 3. 当前锁是 message/batch 级，TTL 固定 30 秒

`handle()` 会对 `copyBatch` 里的所有 `targetId` 加锁，但 TTL 是 30 秒。一个 campaign 深拷贝可能超过 30 秒，锁过期后另一个 worker 可能进入同一批或同一对象。

并行方案需要二选一：

- 改为 item 级锁：每个 item 执行前只锁自己的 source/target，TTL 按预计耗时设置。
- 保留 batch 级锁但动态 TTL：`max(60, copyItems.length * estimatedSecondsPerItem)`，并支持续租。

推荐 item 级锁。原因是 batch 内 item 并行时，batch 级大锁语义变差，而且容易被长任务拖住。

### 4. 限流当前偏消息级

当前 `handle()` 入口会对整条消息 acquire 一次 token bucket。串行时影响较小；并行后一个 `copyBatch` 可能同时发出多组 Meta GET/POST。必须改成每次 Meta 请求前 acquire app + ad account bucket。

最低要求：

- 每个 item 开始前 acquire 一次只是过渡方案。
- 更严格方案是封装 Meta client，在每个 `graph()` 请求前 acquire。
- 命中 Meta rate limit 后，只把未完成或可重试 item 标记为 `retrying`，不要把整批 item fail。

### 5. 自建 deep copy 有父子依赖

当前 campaign deep copy 逻辑是：

```text
create campaign
  -> list source adsets
  -> create each adset under new campaign
      -> list source ads
      -> create each ad under new adset
```

这里父子关系必须严格保持：

- 新 adset 必须挂到当前 item 创建出来的新 campaign。
- 新 ad 必须挂到对应源 adset 映射出来的新 adset。
- 单个 campaign item 内不能无脑把所有 adset/ad 一起 `Promise.all()`，必须按 DAG 执行。

因此建议先只并行不同 item，不并行单个 campaign 内部子对象。

## 推荐目标状态模型

### task item 状态

沿用现有状态，明确语义：

- `pending`：已入队，未被 worker claim。
- `running`：某个 worker 已 claim，正在执行。
- `retrying`：可重试失败，等待重新投递。
- `success`：该 item 复制成功，已结算一次。
- `failed`：永久失败，已结算一次。
- `dead`：超过最大重试，已结算一次。

规则：

- `success/failed/dead` 是终态，任何路径都不能覆盖。
- 只有从非终态迁移到终态时才能增加 task counter。
- Redis progress 只能跟随 DB 真实迁移更新。

### copy step 状态

建议新增 `operation_copy_steps` 表，用来记录每个 item 的复制步骤：

```text
operation_copy_steps
  id
  task_item_id
  step_key
  source_type
  source_id
  target_type
  parent_step_key
  new_id
  status              pending/running/success/unknown/failed
  lease_until
  error
  created_at
  updated_at
```

唯一约束：

```text
UNIQUE(task_item_id, step_key)
```

step key 确定性生成：

```text
top campaign: item:<itemId>:campaign:<sourceCampaignId>
top adset:    item:<itemId>:adset:<sourceAdSetId>
top ad:       item:<itemId>:ad:<sourceAdId>
child adset:  item:<itemId>:adset:<sourceAdSetId>
child ad:     item:<itemId>:ad:<sourceAdId>
```

因为 `count > 1` 已展开成多个 task item，每份复制的 `itemId` 不同，所以 step key 不会互相冲突。

## 并行执行模型

### Phase 1：不提速，只补正确性

改动：

- 新增 `claimItem(itemId, attempt)`。
- 改造 `markSuccess()` 为 `settleSuccessOnce()`。
- 改造 `failItem()` 为 `settleFailedOnce()`。
- `bumpProgress()` 只在 settle 成功后调用。
- `executeCustomCopyBatchProvider()` 内部异常不要冒泡到外层 `handleErr(msg, err, msg.copyBatch)`，避免整批覆盖已完成 item。
- op-lock TTL 动态化或改 item 级锁。

收益：

- 即使仍串行，也能修复当前潜在的重复计数和整批误失败风险。
- 为后续并行打基础。

部署要求：

- 停掉旧 worker 后统一升级，不建议滚动部署。新旧 worker 混跑时，旧 worker 的非幂等 `failItem()` 仍可能覆盖新 worker 的结算。

### Phase 2：复制步骤账本

改动：

- 新增 `operation_copy_steps` 表和迁移。
- 顶层复制先写 step reservation，再调用 Meta create。
- create 成功后立即把 `new_id` 写入 step 并标记 `success`。
- retry 时先查 step；如果 step 已 success，直接复用 `new_id`，不再 create。

收益：

- 已落账的复制结果不会重复创建。
- 可以为后续 campaign 内部 DAG 并发记录父子映射。

限制：

- 仍不能完全覆盖“Meta create 已成功，但 worker 在写 step 前崩溃”的窗口。

### Phase 3：可恢复 marker 或远端幂等

为了覆盖 create 成功但本地未落账的窗口，需要引入可恢复机制。

方案 A：marker name

1. create 时使用临时唯一名称：`<desiredName>__copy_marker_<shortHash>`。
2. create 返回 `new_id` 后立即写 step success。
3. 再 rename 成用户期望名称。
4. 如果 create timeout/5xx，step 进入 `unknown`。
5. retry 时先按 marker 查询 Meta；找到唯一对象则补写 `new_id`，继续后续步骤。

风险：

- 按名称查 Meta 对象可能有一致性延迟。
- 大账户下 list/search 会消耗 quota。
- rename 失败需要单独重试机制，不能把已创建对象当失败重新 create。

方案 B：Meta 远端幂等

如果确认当前 create edge 支持可靠幂等参数，可以替代 marker。确认前不能假设存在。

### Phase 4：copyBatch item 有限并发

新增环境变量：

```text
COPY_BATCH_ITEM_CONCURRENCY=2
COPY_BATCH_ITEM_CONCURRENCY_MAX=5
COPY_PARALLEL_ENABLED=0/1
```

默认建议：

- 先上线 `COPY_PARALLEL_ENABLED=0`。
- 小流量打开并发 2。
- 稳定后按账户、任务类型逐步提高到 3。
- 保留并发 1 作为快速回滚开关。

伪代码：

```ts
async function executeParallelCopyBatchProvider(msg, token, copyItems) {
  const limit = createLimiter(env.copyBatchItemConcurrency);

  await Promise.allSettled(
    copyItems.map((item) => limit(async () => {
      const itemMsg = messageForCopyItem(msg, item);
      const claimed = await claimItem(itemMsg);
      if (!claimed) return;

      try {
        await acquireCopyItemRateLimit(itemMsg.metaActId);
        const result = await executeCopyItemWithLedger(itemMsg, token);
        await writeLocalBestEffort(itemMsg, token, result);
        await settleSuccessOnce(itemMsg, result);
      } catch (err) {
        if (isRetryableCopyError(err)) {
          await markRetrying(itemMsg, err);
          await publishRetry(itemMsg);
          return;
        }
        await settleFailedOnce(itemMsg, err);
      }
    })),
  );

  return { __batchHandled: true };
}
```

关键约束：

- 使用 `Promise.allSettled()`，不要让一个 item throw 导致整批丢失结果。
- 每个 item 自己结算成功、失败或 retry。
- 外层 batch 只负责 ack，不再做整批 fail。
- 每个 item 执行前 claim，执行后 settle-once。

### Phase 5：单个 campaign 内部 DAG 并发

这是可选阶段，只有当 batch item 并发仍不能满足速度需求时再做。

执行 DAG：

```text
create campaign
  -> list source adsets
  -> create adsets with limited concurrency
      -> list source ads for each source adset
      -> create ads under mapped new adset with limited concurrency
```

新增环境变量：

```text
COPY_CHILD_ADSET_CONCURRENCY=1
COPY_CHILD_AD_CONCURRENCY=2
```

必须依赖 copy step ledger：

- 每个源 adset 对应一个 step，记录新 adset id。
- 每个源 ad 对应一个 step，记录新 ad id。
- ad 创建前必须能拿到 parent adset step 的 `new_id`。

不建议在没有 step ledger 的情况下做 campaign 内部并行。

## 冲突控制设计

### item 冲突

用 DB claim 控制。Redis lock 只作为降低并发冲突的性能优化，不能作为正确性唯一依据。

### 同源对象冲突

同一个 source campaign 被复制 N 份时，API 已展开为 N 个 item，并注入 `_copyIndex`。每个 item 应该允许并行执行，因为目标新对象不同。

### 同 item 重复投递

通过 claim + terminal status skip + settle-once 控制。

### 父子关系冲突

通过 step ledger 的 `parent_step_key` 控制。子对象只能使用当前 item 内父 step 的 `new_id`，不能从全局缓存或同名对象推断。

### 进度冲突

只允许 DB settle 成功后更新 Redis progress。禁止在 catch/finally 中无条件 bump。

## 可用状态设计

并行执行期间，前端和运维需要看到可解释状态：

- task 总进度：`success + failed + running + pending`。
- 每层进度：campaign / adset / ad 的 `success`、`failed`、`running`、`pending`。
- item 详情：成功 item 显示 `newId`；失败 item 显示错误。
- retrying item 不应计入 failed，显示为处理中或等待重试。
- step 处于 `unknown` 时，task item 保持 `running` 或 `retrying`，并记录恢复原因，不能直接 success。

当前前端任务详情已经支持运行中轮询/SSE 和分层进度。后端需要保证 item 级 `running/retrying` 统计准确。

## 最小可上线版本

最小版本不建议包含 campaign 内部 DAG 并发。建议只做：

1. `claimItem()`
2. `settleSuccessOnce()` / `settleFailedOnce()`
3. copy step ledger 保护顶层 newId
4. `executeParallelCopyBatchProvider()`，默认并发 2
5. 可重试错误 item 级 retry
6. `COPY_PARALLEL_ENABLED` 和 `COPY_BATCH_ITEM_CONCURRENCY=1` 快速回退
7. 修正 op-lock TTL 或改 item 级 lock
8. 请求级 rate limit

这个版本的收益主要来自多个 item 并发，不触碰单个 campaign 内部深拷贝依赖，风险可控。

## 不建议方案

不要直接做：

```ts
await Promise.all(copyItems.map(copyOne));
```

原因：

- 无 item claim，重复投递会重复创建。
- 无 settle-once，进度计数会错。
- 无请求级限流，会放大 Meta rate limit。
- 无 step ledger，崩溃恢复后可能重复创建。
- 单个 campaign deep copy 的父子关系不能被无脑并行打散。

## 测试计划

### 单元测试

- 并发 claim 同一 item，只能一个成功。
- 重复 settle success，不重复增加 success。
- 重复 settle failed，不重复增加 failed。
- retrying 不改变 success/failed counter。
- `_copyIndex` 并行下命名不冲突。
- step key 对同 item/source 稳定，对不同 item 不冲突。

### 集成测试

- `ad:copy count=100`，并发 2，最终 `success + failed = total`。
- `adset:copy count=50 deepCopy=true`，部分 Meta 5xx 注入，retry 后无重复 newId。
- `campaign:copy count=10 deepCopy=true`，确认每个新 campaign 下的 adset/ad 父子关系正确。
- 同一 `copyBatch` 消息模拟重复投递，所有 item 只结算一次。
- worker 在 create 成功后、settle 前崩溃，验证 step/marker 恢复逻辑。

### 压测

- 并发 1、2、3 分别测试耗时、Meta 429、DB CPU、Redis latency。
- 每个广告账户单独观察，避免一个账户触发 breaker 影响全局判断。

## 上线策略

1. 先上线 Phase 1，保持并发 1，观察 1 天。
2. 上线 step ledger，保持并发 1，观察 DB 写入和任务恢复。
3. 打开 `COPY_PARALLEL_ENABLED=1`，只对测试账户或低风险账户启用并发 2。
4. 扩大到账户级默认并发 2。
5. 根据 Meta 429、失败率、平均耗时决定是否升到 3。
6. 出现异常时把 `COPY_BATCH_ITEM_CONCURRENCY=1` 并重启 worker，立即退回串行行为。

部署注意：

- Phase 1 不建议滚动升级 worker。应先停旧 worker，部署后再启动。
- Phase 2 以后迁移必须先于 worker 新代码生效。
- 回滚时要保证旧代码能忽略新表，不依赖新表字段。

## 评估结论

可以做并行，但正确顺序是先把“状态正确性”补齐，再提高并发。最合理的第一版是 copyBatch item 级有限并发，而不是 campaign 内部全量并行。

建议实施优先级：

1. P0：item claim、settle-once、异常隔离、锁 TTL/粒度修正。
2. P1：copy step ledger。
3. P1：有限并发 `COPY_BATCH_ITEM_CONCURRENCY=2`。
4. P2：marker 或远端幂等恢复。
5. P3：campaign 内部 DAG 并发。

如果业务目标只是缩短批量复制总耗时，做到 P0 + P1 + item 并发 2 就能先获得明显收益；如果目标是严格保证崩溃后也绝不重复创建，则 marker/远端幂等是必要条件，不能省略。
