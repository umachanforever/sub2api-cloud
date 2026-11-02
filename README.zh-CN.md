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

Gemini 和 Antigravity 模型列表直接读取数据库中的验证结果，客户端请求不再执行推理检测。云端签名定时任务每分钟分批处理：成功模型每 10 分钟复查，临时失败每 5 分钟重试，不支持的模型每 30 分钟重试。新模型验证成功后才展示，切换云端进程不会丢失结果；刷新停止后，超过 30 分钟的成功结果不再展示。仅刷新最近 24 小时内获取过列表的模型，闲置记录 7 天后清理。检测仍会消耗上游额度。`x-s2a-model-verification` 响应头区分验证成功、临时失败、不支持和未验证数量。Antigravity 按原仓库区分 Gemini 文本共享配额、图片模型配额和 Claude 配额；容量不足不封禁账号。积分超额仅在明确开启时使用，目录探测不会开启积分消费。差异与限制见[上游一致性审计](docs/UPSTREAM_MODEL_PARITY_AUDIT.md)。

原生 Gemini 聊天请求的实际目标为 `gemini-3-flash` 或 `gemini-3-flash-preview` 时，网关将不支持的 IMAGE 输出选项改为 TEXT，并移除图片输出配置。用户消息保持原样，由模型自行回答。图片模型保留生图参数，上游真实错误仍按错误返回。 原生 Gemini 请求还会将模型历史中由网关生成的 Base64 图片 Markdown 恢复为原始图片字段，避免把图片编码当成文字耗尽上下文。

对于未声明联网搜索工具的 Responses 客户端，网关自动搜索只返回回答和来源引用，不透传内部工具事件；客户端明确声明的搜索工具仍保留原生事件。

聊天支持原生图片生成。WorkBuddy 默认在聊天内显示原图卡片，点击可预览、保存或复制，不自动打开侧栏；需要客户端提供文件工具及权限。其他客户端保持内嵌图片显示。

## 详细文档

[部署说明](docs/DEPLOYMENT.md) · [架构说明](docs/ARCHITECTURE.md) · [参与贡献](CONTRIBUTING.md)

## 开源许可

基于 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)，采用 LGPL-3.0-or-later 许可证。详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
