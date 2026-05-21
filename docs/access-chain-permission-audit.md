# 广告管理选择链路与权限机制检查

检查范围：公司 -> FB 个号 -> 广告账户 -> 广告系列 -> 广告组 -> 广告 的资源选择链路，以及用户角色、作用域、API 校验、前端入口的配合情况。

本次只做静态检查和文档整理，不修改业务代码。

## 总体结论

当前系统已经具备一条可用的广告管理下钻链路：

```text
登录
  -> /fb-accounts
  -> /fb-accounts/:id
  -> /ad-accounts/:id
  -> /ad-accounts/:id/campaigns/:cid
  -> /ad-accounts/:id/campaigns/:cid/adsets/:asid
```

权限模型也已经成型：公司级 RLS 隔离、角色权限控制 action、用户作用域控制 FB 个号和广告账户。但它不是一条完整的“全层级资源授权链”。目前系统只持久化到 `fb_accounts` 和 `ad_accounts`，广告系列、广告组、广告实时从 Meta 拉取，没有本地资源表，也没有下级资源的独立授权粒度。

因此当前状态应判断为：

- 公司隔离：基本完整。
- 公司 -> FB 个号 -> 广告账户：数据模型、查询、授权和 UI 入口基本完整。
- 广告账户 -> 广告系列 -> 广告组 -> 广告：操作链路可用，但权限依赖广告账户级作用域，没有验证下级对象一定属于请求中声明的广告账户。
- 作用域分配：支持 FB 个号和广告账户两种粒度，但对“只授权广告账户”的用户，当前 `/fb-accounts` 默认入口存在可达性问题。

## 现有实现梳理

### 数据模型

已有本地表：

- `companies`：公司/租户。
- `fb_accounts`：FB 个号，包含 `company_id`、`fb_user_id`、加密 token、状态。
- `ad_accounts`：广告账户，包含 `fb_account_id`、`company_id`、`meta_act_id`、币种、状态。
- `users`、`roles`、`permissions`、`role_permissions`、`user_roles`：RBAC。
- `user_resource_grants`：用户作用域，支持 `fb_account` 和 `ad_account`。
- `operation_tasks`、`operation_task_items`：批量任务。
- `audit_logs`：审计日志。

没有本地表：

- `campaigns`
- `adsets`
- `ads`

这意味着广告系列、广告组、广告的父子关系目前不由本地数据库维护，而是运行时通过 Meta API 查询。

### 权限模型

角色权限位于 `packages/shared/src/permissions.ts`：

- `ad_account:read`
- `campaign:status`
- `campaign:budget`
- `campaign:copy`
- `campaign:delete`
- `iam:manage`
- `fb_account:bind`

角色：

- `PlatformAdmin`：全部权限，作用域绕过。
- `CompanyAdmin`：公司内全部广告和 IAM 权限，作用域绕过。
- `Operator`：读广告账户，操作广告对象。
- `Viewer`：只读广告账户。

作用域：

- `fb_account`：授予一个 FB 个号。
- `ad_account`：授予一个具体广告账户。
- `PlatformAdmin`、`CompanyAdmin` 通过 `scope.bypass` 跳过作用域校验。

### 后端校验链路

请求进入后：

1. `authGuard` 解析 JWT。
2. `loadPrincipal` 读取用户角色、权限、作用域。
3. `requirePermission` 校验 action 权限。
4. `withTenant` / RLS 使用 `company_id` 做租户隔离。
5. 广告操作通过 `checkScope(principal, 'ad_account', adAccountId)` 校验广告账户作用域。
6. `resolveAdAccount(companyId, adAccountId)` 用公司 ID 和广告账户 ID 找到 FB token 和 `metaActId`。
7. Meta API 执行实际查询或操作。

批量任务入队也会校验所有 `target.ad_account_id` 属于当前公司和当前用户作用域。

### 前端选择链路

当前前端路径：

1. `/fb-accounts`：FB 个号列表。
2. `/fb-accounts/:id`：该 FB 个号下广告账户。
3. `/ad-accounts/:id`：广告系列。
4. `/ad-accounts/:id/campaigns/:cid`：广告组。
5. `/ad-accounts/:id/campaigns/:cid/adsets/:asid`：广告。

这是一条单向下钻链路，能完成完整操作路径。但默认入口强依赖 FB 个号列表。

## 主要问题

### P0-1：只授权广告账户的用户可能无法从默认入口进入

`listFbAccounts` 当前对非 bypass 用户只返回直接授予的 `fb_account`。如果用户只被授予某个 `ad_account`，它不会反推出所属 FB 个号并返回。

结果：

- 用户登录后默认进入 `/fb-accounts`。
- 如果该用户只有广告账户授权，没有 FB 个号授权，页面可能显示空列表。
- API `listAdAccounts` 实际支持直接广告账户授权，但前端没有全局广告账户入口来承接。

建议：

