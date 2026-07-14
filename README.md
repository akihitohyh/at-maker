# AT Maker

AT Maker 提供 CLI 和 WebUI，用于执行 OpenAI 账号注册流程，保存 ChatGPT access token，并尝试获取平台 OAuth refresh token。

> 本项目仅供学习、研究和接口行为测试。使用者应自行确保用途符合目标平台服务条款、当地法律法规及所在网络环境的合规要求。

## 功能

- CLI 单次或批量并发运行
- WebUI 配置、启动、停止、实时日志与结果下载
- 三种邮箱 Provider：本地微软邮箱池、TempMail.lol、YYDS Mail
- 微软邮箱池支持 OAuth、HTTP API 取件、IMAP、Graph 和邮箱别名
- 注册代理支持 HTTP、HTTPS、SOCKS4 和 SOCKS5
- WebUI 可检测代理出口 IP 及 `chatgpt.com` 可达性
- 注册成功后保存 ChatGPT AT，并尝试通过 OAuth PKCE 获取 RT
- AT 文本下载及 oumiFree/Codex 格式 RT JSON 下载
- 可选连接 chatgpt2api，注册一个自动上传一个，优先上传 RT
- 验证码基线、历史验证码过滤、错误验证码重试和任务立即中断

## 安全提示

WebUI 当前不包含用户登录鉴权，并且配置接口会处理邮箱池、代理凭据、邮件 API Key 和 chatgpt2api Key。

- 不要把 WebUI 端口直接暴露到公网
- 建议仅监听可信内网，或置于带身份认证的反向代理后
- 使用防火墙限制来源 IP
- 不要提交 `config.json`、`hotmail/tokens.txt` 或 `auth/` 中生成的凭据
- 下载 AT/RT 后应按敏感凭据管理

## 环境要求

- Node.js 20.18 或更高版本
- npm
- 可用的注册代理
- 至少一个可用邮箱 Provider

## 安装

### 从源码安装

```bash
git clone https://github.com/akihitohyh/at-maker.git
cd at-maker
npm install
cp config.example.json config.json
npm run build
```

### 使用 Release 包

