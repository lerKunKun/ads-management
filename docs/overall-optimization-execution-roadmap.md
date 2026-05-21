# 整体优化执行顺序

本文档用于统一排序现有几份优化文档中的工作，避免重复建设和执行顺序错位。

涉及文档：

- `docs/global-governance-and-ad-object-storage-evaluation.md`
- `docs/access-chain-permission-audit.md`
- `docs/ui-optimization-iam-and-home-workspace.md`
- `docs/ui-optimization-suggestions.md`

## 排序原则

执行顺序按以下原则排：

1. 先安全和正确性，再做 UI。
2. 先统一权限与作用域，再做 IAM 三栏联动。
3. 先保证广告管理入口可达，再重做登录首页。
4. 先做轻量归属校验，再做广告对象大规模落库。
5. 先拆管理信息架构，再做高级表格和视觉细节。

不建议先做的事：

- 不要先做完整 UI 美化，再回头补权限闭环。
- 不要一开始就把 campaign / adset / ad 全量落库同步做大。
- 不要继续在 `/admin` 长页面上加模块。
- 不要把 `/fb-accounts` 继续作为唯一广告管理入口。

## 总体执行顺序

推荐顺序：

```text
阶段 1：全局治理底座
阶段 2：权限与选择链路闭环
阶段 3：管理页拆菜单 + IAM 三栏联动
阶段 4：广告管理首页工作台
阶段 5：广告对象本地读模型与同步
阶段 6：表格、任务中心、审计体验增强
```

## 阶段 1：全局治理底座

来源文档：

- `global-governance-and-ad-object-storage-evaluation.md`

目标：

先把错误、审计、权限声明方式统一，否则后续 UI 和业务功能越多，权限和错误处理会继续散落。

建议先做：

- 增加 requestId。
- API 全局错误响应统一携带 requestId。
- 服务端结构化错误日志。
- 前端 `api.call()` 统一处理 401 / 403 / 409 / 500。
- `writeAudit()` 改为 best-effort，避免审计失败影响主业务。
- 审计表补复合索引：
  - `(company_id, created_at desc)`
  - `(company_id, action, created_at desc)`
- 建立权限常量使用规范，禁止新代码继续手写权限字符串。

可暂缓：

- outbox 审计。
- 错误事件入库。
- 全量任务审计重构。

验收标准：

- 任意 API 报错都能拿到 requestId。
- 前端 401 自动回登录，403 有统一无权限提示。
- 新增 route 不再直接写裸字符串权限。
- 审计失败不会导致业务接口失败。

## 阶段 2：权限与选择链路闭环

来源文档：

- `access-chain-permission-audit.md`
- `global-governance-and-ad-object-storage-evaluation.md`

目标：

先解决“用户能不能进来、看到什么、能不能越权操作”的问题。

建议先做：

- 新增 `resolveEffectiveScope(principal)`：
  - bypass：公司下全部 FB 个号和广告账户。
  - FB grant：该 FB 个号及其下全部广告账户。
  - Ad grant：该广告账户及其所属 FB 个号。
- 修复只授权广告账户用户在 `/fb-accounts` 入口为空的问题。
- 新增全局广告账户入口 `/ad-accounts`，不要只依赖 `/fb-accounts`。
- 登录后默认入口从 `/fb-accounts` 调整为广告管理工作台或 `/ad-accounts`。
- 增加 campaign / adset / ad 归属校验。
- 任务详情 `/operations/:taskId` 增加创建人或管理权限校验。

归属校验建议先用轻量方案：

- 操作 campaign 前确认 campaign 属于当前 ad account。
- 操作 adset 前确认 adset 所属 campaign / ad account。
- 操作 ad 前确认 ad 所属 adset / campaign / ad account。
- 后续落库后再切换为本地表校验。

可暂缓：

- campaign / adset / ad 完整本地表。
- 细分 `adset:*`、`ad:*` 权限。

验收标准：