- 后端 `listFbAccounts` 需要把“有任意广告账户授权的所属 FB 个号”也纳入可见列表，并且 `adAccountCount` 应显示有效可见广告账户数。
- 或者前端登录后默认进入全局 `/ad-accounts` 资产页，`/fb-accounts` 只作为“授权账号管理”页面。
- 最好两者都做：广告管理入口按广告账户组织，FB 个号入口按授权源管理。

### P0-2：下级对象没有校验归属关系，存在越过广告账户作用域的风险

当前操作会先校验用户是否有 `adAccountId` 的作用域，但广告系列、广告组、广告的 ID 是直接传给 Meta 的。

典型例子：

```text
用户有广告账户 A 的权限。
用户知道广告账户 B 下某 campaign/adset/ad 的 Meta 对象 ID。
如果 A 和 B 来源于同一个 FB token，后端会用 A 对应的 token 调 Meta 对象接口。
当前本地没有校验该 campaign/adset/ad 是否属于 A。
```

风险点：

- `listAdSets(adAccountId, campaignId)` 只校验 `adAccountId`，随后调用 `/{campaignId}/adsets`。
- `listAds(adAccountId, adsetId)` 只校验 `adAccountId`，随后调用 `/{adsetId}/ads`。
- `setStatus`、`setBudget`、`copy`、`delete` 也只校验广告账户作用域，不校验目标对象归属。
- `MetaProvider` 的 `adAccountId` 参数在 status/budget/remove 中基本没有参与归属校验。

建议：

- 所有下级对象操作前增加归属校验。
- 最稳方案：本地缓存 `campaigns`、`adsets`、`ads` 三张资源表，记录 `company_id`、`ad_account_id`、父级 ID、Meta ID、状态、更新时间。列表同步时写入，操作前查本地归属。
- 轻量方案：操作前调用 Meta 读取目标对象字段，比如 `account_id`、`campaign_id`、`adset_id`，与当前 `adAccount.metaActId` 和 URL 父级参数对比，通过后再执行写操作。
- 列表接口也要验证父对象归属，例如进入广告组前先确认 `campaignId` 属于当前 `adAccountId`。

### P0-3：FB 个号授权语义过宽，需要在 UI 和文档中明确

当前 `fb_account` grant 等价于“这个 FB 个号下所有当前和未来广告账户都可见/可操作”。这可能是合理设计，但 UI 上没有明显提示。

建议：

- 作用域弹窗中明确显示：勾选 FB 个号会授权其下所有广告账户，包括后续同步新增账户。
- 如果业务更偏最小权限，默认推荐授权广告账户，不推荐直接授权 FB 个号。
- 可以把 FB 个号授权设计成“整组授权”，并显示展开的有效广告账户清单。

## 其他问题

### P1-1：权限命名和下级资源不匹配

`adset` 和 `ad` 的状态、复制、删除都复用 `campaign:*` 权限。

当前好处是简单，但表达上不准确。后续如果需要“只能操作广告组不能操作广告系列”或“只能复制广告不能改预算”，现有权限无法支持。

建议：

- 如果继续粗粒度授权，建议把权限改名为更通用的 `ad_object:status`、`ad_object:copy`、`ad_object:delete`、`ad_object:budget`。
- 如果需要精细授权，新增 `adset:*`、`ad:*` 权限，并在角色中显式配置。

### P1-2：公司上下文完全隐式

公司由 JWT 和 RLS 隐式决定，前端没有显示当前公司，也没有平台管理员跨公司选择入口。

建议：

- TopBar 显示当前公司名称。
- `PlatformAdmin` 如需跨公司运维，应设计公司切换器或独立平台管理入口。

### P1-3：作用域分配 UI 是平铺列表，不体现层级

当前用户作用域弹窗平铺 FB 个号和广告账户。管理员不容易判断某个广告账户属于哪个 FB 个号，也不容易理解有效权限覆盖范围。

建议：

```text
FB 个号 A
  [ ] 授权整个 FB 个号
  [x] 广告账户 1
  [ ] 广告账户 2

FB 个号 B
  [ ] 授权整个 FB 个号
  [ ] 广告账户 3
```

并显示：

- 直接授权数量。
- 继承自 FB 个号授权的广告账户数量。
- CompanyAdmin / PlatformAdmin 的“绕过作用域”状态。

### P1-4：任务查询只校验公司，不校验任务归属

`/operations/:taskId` 和 SSE 当前校验任务属于同公司，但没有限制只能任务创建人或管理员查看。UUID 不易猜，但这仍是权限边界不完整。

建议：

- 普通用户只能查看自己创建的任务。
- `iam:manage` 或新增 `operation:manage` 权限的用户可查看公司全部任务。

### P2-1：多态授权表没有资源外键约束

`user_resource_grants.resource_id` 是多态 ID，没有数据库外键。服务层 `addGrant` 有校验，但删除 FB 个号或广告账户后可能留下 stale grant。

建议：

- 保留多态表也可以，但需要定期清理 stale grants。
- 或拆分成 `user_fb_account_grants` 和 `user_ad_account_grants`，用真实外键和级联删除。

### P2-2：审计可读性不足

审计记录有 action、resource、detail，但作用域变更、批量任务、广告对象操作缺少资源名称快照，后续排查需要再查外部系统或已变化的数据。

