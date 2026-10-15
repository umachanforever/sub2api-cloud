# sub2api-supabase

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
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端 service-role JWT |
| `SUPABASE_DB_PASSWORD` | CLI 使用的项目数据库密码 |
| `SUPABASE_ACCESS_TOKEN` | 初始化数据库权限所需的 Management API 令牌 |
| `SUB2API_LOCAL_ADMIN_EMAIL` | 管理员邮箱 |
| `SUB2API_ADMIN_USER_IDS` | 已有管理员 Auth UUID；留空可自动创建 |

保留 `SUB2API_DATA_MODEL=native`。管理员密码和凭据加密密钥如未填写，会自动生成并保存到 `.env.local`；本地管理服务的数据库密码与服务密钥保存在 `.local/`。这些文件不进入 Git，也不会发送到浏览器。

控制台使用 Supabase Auth 登录。供应商凭据由 Supabase Vault 加密保存，API 鉴权与用量记录直接使用原版 Go 业务表。个人云端调用不受商业计费逻辑限制，也不扣减用户余额。

使用 Gemini CLI 或 Antigravity OAuth 授权前，请在 `.env.local` 配置对应的 `GEMINI_CLI_OAUTH_CLIENT_ID` / `GEMINI_CLI_OAUTH_CLIENT_SECRET` 或 `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET`。Google OAuth 客户端信息由部署者提供。Gemini 支持 AI Studio 和 Code Assist，可通过 `GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET` 配置自定义 AI Studio 客户端。一键部署会同步云端刷新所需配置，Code Assist 的项目信息保存在加密账号凭据中。

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
https://<project-ref>.supabase.co/functions/v1/subscription-api
```

在原版控制台创建供应商账号，绑定对应平台的分组，再创建 API Key。从 `/v1/models` 选择可用模型；也可使用账号的模型映射，保留现有应用使用的模型名。

```sh
export AI_BASE_URL='https://<project-ref>.supabase.co/functions/v1/subscription-api'
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

仅需查看用量时，可选用 `npm run usage:access` 生成 `sk-usage-` 只读 Key，配置保存在 `.local/agent-usage.json`。它无法调用 AI 或访问管理接口，并继承关联调用 Key 的分组、有效期、启用状态和 IP 限制。在 `s2a_private.usage_tokens` 设置对应记录的 `revoked_at` 可撤销授权；停用或删除关联调用 Key 也会阻止访问。

控制台的仪表板、用量、账号详情、设置等成功的数据查询统一在当前标签页内存缓存 60 秒。修改数据或切换登录身份会清空缓存；认证、OAuth 流程、导出和流式接口直接请求，携带 `Cache-Control: no-cache` 可强制重新读取。

## 目录

| 目录 | 内容 |
| --- | --- |
| `backend/` | 原版 Go 管理后端 |
| `frontend/` | 原版 Vue 控制台与云端身份适配 |
| `supabase/functions/subscription-api/` | 云端 AI 请求处理与供应商协议 |
| `supabase/migrations/` | Supabase 项目基础结构 |
| `deploy/` | 管理数据权限、Vault 凭据存储与云端 RPC |
| `scripts/` | 初始化、部署及本地控制台服务 |
| `tests/` | 网关与管理功能验证 |
| `docs/` | 部署、架构及上游资料 |

详细说明见 [Deployment](docs/DEPLOYMENT.md)、[Architecture](docs/ARCHITECTURE.md) 和 [Contributing](CONTRIBUTING.md)。

## 开源许可

基于 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)，使用 LGPL-3.0-or-later 许可证。原版许可证和作者声明保存在 [LICENSE](LICENSE)、[COPYING](COPYING) 与 [NOTICE](NOTICE)。
