# 批量复制并行异步改造 — 上线风险分析

更新时间：2026-05-23

> 本文档是对 `copy-parallel-async-plan.md` 的配套风险评估。**不含代码改动**，仅做分析，供实施前决策参考。

---

## 一、当前代码中已存在、上线后会被放大的 Bug

### 🔴 B1：`markSuccess` / `failItem` 无条件写，存在 TOCTOU 窗口（最高优先级）

**位置**：`apps/worker/src/handler.ts` L1110–1158

```ts
// markSuccess：无条件 UPDATE，无条件 success+1
UPDATE operation_task_items SET status='success' WHERE id=:itemId
UPDATE operation_tasks SET success = success + 1 ...

// failItem：同上，无条件 failed+1
```

**现有保护**：`handle()` 步骤 3 先读 status，`running` / `retrying` 时不跳过；`executeCustomCopyBatchProvider` 里有 `readItemStatus()` 检查终态后跳过。  
**问题**：两处检查都是先读再判断，无原子性。RabbitMQ 保证 at-least-once，同一消息被投递两次（consumer 重启、ack 超时），两次都通过状态检查，都执行 `success+1`，`operation_tasks.success` 超过 `total`。

- 串行时风险等级：低（概率小但存在）
- 并行后风险等级：高（op-lock 超时后第二个消费者进入，窗口明显扩大）

---

### 🔴 B2：`executeCustomCopyBatchProvider` 内部异常触发整批覆盖

**位置**：`handle()` L252–256

```ts
} catch (err) {
  if (err instanceof AsyncCopyPending) { ... }
  return await handleErr(msg, err, msg.copyBatch);  // ← 传入全量 copyBatch
}
```

`handleErr` → `failMessages()` → 对**所有** batch items 调用 `failItem()`。  

场景：内部循环已成功处理第 1–30 个 item，第 31 个 item 的 `readItemStatus()` 时 DB 连接超时，函数向上抛出，catch 把全部 50 个 item 覆写为 failed，`failed+50`。  
结果：`success+30`，`failed+50`，`total=50` → `success+failed=80 > total`，进度永久错乱。

- 现在触发概率：低，需 DB 连接在循环中途断开
- 并行后多 worker 竞争连接池，触发概率上升

---

### 🔴 B3：op-lock TTL（30s）不覆盖 batch 处理时长

**位置**：`op-lock.ts` L22，`handle()` L163–167

```ts
const ok = await redis.set(key, token, 'EX', 30, 'NX');  // TTL 固定 30s
// 对 batch 里所有 targetId 一次性加锁
const locks = await acquireTargetLocks(lockItems.map((item) => item.targetId));
```

50 个 item，每个 Meta copy API 耗时 2–5s → 总计 100–250s，远超 30s TTL。锁过期后另一个 worker 进入，两者并发写同一批 item，触发 B1 的计数器超出。

---

### 🟡 B4：`handleErr` 里有重复 return（死代码）

**位置**：`handler.ts` L1066–1068

```ts
if (err.isRateLimited) {
  await openFor(BreakerKey.adAccount(msg.metaActId), 60, 'meta rate limited');
  return { kind: 'retry', ... };
  return { kind: 'retry', ... };  // ← 永远不执行
}
```

无运行时危害，但说明该区块改动时未被 typecheck 覆盖，存在逻辑审查遗漏。

---

## 二、Phase 1 实施风险

Phase 1 只改 settle-once + claim，看起来无侵入，实际有以下隐患：

### 🔴 P1-R1：Phase 1 必须全量替换，不能滚动部署

混跑场景分析：

- 旧 Worker 无 claim，item 可被两个 worker 同时执行
- 旧 Worker 的 `failItem()`（无条件写）在新 Worker settle 为 success 之后执行，会把 success 覆盖为 failed，计数器错乱

**结论**：Phase 1 必须停所有 Worker 再统一升级，或使用蓝绿部署而非滚动。

### 🟡 P1-R2：claim 写 `running` 需确认前端/查询兼容

`operationItemStatus` enum 已有 `running`，但**当前代码从未把 item 写成 `running`**（只有 task 级别的 `setRunning`）。Phase 1 的 claim 会首次出现 item 级 `running` 状态。  
需确认 `query-service.ts`、SSE、前端的进度查询逻辑不依赖 `item.status != 'running'` 的隐式假设。