从 [Releases](https://github.com/akihitohyh/at-maker/releases) 下载发布包。发布包已包含 `bundle/`：

```bash
tar -xzf at-maker-v0.1.0.tar.gz
cd at-maker-v0.1.0
npm install --omit=dev
cp config.example.json config.json
```

## 配置

`config.example.json` 包含完整字段：

```json
{
  "defaultProxyUrl": "http://127.0.0.1:10808",
  "defaultPassword": "kuaileshifu88",
  "loopDelayMs": 30000,
  "emailProvider": "hotmail",
  "tempmailApiKey": "",
  "yydsApiKey": "",
  "yydsBaseUrl": "https://maliapi.215.im/v1",
  "yydsDomain": "",
  "chatgpt2apiBaseUrl": "http://127.0.0.1:3000",
  "chatgpt2apiAuthKey": ""
}
```

| 字段 | 说明 |
| --- | --- |
| `defaultProxyUrl` | 注册流量使用的代理 |
| `defaultPassword` | 注册账号使用的默认密码，请自行修改 |
| `loopDelayMs` | CLI 批次之间的等待时间，单位毫秒 |
| `emailProvider` | `hotmail`、`tempmail` 或 `yyds` |
| `tempmailApiKey` | TempMail.lol Bearer Key，可选 |
| `yydsApiKey` | YYDS `X-API-Key`，使用 YYDS 时必填 |
| `yydsBaseUrl` | YYDS API 地址 |
| `yydsDomain` | YYDS 指定域名；留空时尝试 wildcard 自动分配 |
| `chatgpt2apiBaseUrl` | chatgpt2api 服务地址 |
| `chatgpt2apiAuthKey` | chatgpt2api 管理鉴权 Key |

WebUI 保存配置时会更新 `config.json`。该文件包含敏感信息，已被 `.gitignore` 忽略。

## 邮箱 Provider

### 本地微软邮箱池

将账号写入 `hotmail/tokens.txt`，每行一个。OAuth 与 HTTP API 取件格式可以混用。

OAuth 格式：

```text
邮箱----密码----client_id----refresh_token
```

HTTP API 取件格式：

```text
邮箱----https://mailapi.icu/key?type=html&orderNo=订单号
```

也兼容以下格式，中间字段会被忽略：

```text
邮箱----任意字段----https://mailapi.icu/key?type=html&orderNo=订单号
```

程序会识别行中的 HTTP(S) URL。对于 `mailapi.icu`，`type=html` 会在取件时转换为 `type=json`。

微软 OAuth 邮箱支持以下接码模式：

| 模式 | 说明 |
| --- | --- |
| 自动 | 根据 token scope 和 token 类型选择 IMAP 或 Graph |
| IMAP | 适合具有 Outlook IMAP 权限的消费级账号 |
| Graph | 需要 Microsoft Graph `Mail.Read` 权限 |

#### 邮箱别名

WebUI 中填写别名后缀后：

```text
user@outlook.com + 后缀 1 -> user+1@outlook.com
```

- 留空时使用原邮箱
- 固定后缀会生成固定 `+alias`
- 启用随机选项后会追加随机字符串
- API 取件使用别名注册，但仍通过基础邮箱对应的取件 URL 获取验证码

使用别名前，请确认邮箱服务商会将 `+alias` 邮件投递到基础邮箱。

### TempMail.lol

WebUI 选择 `TempMail.lol` 后，程序通过 API v2 创建临时收件箱并轮询验证码：

- `POST /inbox/create`
- `GET /inbox?token=...`

API Key 为可选 Bearer Key。具体额度、地区限制和域名策略以 TempMail.lol 当前服务规则为准。

### YYDS Mail

WebUI 选择 `YYDS Mail` 后必须填写 `X-API-Key`。默认 API 地址：

```text
https://maliapi.215.im/v1
```

- 未指定域名时优先调用 `/accounts/wildcard`
- 指定域名时调用 `/accounts`
- 验证码优先通过 `/messages/next` 获取
- wildcard 不可用时会尝试查询公共域名

## WebUI

开发模式：

```bash
npm run dev:web
```

构建或 Release 模式：

```bash
npm run start:web
```

默认地址为 `http://localhost:8318`，可通过 `PORT` 修改：

```bash
PORT=5800 npm run start:web
```

WebUI 提供：

- 代理配置和连通性检测
- chatgpt2api 配置和连接检测
- 邮箱 Provider 切换及对应配置
- 线程数、注册数量和邮箱池管理
- SSE 实时运行日志
- 立即停止任务
- AT 和 RT 分别下载

## CLI

CLI 当前使用本地微软邮箱池和 `config.json` 中的基础配置。

```bash
npm run dev
npm run dev -- --n 10
npm run dev -- --n 100 --threads 10
```

使用构建入口：

```bash
npm run start -- --n 10 --threads 2
```

## AT 与 RT

每次注册成功后，程序会保存 ChatGPT session AT，并尝试通过平台 OAuth PKCE 获取 RT。

本地文件：

- `auth/at/*.json`：每个账号的完整本地归档
- `auth/access_tokens.txt`：ChatGPT session AT 汇总
- `auth/codex/*.json`：成功获得 RT 时生成的 oumiFree/Codex 格式文件

WebUI 下载行为：

- “下载 AT”返回 `access_tokens.txt`，成功发送后清空该汇总文件
- “下载 RT”单账号返回 JSON，多账号返回 ZIP，成功发送后清空 `auth/codex/` 待下载文件
- `auth/at/` 本地归档不会因下载操作删除

OAuth PKCE 失败不会使整个注册结果失败，AT 仍会保存。

## chatgpt2api 上传

填写服务地址和管理鉴权 Key 后，先在 WebUI 中检测连接。任务开始时会再次检测：

- 连接正常：每成功注册一个账号立即上传一个
- 存在 RT：优先上传完整 Codex 账号结构
- 没有 RT：回退为 AT 上传
- 上传失败：保留本地 AT/RT，不影响本轮注册成功状态

连接检测使用 `GET /api/accounts`，上传使用 `POST /api/accounts`。

## 发布包内容

发布包包含：

- `src/` TypeScript 源码
- `public/` WebUI
- `bundle/` 已构建的 CLI 和 WebUI 入口
- `package.json` 与 `package-lock.json`
- 示例配置和空的运行目录

发布包不包含 `node_modules`、真实配置、邮箱账号、订单号、代理凭据、邮件 API Key、chatgpt2api Key 或 token。

## 更新记录

### v0.1.0

- 新增 TempMail.lol 与 YYDS Mail Provider
- 新增代理出口 IP 与 ChatGPT 可达性检测
- 新增平台 OAuth PKCE RT 获取
- 新增 oumiFree/Codex 格式 RT 保存和下载
- 新增 chatgpt2api 连接检测及注册后自动上传
- WebUI 重构为配置面板与实时日志双栏界面
- 扩展配置文件、运行状态和下载接口
- 完善敏感文件忽略规则与发布文档

### v0.0.3

- 新增 HTTP API 取件
- API 取件支持固定别名和随机别名
- 改进 IMAP/Graph、验证码基线、轮询和立即停止

## 致谢

<https://linux.do>
