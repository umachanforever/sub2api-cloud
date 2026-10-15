# sub2api-cloud

[English](README.md) | [简体中文](README.zh-CN.md)

面向开发者的 AI API 网关：核心请求运行在 Supabase 云端，管理端沿用原版 Sub2API 的 Go 后端和 Vue 控制台。支持接入 OpenAI、Anthropic、Gemini OAuth 账号与受支持供应商的 API Key，管理账号池、调用密钥与 Token 用量。

Supabase 负责 API 鉴权、凭据刷新、供应商请求、流式响应和用量记录。本地管理端直接读写同一套云端数据，**关闭本地服务后，云端 AI API 仍可独立使用**。小程序自身的登录认证保持独立。

使用 Supabase 的主要目的是利用免费额度和平台提供的 HTTPS 地址，减少额外购买主机、域名及运行本地代理软件的费用。在 Supabase 地址可直连、部署区域可访问模型供应商的情况下，中国大陆客户端可免翻墙调用。实际可用性及免费额度取决于网络和 [Supabase 当前套餐](https://supabase.com/pricing)。

## 云端部署

准备 Node.js 24+、带 Compose 2.24+ 的 Docker 和 Supabase CLI。

```sh
cp .env.example .env.local
chmod 600 .env.local
# Fill the Supabase project settings in .env.local.
npm run up -- --cloud
```

打开 http://127.0.0.1:3000 。启动命令会创建独立的管理数据库角色，应用原版 Go 业务表与云端网关函数，关联管理员的 Supabase 身份，部署 Edge Function，并启动本地管理服务。

| 配置项 | 用途 |
| --- | --- |
| `SUPABASE_URL` | Supabase 项目地址 |
| `SUPABASE_PUBLISHABLE_KEY` | 公开 publishable 或 anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | 可留空；通过 access token 自动读取已有的服务端密钥 |
| `SUPABASE_DB_PASSWORD` | CLI 使用的项目数据库密码 |
| `SUPABASE_ACCESS_TOKEN` | 初始化数据库权限所需的 Management API 令牌 |
| `SUB2API_LOCAL_ADMIN_EMAIL` | 管理员邮箱 |
| `SUB2API_ADMIN_USER_IDS` | 已有管理员 Auth UUID；留空可自动创建 |

Supabase 会生成 service-role key，并自动注入云端 Edge Function。本地部署时如留空，会通过 Management API 读取项目已有密钥，无需手动复制，也不会重新生成或轮换密钥。

保留 `SUB2API_DATA_MODEL=native`。管理员密码和凭据加密密钥如未填写，会自动生成并保存到 `.env.local`；本地管理服务的数据库密码与服务密钥保存在 `.local/`。这些文件不进入 Git，也不会发送到浏览器。

控制台使用 Supabase Auth 登录。供应商凭据由 Supabase Vault 加密保存，API 鉴权与用量记录直接使用原版 Go 业务表。个人云端调用不受商业计费逻辑限制，也不扣减用户余额。

使用 Gemini CLI 或 Antigravity OAuth 授权前，请在 `.env.local` 配置对应的 `GEMINI_CLI_OAUTH_CLIENT_ID` / `GEMINI_CLI_OAUTH_CLIENT_SECRET` 或 `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET`。Google OAuth 客户端信息由部署者提供。Gemini 支持 AI Studio 和 Code Assist，可通过 `GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET` 配置自定义 AI Studio 客户端。一键部署会同步云端刷新所需配置，Code Assist 的项目信息保存在加密账号凭据中。

Grok API Key 与 OAuth 账号支持原生 Chat Completions、Responses 和模型列表，可返回普通 JSON 或 SSE 流式响应。OAuth 请求使用官方 Grok CLI 客户端标识，并在云端刷新凭据；账号凭据可选择官方 xAI 区域地址。

Antigravity OAuth 账号提供供应商模型目录，以及 Gemini 原生 `generateContent` / `streamGenerateContent` 和 Claude Messages 接口，支持普通 JSON 与 SSE 流式响应。Claude 客户端可使用 `/antigravity` 基础路径和同一分组的调用密钥。配置 `ANTIGRAVITY_OAUTH_CLIENT_ID` 和 `ANTIGRAVITY_OAUTH_CLIENT_SECRET` 后，由云端刷新凭据。网关保留加密的项目 ID，在保留调用方指令的同时注入上游身份提示，解包内部响应，并在供应商固定的 daily 和 production 地址间执行故障切换。

## 本地 Supabase

```sh
npm run up -- --local
```

本地模式会启动独立的 Supabase 容器组，创建对应业务表和管理员，不需要云端账户。管理员信息保存在 `.local/admin.json`，本地 Edge Function 需要保持启动终端运行。本地与云端的数据和账号相互独立。

```sh
npm run down -- --local
npm run up -- --cloud
```

切换到云端后，本地 Supabase 可以保持关闭，以节省资源。需要管理时运行本地控制台、Go 管理服务与 Redis；即使这些本地容器全部关闭，云端 AI API 也仍可使用。

## API 调用

控制台会显示项目的云端网关地址：

```text
https://<project-ref>.supabase.co/functions/v1/sub2api
```

网关同时支持原版根路径别名 `/models`、`/models/:model`、`/chat/completions`、`/responses`、`/embeddings` 和 `/images/generations`，使用相同的云函数入口，并与 `/v1` 路径共用鉴权、模型策略和用量记录。

Codex 客户端标识会自动跟随官方稳定版。Supabase Cron 每 6 小时检查一次，本地服务关闭后仍会执行；请求处理也会刷新过期版本。界面中的自动同步开关同时控制两条更新路径，手动指定的客户端版本优先生效。实际模型可用性还取决于上游账号。

在原版控制台创建供应商账号，绑定对应平台的分组，再创建 API Key。从 `/v1/models` 选择可用模型；也可使用账号的模型映射，保留现有应用使用的模型名。

```sh
export AI_BASE_URL='https://<project-ref>.supabase.co/functions/v1/sub2api'
export AI_API_KEY='your-issued-api-key'
curl "$AI_BASE_URL/v1/models" -H "Authorization: Bearer $AI_API_KEY"
```

网关提供 Responses、Chat Completions、Anthropic Messages 与 Gemini API 格式，按照供应商和凭据类型支持普通响应及流式响应。

### 订阅用量

`GET /v1/usage` 返回当前 Key 所属分组中 OpenAI OAuth 账号的 5 小时、7 日订阅额度，使用 `Authorization: Bearer <api-key>` 鉴权。每个账号包含 `five_hour` 和 `seven_day`，提供已用比例 `used_percent`、剩余比例 `remaining_percent`、窗口长度 `window_seconds` 和重置时间 `reset_at`。这些是账号共享的订阅额度，不是当前 Key 单独消耗的 Token 总数。不支持的平台分组返回空账号列表；缺失的额度信息为 `null`。

快照最多复用 60 秒；添加 `?refresh=true` 直接查询上游，添加 `?account_id=<id>` 可指定账号。通过 `fetched_at`、`age_seconds`、`cached` 和 `stale` 判断数据新鲜程度；上游失败时返回账号级 `error`，并将保留的快照标为过期。

```sh
curl "$AI_BASE_URL/v1/usage?refresh=true" -H "Authorization: Bearer $AI_API_KEY"
```

需要完整 API 能力的 Agent，可在本地控制台运行时执行 `npm run agent:access`；在 `.env.local` 配置管理员登录信息和已有的 `GPT_SUBSCRIPTION_GATEWAY_KEY`。命令会在同一供应商分组创建标准 `sk-` 调用 Key，将 `base_url`、`api_key`、模型和用量地址保存到私有文件 `.local/agent-access.json`。这个 Key 支持 AI 请求、模型列表和用量查询，可在控制台管理。如果 `.local/agent-usage.json` 中有旧的只读 Key，会将其撤销并更新该配置。

执行 `npm run verify:cloud`，可使用 `.local/agent-access.json` 验收云端网关的鉴权、模型列表、普通与流式 Responses 和 Chat Completions、返回模型一致性以及用量接口，无需启动本地管理服务。验收会发送四次简短的 AI 请求。

执行 `npm run verify:independence`，可暂时停止本项目的本地控制台、管理服务和 Redis，再运行云端验收，最后恢复原本运行的容器。命令会先确认容器归属，验收失败或中断时也会恢复服务，其他 Docker 项目继续运行。

仅需查看用量时，可选用 `npm run usage:access` 生成 `sk-usage-` 只读 Key，配置保存在 `.local/agent-usage.json`。它无法调用 AI 或访问管理接口，并继承关联调用 Key 的分组、有效期、启用状态和 IP 限制。在 `s2a_private.usage_tokens` 设置对应记录的 `revoked_at` 可撤销授权；停用或删除关联调用 Key 也会阻止访问。

常用数据页面在切换菜单时也会保留已加载的界面状态 60 秒。不同筛选条件分别保存；修改数据后其他页面快照失效，退出登录会清空页面缓存。实时监控和支付流程保持原有生命周期。

如需直接在浏览器中查询，在生成 Agent 调用配置后运行 `npm run usage:link`。只读链接保存在 `.local/usage-link.json` 的 `browser_url`。该链接按名称分别显示关联 Key 所属分组内每个已启用订阅账户的 5 小时和 7 日用量，不显示停用账户。

控制台的仪表板、用量、账号详情、设置等成功的数据查询统一在当前标签页内存缓存 60 秒。修改数据或切换登录身份会清空缓存；认证、OAuth 流程、导出和流式接口直接请求，携带 `Cache-Control: no-cache` 可强制重新读取。

## 目录

| 目录 | 内容 |
| --- | --- |
| `backend/` | 原版 Go 管理后端 |
| `frontend/` | 原版 Vue 控制台与云端身份适配 |
| `supabase/functions/sub2api/` | 云端 AI 请求处理与供应商协议 |
| `supabase/migrations/` | Supabase 项目基础结构 |
| `deploy/` | 管理数据权限、Vault 凭据存储与云端 RPC |
| `scripts/` | 初始化、部署及本地控制台服务 |
| `tests/` | 网关与管理功能验证 |
| `docs/` | 部署、架构及上游资料 |

详细说明见 [Deployment](docs/DEPLOYMENT.md)、[Architecture](docs/ARCHITECTURE.md) 和 [Contributing](CONTRIBUTING.md)。

## 开源许可

基于 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)，使用 LGPL-3.0-or-later 许可证。原版许可证和作者声明保存在 [LICENSE](LICENSE)、[COPYING](COPYING) 与 [NOTICE](NOTICE)。

