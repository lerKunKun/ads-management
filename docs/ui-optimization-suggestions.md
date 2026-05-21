# 前端 UI 优化建议

本文档基于当前 `apps/web` 前端代码的静态检查整理，目标是把现有页面从“轻量列表页集合”调整为更符合常规后台系统的工作台式体验。

## 当前判断

前端技术栈是 React 19、Vite、TanStack Router、TanStack Query、Tailwind，并已有一套简化版 shadcn 风格基础组件。当前页面可以承载 MVP 功能，但布局和交互更接近普通网页：顶部横向导航、居中内容容器、各页面自行拼表格和按钮。对于广告账户、广告系列、广告组、广告、任务、审计、用户权限这类高频后台操作来说，信息架构、操作入口和状态反馈都不够清晰。

重点问题：

- 全局布局没有后台常见的侧边导航、模块分组、面包屑、页面头和内容工具栏。
- 多层资源路径依赖逐级点击进入，用户很难知道自己处在 `FB 个号 -> 广告账户 -> 广告系列 -> 广告组 -> 广告` 的哪一层。
- 列表页功能齐全但过于拥挤，搜索、筛选、日期、刷新、批量启停、预算、复制、归档都堆在同一行。
- 批量操作缺少明确的“已选对象范围”和“危险操作确认”设计，当前依赖浏览器 `confirm`，不适合生产后台。
- 管理页把熔断、Token 健康、任务历史、审计日志纵向堆叠，缺少分区导航和运维视角的信息优先级。
- UI 组件较基础：状态只有文字颜色，缺少 Badge、空状态、加载骨架、错误面板、确认弹窗、任务抽屉等后台高频组件。
- 表格缺少排序、列宽控制、固定首列/操作列、分页大小、筛选摘要、列展示配置等数据管理能力。
- 顶部导航没有 active 状态，登录后用户、角色、公司/作用域信息不成体系。

## 建议目标布局

建议先引入统一 `AppShell`，把后台系统的结构固定下来：

```text
┌─────────────────────────────────────────────────────────────┐
│ TopBar: 公司/环境/当前用户/任务入口/退出                    │
├───────────────┬─────────────────────────────────────────────┤
│ Sidebar       │ Breadcrumb                                  │
│ - 广告资产    │ PageHeader: 标题 / 资源摘要 / 主操作         │
│ - 批量任务    │ Tabs 或 Section Nav                          │
│ - 系统管理    │ Toolbar: 搜索 / 筛选 / 日期 / 刷新            │
│ - 审计日志    │ Content: 表格 / 详情 / 任务反馈               │
└───────────────┴─────────────────────────────────────────────┘
```

侧边栏建议按工作流分组，而不是按技术路由分组：

- 广告资产：FB 个号、广告账户、广告系列、广告组、广告
- 运营任务：批量任务、任务历史
- 系统管理：用户与作用域、Token 健康、熔断管理
- 审计与日志：操作审计

## 信息架构优化

### 1. 建立资源上下文

当前详情页通过手写面包屑展示层级，但不同页面表现不一致。建议抽成统一资源上下文组件：

- `ResourceBreadcrumb`：固定展示当前路径。
- `ResourceSummaryBar`：展示当前 FB 个号、广告账户、币种、状态、最近同步时间。
- `ScopeSelector`：允许在页面头快速切换 FB 个号或广告账户，减少反复返回列表的成本。

广告层级页面建议保持同一套布局：

```text
广告账户详情
  Header: 账户名称、Meta act id、币种、状态、同步时间
  Tabs: 广告系列 / 广告组 / 广告 / Insights
  Table: 当前层级数据
```

这样用户不必通过深层 URL 才能理解层级，也方便后续做跨层筛选和汇总。

### 2. 管理模块拆成独立页面

当前 `/admin` 同时承载熔断、Token、任务、审计，建议改成：

- `/admin/overview`：系统概览，放关键风险和最近任务。
- `/admin/users`：用户与作用域。
- `/admin/breakers`：熔断管理。
- `/admin/tasks`：任务历史。
- `/admin/audit`：审计日志。

