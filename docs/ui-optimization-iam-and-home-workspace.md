# IAM 与广告管理首页 UI 优化方案

本文档基于新的产品方向整理：管理页面不再平铺所有模块，而是拆为多菜单；IAM 授权页采用“全局公司切换器 + 三栏联动看板”；登录后的首页采用从组织到广告对象的逐级选择工作流。

## 设计目标

当前后台页面的问题是模块平铺、上下文弱、授权关系不直观。下一版 UI 应优先解决：

- 管理模块拆分为清晰菜单，不再把用户、熔断、Token、任务、审计堆在一个长页面。
- IAM 权限分配从“弹窗勾选列表”升级为“三栏联动工作台”。
- 管理员能直观看到“权限赋予谁、资产来自哪个 FB 个号、最终落在哪些广告账户”。
- 登录后的广告管理首页形成明确选择链路：组织 -> FB 个号 -> 广告系列 -> 广告组 -> 广告。
- 各栏独立滚动，避免整页滚动导致上下文丢失。

## 管理模块信息架构

管理入口建议拆成多菜单：

```text
系统管理
  - IAM 权限管理
  - 用户与角色
  - 公司与组织
  - Token 健康
  - 熔断管理
  - 批量任务
  - 审计日志
```

其中 IAM 权限管理作为重点页面，不再使用普通表格 + 弹窗，而是做成联动工作台。

建议路由：

```text
/admin/iam
/admin/users
/admin/companies
/admin/token-health
/admin/breakers
/admin/tasks
/admin/audit
```

## IAM 全局公司切换器

IAM 页面顶部保留全局公司切换器：

```text
公司：Demo Co. v      当前角色：CompanyAdmin      同步状态：正常
```

规则：

- `PlatformAdmin` 可以切换公司。
- `CompanyAdmin` 只能看到当前公司，切换器置灰或只展示当前公司。
- 切换公司后，三栏数据整体刷新。
- 公司切换器是 IAM 页面上下文源，不应藏在筛选项里。

建议页面结构：

```text
┌──────────────────────────────────────────────────────────┐
│ PageHeader: IAM 权限管理                                 │
│ CompanySwitcher / 当前公司状态 / 最近同步时间             │
├──────────────────────────────────────────────────────────┤
│ Users Panel │ FB Accounts Panel │ Ad Accounts Scope Panel │
└──────────────────────────────────────────────────────────┘
```

## 三栏联动看板

页面主体采用 Three-Column Linked Workspace。

布局建议：

```tsx
<div className="grid h-[calc(100vh-112px)] grid-cols-[1fr_1fr_1.2fr] gap-4 overflow-hidden">
  <section className="overflow-y-auto">Users</section>
  <section className="overflow-y-auto">FB Accounts</section>
  <section className="overflow-y-auto">Ad Accounts</section>
</div>
```

如果先求简单，可以使用：

```text
grid-cols-3
```

关键点：

- 三栏独立滚动。
- 页面整体不再纵向堆叠。
- 左栏选中用户后，中栏和右栏立即联动。
- 中栏勾选 FB 个号后，右栏广告账户范围动态收窄。
- 已授权资源默认高亮或勾选，方便审计。

## 左栏：用户/员工列表

定位：权限赋予谁。

组件形态：

- 紧凑型单列 Card 列表，或单列 Table。
- 每行包含头像、姓名或邮箱、角色、状态。
- 支持关键词搜索邮箱/姓名。
- 支持角色筛选：CompanyAdmin、Operator、Viewer。
- 支持状态筛选：active、disabled。

交互：

- 单选，类似 Radio interaction。
- 点击用户行即选中。
- 选中行使用 active background。
- 选中后中栏和右栏展示该用户当前已有权限。

推荐行信息：

```text
[头像] admin@demo.local
       CompanyAdmin · active
       作用域：全量自动授权
```

普通用户：

```text
[头像] buyer@demo.local
       Operator · active
       FB: 2 / Ad: 18
```

状态规则：

- 未选中用户时，中栏和右栏显示空态：“请选择一个用户查看作用域”。
- 选中 CompanyAdmin / PlatformAdmin 时，中栏、右栏置灰并显示自动授权提示。

## 中栏：FB 个人号列表

定位：资产所属渠道。

组件形态：

- Checkbox 列表。
- 顶部带前端关键字过滤，过滤名称或 FB 用户 ID。
- 每行显示名称、FB 用户 ID、状态、广告账户数。

交互：

- 多选。
- 选中用户后，用户已拥有的 FB 个号授权默认勾选。
- 勾选或取消勾选 FB 个号时，立即更新用户授权。
- 如果中栏没有勾选任何个号，右栏默认展示该公司名下全量广告账户。
- 如果中栏勾选一个或多个 FB 个号，右栏只展示这些 FB 个号名下的广告账户。

推荐行信息：

```text
[ ] Mock FB User
    fb_user_id: 123456789
    active · 24 个广告账户
```

高亮规则：

- 已直接授予用户的 FB 个号：checkbox checked。
- 由角色绕过作用域获得权限：整栏 disabled，显示 Badge。
- token_invalid 的 FB 个号：红色状态 Badge，并提示可能需要重新授权。

