# 线上 Meta 测试配置说明

日期：2026-05-21

本文档用于准备线上版本测试，目标是避免前端展示 mock 数据，并确认广告相关页面读取真实 Meta 数据。

## 结论

当前项目的 mock 开关是环境变量 `META_FAKE=1`。线上测试时 API 和 Worker 都不能配置 `META_FAKE`，也不要配置 `FAKE_DELAY_MS`、`FAKE_FAIL_RATE`、`FAKE_RATELIMIT_RATE`、`MOCK_AD_ACCOUNT_COUNT`、`MOCK_COMPANY_NAME`。

已清理本地数据库中明确的 mock 业务数据：

- `fb_accounts` 中 `mock_*` 账户：0
- `ad_accounts` 中 `act_mock_*` 账户：0
- `campaigns / adsets / ads` 中 `mock_*` 对象：0
- mock 相关审计和任务项：0

代码层面没有删除 fake/mock 开发能力，但只要线上环境不设置 `META_FAKE=1`，它不会参与真实链路。

## TOKEN_ENC_KEY 是什么

`TOKEN_ENC_KEY` 是用于加密 Facebook 用户 access token 的服务端密钥。

项目中 `apps/api/src/lib/crypto.ts` 使用 `AES-256-GCM` 加密 token，密文落库在 `fb_accounts.access_token_enc`。这个密钥必须是：

- 32 字节原始随机值
- 使用 base64 编码后写入环境变量
- API 和 Worker 使用同一个值
- 生产环境必填，否则服务启动会拒绝

生成方式：

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

或：

```bash
openssl rand -base64 32
```

注意：

- 不能填写普通字符串，例如 `replace-me-with-32-bytes-base64`。
- 上线后不要随意更换。更换后，数据库里已经加密的旧 token 无法解密，需要用户重新绑定广告账户组。
- 不要提交到 Git，不要发到群里，只放在部署平台的 Secret/Env 中。

## 必填环境变量

线上测试建议使用以下配置。具体值按部署环境替换。

```env
NODE_ENV=production
API_PORT=3001
WEB_PORT=5173

DATABASE_URL=postgres://ads_app:<password>@<host>:5432/ads
DATABASE_ADMIN_URL=postgres://ads:<password>@<host>:5432/ads
REDIS_URL=redis://<host>:6379
RABBITMQ_URL=amqp://<user>:<password>@<host>:5672

JWT_SECRET=<强随机字符串>
JWT_EXPIRES_IN=12h
TOKEN_ENC_KEY=<32字节随机值的base64>

CRM_BASE_URL=https://adtool-api.gimc-hk.com
CRM_CID=<第三方提供>
CRM_ACCESS_TOKEN=<第三方提供>

META_API_VERSION=v21.0
META_GRAPH_BASE=https://graph.facebook.com
FB_OAUTH_REDIRECT_URI=https://<线上域名>/oauth/fb/callback

AD_OBJECT_CACHE_TTL_MS=0
AD_OBJECT_SYNC_ENABLED=0

NOTIFIER_DRIVER=console
# NOTIFIER_DRIVER=feishu
# FEISHU_WEBHOOK_URL=<飞书机器人 webhook>
```

线上测试阶段建议 `AD_OBJECT_CACHE_TTL_MS=0`，这样广告系列、广告组、广告列表不会命中本地短缓存，会重新查询 Meta 后再写入本地快照。等链路验证完成后，再按性能需要恢复为 `30000` 或更高。

## 第三方需要提供什么

向 CRM/第三方授权服务提供方确认：

- `CRM_BASE_URL`
- `CRM_CID`
- `CRM_ACCESS_TOKEN`
- 授权链接接口是否启用：`GET /api/custom/security/accounts/meta/oauth/authorize-url`
- code 换 token 接口是否启用：`POST /api/custom/security/accounts/meta/oauth/access-token`
- 请求头是否仍为 `cid` 和 `accessToken`
- `FB_OAUTH_REDIRECT_URI` 是否已在第三方和 Meta App 后台白名单中配置
- access token 有效期、续期规则、失效错误码
- CRM 接口限流策略、错误响应格式、测试环境和生产环境地址

向 Meta Business/广告账户所属方确认：

- 用于测试登录授权的 Facebook 用户账号
- 该用户可访问的 Business Manager
- 可测试的广告账户清单，包含 `act_id`、账户名称、币种、时区、国家
- 账号是否允许执行写操作：启动、暂停、改预算、复制、归档
- 测试广告系列、广告组、广告 ID，建议使用低风险或测试专用对象
- 允许的预算改动范围和最小预算限制
- 是否允许真实投放，建议先约定只操作暂停态或测试广告对象
- Meta App 已申请并获批的权限，至少需要覆盖广告读取、洞察读取和广告管理写操作

向部署/运维方确认：

- 线上 HTTPS 域名和 TLS 证书
- 前端 `/api` 代理或网关转发到 API 的规则
- 服务是否能访问 `https://graph.facebook.com`
- 服务是否能访问第三方 `CRM_BASE_URL`
- PostgreSQL、Redis、RabbitMQ 的持久化和备份策略
- Secret 管理方式，尤其是 `TOKEN_ENC_KEY`、`JWT_SECRET`、`CRM_ACCESS_TOKEN`

## 页面数据来源检查