侧边栏中“系统管理”只保留入口，不把所有表格塞进一个页面。

## 列表与表格优化

建议建立统一 `DataPage` / `DataTable` 模式，避免每个路由重复拼装：

```text
PageHeader
FilterBar
SelectionActionBar
DataTable
Pagination
TaskFeedback
```

表格建议：

- 首列选择框固定宽度，名称列固定或最小宽度，操作列右侧固定。
- 状态使用 `StatusBadge`，不要只靠文字颜色表达。
- 数值列统一右对齐并使用 `tabular-nums`，金额、CPA、CPC、CPM 要统一格式化。
- 支持排序，至少对花费、订单、CPA、状态、更新时间开放。
- 支持 page size 选择，默认 20，但允许 50/100。
- 加载态使用骨架行，空数据使用 `EmptyState`，错误使用可重试的错误面板。
- 表头需要清晰区分“实体字段”和“指标字段”，指标可以按日期范围刷新。

筛选建议：

- 搜索、状态、币种、日期范围放在统一工具栏。
- 筛选条件变多时使用“更多筛选”抽屉，不继续横向堆控件。
- 筛选后展示摘要，例如“已筛选 12 / 80，状态：ACTIVE，币种：USD”。
- 清除筛选按钮固定在筛选摘要旁。

## 批量操作优化

当前批量按钮一直占据顶部空间，并且危险操作和普通操作混在一起。建议改成“选中后出现”的批量操作栏：

```text
已选 12 项   暂停   启用   改预算   复制   更多 ▾   归档
```

规则：

- 没有选中时隐藏批量操作栏，只保留页面主操作和筛选。
- 跨页选择必须明确提示，例如“已选当前页 20 项，可选择全部 156 项”。
- 归档、删除、批量改预算必须使用自定义 `ConfirmDialog`，展示影响对象数量、操作不可逆说明、确认按钮文案。
- 批量任务提交后不要只弹进度对话框，建议进入右侧 `TaskDrawer` 或全局任务中心，允许用户继续浏览页面。

## 对话框与任务反馈

建议替换当前极简 Dialog，实现以下能力：

- 使用 Radix Dialog 或完整封装，支持 portal、焦点锁定、Esc 关闭、滚动内容、无障碍标题。
- 复制广告的表单拆成区块：复制范围、投放时间、命名规则、复制后状态、预览。
- 表单校验应内联展示，不使用 `alert`。
- 任务进度统一接入 `TaskDrawer`：展示状态、成功/失败数量、失败原因入口、完成后刷新相关列表。
- 顶部增加任务入口，显示运行中任务数量。

## 视觉规范建议

### 导航

- 侧边栏宽度建议 220-240px。
- 菜单项使用 lucide 图标，当前路由高亮。
- TopBar 放当前公司、环境、当前用户和退出，不承载主要业务导航。

### 颜色与状态

建议统一状态语义：

- Active：绿色 Badge。
- Paused / Pending：黄色或灰色 Badge。
- Disabled / Token Invalid / Failed：红色 Badge。
- Running：蓝色 Badge。
- Archived / Deleted：灰色 Badge。

### 组件

建议新增或补齐：

- `AppShell`
- `SidebarNav`
- `TopBar`
- `PageHeader`
- `Breadcrumbs`
- `StatusBadge`
- `MetricCell`
- `DataToolbar`
- `DataTable`
- `SelectionActionBar`
- `ConfirmDialog`
- `TaskDrawer`
- `EmptyState`
- `ErrorState`

## 页面级改造建议

### 登录页

当前登录页过于简单，可保留轻量，但需要：

- 居中卡片式登录区域。
- 明确系统名称。
- 去掉生产环境默认账号预填，或仅在 mock/dev 环境展示。
- 错误信息使用统一表单错误样式。

### FB 个号列表

建议定位为“授权账户管理”：

- 顶部展示总个号、有效个号、Token 异常个号。
- 主操作是“绑定 FB 个号”。
- Token 到期时间要有风险提示，临近过期高亮。
- 点击个号进入详情，也可以在行内展示广告账户数和最近同步时间。

### 广告账户列表