---

## 三、Phase 2（copy step 账本）实施风险

### 🔴 P2-R1：deployment 时序约束

部署 Phase 2 时若有 in-flight copy 消息：
- 新代码查询不存在的表 → 所有 copy 任务报错 → batch 消息进入 retry 循环

**缓解**：DB migration 必须先于新 Worker 代码部署，用停机或蓝绿方式，不能滚动。

### 🔴 P2-R2：lease 过期后的 unknown 恢复路径在 Phase 2 未实现

文档设计里 `lease_until` 过期意味着需要走 marker 恢复（Phase 3）。Phase 2 只有账本，没有 marker。  
若 worker 在 Meta create 成功、写 step 之前崩溃，重启后发现 step 是 `running` 且 lease 过期，进入 `unknown` 分支，但该分支 Phase 2 阶段没有实现，会 throw 或走错误路径，item 永远卡住。

**缓解**：Phase 2 必须对 lease 过期做明确 fallback 处理（如：视为未创建，重新 create），即使不如 marker 方案可靠，也要有明确行为。

### 🟡 P2-R3：step ledger DB 写入量大幅上升

保守估算：
- 浅层 copy：50 item × 1 step = 50 次额外 DB read + write / batch
- 深拷贝 DAG（后期）：50 item × (1 campaign + 100 adsets + 1000 ads) = 55,050 步 / batch

`operation_task_items` 表无 `company_id` 前导列，跨租户查询走 `bypass_rls`。`operation_copy_steps` 表的索引设计需仔细规划，否则 Phase 2 上线即打高 DB。

---

## 四、Phase 3（marker 恢复）实施风险

### 🔴 P3-R1：按 marker_name 搜索 Meta 对象在多种场景下不可靠

文档恢复策略：

> retry 时先用 `marker_name` 查询 Meta（在对应广告账户下按名称过滤）

问题：
1. **API quota 消耗**：list campaigns/adsets/ads 本身消耗 BUC quota，rate limit 崩溃场景下，恢复查询也会触发 rate limit，形成恶性循环
2. **一致性延迟**：Meta 对象创建后可能在 list API 中有秒级到分钟级延迟才可见，导致误判"找不到"
3. **名称非唯一**：marker_name 格式 `<desired_name>__copy_marker_<hash>`，desired_name 包含用户输入，用户命名本身可能含 `__copy_marker_` 子串，导致误识别
4. **账户对象数量大**：有些账户数万 campaign，list 翻页 + 名称过滤极慢

**建议**：marker 策略可行性需要线上测试验证，不能在设计阶段直接假定可行。实施前需确认 Meta list API 的一致性保证和 quota 消耗规则。

### 🟡 P3-R2：rename 异步重试机制未定义

文档说 rename 失败后"单独重试"，但未说用什么机制：
- 现有 RabbitMQ 重试机制：需要新 exchange/queue
- DB 定时扫描：需要定时任务

两种方式都是额外实现，不是小改动，需要在 Phase 3 规划时明确。

---

## 五、Phase 4（并行执行）实施风险

### 🔴 P4-R1：op-lock 在并行模式下语义必须同步调整

当前 op-lock 在 `handle()` 消息级对所有 targetId 加锁，整批共用一把大锁，TTL 30s（B3 问题）。  
Phase 4 并行后有两个选择：
1. 保留消息级大锁 → TTL 问题更严重，50 item 并发更快超时
2. 改成 item 级加锁 → 要修改 `handle()` step 2 的逻辑

文档未明确说明，容易被遗漏。**Phase 4 必须同步处理 op-lock 调整**。

### 🔴 P4-R2：rate limit 从消息级变请求级，桶容量参数需同步评估

当前 `DEFAULT_BUCKETS.adAccount` 容量 20 tokens，refill 2/s。  
并发 3 时 3 个 item 同时消耗令牌，比串行快 3 倍消耗，桶更快触底，限流更频繁。  
真正的问题是桶参数是否与 Meta 实际限制对应。现有 `adjustFromMetaHeaders` 有动态调整逻辑，但要确认并行路径上每个 Meta 请求都触发了调用。

### 🟡 P4-R3：item 自己负责结算，`claimItem()` 本身抛出时 item 卡 running