| 页面 | 展示数据 | 线上真实来源 | 备注 |
|---|---|---|---|
| `/` 首页 | 当前公司、账户组数、广告账户数、任务概览 | 本地 DB | 公司和任务是系统数据；账户组和广告账户来自真实绑定后的 DB 快照 |
| `/fb-accounts` 广告账户组 | 绑定账号 ID、名称、Token 到期、状态 | OAuth 绑定时由 CRM/Meta 返回后落库 | 不是 mock；刷新按钮只重新读本地 DB |
| `/fb-accounts/:id` 组内广告账户 | act_id、名称、币种、时区、投放国家、状态 | OAuth 绑定时调用 Meta `/me/adaccounts` 后落库 | 新增广告账户需要重新绑定或后续增加手动同步 |
| `/ad-accounts` 广告账户 | act_id、币种、时区、投放国家、状态 | 同上 | 当前字段已包含 `currency`、`timezone_name`、`business_country_code` |
| `/ad-accounts/:id` 广告系列 | 广告系列列表、状态、预算、洞察 | Meta Graph API | `AD_OBJECT_CACHE_TTL_MS=0` 时每次列表查询都会重新查 Meta |
| `/campaigns/:cid` 广告组 | 广告组列表、状态、预算、洞察 | Meta Graph API | 查询后会写入本地快照 |
| `/adsets/:asid` 广告 | 广告列表、状态、素材 ID、洞察 | Meta Graph API | 查询后会写入本地快照 |
| `/admin/operations` | 熔断、Token 健康、同步任务、任务历史 | 本地 DB/Redis/RabbitMQ | 管理运行态数据，不来自 Meta |
| `/admin/audit` | 审计日志 | 本地 DB | 记录系统内操作 |

当前重要边界：

- 广告账户组和广告账户列表不是每次页面刷新都实时查 Meta，而是绑定时同步到本地 DB。
- 广告系列、广告组、广告和洞察可以通过 `AD_OBJECT_CACHE_TTL_MS=0` 保证测试期每次查询走 Meta。
- 批量启动、暂停、改预算、复制、归档在非 fake 模式下会入队给 Worker，由 Worker 调 Meta API。

## 上线测试步骤

1. 部署前确认 API 和 Worker 环境变量中没有 `META_FAKE`。
2. 执行数据库迁移：`bun --cwd packages/db migrate`。
3. 只执行基础种子：`bun --cwd packages/db seed`。不要执行 `seed-mock-fb.ts`。
4. 设置真实 `TOKEN_ENC_KEY`、`JWT_SECRET`、CRM 凭证和线上 OAuth 回调地址。
5. 启动 API、Worker、Web。
6. 登录后台，新增或确认测试公司和测试用户。
7. 在广告账户组页面点击绑定，走第三方授权链接并完成 Meta 授权。
8. 回到系统后检查广告账户列表，确认没有 `act_mock_*`，并核对币种、时区、投放国家。
9. 进入广告账户，检查广告系列、广告组、广告列表和洞察是否正常加载。
10. 选一个测试对象做小范围写操作：暂停/启动、改预算、复制或归档。
11. 在 Meta Ads Manager 侧复核结果，同时检查 `/admin/operations` 和 `/admin/audit`。

## 推荐验收标准

- 页面上不出现 `mock_*`、`act_mock_*`、`Mock Ad Account`、`Mock Campaign`。
- 绑定广告账户组后，广告账户能展示真实 `act_id`、币种、时区、投放国家。
- 广告系列、广告组、广告列表能从 Meta 拉到真实对象。
- 洞察字段能返回真实 `spend`、`impressions`、`clicks`、`orders` 等数据。
- 单个操作和批量操作都能在任务中心看到进度，并能在 Meta 侧验证实际变更。
- Token 失效、Meta 限流、权限不足时，前端能看到明确错误，后台能看到熔断或任务失败记录。

## 可选清理 SQL

如线上测试库曾经导入过 mock 数据，可按以下 SQL 清理。执行前先确认环境和备份。

```sql
BEGIN;
WITH mock_ad_accounts AS (
  SELECT id FROM ad_accounts WHERE meta_act_id LIKE 'act_mock_%' OR name ILIKE 'Mock%'
), mock_fb_accounts AS (
  SELECT id FROM fb_accounts WHERE fb_user_id LIKE 'mock_%' OR name ILIKE 'Mock%'
), mock_tasks AS (
  SELECT DISTINCT task_id AS id
  FROM operation_task_items
  WHERE target_id LIKE 'mock_%' OR target_id LIKE 'fake_%'
     OR ad_account_id IN (SELECT id FROM mock_ad_accounts)
), deleted_grants AS (
  DELETE FROM user_resource_grants
  WHERE (resource_type = 'fb_account' AND resource_id IN (SELECT id FROM mock_fb_accounts))
     OR (resource_type = 'ad_account' AND resource_id IN (SELECT id FROM mock_ad_accounts))
  RETURNING 1
), deleted_tasks AS (
  DELETE FROM operation_tasks WHERE id IN (SELECT id FROM mock_tasks)
  RETURNING 1
), deleted_audit AS (
  DELETE FROM audit_logs
  WHERE resource ILIKE '%mock%'
     OR detail::text ILIKE '%mock%'
     OR detail::text ILIKE '%fake%'
  RETURNING 1
), deleted_fb AS (
  DELETE FROM fb_accounts WHERE id IN (SELECT id FROM mock_fb_accounts)
  RETURNING 1
)
SELECT
  (SELECT count(*) FROM deleted_grants) AS deleted_grants,
  (SELECT count(*) FROM deleted_tasks) AS deleted_tasks,
  (SELECT count(*) FROM deleted_audit) AS deleted_audit,
  (SELECT count(*) FROM deleted_fb) AS deleted_fb_accounts;
COMMIT;
```

## 参考链接

- Meta Marketing API 文档：https://developers.facebook.com/docs/marketing-apis/
- Meta Graph API Explorer：https://developers.facebook.com/tools/explorer/
- Meta 登录文档：https://developers.facebook.com/docs/facebook-login/
