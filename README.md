# 流程终止工具

这是一个为 Cloudflare Pages 重构后的极简版本：

- 一个页面：`public/index.html`
- 一份样式：`public/app.css`
- 一份交互脚本：`public/app.js`
- 一个边缘接口：`functions/api/process.js`

## 本地开发

1. 安装 Wrangler：

```bash
npm install -g wrangler
```

2. 在 Cloudflare Pages 项目或本地 `.dev.vars` 中配置环境变量。

3. 本地启动：

```bash
wrangler pages dev public
```

## 环境变量

- `APP_PASSWORD_SALT`
- `APP_PASSWORD_HASH`
- `SESSION_SECRET`
- `KINGDEE_API_URL`
- `KINGDEE_CLIENT_ID`
- `KINGDEE_CLIENT_SECRET`
- `KINGDEE_USERNAME`
- `KINGDEE_ACCOUNT_ID`
- `KINGDEE_LANGUAGE`（可选，默认 `zh_CN`）

## 生成密码哈希

密码不会明文写入前端。建议使用本地命令生成：

```bash
node -e "const crypto=require('crypto'); const salt='replace-with-random-salt'; const password='replace-with-strong-password'; console.log(crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex'))"
```
