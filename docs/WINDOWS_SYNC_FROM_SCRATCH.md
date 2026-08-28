# Windows 11：拼多多浏览器同步从零测试

本文只用于拼多多。1688 已迁移到服务器官方 Open API，Windows 不安装、不登录、不运行 1688
同步；请改看 [`ALI1688_OPEN_API.md`](ALI1688_OPEN_API.md)。

本轮先完成安装、自检、手工登录和只读 `dry-run`，不要立即启用定时任务或提交真实批次。

## 1. 安装和下载

安装 [Git for Windows](https://git-scm.com/download/win) 和 Node.js 20 LTS 或更高版本，重新打开
PowerShell：

```powershell
node -v
npm.cmd -v
git --version
New-Item -ItemType Directory -Force C:\ArrivalLedger | Out-Null
Set-Location C:\ArrivalLedger
git clone --branch codex/1688-open-api-mvp https://github.com/hyyyyyyz/arrival-ledger.git app
Set-Location .\app\sync-agent
npm.cmd ci
npx.cmd playwright install chromium
```

如果该目录已存在，使用 `git fetch origin`、`git switch codex/1688-open-api-mvp` 和
`git pull --ff-only` 更新，不要删除 `profiles`、`state` 或 `logs`。

## 2. 创建独立 PDD profile

```powershell
New-Item -ItemType Directory -Force C:\ArrivalLedger\profiles\pdd, .\state, .\logs | Out-Null
```

程序使用 Playwright 自带 Chromium 的 headed 窗口，不会替换或影响日常 Chrome、Chrome Sync、书签或
其它配置。不要使用日常 Chrome 的 User Data 目录，也不要创建或配置 1688 profile。

创建本机私密配置（`ARRIVAL_SYNC_WORKER_KEY` 仅在准备上传时再补）：

```powershell
@'
ARRIVAL_API_BASE_URL=http://192.168.1.5:8766
ARRIVAL_WORKER_ID=win-arrival-01
ARRIVAL_SYNC_WORKER_KEY=
PDD_PROFILE_DIR=C:/ArrivalLedger/profiles/pdd
PDD_ACCOUNT_KEY=pdd-main
SYNC_MAX_PAGES=3
SYNC_MAX_RECORDS=30
SYNC_PAGE_DELAY_MS=2500
SYNC_MIN_INTERVAL_MINUTES=15
ARRIVAL_STATE_DIR=state
ARRIVAL_LOG_DIR=logs
'@ | Set-Content -Encoding UTF8 .env.local
```

为 profile、配置、报告和日志设置当前用户专属 ACL；至少不要让其它 Windows 用户读取：

```powershell
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls C:\ArrivalLedger\profiles /inheritance:r /grant:r "${currentUser}:(OI)(CI)F"
icacls .\.env.local /inheritance:r /grant:r "${currentUser}:F"
icacls .\state /inheritance:r /grant:r "${currentUser}:(OI)(CI)F"
icacls .\logs /inheritance:r /grant:r "${currentUser}:(OI)(CI)F"
```

密码、短信/二维码内容、Cookie、截图、完整报告不得粘贴到聊天或提交 Git。

## 3. 自检和测试

```powershell
npm.cmd run doctor -- --offline
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run doctor
```

`doctor --offline` 不启动浏览器、不联网；普通 `doctor` 只检查本地浏览器能否启动。任何 `FAIL`
都先修复，不要继续访问平台。

## 4. 手工登录

```powershell
npm.cmd run login-check -- --platform pdd
```

程序打开可见窗口后，只在拼多多官方页面手工登录，确认进入“我的订单”，再回 PowerShell 按 Enter。
程序不自动填写密码、不处理验证码/滑块、不读取 Cookie。

- `NEEDS_LOGIN`：在窗口内完成登录后按 Enter 复检。
- `CAPTCHA_OR_BLOCKED` 或“系统繁忙”：停止操作，不刷新、不连续重试、不绕过风控；冷却后由账号持有人
  重新运行一次 `login-check`。
- 成功后 profile 保存在 `C:\ArrivalLedger\profiles\pdd`。

## 5. PDD dry-run（只读）

确认页面访问冷却已满足（默认 15 分钟；如果刚刚完成 login-check，等待冷却），只执行一次：

```powershell
npm.cmd run sync-once -- --platform pdd --mode dry-run
```

程序最多读取 3 页/30 条订单，生成仅本机可读的 `state\report-pdd-*.json` 和
`state\snapshot-*.json`。报告包含真实订单号、商品和运单号，不能发给任何人。核对数量、订单号、
店铺、商品、规格、数量、状态和页面可见物流；空列表先核对账号与筛选条件，不得覆盖服务器已有数据。

遇到 `SCHEMA_CHANGED`、`NEEDS_LOGIN`、`CAPTCHA_OR_BLOCKED` 或 `NETWORK_ERROR`，不要运行 commit，
记录脱敏状态并等待处理。dry-run 不上传服务器、不修改平台订单。

## 6. 确认后再 commit（可选）

只有人工核对报告、服务器 worker token 已配置且用户明确同意后，才在同一台 Windows 执行：

```powershell
npm.cmd run sync-once -- --platform pdd --mode commit --from-report .\state\snapshot-pdd-pdd-main-<batch_id>.json --yes
```

commit 只上传 dry-run 快照，不重新打开网页抓取；快照过期（30 分钟）、hash 改变或游标不一致都会拒绝。
同一批次重复提交由服务器幂等处理，不会重复订单/商品/包裹。若只做首次验证，可以停在 dry-run。

## 7. 定时任务、回滚与交接

首次真实同步至少完成一次 dry-run + commit、重复批次幂等、收货单号匹配和停止 worker 后手机收货仍正常，
再评估 Windows Task Scheduler；建议每天 1–2 次，不能并发执行，遇到风控自动停机。定时任务只运行
PDD，绝不能调用 1688。

回滚时先停止任务，保留 `state`/`logs`，恢复仓库上一已验证版本；服务器端按
[`DEPLOYMENT.md`](DEPLOYMENT.md) 的镜像和数据库备份步骤操作。不要 `git reset --hard`、不要删除
照片或数据库。

只回传以下脱敏摘要，不回传报告或订单号：

```text
doctor：0 FAIL
PDD login-check：OK / NEEDS_LOGIN / CAPTCHA_OR_BLOCKED
dry-run：读取 N 条、解析 N 条、失败 N 条、页数 N
字段完整率：订单号 %、商品 %、数量 %、店铺 %、物流 %
commit：未执行 / created / updated / skipped / errors
异常：<状态码和简短原因，不含账号、token、订单号>
```

## 常见错误

- `npm.ps1` 被策略阻止：使用 `npm.cmd`/`npx.cmd`。
- `Chromium executable` 不存在：重新执行 `npx.cmd playwright install chromium`。
- `profile locked`：关闭该 profile 的所有窗口，确保没有并发命令。
- 账号验证失败：停止重试，按平台提示由本人处理，冷却后再试。
