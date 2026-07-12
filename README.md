# AT Maker

AT Maker 提供 CLI 和 WebUI，用于执行 OpenAI 账号注册流程并导出 ChatGPT access token。

> 本项目仅供学习、研究和接口行为测试。使用者应自行确保用途符合目标平台服务条款、当地法律法规及所在网络环境的合规要求。

## 功能

- CLI 单次或批量并发运行
- WebUI 配置、启动、停止、进度查看与 token 下载
- Hotmail/Outlook OAuth 邮箱，支持 IMAP、Graph 和自动选择
- HTTP API 取件，支持 `mailapi.icu` 等 `orderNo` 接口
- 固定别名和随机别名，OAuth 与 API 取件均可使用
- 验证码基线、历史验证码过滤和错误验证码重试
- HTTP、HTTPS 和 SOCKS5 注册代理
- 运行中立即停止，网络请求和验证码轮询可中断

## 环境要求

- Node.js 20.18 或更高版本
- npm
- 可用的注册代理
- Hotmail/Outlook OAuth 邮箱，或受支持的 HTTP 取件接口

## 安装

从源码运行：

```bash
git clone https://github.com/akihitohyh/at-maker.git
cd at-maker
npm install
cp config.example.json config.json
```

也可以从 [Releases](https://github.com/akihitohyh/at-maker/releases) 下载已包含 `bundle/` 的发布包。发布包仍需执行 `npm install --omit=dev` 安装运行依赖。

## 配置

编辑 `config.json`：

```json
{
  "defaultProxyUrl": "http://user:pass@host:port",
  "defaultPassword": "change-me",
  "loopDelayMs": 1000
}
```

| 字段 | 说明 |
| --- | --- |
| `defaultProxyUrl` | 注册请求使用的 HTTP、HTTPS 或 SOCKS5 代理 |
| `defaultPassword` | 注册账号使用的默认密码，请在运行前修改 |
| `loopDelayMs` | 批次之间的等待时间，单位为毫秒 |

不要提交 `config.json`、邮箱池或生成的 token。项目的 `.gitignore` 已默认忽略这些文件。

## 邮箱池

将邮箱账号写入 `hotmail/tokens.txt`，每行一个。OAuth 与 API 取件格式可以混用。

### OAuth

```text
邮箱----密码----client_id----refresh_token
```

WebUI 可选择以下接码模式：

| 模式 | 说明 |
| --- | --- |
| 自动 | 根据 token scope 和 token 类型选择 IMAP 或 Graph |
| IMAP | 适合具有 Outlook IMAP 权限的消费级账号 |
| Graph | 需要 Microsoft Graph `Mail.Read` 权限 |

### API 取件

```text
邮箱----https://mailapi.icu/key?type=html&orderNo=订单号
```

也支持以下兼容格式，其中中间字段会被忽略：

```text
邮箱----任意字段----https://mailapi.icu/key?type=html&orderNo=订单号
```

程序会识别行中的 HTTP(S) URL。对于 `mailapi.icu`，`type=html` 会在取件时转换为 `type=json`，便于解析验证码。

## 邮箱别名

WebUI 中填写“别名后缀”即可启用 Outlook `+alias` 地址：

```text
user@outlook.com + 后缀 1 -> user+1@outlook.com
```

- 留空：使用原邮箱
- 固定后缀：每次使用相同别名
- 随机后缀：在固定后缀后追加随机字符串
- API 取件：注册时使用别名地址，验证码仍通过原邮箱对应的取件 URL 获取

使用别名前，请确认邮箱服务商会将 `+alias` 邮件投递到基础邮箱。

## WebUI

开发模式：

```bash
npm run dev:web
```

构建并运行：

```bash
npm run build
npm run start:web
```

默认地址为 `http://localhost:8318`。可以使用 `PORT` 环境变量覆盖端口：

```bash
PORT=5800 npm run start:web
```

WebUI 支持保存配置、更新邮箱池、并发运行、立即停止和下载汇总 token。

## CLI

```bash
npm run dev
npm run dev -- --n 10
npm run dev -- --n 100 --threads 10
```

使用构建版本：

```bash
npm run build
npm run start -- --n 10 --threads 2
```

## 输出文件

- `auth/at/*.json`：每个成功账号的认证数据
- `auth/access_tokens.txt`：access token 汇总

这些文件包含敏感凭据。不要上传、提交或发送给不受信任的第三方。

## 发布包

发布包包含：

- `src/` TypeScript 源码
- `public/` WebUI
- `bundle/` 已构建的 CLI 和 WebUI 入口
- `package.json` 与 `package-lock.json`
- 示例配置和空的运行目录

发布包不包含 `node_modules`、真实配置、邮箱账号、订单号、代理凭据或 token。

## v0.0.3

- 新增 HTTP API 取件及 API 响应解析
- API 取件支持固定别名和随机别名
- OAuth 与 API 邮箱可在同一邮箱池中混用
- 改进验证码基线、轮询、旧码过滤和错误码重试
- 增加 IMAP 会话复用及 Graph/IMAP 自动选择
- 增加注册任务立即停止和请求中断
- 更新 WebUI 接码模式、邮箱池和别名配置
- 整理发布包与 README，排除运行凭据和临时文件

## 致谢

<https://linux.do>