- 只授权广告账户的 Operator 可以进入广告管理。
- Viewer 能看但不能操作。
- 用有权限的广告账户 ID 搭配别的账户下 campaign/adset/ad ID，会被后端拒绝。
- 普通用户不能查看同公司其他用户任务详情。

## 阶段 3：管理页拆菜单 + IAM 三栏联动

来源文档：

- `ui-optimization-iam-and-home-workspace.md`
- `ui-optimization-suggestions.md`

目标：

管理页不再平铺，把 IAM 做成主要权限工作台。

建议先做：

- `/admin` 改为 overview 或管理首页。
- 拆出菜单：
  - `/admin/iam`
  - `/admin/users`
  - `/admin/companies`
  - `/admin/token-health`
  - `/admin/breakers`
  - `/admin/tasks`
  - `/admin/audit`
- IAM 页面顶部加入公司切换器。
- 实现三栏独立滚动布局：
  - 左栏：用户/员工列表。
  - 中栏：FB 个人号 Checkbox 列表。
  - 右栏：广告账户作用域 Checkbox 看板。
- CompanyAdmin / PlatformAdmin 显示“全量自动授权”，中右栏置灰。
- 中栏勾选 FB 个号后，右栏只展示这些 FB 个号下的广告账户。

建议依赖：

- 先完成阶段 2 的 `resolveEffectiveScope()`，否则 IAM 三栏会重复造作用域逻辑。

可暂缓：

- 公司多租户平台管理完整 UI。
- 高级审计跳转联动。
- 批量授权复杂确认。

验收标准：

- 管理页面不再长页面平铺。
- 选中用户后，中栏和右栏能立即显示当前用户已有授权。
- 只授权广告账户、只授权 FB 个号、管理员 bypass 三种状态都能正确表达。
- 三栏各自滚动，页面不会整页长滚动。

## 阶段 4：广告管理首页工作台

来源文档：

- `ui-optimization-iam-and-home-workspace.md`
- `access-chain-permission-audit.md`
- `ui-optimization-suggestions.md`

目标：

把登录后的业务入口改成清晰的广告管理工作台，而不是单一 FB 个号列表。

建议先做：

- 首页结构：
  - 卡片：选择组织。
  - 卡片：选择 FB 个号。
  - 列表：广告系列。
  - 列表：广告组。
  - 列表：广告。
- 增加“全部可见广告账户”入口，兼容只授权广告账户用户。
- 页面显示当前选择摘要。
- 广告系列、广告组、广告按选中项联动。
- Viewer 隐藏操作按钮，Operator 显示授权范围内操作。

建议不要一次做太复杂：

- 第一版可以先保留当前 `EntityListView`，只是把入口和选择上下文重排。
- 后续再做高级表格、固定列、列配置。

验收标准：

- 登录后用户能明确看到当前组织和可见资产。
- 不需要先进入 `/fb-accounts` 才能管理广告。
- 组织、FB 个号、广告系列、广告组、广告之间联动清晰。
- 只授权广告账户用户不会遇到空首页。

## 阶段 5：广告对象本地读模型与同步

来源文档：

- `global-governance-and-ad-object-storage-evaluation.md`
- `access-chain-permission-audit.md`

目标：

把 campaign / adset / ad 做成本地读模型，支撑归属校验、搜索、排序、审计和减少 Meta 实时调用。

建议先做最小读模型：

```text
campaigns
adsets
ads
ad_account_sync_state
```

第一版只保存：

- company_id
- ad_account_id
- 父级 ID
- Meta ID
- name
- status
- budget
- updated_time
- last_synced_at
- sync_hash

同步策略：

- 操作成功后写穿本地表。
- 后台按广告账户异步增量同步。
- 只 upsert 变化数据。
- 活跃账户高频，冷账户低频。
- 定期低优先级全量校准。

必须同时处理：

- 任务计数热点：避免每个 item 高频更新同一行 `operation_tasks`。
- 同步并发：不要让 1000+ 广告账户同时全量同步。