建议：

- 作用域变更审计记录资源名称、Meta ID、父级 FB 个号。
- 广告对象操作审计记录对象名称快照、广告账户名、Meta act ID。

## 推荐下一步优化方案

### 第一步：统一“有效作用域”解析

新增一个后端内部服务，不一定新增外部 API：

```text
resolveEffectiveScope(principal):
  - bypass: 返回公司下全部 FB 个号和广告账户
  - fb grants: 返回这些 FB 个号及其下全部广告账户
  - ad grants: 返回这些广告账户及其所属 FB 个号
```

所有查询和操作都使用这个解析结果，而不是每个 service 各自拼 `principal.scope`。

输出建议：

```ts
{
  fbAccountIds: string[];
  adAccountIds: string[];
  fbVisibleByAdGrant: string[];
  bypass: boolean;
}
```

### 第二步：补全前端广告管理入口

新增全局广告账户页，作为广告管理真正入口：

```text
/ad-accounts
```

展示当前用户可见的全部广告账户，不要求先选择 FB 个号。

同时调整定位：

- `/ad-accounts`：广告管理入口。
- `/fb-accounts`：FB 授权账号管理入口。
- `/fb-accounts/:id`：查看某个授权账号下的广告账户。

登录后默认跳转建议改为 `/ad-accounts`。

### 第三步：修正 `/fb-accounts` 可见规则

即使保留当前默认入口，也要让广告账户授权用户可见其所属 FB 个号。

建议规则：

- 直接授予 `fb_account`：显示该 FB 个号，广告账户数为其下全部可见广告账户。
- 只授予 `ad_account`：显示该广告账户所属 FB 个号，广告账户数为授权广告账户数量。
- 同时授予 FB 和广告账户：去重合并。

### 第四步：增加下级对象归属校验

短期可用 Meta on-demand 校验：

- 操作 campaign 前读取 campaign 的 `account_id`，必须等于当前 `adAccount.metaActId` 去掉 `act_` 后的账号 ID，或与 Meta 返回格式统一后比较。
- 操作 adset 前读取 `campaign_id` 和账户归属。
- 操作 ad 前读取 `adset_id`、`campaign_id` 和账户归属。
- 列表页进入下一层时也要校验父级归属，不只依赖前端路由。

中期建议本地缓存：

```text
campaigns(company_id, ad_account_id, meta_campaign_id, name, status, updated_at)
adsets(company_id, ad_account_id, campaign_id, meta_adset_id, name, status, updated_at)
ads(company_id, ad_account_id, campaign_id, adset_id, meta_ad_id, name, status, updated_at)
```

这样权限、审计、搜索、分页、排序、归属校验都会更稳。

### 第五步：重做作用域分配 UI

把当前平铺列表升级为资源树：

- 按 FB 个号分组广告账户。
- 支持搜索 FB 名称、Meta act ID、广告账户名称。
- 明确“授权整个 FB 个号”和“授权单个广告账户”的差异。
- 显示有效权限预览。
- 对 bypass 角色展示“该角色无需作用域授权”。

### 第六步：补充自动化验证场景

建议至少覆盖这些场景：

- CompanyAdmin 可以看到公司内所有 FB 个号和广告账户。
- Operator 只授予 FB 个号时，可以看到该 FB 下全部广告账户。
- Operator 只授予单个广告账户时，可以从默认入口进入该广告账户。
- Viewer 可以查看但不能修改状态、预算、复制、归档。
- 用户尝试用有权限的广告账户 ID 搭配另一个广告账户的 campaign/adset/ad ID 时，后端拒绝。
- 普通用户不能查看同公司其他用户的任务详情，管理员可以。
- 授权变更后 `perm:{userId}` 缓存立即失效，新权限马上生效。

## 优先级清单

P0：

- 修复广告账户单独授权用户无法从默认链路进入的问题。
- 增加 campaign/adset/ad 归属校验，避免只校验广告账户 ID。
- 明确 FB 个号授权会覆盖其下全部广告账户的语义。

P1：

- 新增全局广告账户入口，弱化 `/fb-accounts` 作为广告管理唯一入口。
- 重做作用域分配 UI 为树形结构。
- 调整权限命名或拆分 adset/ad 权限。
- 任务详情按创建人或管理权限做访问控制。

P2：

- 建立下级广告对象本地缓存表。
- 清理或拆分多态 grants，增强数据库级约束。
- 增强审计日志中的资源名称快照和父级上下文。

## 结论

当前系统已经完成 MVP 级别的广告管理链路和权限框架，但还不能算“完整的选择链路和权限分配机制”。完整性缺口主要不在页面数量，而在两个地方：

1. 前端入口没有覆盖“只授予广告账户”的常见权限场景。
2. 后端没有对 campaign/adset/ad 与广告账户的归属关系做强校验。

下一步应优先把“有效作用域解析 + 全局广告账户入口 + 下级对象归属校验”作为一个小版本完成。完成后，这条链路才适合作为生产级广告管理入口继续扩展 UI 和数据分析能力。