`claimItem()` 若因 DB 连接断而抛出，item 级 catch 对此场景没有处理，item 停留在 `running` 状态，直到 batch 消息重新投递时才会重新处理。  
`lease_until` 机制解决了这个问题，但需确认 lease 过期的扫描/恢复逻辑在 Phase 2 完成后正确实现。

---

## 六、部署/运维风险

### 🔴 D1：各 Phase 不可回滚跳跃

```
Phase 1 → Phase 2 → Phase 3 → Phase 4
```

- Phase 4 回滚到 Phase 3 时，`operation_copy_steps` 表已有 Phase 4 写入的 running/unknown step，旧代码能否正确处理需要设计向后兼容策略。
- 跳过任意 Phase 直接上线后续 Phase，会导致中间状态无处理，任务永远卡住。

### 🟡 D2：Phase 1 部署窗口期的 in-flight 消息

Phase 1 部署后，RabbitMQ 里已有 `copyBatch` 消息（旧状态 `pending`）可以被新代码正常 claim，不会出错。  
但 Phase 1 上线后立即进行大规模生产复制操作，若崩溃发生，Phase 2 step 账本还没上，无法恢复重复创建。  
**建议**：Phase 1 上线后保持观察期，不立即进行大规模批量复制，等 Phase 2 跟上。

---

## 七、风险矩阵汇总

| 编号 | 风险描述 | 是否当前已存在 | 并行后影响 | 严重程度 |
|---|---|---|---|---|
| B1 | counter 重复累加（TOCTOU） | ✅ 已存在 | 显著放大 | 🔴 P0 |
| B2 | 批量异常时覆盖已 success item | ✅ 已存在 | 更高概率触发 | 🔴 P0 |
| B3 | op-lock TTL 30s < batch 处理时长 | ✅ 已存在 | 并行后锁更快过期 | 🔴 P0 |
| B4 | handleErr 重复 return 死代码 | ✅ 已存在 | 无直接危害 | 🟡 低 |
| P1-R1 | Phase 1 不能滚动部署 | 新引入 | 部署事故 | 🔴 高 |
| P1-R2 | item running 状态兼容性 | 新引入 | 进度展示错误 | 🟡 中 |
| P2-R1 | migration 时序约束 | 新引入 | 全量 copy 报错 | 🔴 高 |
| P2-R2 | lease 过期 unknown 无处理 | 新引入 | 任务永远卡住 | 🔴 高 |
| P2-R3 | step ledger DB 写入量暴增 | 新引入 | DB 压力 | 🟡 中 |
| P3-R1 | marker 按名搜索 Meta 不可靠 | 新引入 | 恢复失败/误判/quota 循环 | 🔴 高 |
| P3-R2 | rename 重试机制未定义 | 新引入 | 名称永远不更新 | 🟡 中 |
| P4-R1 | op-lock 并行下语义冲突 | 新引入 | 锁失效 | 🔴 高 |
| P4-R2 | 并行后令牌桶消耗加速 | 新引入 | 限流更频繁 | 🟡 中 |
| D1 | Phase 间不可回滚跳跃 | 新引入 | 部署事故 | 🟡 中 |

---

## 八、建议：先于并行改造修复的 3 个 Bug

无论是否推进并行改造，以下 3 个问题**现在就值得修**（串行下也应修复）：

### Fix-1（对应 B3）：op-lock TTL 动态化
```ts
// 根据 batch 大小估算 TTL，留足余量
const ttlSec = Math.max(30, copyItems.length * 8);  // 每 item 预留 8s
const locks = await acquireTargetLocks(lockItems.map((item) => item.targetId), ttlSec);
```

### Fix-2（对应 B2）：`executeCustomCopyBatchProvider` 不向外 throw
```ts
// 内部所有异常已有 per-item try/catch；函数级确保 return { __batchHandled: true }
// 不再向外 throw，让外层 catch 对所有 batch items 做 failItem
try {
  // ... 现有 for 循环
} catch (err) {
  // 此处只做日志，不 re-throw
  console.error('[meta-custom-copy-batch] unexpected error', err);
}
return { __batchHandled: true };
```

> 注意：Fix-2 只是止血，不是根治。真正根治需要 Phase 1 的 settle-once。

### Fix-3（对应 B4）：删除重复 return
```ts
// 删除 handleErr 里第二个重复的 return 语句
```

这三个改动可独立于并行改造上线，不新增功能，只降低现有风险。
