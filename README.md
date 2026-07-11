# AT Maker

自动注册 OpenAI 账号并导出 ChatGPT accessToken（仅 at 模式）。

## 免责声明

本项目仅供学习、研究与接口行为测试使用。使用者应自行确保其用途符合目标平台的服务条款、当地法律法规以及所在网络环境的合规要求。

## 环境要求

- Node.js 20.18+
- 可用代理
- Hotmail/Outlook 邮箱账号

## 快速开始

```bash
npm install
cp config.example.json config.json
# 编辑 config.json 填入代理地址
```

### Hotmail 邮箱

把账号放在 `hotmail/tokens.txt`，格式：

```
邮箱----密码----client_id----refresh_token
```

## CLI 使用

```bash
npm run dev           # 注册 1 个
npm run dev -- --n 10 # 注册 10 个
npm run dev -- --n 100 --threads 10  # 10 线程并发注册 100 个

npm run build && npm run start -- --n 10
```

## WebUI 使用

```bash
npm run dev:web
# 打开 http://localhost:8318
# 生产：npm run build && npm run start:web
# 默认端口 8318，可用环境变量 PORT 覆盖
```

### 接码模式

WebUI 支持三种邮箱读信模式：

| 模式 | 说明 |
|------|------|
| **自动（推荐）** | 根据 token scope 自动选择 IMAP / Graph |
| **IMAP** | 适合 Outlook/Hotmail 消费级 token（`outlook.office.com` 权限） |
| **Graph** | 需要 Graph JWT（`graph.microsoft.com/Mail.Read`） |

多数卖家号只有 IMAP 权限，请使用 **自动** 或 **IMAP**。

## 配置

```json
{
  "defaultProxyUrl": "http://user:pass@host:port",
  "defaultPassword": "your-password",
  "loopDelayMs": 1000
}
```

## 输出

- `auth/at/` — 每个账号一个 JSON 文件，包含 accessToken
- `auth/access_tokens.txt` — 所有 accessToken 汇总

## 更新记录

### 2026-07-11 — v2.1.0

#### 邮箱验证码（IMAP / Graph）

- **自动接码模式**：根据 token scope / 是否 JWT 自动走 IMAP 或 Graph，Graph 失败可回退 IMAP
- **IMAP 连接池**：复用会话，避免每次轮询都重新 CONNECT + AUTH
- **代理支持**：IMAP 支持 HTTP CONNECT 与 SOCKS5（使用注册代理 `REGISTRATION_PROXY_URL`）
- **OTP 基线（baseline）**：发码前快照邮箱，避免提交历史验证码
- **MIME 解码修复**：正确 UTF-8 quoted-printable 解码中文 OpenAI 邮件（`你的 ChatGPT 临时验证码`）
- **验证码提取增强**：中英文模板、过滤 MIME 头噪声与日期伪码（如 `202612`）
- **错误码自动重试**：`wrong_email_otp_code` 时标记旧码并继续等待新邮件
- **别名收件匹配**：`user+alias@` 可与 base 邮箱匹配

#### 停止注册

- **立即中断**：停止按钮不再等本轮结束
- HTTP 请求注入 `AbortSignal`，网络重试 / OTP 轮询 / 步骤间隙均可即时 abort
- 中断中的轮次不计入失败

#### WebUI

- 接码模式：自动 / IMAP / Graph
- 停止按钮文案与 SSE `stopped` 事件反馈

#### 依赖

- 新增 `imapflow`（IMAP 读信）

### 更早

- 初始版本：OpenAI 注册 + ChatGPT accessToken 导出（at 模式）
- WebUI 多线程注册、邮箱池、别名后缀
- 旧邮件时间戳过滤（避免复用过期验证码）

## 致谢

<https://linux.do>
