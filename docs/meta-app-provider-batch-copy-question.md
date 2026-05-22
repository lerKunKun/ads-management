# 向 Meta App 第三方提供方咨询批量复制失败问题

更新时间：2026-05-22

本文档用于向提供 Meta App / OAuth 授权能力的第三方说明当前批量复制失败现象，并请求对方确认 App 能力、接口支持范围和正确调用方式。

## 背景

我们系统通过第三方提供的 Meta App / OAuth token 对接 Meta Marketing API。

当前目标是支持批量复制广告对象，包括：

- 广告系列：`campaign`
- 广告组：`adset`
- 广告：`ad`

当前线上配置：

```text
META_API_VERSION=v21.0
META_GRAPH_BASE=https://graph.facebook.com
```

当前测试对象：

```text
ad account: act_1185412366848999
source campaign id: 120249643202090210
task_id: b1578bfc-2b59-4e22-b722-c342b71e4828
action: campaign:copy
copy count: 5
```

## 已确认 token 权限

我们已通过 `/me/permissions` 确认当前 token 具备以下权限：

```text
ads_management: granted
ads_read: granted
business_management: granted
pages_show_list: granted
pages_read_engagement: granted
public_profile: granted
```

因此目前初步判断不是用户 token scope 缺失。

## 尝试方式一：async_batch_requests

我们先尝试使用 Meta async request set。

请求：

```http
POST https://graph.facebook.com/v21.0/act_1185412366848999/async_batch_requests
```

表单示例：

```text
name=copy_batch_xxx
adbatch=[
  {
    "relative_url": "120249643202090210/copies",
    "body": "deep_copy=true&start_time=2026-05-23T01%3A00%3A00.000Z&status_option=PAUSED&rename_options=...",
    "name": "copy_xxx"
  }
]
```

实际返回错误：

```text
请求集中提供的 relative_url 是无效的。
```

对应 worker 日志：

```text
[meta-async-copy] submit account=act_1185412366848999 requests=5 ...
[meta-copy-batch] async request set rejected relative_url; falling back to Graph batch task=b1578bfc...
```

## 尝试方式二：Graph Batch fallback

async request set 返回 `relative_url` 无效后，我们 fallback 到 Graph Batch。

请求：

```http
POST https://graph.facebook.com
```

表单示例：

```text
include_headers=false
batch=[
  {
    "method": "POST",
    "relative_url": "v21.0/120249643202090210/copies",
    "body": "deep_copy=true&start_time=2026-05-23T01%3A00%3A00.000Z&status_option=PAUSED&rename_options=...",
    "name": "copy_xxx"
  }
]
```

为了避免常规复制超过 3 个对象的限制，我们已经按每批最多 3 条拆分：

```text
5 个复制请求 -> 3 + 2 两批 Graph Batch
```

实际返回错误：

```text
(#3) Application does not have the capability to make this API call.
```

该错误出现在每个 batch 子请求中。

对应 worker 日志：

```text
[meta-copy-batch] submit requests=3 names=...
[meta-copy-batch] submit requests=2 names=...
```

数据库 item 错误：

```text
(#3) Application does not have the capability to make this API call.
```

## 当前线上失败样例

任务：

```text
task_id: b1578bfc-2b59-4e22-b722-c342b71e4828
action: campaign:copy
total: 5
success: 0
failed: 5
source campaign: 120249643202090210
ad account: act_1185412366848999
```

5 个 item 均失败，错误一致：

```text
(#3) Application does not have the capability to make this API call.
```

## 希望第三方确认的问题

请帮忙确认以下问题：

1. 你们提供的 Meta App 是否支持 Marketing API v21.0 的批量复制广告对象？

2. 该 App 是否允许通过 Graph Batch 调用以下 copy edge？

```text
/{campaign_id}/copies
/{adset_id}/copies
/{ad_id}/copies
```

3. 如果 Graph Batch 不支持复制广告对象，v21.0 下官方推荐的批量复制接口是哪一个？

4. `async_batch_requests` 是否支持 `/{campaign_id}/copies`、`/{adset_id}/copies`、`/{ad_id}/copies` 作为 `relative_url`？

5. 如果支持，正确的 `adbatch` item 格式是什么？

当前我们使用的是：

```json
{
  "relative_url": "120249643202090210/copies",
  "body": "deep_copy=true&start_time=...&status_option=PAUSED&rename_options=...",
  "name": "copy_xxx"
}
```

6. `(#3) Application does not have the capability to make this API call.` 是否表示 Meta App 缺少某项 App Review、Advanced Access 或 Business capability？

7. 是否需要你们在 Meta App 后台开通额外能力，或将我们的 Business / 广告账户加入允许名单？

8. 当前 token 已有 `ads_management`、`ads_read`、`business_management`，是否还需要额外权限或系统用户授权？

9. 如果批量复制必须使用异步接口，请提供 v21.0 的完整请求示例，包括：

```text
endpoint
method
headers/form/json
relative_url 格式
body 格式
返回字段
轮询方式
```

## 我们可提供的排查信息

### Worker 日志命令

```bash
sudo journalctl -u ads-worker --since '2026-05-22 09:30:00 UTC' --no-pager \
  | grep -E 'b1578bfc|meta-async-copy|meta-copy-batch|relative_url'
```

### 任务明细 SQL

```sql
select id,type,total,status,success,failed,payload,created_at
from operation_tasks
where id::text like 'b1578bfc%';

select id,target_type,target_id,action,status,attempts,error,created_at
from operation_task_items
where task_id::text like 'b1578bfc%'
order by created_at;
```

### token 权限检查

```http
GET https://graph.facebook.com/v21.0/me/permissions
```

当前返回包含：

```text
ads_management: granted
ads_read: granted
business_management: granted
```

## 当前我们的初步判断

当前系统内部链路已经执行到 Meta API 调用阶段：

```text
前端提交 -> API 创建 task/items -> RabbitMQ 入队 -> Worker 消费 -> Meta async request set -> Graph Batch fallback
```

失败点在 Meta 返回的接口能力限制：

```text
(#3) Application does not have the capability to make this API call.
```

请第三方重点确认这是 App 能力限制、接口调用方式不支持，还是需要使用另外的 v21.0 官方批量复制接口。
