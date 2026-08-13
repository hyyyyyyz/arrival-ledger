# sync-agent（到货管家 Windows 同步端）

从用户已经登录的 1688 / 拼多多可见网页低频读取订单，dry-run 预览后把规范化批次
上传到到货管家自己的 `/api/sync/v1/batches`。本包不调用任何平台官方 API、OAuth、
抓包或验证码绕过。完整边界见仓库根目录 [`docs/BROWSER_SYNC_SPEC.md`](../docs/BROWSER_SYNC_SPEC.md)。

## 当前进度（D1：骨架与离线 doctor）

已实现：

- 统一订单/批次模型与客户端校验（`src/models.ts`）；
- 纯函数字符串/日期/数量规范化（`src/normalize.ts`）；
- 本机配置加载与脱敏展示（`src/config.ts`）；
- 平台游标原子读写、单实例锁、脱敏 JSON Lines 日志（`src/state/`、`src/log.ts`）；
- `doctor --offline` 本地自检命令。

尚未实现（后续阶段）：

- D2 服务器批次接收接口、`transport` 客户端；
- D3/D4 `login-check`、`sync-once` 与 PDD/1688 可见页面适配器（当前命令会明确退出并提示未实现）。

本包不会连接真实平台页面；`doctor` 的非离线模式只检查本机 Chromium 是否可启动。

## 环境要求

- Node.js 20 LTS（或更高）；
- Windows 10/11（运行同步时）或任意平台（开发/测试）。

## 安装

```powershell
cd sync-agent
npm ci
```

## 命令

```powershell
npm run doctor -- --offline                     # 本地自检，不启动浏览器、不联网
npm run doctor                                  # 额外检查本机 Chromium 是否可启动
npm run doctor -- --platform pdd                # 只检查 pdd 一项
npm run login-check -- --platform pdd           # D3/D4 实现（当前会提示未实现）
npm run sync-once -- --platform pdd --mode dry-run
```

检查与测试：

```powershell
npm test
npm run typecheck
npm run build
```

## 配置

包根目录创建 `.env.local`（已被 Git 忽略，不提交）。可选键：

```dotenv
ARRIVAL_API_BASE_URL=http://192.168.1.5:8766
ARRIVAL_SYNC_WORKER_KEY=填入本机密钥，不提交 Git
ARRIVAL_WORKER_ID=win-arrival-01
PDD_PROFILE_DIR=C:/ArrivalLedger/profiles/pdd
ALI1688_PROFILE_DIR=C:/ArrivalLedger/profiles/1688
SYNC_MAX_PAGES=5
SYNC_MAX_RECORDS=30
SYNC_PAGE_DELAY_MS=2500
ARRIVAL_STATE_DIR=state
ARRIVAL_LOG_DIR=logs
```

- 默认值：`SYNC_MAX_PAGES=5`、`SYNC_MAX_RECORDS=30`（上限 500）、`SYNC_PAGE_DELAY_MS=2500`；
- Windows 上默认 profile 目录为 `C:/ArrivalLedger/profiles/<platform>`，其他平台为 `./profiles/<platform>`；
- worker key 只以明文保存在 Windows 本机受 ACL 保护的 `.env.local`，日志和输出中始终脱敏；
- 公网隧道使用时 `ARRIVAL_API_BASE_URL` 必须为 `https://`。

## 目录

```text
src/
  cli.ts          doctor / login-check / sync-once 命令入口
  config.ts       本机配置，不含密码/Cookie
  models.ts       统一订单与批次类型、校验
  normalize.ts    纯函数规范化
  log.ts          JSON Lines 日志（自动脱敏）
  state/
    redact.ts     敏感字段打码
    lock.ts       单实例锁（同平台同 profile 互斥）
    cursor.ts     游标原子读写
  browser/        D3/D4：持久 headed context 与页面守卫
  adapters/       D3/D4：pdd / 1688 只读适配器
tests/            脱敏 fixture 与单元测试
```

## 安全红线

- 密码、Cookie、登录态、profile 永远只留在 Windows 本机，不上传、不提交 Git、不写日志；
- 日志采用 JSON Lines 并自动打码 Authorization/手机号/长数字串/敏感键名；
- 同一平台同一 profile 同时只允许一个同步进程（lock 文件）；
- 只读、低频、手动确认；出现验证码/风控必须停止并人工处理。
