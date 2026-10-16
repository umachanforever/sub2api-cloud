# sub2api-cloud

[English](README.md) | [简体中文](README.zh-CN.md)

通过 Supabase 将 ChatGPT 订阅转为 API，在本地网页控制台管理账号、密钥和用量。

- 支持 OpenAI Responses、Chat Completions、流式响应和附件输入。
- 支持多个订阅账号、模型列表与模型别名。
- 分别查看每个已启用账号的 5 小时和 7 日订阅用量。
- 云端完成鉴权、凭据自动刷新和用量记录。
- 支持本地或云端 Supabase；关闭本地控制台后，云端 API 仍可使用。

Supabase 提供免费额度和 HTTPS 地址，节省主机与域名费用。地址可直连时，中国大陆客户端无需翻墙或运行本地代理。实际可用性和额度取决于网络、上游账号及 [Supabase 套餐](https://supabase.com/pricing)。

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

打开[本地控制台](http://127.0.0.1:3000)，登录后添加 OpenAI 订阅账号、绑定分组并创建 API Key。自动生成的管理员凭据保存在 `.env.local`。

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

同一密钥可调用 `/responses`、`/chat/completions` 和 `/usage`。用量接口分别返回已启用订阅账号的数据，添加 `?refresh=true` 可立即向上游刷新。

`gpt-6`、`gpt-6.1` 等别名默认选择对应的 `-sol` 版本，账号模型映射优先。实际可用模型取决于订阅账号。

## 详细文档

[部署说明](docs/DEPLOYMENT.md) · [架构说明](docs/ARCHITECTURE.md) · [参与贡献](CONTRIBUTING.md)

## 开源许可

基于 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)，采用 LGPL-3.0-or-later 许可证。详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