## 右栏：广告账户作用域

定位：最终权限落点。

组件形态：

- 高密度资产看板。
- 每行包含 Checkbox、账户名、`act_id`、状态、币种、Timezone。
- 顶部常驻快速操作：全选、反选、清空、只看已授权。

推荐行信息：

```text
[x] US - Main Store
    act_123456789 · active · USD · America/Los_Angeles
```

交互：

- 多选。
- 选中用户后，该用户已有广告账户授权默认勾选。
- 勾选广告账户立即授权，取消勾选立即撤销授权。
- 顶部“全选”只对当前右栏可见范围生效。
- 当中栏勾选 FB 个号时，右栏全选只选这些 FB 个号名下的广告账户。

特殊逻辑：

- CompanyAdmin / PlatformAdmin：右栏整体置灰，显示“全量自动授权” Badge。
- 如果用户已被授予整个 FB 个号，则该 FB 个号下广告账户可以显示为继承授权状态。
- 继承授权和直接授权要视觉区分：
  - 直接授权：实心 checkbox。
  - 继承授权：半选或 Badge “继承自 FB 个号”。

## IAM 联动状态设计

### 普通用户

```text
左栏：选中 buyer@demo.local
中栏：勾选该用户已授权的 FB 个号
右栏：勾选该用户已授权的广告账户
```

### 只授权广告账户

```text
左栏：选中 buyer@demo.local
中栏：不勾选 FB 个号
右栏：展示公司全量广告账户，其中已授权账户勾选
```

### 勾选 FB 个号后缩小范围

```text
中栏：勾选 FB A、FB B
右栏：只展示 FB A、FB B 下广告账户
```

### 管理员绕过作用域

```text
左栏：选中 CompanyAdmin 用户
中栏：disabled，Badge：全量自动授权
右栏：disabled，Badge：全量自动授权
```

## IAM 页面数据需求

建议后端为三栏联动提供一个聚合接口，减少前端多接口拼装。

```text
GET /iam/workspace?company_id=xxx
```

返回建议：

```ts
{
  company: { id, name, status },
  users: [
    {
      id,
      email,
      name,
      status,
      roles,
      scopeBypass,
      grants: {
        fbAccountIds: string[],
        adAccountIds: string[]
      }
    }
  ],
  fbAccounts: [
    {
      id,
      name,
      fbUserId,
      status,
      adAccountCount
    }
  ],
  adAccounts: [
    {
      id,
      fbAccountId,
      name,
      metaActId,
      status,
      currency,
      timezone
    }
  ]
}
```

写接口可以继续保持：

```text
POST   /iam/users/:id/grants
DELETE /iam/users/:id/grants/:grantId
```

但前端需要乐观更新和失败回滚。

## 登录后首页选择链路

登录后首页不应直接进入单一列表，而是形成广告管理的选择工作流。

目标链路：

```text
卡片：选择组织
  -> 卡片：选择 FB 个号
  -> 列表：广告系列
  -> 列表：广告组
  -> 列表：广告
```

推荐首页布局：

```text
┌────────────────────────────────────────────────────────────┐
│ Header: 广告管理工作台                                      │
├──────────────┬──────────────┬──────────────────────────────┤
│ 组织卡片     │ FB 个号卡片   │ 当前选择摘要                  │
├──────────────┴──────────────┴──────────────────────────────┤
│ 广告系列列表                                                │
├────────────────────────────────────────────────────────────┤
│ 广告组列表                                                  │
├────────────────────────────────────────────────────────────┤
│ 广告列表                                                    │
└────────────────────────────────────────────────────────────┘
```

如果需要更强联动，也可以做成横向分栏：

```text
组织 / FB 个号 / 广告系列 / 广告组 / 广告
```

但考虑广告系列、广告组、广告是数据表格，建议组织和 FB 个号用卡片，后三级用列表。

## 首页：组织选择卡片

定位：选择公司/组织。

组件：

- 卡片列表。
- 每张卡片显示公司名称、状态、广告账户数、异常 Token 数。
- `CompanyAdmin` 只有一张当前公司卡片。
- `PlatformAdmin` 可以看到多公司并切换。

交互：

- 点击组织卡片后，FB 个号卡片刷新。
- 当前组织卡片高亮。

## 首页：FB 个号选择卡片

定位：选择授权渠道。

组件：

- 卡片列表。
- 每张卡片显示 FB 个号名称、状态、广告账户数量、Token 到期风险。
- 支持搜索名称或 FB 用户 ID。

交互：

- 点击 FB 个号后，广告系列列表刷新。
- 如果用户只被授予广告账户而没有 FB 个号授权，需要显示“可见广告账户所属 FB 个号”，不能让入口为空。
- 支持“全部可见广告账户”入口，避免必须先选 FB 个号。

## 首页：广告系列列表

定位：进入广告管理的第一层业务列表。

展示字段：

- 名称
- 状态
- 日预算
- 花费
- 订单
- CPA
- CPC
- CPM
- 更新时间

交互：