可暂缓：

- ClickHouse 报表。
- 素材本地化。
- 多平台 provider 全量抽象。

验收标准：

- 页面主列表可从本地库读取。
- 操作成功后本地状态能及时更新。
- 后台同步失败不会阻断用户操作。
- 不做高频全量 upsert。

## 阶段 6：表格、任务中心、审计体验增强

来源文档：

- `ui-optimization-suggestions.md`
- `global-governance-and-ad-object-storage-evaluation.md`

目标：

在权限、入口、数据模型稳定后，再提高效率和可观测性。

建议做：

- 统一 `DataToolbar`。
- 统一 `SelectionActionBar`。
- 表格排序、固定列、page size。
- 状态 Badge。
- 空状态、错误态、加载骨架。
- 全局 `TaskDrawer`。
- 审计页面增加用户、action、时间范围筛选。
- 批量任务支持失败原因查看和重试入口。

验收标准：

- 高频广告操作无需在多个页面反复跳转。
- 批量任务可追踪。
- 审计可按用户、资源、时间定位。
- 表格能支撑大数据量日常运营。

## 文档执行排序

如果按文档维度排序，建议如下：

1. `global-governance-and-ad-object-storage-evaluation.md`

先执行其中 P0 的全局错误、审计、权限统一、任务计数热点建议。

2. `access-chain-permission-audit.md`

紧接着执行有效作用域、广告账户入口、下级对象归属校验。

3. `ui-optimization-iam-and-home-workspace.md`

在权限链路稳定后，执行管理页拆菜单、IAM 三栏联动、登录首页工作台。

4. `ui-optimization-suggestions.md`

最后作为整体视觉、表格、任务反馈和组件规范的补充执行。

注意：第 3 和第 4 份文档有重叠。以后以 `ui-optimization-iam-and-home-workspace.md` 作为 IAM 和首页的准线，以 `ui-optimization-suggestions.md` 作为通用后台组件和视觉规范补充。

## 推荐版本切分

### V1：安全可达版

范围：

- requestId + 全局错误处理。
- 权限 policy 基础整理。
- `resolveEffectiveScope()`。
- `/ad-accounts` 全局入口。
- `/fb-accounts` 可见规则修正。
- 轻量下级对象归属校验。

目标：

先保证用户能正确进入、不能越权、错误能追踪。

### V2：管理工作台版

范围：

- 管理页拆菜单。
- `/admin/iam` 三栏联动。
- 公司切换器。
- 管理员自动授权置灰。

目标：

把 IAM 从弹窗勾选改成可审计的工作台。

### V3：广告首页版

范围：

- 登录后广告管理工作台。
- 组织卡片。
- FB 个号卡片。
- 广告系列、广告组、广告联动列表。
- 全部可见广告账户入口。

目标：

把业务入口从资源列表变成运营工作台。

### V4：本地读模型版

范围：

- campaign / adset / ad 落库。
- 操作写穿。
- 异步增量同步。
- 同步状态表。
- 任务计数热点优化。

目标：

支撑 1000+ 广告账户的稳定查询、归属校验和后续报表。

### V5：效率增强版

范围：

- 高级表格。
- 全局任务抽屉。
- 审计筛选增强。
- 批量操作体验优化。

目标：

提升运营效率和管理可观测性。

## 最终建议

优先不要从 UI 细节开始。第一步应先做 V1：全局治理和权限链路闭环。

最推荐的具体执行顺序是：

```text
requestId / 错误处理
  -> 权限 policy / resolveEffectiveScope
  -> 全局广告账户入口 / fb 可见规则
  -> 下级对象归属校验
  -> 管理页拆菜单
  -> IAM 三栏联动
  -> 登录首页工作台
  -> campaign/adset/ad 本地读模型
  -> 表格和任务中心体验增强
```

这个顺序能最大限度减少返工：权限和数据边界先稳定，UI 工作台再基于稳定的数据契约开发，最后再投入大规模落库和效率增强。
