# sub2api-cloud

[English](README.md) | [简体中文](README.zh-CN.md)

基于 Supabase 的 AI API 网关，支持订阅账号与供应商 API Key，在本地网页控制台管理账号、密钥和用量。

- 接入 OpenAI、Anthropic、Gemini 等供应商。
- 支持 Responses、Chat Completions、Messages 和 Gemini API 格式，流式响应及附件能力取决于供应商。
- 支持多个订阅账号、模型列表与模型别名。
- 按账号查看用量和订阅额度，具体指标以供应商提供的数据为准。
- 云端完成鉴权、凭据自动刷新和用量记录。
- 支持本地或云端 Supabase；关闭本地控制台后，云端 API 仍可使用。

Supabase 提供免费额度和 HTTPS 地址，节省主机与域名费用。全球客户端均可通过云端网关调用 OpenAI、Anthropic、Gemini 等 API，中国大陆客户端也无需翻墙或运行本地代理。使用额度取决于上游账号及 [Supabase 套餐](https://supabase.com/pricing)。

## 快速开始

安装 Node.js 24+、Docker Compose 2.24+ 和 Supabase CLI，创建 Supabase 项目，然后执行：

```sh
cp .env.example .env.local
chmod 600 .env.local
```

填写 `.env.local`：

| 配置 | 内容 |
| --- | --- |
| `SUPABASE_URL` | 项目地址 |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable 或 anon key |
| `SUPABASE_DB_PASSWORD` | 数据库密码 |
| `SUPABASE_ACCESS_TOKEN` | Supabase 访问令牌 |
| `SUB2API_LOCAL_ADMIN_EMAIL` | 管理员邮箱 |

`SUPABASE_SERVICE_ROLE_KEY` 可留空，部署时自动获取。

```sh
npm run up -- --cloud
```

打开[本地控制台](http://127.0.0.1:3000)，登录后添加供应商账号、绑定对应分组并创建 API Key。自动生成的管理员凭据保存在 `.env.local`。

使用本地 Supabase 时执行 `npm run up -- --local`。切换云端后，可用 `npm run down -- --local` 关闭本地 Supabase，节省资源。

## API 调用

使用控制台显示的 Base URL：

```text
https://<project-ref>.supabase.co/functions/v1/sub2api/v1
```

```sh
export OPENAI_BASE_URL='https://<project-ref>.supabase.co/functions/v1/sub2api/v1'
export OPENAI_API_KEY='sk-your-key'

curl "$OPENAI_BASE_URL/models" \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

同一密钥可调用 `/responses`、`/chat/completions` 和 `/usage`。用量接口按已启用账号分别返回数据，`windows` 保留各供应商的额度周期；上游不提供额度查询的账号标记为 `supported: false`。添加 `?refresh=true` 可立即向上游刷新。

浏览器可直接打开 `https://<project-ref>.supabase.co/functions/v1/sub2api/usage?key=<你的API密钥>`，只显示该密钥有权使用的账号。

`gpt-6`、`gpt-6.1` 等别名默认选择对应的 `-sol` 版本，账号模型映射优先。实际可用模型取决于订阅账号。

Gemini 原生接口和 Antigravity 模型列表中的所有条目（包括 Claude 名称和自定义别名），都会使用客户端密钥的正常调度与计费链路，逐个发送小型生成请求验证；标准模型列表也会验证其中标记为 Gemini/Antigravity 来源的条目，只返回验证成功的模型，通配符条目不会返回。验证失败不会触发整个账号冷却，避免单个模型的额度限制导致其他可用模型被隐藏。最多同时验证两个模型，每个模型超时 10 秒，单次列表验证预算为 45 秒，预算内未验证成功的模型暂不返回。成功结果缓存 10 分钟，明确不支持的结果缓存 5 分钟，临时失败缓存 15 秒。缓存按客户端密钥隔离，保存在各网关进程内，冷启动后会重新验证。首次获取列表可能较慢，并会消耗少量上游额度。其他厂商维持原有列表行为。

聊天默认使用原生图片模型生成图片。WorkBuddy 等提供 `show_widget` 工具的 OpenAI OAuth 客户端使用原图文件直接展示 PNG/JPEG/WebP，避免大量 base64 正文增量；底层采用私有 Storage 的七天签名图片地址，界面渲染为图片而非裸链接，不会改用 SVG/HTML 绘图。默认仅在聊天内显示图片，即使客户端提供 `present_files` 也不会自动触发侧栏或放大预览。仅在用户明确要求下载、保存、复制或导出时，模型可使用原图地址下载本地文件并交付；此步骤依赖客户端的文件工具及权限。其他客户端及 Antigravity 保持内嵌图片返回，流式内容分段发送；分组图片权限、独立图片任务和历史图片引用仍受支持。

## 详细文档

[部署说明](docs/DEPLOYMENT.md) · [架构说明](docs/ARCHITECTURE.md) · [参与贡献](CONTRIBUTING.md)

## 开源许可

基于 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)，采用 LGPL-3.0-or-later 许可证。详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