- 单击行选中广告系列。
- 右侧或下方广告组列表联动刷新。
- 支持搜索、状态筛选、日期范围。
- 支持批量暂停、启用、改预算、复制、归档。

## 首页：广告组列表

定位：当前广告系列下的广告组。

展示字段：

- 名称
- 状态
- 日预算
- 优化目标
- 花费
- 订单
- CPA
- 更新时间

交互：

- 单击行选中广告组。
- 广告列表联动刷新。
- 支持与广告系列一致的批量操作。

## 首页：广告列表

定位：当前广告组下的广告。

展示字段：

- 名称
- 状态
- 素材/creative ID
- 花费
- 点击
- 订单
- CPA
- 更新时间

交互：

- 支持暂停、启用、复制、归档。
- 广告层不展示预算编辑。
- 支持预览入口，后续可扩展素材预览。

## 首页状态规则

### 未选择组织

显示组织卡片，其他区域空态：

```text
请选择组织开始管理广告资产
```

### 已选择组织，未选择 FB 个号

显示该组织下可见 FB 个号，同时广告系列区域展示：

```text
请选择 FB 个号或查看全部可见广告账户
```

### 已选择 FB 个号

加载该 FB 个号下广告账户，并可进入广告系列。

### 只有广告账户授权

不能出现空白入口。应提供：

```text
全部可见广告账户
```

或者展示“由广告账户授权反推的 FB 个号卡片”。

## 与权限系统的关系

首页展示必须基于有效作用域：

```text
有效作用域 = 角色权限 + FB 个号授权 + 广告账户授权 + bypass
```

规则：

- Viewer：可查看，不能操作。
- Operator：可按权限操作广告对象。
- CompanyAdmin：公司内全量可见。
- PlatformAdmin：可切换公司后查看对应公司全量。

前端不应只靠隐藏按钮保证权限；后端仍必须校验。

## 组件拆分建议

### IAM

```text
apps/web/src/components/iam/CompanySwitcher.tsx
apps/web/src/components/iam/IamWorkspace.tsx
apps/web/src/components/iam/UserPane.tsx
apps/web/src/components/iam/FbAccountPane.tsx
apps/web/src/components/iam/AdAccountScopePane.tsx
apps/web/src/components/iam/ScopeBadge.tsx
```

### 首页工作台

```text
apps/web/src/components/workspace/OrganizationCards.tsx
apps/web/src/components/workspace/FbAccountCards.tsx
apps/web/src/components/workspace/CampaignListPane.tsx
apps/web/src/components/workspace/AdSetListPane.tsx
apps/web/src/components/workspace/AdListPane.tsx
apps/web/src/components/workspace/SelectionSummary.tsx
```

### 通用

```text
apps/web/src/components/data/LinkedPane.tsx
apps/web/src/components/data/StatusBadge.tsx
apps/web/src/components/data/ToolbarSearch.tsx
apps/web/src/components/feedback/EmptyState.tsx
apps/web/src/components/feedback/ErrorState.tsx
```

## 推荐实施顺序

### P0：管理页拆菜单

- 新建管理侧边菜单。
- `/admin` 只保留 overview。
- 新增 `/admin/iam`。
- 用户与作用域从弹窗迁移到 IAM 工作台。

### P1：IAM 三栏联动

- 实现公司切换器。
- 实现左栏用户单选。
- 实现中栏 FB 个号多选。
- 实现右栏广告账户作用域多选。
- 管理员角色显示“全量自动授权”置灰状态。

### P2：登录首页工作台

- 登录后进入广告管理工作台。
- 组织卡片和 FB 个号卡片作为上游选择。
- 广告系列、广告组、广告列表按选中项联动。
- 补“全部可见广告账户”入口，兼容只授权广告账户用户。

### P3：体验完善

- 乐观更新授权。
- 失败回滚和 toast。
- 搜索、筛选和只看已授权。
- 批量授权确认。
- 审计入口联动到用户/资源。

## 验收标准

IAM 页面：

- 管理页面不再平铺。
- 进入 IAM 后能通过公司切换器确定当前公司上下文。
- 选中用户后，中栏和右栏立即展示该用户现有权限。
- 勾选 FB 个号后，右栏广告账户范围动态缩小。
- CompanyAdmin / PlatformAdmin 显示全量自动授权，不要求重复勾选。
- 三栏独立滚动，页面高度固定，不出现整页长滚动。

首页工作台：

- 登录后能按组织、FB 个号、广告系列、广告组、广告逐步进入。
- 只授权广告账户的用户也能进入广告管理。
- Viewer 看不到操作按钮。
- Operator 只看到自己作用域内的资产。
- 页面选择状态清晰，刷新后可通过 URL 或本地状态恢复主要上下文。

## 最终建议

下一版 UI 不要继续在原有 `/admin` 长页面上加模块。应先拆管理菜单，再把 IAM 做成独立三栏联动页面。

广告管理首页也不应把 `/fb-accounts` 当唯一入口。更合理的是把登录后首页做成“选择组织 + 选择 FB 个号 + 广告对象联动列表”的工作台，同时保留“全部可见广告账户”能力，保证只授予广告账户的普通操作员也能顺畅进入业务。
