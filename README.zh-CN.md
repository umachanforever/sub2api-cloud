# sub2api-supabase

**Supabase 部署版**

[English](README.md) | [简体中文](README.zh-CN.md)

面向开发者的 AI API 网关：将 OpenAI、Anthropic、Gemini 及其他受支持的供应商账号接入统一 API，提供账号池、密钥管理和用量查看。网关部署在能够访问上游供应商、且中国大陆可直连的环境后，调用方可免翻墙使用；实际可用性取决于部署位置和入口网络。


主要面向个人自用：鉴权、供应商请求、凭据刷新和用量采集在 Supabase 云端完成，本地 Go 后端与 Vue 控制台负责管理配置、查看云端记录，AI 调用不依赖本地服务持续运行。商业计费不属于核心请求链路。

## 为什么使用 Supabase

主要目的是让开发者方便地把核心后端免费部署到云端：在 Supabase 免费额度内使用 PostgreSQL、Auth 和 Edge Functions，并直接使用平台提供的 HTTPS 地址，减少单独租用主机、购买域名和运行代理软件的开销。前端控制台可在本地运行，模型请求直接调用云端 API，无需让本地 Supabase 常驻。

免费部署受 Supabase 当前套餐的数据库、请求、流量和函数运行限制约束，不保证所有负载都免费。模型 API 或订阅账号的费用另计；如果需要更高额度、自定义域名或额外网络代理，仍可能产生费用。大陆免翻墙调用取决于云端入口是否可直连及服务端是否能访问上游，Supabase 本身不保证这些网络条件。

基于 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)，保留原 Vue 控制台，并将固定版本的原 Go 后端保存在 `backend/`。架构采用本地 Go 管理服务和 Supabase TypeScript AI 网关，数据共用规则见[架构说明](docs/ARCHITECTURE.md)。现有启动命令运行 Edge 后端和 Vue 控制台。

原版 Go 管理后端提供账号、密钥、分组、用量、公告与审计等功能，Supabase Auth 管理身份会话，TypeScript Edge 网关负责供应商请求、流式响应和云端任务。许可证为 LGPL-3.0-or-later，来源见 [NOTICE](NOTICE)。

本项目适合独立发布为 GitHub 开源仓库。Edge 网关使用运行时导入映射；Vue 控制台使用现有依赖锁文件。发布工具链需要 Node.js 24+、Go（版本要求见 `backend/go.mod`）、Deno 2、Supabase CLI 和 Docker。

## 一键启动