Sol 系列的 GPT 版本名默认选择 Sol：`gpt-6` → `gpt-6-sol`、`gpt-6.1` → `gpt-6.1-sol`，后续 GPT 版本沿用此规则。明确指定的变体及账户模型映射优先。别名对应的目标模型仍需上游实际支持。

OpenAI API Key 账户支持 `/v1/embeddings`（也支持 `/embeddings`），包括文本或 Token 批量输入、浮点或 base64 向量、模型映射和输入 Token 用量记录。该接口使用文本请求体上限，不支持流式响应。ChatGPT OAuth 账户不提供 embeddings API Key。

Chat Completions 支持内联文件数据及上游文件 ID。Messages 转 OpenAI 桥接支持 base64 PDF、文档 URL、纯文本文档，以及工具返回的文件。文档引用标注需要上游原生支持；通过 OpenAI 桥接启用引用标注会明确报错。

OpenAI 账户支持 `POST /v1/responses/input_tokens`，以及 `/responses/input_tokens`、`/backend-api/codex/responses/input_tokens` 别名。网关优先使用上游预检接口；接口不支持时，在 Edge Function 内按原版 tiktoken 方式估算。预检不会新增生成用量记录，也不扣余额；回退结果为估算值，多模态输入同样如此。

Anthropic 格式客户端可通过 `POST /v1/messages/count_tokens` 或 `/messages/count_tokens` 预估输入 Token，支持 Bearer 和 `x-api-key` 鉴权。OpenAI 账号通过 Responses 预估接口转换，Grok 账号使用本地估算，Anthropic 账号使用原生计数接口。这些请求不会写入生成用量。

云端网关和本地控制台代理的 AI 请求体默认上限均为 256 MiB，与原版 Sub2API 一致；embeddings、搜索和 systemone 专用文本路由上限为 32 MiB。部署前可通过 `SERVER_MAX_REQUEST_BODY_SIZE`、`GATEWAY_MAX_BODY_SIZE` 和 `GATEWAY_TEXT_MAX_BODY_SIZE` 按字节配置。服务器上限设为 `0` 仅关闭全局限制，网关限制仍然生效。Supabase 运行内存及上游服务限制可能使大型附件的实际可用上限更低。