建议定位为进入广告操作的主入口：

- 列表默认显示账户名、Meta ID、币种、状态、最近同步、广告系列数量、今日花费。
- 支持按 FB 个号、币种、状态筛选。
- 行点击进入账户工作台，而不是只进入下一层列表。

### 广告系列/广告组/广告列表

建议统一为“广告资产表格”：

- 页面头展示当前账户上下文。
- 顶部 Tabs 区分层级。
- 表格支持指标排序和批量操作。
- 操作列只保留高频操作，低频操作收进更多菜单。
- 预算编辑建议用 Popover 或侧栏表单，不建议用隐藏在数字按钮上的弱提示。

### 系统管理

建议用运维后台结构：

- Overview：异常 Token、打开的熔断、运行中任务、最近失败任务。
- Breakers：按类型、目标、TTL、原因筛选。
- Tasks：任务状态、类型、进度、失败数、创建人、创建时间。
- Audit：支持 action、resource、用户、时间范围筛选。

## 推荐实施顺序

### P0：先修后台骨架

目标是先让系统“像后台”：

- 新增 `AppShell`、`SidebarNav`、`TopBar`、`PageHeader`、`Breadcrumbs`。
- 根路由改成侧边栏 + 顶栏 + 内容区。
- 给导航加 active 状态和权限控制。
- 统一页面标题、描述、主操作区域。

### P1：统一列表页体验

目标是让高频操作可用：

- 抽象 `DataToolbar`、`SelectionActionBar`、`StatusBadge`、`ConfirmDialog`。
- 改造 FB 个号、广告账户、广告资产列表。
- 批量操作从顶部按钮堆叠改为选中后动作栏。
- 替换 `alert` 和 `confirm`。

### P2：强化任务和管理模块

目标是让批量操作和运维可追踪：

- 引入 `TaskDrawer` 和全局任务入口。
- 拆分 `/admin` 页面。
- 任务历史支持筛选、失败原因查看、重新拉取。
- 审计日志支持时间范围和用户筛选。

### P3：数据表格能力增强

目标是提升效率：

- 表格排序、列宽、固定列、page size。
- 指标列分组和日期范围联动。
- 列展示配置和本地偏好缓存。
- 更完整的空状态、错误态、加载骨架。

## 建议先落地的代码位置

优先新增这些组件目录：

```text
apps/web/src/components/layout/AppShell.tsx
apps/web/src/components/layout/SidebarNav.tsx
apps/web/src/components/layout/TopBar.tsx
apps/web/src/components/layout/PageHeader.tsx
apps/web/src/components/navigation/Breadcrumbs.tsx
apps/web/src/components/data/DataToolbar.tsx
apps/web/src/components/data/SelectionActionBar.tsx
apps/web/src/components/data/StatusBadge.tsx
apps/web/src/components/feedback/ConfirmDialog.tsx
apps/web/src/components/feedback/TaskDrawer.tsx
apps/web/src/components/feedback/EmptyState.tsx
apps/web/src/components/feedback/ErrorState.tsx
```

然后按这个顺序改造：

1. `apps/web/src/routes/__root.tsx`
2. `apps/web/src/routes/fb-accounts.tsx`
3. `apps/web/src/routes/fb-accounts_.$id.tsx`
4. `apps/web/src/components/EntityListView.tsx`
5. `apps/web/src/routes/admin.tsx`
6. `apps/web/src/routes/admin_.users.tsx`

## 验收标准

第一版 UI 优化完成后，建议用以下标准验收：

- 用户登录后能立刻识别当前模块、当前资源层级和可执行主操作。
- 广告资产相关页面有统一的头部、筛选、批量操作、表格和分页体验。
- 批量操作不会和普通操作混在一起，危险操作有明确二次确认。
- 任务提交后用户可以继续操作，并能从全局入口查看任务进度。
- 管理页不再是长页面堆叠，而是按系统管理任务分区。
- 状态、金额、指标、错误、空数据、加载中都有统一视觉表达。
- 前端仍保持当前技术栈，不引入大型 UI 框架，优先复用 Tailwind、Radix、lucide 和现有组件风格。