选择套餐前请查看当前的 [Supabase 定价](https://supabase.com/pricing)与 [Edge Functions 限制](https://supabase.com/docs/guides/functions/limits)。

准备 Node.js 24+、Go（版本要求见 `backend/go.mod`）、Supabase CLI 和 Docker。从仓库根目录执行：

本地模式会运行 Supabase 容器组并构建 Vue 控制台。建议为 Docker 分配至少 6 GB 内存，以保证本地部署稳定运行。

```sh
cp .env.example .env.local
# Cloud: configure URL, public/service keys, database password and CLI credentials
npm run up -- --cloud

# Local: no cloud account required; the first run downloads Supabase images
npm run up -- --local
```

也可在 `.env.local` 中设置 `SUPABASE_MODE=cloud` 或 `local`，然后执行 `npm run up`。云端入口会应用迁移、发布函数并启动 Docker 控制台；本地入口会启动本地 Supabase、应用迁移、创建初始管理员并启动控制台与 Edge Functions。两种模式均使用 http://127.0.0.1:3000 。首次启动自动生成缺失的凭据加密密钥和管理员密码，已有密钥会保留。

云端管理员配置保存在 `.env.local`，本地保存在 `.local/admin.json`；不把密码打印到终端。可在启动前设置 `SUB2API_LOCAL_ADMIN_EMAIL`，默认 `admin@sub2api.local`。本地模式需保持启动终端运行；停止时在另一终端执行 `npm run down -- --local`。云端停止控制台执行 `npm run down -- --cloud`。停止不会删除数据库数据。切换模式不会复制数据或账号，需要分别导入上游凭据。

本地模式的密钥和数据库与云端独立，CLI 不会链接或推送到云端项目。已有云端用户和管理员 UUID 会保留；新项目由启动脚本创建初始管理员。`SUB2API_ADMIN_USER_IDS` 只在首次初始化时设置管理员，后续角色变更通过控制台管理并保存在 PostgreSQL 中。

### 切换到云端部署

使用云端 Supabase 时，可关闭本地 Supabase 以释放本机资源。先停止本地模式，再启动云端控制台：

```sh
npm run down -- --local
npm run up -- --cloud
```

本地启动终端如仍未退出，按 Ctrl+C 结束函数服务进程。停止会保留本地数据库卷与 `.local/` 凭据，不影响云端数据库；不要使用删除卷的选项。云端模式只需本地控制台容器，无需本地 Supabase 容器。

## 已实现

- Supabase Auth 用户会话、数据库管理的管理员角色。
- Supabase 邮箱注册、密码找回、密码修改与原生 TOTP 保护。
- 管理员创建/停用分组、成员授权、加密导入和停用账号。
- 多账号优先级与最近使用调度、Key 与账号并发限制、数据库事务预约。
- 每用户 API Key 发放、仅存摘要、有效期、撤销与分组隔离。
- Key 每分钟请求限流、上游错误冷却与有限账号切换。
- OpenAI OAuth PKCE 授权向导、幂等授权票据、重新授权、持久化刷新、跨实例刷新锁和 401 重试。
- Responses SSE / 显式非流式、文本 Chat Completions 转换、Codex manifest 和逐次调用 Token 记录。
- 官方 OpenAI、Anthropic、Gemini API Key 原生转发；用户资料/改密与管理员用户管理。
- 公告发布/阅读、余额与有效订阅的 AND/OR 定向投放、业务与原生 Auth 用户/TOTP 因子变更审计，以及需要新 TOTP 验证的审计清理。

前端源码已包含原版 Vue 控制台，已接通 OpenAI OAuth 授权、Supabase TOTP、供应商 API Key、用量看板、管理、公告和审计工作流。工具由调用方执行，网关保留调用方 instructions 和工具定义，不注入额外权限指令。

## 架构与目录

浏览器 → 本地 Vue 控制台 / Node 接口代理 → Supabase Auth 与 `subscription-api` Edge Function → PostgreSQL / 官方模型上游。Docker 运行前端静态文件与代理，数据库、核心 API 和凭据刷新仍运行于 Supabase；通过配置选择云端托管 Supabase 或本地 Supabase；本地模式仍需网络访问模型上游。

| 目录 | 内容 |
| --- | --- |
| `frontend/` | 固定上游版本的 Vue 控制台及本项目适配 |
| `supabase/functions/subscription-api/` | TypeScript 核心网关与管理接口 |
| `supabase/migrations/` | PostgreSQL 结构、权限、调度和审计 |
| `scripts/` | 本地代理、静态服务、部署与凭据导入 |
| `tests/` | 项目自动化验证 |
| `docs/` | 部署、架构、法律与上游参考文档 |

## 云端项目配置

需要 Node.js 24+、Go（版本要求见 `backend/go.mod`）、pnpm 10、Deno 2、Supabase CLI 和 Docker 完成发布部署。先在 Supabase 新建独立项目，再从仓库根目录执行：

```sh
cp .env.example .env.local
chmod 600 .env.local
openssl rand -base64 32
```

手动编辑 `.env.local`：填写 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`（公开 publishable / anon key）、旧版 `SUPABASE_SERVICE_ROLE_KEY` JWT、`SUB2API_ADMIN_USER_IDS`（管理员 Auth UUID），将生成的密钥填入 `GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64` 并安全备份。部署另需 `SUPABASE_DB_PASSWORD`；`SUPABASE_ACCESS_TOKEN` 可省略并先执行 `supabase login`。不要提交 `.env.local` 或凭据文件。

Docker 控制台只需要 URL 和公开密钥。service role、账户令牌、数据库密码和加密密钥仅用于后端或本地管理工具，不能传给浏览器或控制台容器。生成的加密密钥用于解密已保存凭据，丢失后无法恢复；更换它不会自动重加密已有数据。

## 本地原版前端

`frontend/` 直接保留上游 Vue 页面、组件、国际化和资源，不另写控制台。来源和修改范围见 NOTICE。两个终端均从本目录启动：

```sh
pnpm --dir frontend --ignore-workspace install --frozen-lockfile --registry=https://registry.npmjs.org
npm run console       # Terminal 1: local API proxy, 127.0.0.1:4173
npm run frontend      # Terminal 2: original Vite frontend, 127.0.0.1:3000
```

打开 http://127.0.0.1:3000 。首次打开可查看原版登录页；完成 Supabase 项目配置后，在 `.env.local` 添加 `SUPABASE_PUBLISHABLE_KEY`（公开 publishable / anon key），重启接口代理。代理只使用项目 URL 和公开密钥，每次管理请求都由服务端通过 PostgreSQL 验证管理员权限。浏览器无需也不能配置 service role key。

Compose 使用固定容器名 `sub2api-supabase-console`，镜像标签为 `sub2api-supabase-console:latest`。

当前兼容：Supabase 邮箱密码登录、会话刷新/退出、用户信息、授权分组、密钥分页/创建/改名/有效期/撤销、用户/管理员调用记录、按日或小时趋势及模型统计、管理员分组和账号列表。完整密钥仅创建时弹窗显示一次，列表只有前缀。控制台显示钱包余额、订阅额度、Token 费用和上游返回的缓存用量；用量结算保留价格快照与计费来源，上游未返回的 Token 数保留为空。注册支持邀请码、邮箱域名规则与主域名单账号注册额度、默认余额与订阅，以及限制使用次数的优惠码。日期按北京时间汇总。

原版前端的基础账号/分组创建、查询、核心字段编辑和停用已适配；账号状态与参与调度独立，支持到期自动排除、单个调度开关和最多 100 个账号的基础批量编辑，逐项返回结果；API Key 账号可在原版编辑页原子保存新密钥和基础设置，活跃请求会阻止轮换；成员授权也可使用下方 API。UUID 值在支持的工作流中统一以字符串传递。

构建输出在 `frontend/dist`，不写入原 Go 后端目录。`pnpm preview` 只有静态预览，不提供开发代理；当前可使用 Vite dev，或下方 Docker 内置静态服务器。前端及代理均绑定回环地址。

## 部署到 Supabase

推荐新建独立 Supabase 项目。此目录的迁移不是原 Sub2API 或主业务数据库的升级脚本，不能直接应用到已有服务。

1. 在 Supabase 控制台 Auth 中创建管理员用户，记下其 UUID。按需要关闭公开注册；其他用户也通过 Supabase Auth 创建。
2. 编辑 `.env.local`，填写项目 URL、公开密钥、service role key 和管理员 UUID，保留已生成的加密密钥。克隆后的初始配置见上文。
3. 填写 `.env.local` 中的 `SUPABASE_DB_PASSWORD` 和 `SUPABASE_ACCESS_TOKEN`（或者先执行 `supabase login`），然后执行：

```sh
npm run deploy
```

云端的 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY` 由 Supabase 注入。配置关闭平台 JWT 检查；函数内部为管理接口验证 Auth JWT，为模型接口验证自己的 API Key。不能移除此鉴权逻辑。

函数基地址为：`https://YOUR_PROJECT_REF.supabase.co/functions/v1/subscription-api`。公开 `/health` 仅检查进程存活，不检查账号或上游连通性。

本地可运行 `deno task dev`（默认端口 8000），使用 `.env.local` 中的项目数据库。它会写入该数据库，请使用独立开发项目。

## 首次配置

在下文中，将 `GATEWAY_URL` 设置为函数基地址。`ADMIN_JWT` 是管理员的 Supabase Auth access token，**不是 service role key，也不是模型调用 Key**。可通过 Supabase Auth 的标准登录接口取得：

```sh
curl "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}'
```

不要将密码写入可提交的脚本；示例中均为占位值。Shell 中设置的变量需要自行填入，`.env.local` 不会自动加载到当前 Shell。

创建分组，记录返回的 `id` 为 `GROUP_ID`：

```sh
curl "$GATEWAY_URL/api/v1/admin/groups" \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"name":"OpenAI"}'
```

给用户授权分组。通过创建接口建立分组时，自动授予创建者成员资格；其他用户仍需授权：

```sh
curl -X PUT "$GATEWAY_URL/api/v1/admin/groups/$GROUP_ID/members/$USER_ID" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

准备自己已有的 OAuth 凭据 `account.credentials.json`：

```json
{
  "access_token": "YOUR_ACCESS_TOKEN",
  "refresh_token": "YOUR_REFRESH_TOKEN",
  "chatgpt_account_id": "YOUR_ACCOUNT_ID",
  "expires_at": "2030-01-01T00:00:00Z"
}
```

填写真实有效期，不要照抄示例日期。`expires_at` 支持 Unix 秒、毫秒、ISO 日期，也可省略（401 后刷新）；`client_id` 可选。控制台已提供 OpenAI OAuth 授权向导；文件导入是另一种方式，不会自动读取其他应用的凭据。

```sh
npm run credentials:import -- "$GROUP_ID" /absolute/path/to/account.credentials.json "Primary"
```

导入器将凭据加密后插入账号表，不覆盖已有账号。相同 ChatGPT account ID 不能重复导入；一个账号可通过多个分组路由请求。导入后应由本服务独占刷新，同一份 refresh token 不应继续交给 Sub2API、Codex 或其他客户端轮换。

用户以自己的 Supabase Auth access token（下文 `USER_JWT`）创建调用 Key：

```sh
curl "$GATEWAY_URL/api/v1/keys" \
  -H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json" \
  -d "{\"name\":\"CLI\",\"group_id\":\"$GROUP_ID\"}"
```

响应中的 `key` 只返回一次。默认每分钟 60 次请求、最多 3 个并发；普通用户不能创建高于这两个值的 Key。多个 Key 目前独立计算限额。

## 调用模型

将刚创建的 Key 设为 `API_KEY`，从模型目录选择账号可用的模型：

```sh
curl "$GATEWAY_URL/v1/models" -H "Authorization: Bearer $API_KEY"

curl -N "$GATEWAY_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"MODEL_FROM_CATALOG","input":"Reply with hello","stream":true}'
```

Responses 客户端的 base URL 为 `$GATEWAY_URL/v1`。OpenAI OAuth 请求发送上游时使用 `stream:true`、`store:false`，移除 Codex 不支持的采样和输出长度参数；显式 `stream:false` 在网关聚合 JSON，省略 stream 保持 SSE。提供 `/v1/chat/completions` 文本、图像和工具转换，以及 `/v1/messages` 到 OpenAI Responses 的请求、响应和 SSE 转换。API Key 账号使用固定官方供应商原生协议。

请求按账号类型发送到固定官方 Codex、OpenAI、Anthropic 或 Gemini 上游，不接受自定义 upstream URL。客户端请求体上限 1 MiB，整个模型调用和流输出限时 120 秒，也受 Supabase 实际套餐的运行限制约束。

## 管理接口

所有路径以函数基地址为前缀；管理/用户接口使用 Supabase Auth JWT，模型接口使用本项目 API Key。没有浏览器 CORS 配置或静态页面托管。

| 方法 | 路径 | 权限 / 行为 |
| --- | --- | --- |
| GET | `/health` | 无需认证，进程存活 |
| GET | `/api/v1/user/profile` | 当前用户 |
| GET | `/api/v1/groups/available` | 用户已获授权的有效分组 |
| GET / POST | `/api/v1/keys` | 列出 / 创建自己的 Key |
| PATCH | `/api/v1/keys/:id` | 修改自己的 name、rpm、concurrency、expires_at |
| DELETE | `/api/v1/keys/:id` | 删除墓碑，保留历史且不能重新启用 |
| GET | `/api/v1/usage/dashboard?days=7` | 自己的请求数、已知 Token 汇总和趋势 |
| GET | `/api/v1/usage?limit=50` | 自己的调用记录，最多 100 条 |
| GET / POST | `/api/v1/admin/groups` | 管理员列表 / 创建分组 |
| PATCH | `/api/v1/admin/groups/:id` | `{ "enabled": false }` 停用分组 |
| PUT / DELETE | `/api/v1/admin/groups/:id/members/:user_id` | 管理员授予 / 撤回分组访问 |
| GET / POST | `/api/v1/admin/accounts` | 管理员列表 / 创建供应商账号 |
| GET / POST | `/api/v1/admin/accounts/data` | 管理员导出 / 恢复账号备份 |
| GET | `/api/v1/admin/accounts/:id/models` | 管理员查询账号可用模型与显示信息 |
| PATCH | `/api/v1/admin/accounts/:id` | 修改 name、status、priority、concurrency |
| GET | `/api/v1/admin/usage?limit=50` | 管理员查看所有调用记录 |
| GET | `/v1/models` | 模型目录；占用一个请求预约 |
| POST | `/v1/responses` | SSE 或显式非流式 JSON |
| POST | `/v1/chat/completions` | 文本与工具调用，流式或非流式 |
| POST | `/v1/messages` | Anthropic API Key 原生协议 |
| POST | `/v1beta/models/:model:generateContent` / `:streamGenerateContent` | Gemini API Key 原生协议 |
| GET / POST | `/api/v1/admin/users` | 用户管理、管理员角色、自定义属性和分组筛选 |
| GET / PUT / DELETE | `/api/v1/admin/users/:id` | 查询、更新/封禁、永久删除所选 Auth 用户 |
| GET / POST | `/api/v1/admin/announcements` | 公告列表与发布 |
| GET | `/api/v1/admin/audit-logs` | 基础业务表审计 |

创建账号的 JSON 字段为 `name`、`platform`、`type`、`credentials`，以及可选的 `group_ids`、`priority` 和 `concurrency`。API Key 账号使用 `{ "api_key": "YOUR_PROVIDER_KEY" }`；OpenAI OAuth 账号使用导入凭据格式。账号停用使用 `{ "status": "disabled" }`。撤销 Key、移除成员资格、停用分组仅阻止新的预约，不中止已开始的流。

账号可以不绑定分组保存，分配分组后才能参与调度。创建账号时省略分组，会在存在时绑定启用的 `<platform>-default` 分组；`skip_default_group_bind` 可跳过默认绑定。空的 `group_ids` 数组用于清除所有绑定。

账号模型映射支持精确名称与末尾通配符。非空映射限定账号可服务的模型，并改写上游模型和计费模型。预约保存映射与价格快照，用量记录保留请求模型、计费模型和上游模型。

管理员账号备份包含明文供应商凭据、模型映射和调度配置，请将备份文件保存在私密位置。控制台恢复备份时逐项返回结果，并加密保存凭据。恢复默认不绑定分组；将 `skip_default_group_bind` 设为 `false` 可使用启用的供应商默认分组。单次导入支持最多 1 MiB 和 1,000 条账号记录。`Idempotency-Key` 用于在两小时内识别重试；省略时使用规范化请求的指纹作为键。同一键对应不同内容会返回冲突，已有账号身份不会被覆盖。

账号列表展示模型映射，不返回凭据密文；Key 列表不返回 Key 或摘要。记录包含每次账号尝试，使用 `request_id` 关联重试；未知 Token 数为 `null`。已完成请求的费用、额度和用量记录通过同一事务结算。

## 验证

```sh
npm ci --ignore-scripts
npm test
npm run test:database
deno task check
```

## 本地 Docker 控制台

先部署 Supabase 后端并填好 `.env.local`。以下命令从仓库根目录执行；如果 Vite 已占用 3000，先停止 Vite，或使用备用端口：

```sh
docker compose --env-file .env.local up --build -d
# Use another port if 3000 is occupied:
CONSOLE_PORT=4300 docker compose --env-file .env.local up --build -d
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)（备用端口使用 4300）。浏览器与代理使用同一端口；容器内监听 4173，主机只发布到回环地址。代理仅接受 localhost / 127.0.0.1 来源，目前不支持公网域名或远程浏览器部署。

```sh
docker compose --env-file .env.local logs --tail=100 console
docker compose --env-file .env.local down
```

构建上下文仅包含前端、代理、前端引用的法律文档及许可证；`.env.local`、Git 历史、后端源码和本地凭据不会进入镜像。Compose 仅将部署模式、URL 和公开密钥注入容器，未挂载环境文件。容器使用非 root 用户、只读文件系统及禁用额外 capabilities。Docker 命令提供本地控制台和代理；请先发布云函数并应用数据库迁移。启动控制台前，请先使用 `npm run deploy` 发布 Edge Function 并应用数据库迁移。

## 用量与计费

用量明细和统计共用分组、账号、API Key、模型、请求类型、流式请求和计费来源筛选。用户视图始终限定为当前登录用户，管理员还可以按用户筛选。`billing_type` 区分余额（`0`）与订阅（`1`）来源，`billing_mode` 表示计价单位。

Token 定价以美元为单位，使用内置模型价格表，支持缓存折扣、长上下文价格和 priority、flex 服务档位。标准分组的倍率决定用户钱包的实际扣费金额。API Key 的额度以金额计算，`token_quota` 则是独立的可选 Token 限额。每次用量结算会在同一事务内保存定价快照、费用和钱包流水。付费请求需要可用余额；若供应商最终用量产生欠款，需要补足后才能继续付费调用。价格表无法识别的模型会返回 `model_pricing_unavailable`。

## 兑换码

管理员可以生成余额和并发额度兑换码，支持正数发放、负数扣减，并管理有效期、状态和备注。兑换权益与核销兑换码在同一事务内完成。固定兑换码发放支持重试，避免重复充值。用户历史包含兑换记录与管理员余额调整，内部兑换码备注不会向用户公开。已兑换记录保留核销状态，管理接口不能删除或重新启用这些兑换码。

## 参与贡献与安全报告

提交前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。缺陷和功能提议使用 GitHub issue 模板；安全问题请遵循 [SECURITY.md](SECURITY.md)，不要公开访问令牌或生产凭据。

## 项目名称与来源

项目名称为 sub2api-supabase。默认界面、Logo、标题与欢迎文案使用本项目名称；Supabase 是部署平台，本项目不是 Supabase 官方产品。许可证和上游版权归属保留在 LICENSE、COPYING、NOTICE 中。已部署云函数继续使用 `subscription-api` 路径，现有调用无需修改。

### 订阅套餐

订阅分组提供按日、周、月计算的美元额度。管理员可以在原版控制台中分配、续期、缩短、撤销、恢复订阅及重置额度。订阅请求消耗套餐额度，标准分组使用钱包余额。批量操作和固定订单订阅兑换支持安全重试。

### 自定义页面

管理 API 和自定义导航由原版 Go 管理服务提供。通过 `MANAGEMENT_URL` 配置本地 HTTP 地址，模型请求继续由 Supabase Edge Functions 处理。

### OpenAI 订阅额度

账号控制台展示实时额度窗口、余额和重置卡到期时间。手动重置支持持久化重试；自动重置默认关闭，可分别设置五小时与七天窗口的阈值，优先使用最早到期的卡。消费结果不确定时，重试沿用原卡和原消费编号。调度任务运行在 Supabase 中，本地控制台关闭后仍可执行。配置与恢复行为见 [OpenAI 额度卡](docs/DEPLOYMENT.md#openai-quota-cards)。

### 运维邮件

在控制台常规设置中配置 SMTP 和发件人，也可在 `.env.local` 中配置 `RESEND_API_KEY` 和 `SUB2API_MAIL_FROM`，使用 Resend 验证的发件地址。SMTP 优先使用，密码加密保存在私有数据库中；留空保留原密码，更换服务器、端口或用户名需重新填写密码。SMTP 支持隐式 TLS 和 STARTTLS，远程密码认证需启用加密连接。Supabase Auth 的确认和找回密码邮件使用独立的 Auth SMTP 配置。运维设置支持告警收件人、严重程度、批量窗口、每小时发送限额及日报、周报等定时报告。Supabase 保存队列和投递状态，并自动运行任务。定时任务默认采用 Supabase Cron 的 UTC 时区；详见[部署说明](docs/DEPLOYMENT.md#operations-email-delivery)。

### 实时运维

控制台支持经本地代理或直接连接 Supabase Edge 的 QPS/TPS WebSocket 推送，使用数据库连接租约限制并发，并持续校验会话和管理员权限。连接定期轮换并自动重连，关闭实时监控会停止推送。详见[部署说明](docs/DEPLOYMENT.md#realtime-operations-websocket)。

### 代理管理

原管理控制台支持 HTTP、HTTPS、SOCKS5 和 SOCKS5h 代理记录，提供密码加密保存、列表筛选、批量操作、有效期、备用代理设置及实际连接测试。详见[部署说明](docs/DEPLOYMENT.md#proxy-registry)。

账号代理绑定覆盖模型请求、OAuth 令牌操作、模型发现、隐私设置和 OpenAI 配额查询。代理到期后按照配置切换备用代理或直连，支持在账号控制台恢复原代理。
