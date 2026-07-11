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
```

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

## 致谢
<https://linux.do>
