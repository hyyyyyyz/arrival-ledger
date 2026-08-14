# Arrival Ledger：Windows 11 浏览器同步端从零测试教程

## 适用范围

本教程只执行：安装 → 自检 → 手工登录 → `dry-run` 只读测试。

本轮不会上传服务器、不会修改平台订单、不会配置定时任务。

> [!IMPORTANT]
> 1. 当前程序使用 Playwright 自带的 Chromium，不使用系统安装的 Google Chrome。
> 2. 安装 Chromium 不会替换或影响你的 Chrome、Chrome Sync、书签或日常配置。
> 3. 拼多多和 1688 各使用一个独立 profile，因此需要分别手工登录一次。
> 4. 在 Codex 审核真实 `dry-run` 摘要前，不要运行任何 `--mode commit` 命令。

## 1. 安装基础软件

在 Windows 11 安装：

- [Git for Windows](https://git-scm.com/download/win)
- [Node.js LTS](https://nodejs.org/)：必须为 20 或更高版本

安装完成后，关闭并重新打开 PowerShell，执行：

```powershell
node -v
npm.cmd -v
git --version
```

`node -v` 显示 `v20`、`v22` 或更高即可。

## 2. 下载或更新项目

以下命令在普通 PowerShell 中执行，不需要管理员权限。

```powershell
New-Item -ItemType Directory -Force C:\ArrivalLedger | Out-Null
Set-Location C:\ArrivalLedger
Test-Path .\app
```

如果最后显示 `False`，执行：

```powershell
git clone --branch feat/browser-sync-mvp https://github.com/hyyyyyyz/arrival-ledger.git app
Set-Location .\app\sync-agent
git branch --show-current
```

如果最后显示 `True`，不要删除原目录，改为执行：

```powershell
Set-Location C:\ArrivalLedger\app
git fetch origin
git switch feat/browser-sync-mvp
git pull --ff-only
Set-Location .\sync-agent
git branch --show-current
```

最终分支应该显示：

```text
feat/browser-sync-mvp
```

## 3. 安装依赖和 Chromium

确认当前目录为 `C:\ArrivalLedger\app\sync-agent`，然后执行：

```powershell
Set-Location C:\ArrivalLedger\app\sync-agent
npm.cmd ci
npx.cmd playwright install chromium
```

如果提示 Chromium executable 不存在，再执行一次：

```powershell
npx.cmd playwright install chromium
```

## 4. 创建两个独立浏览器配置目录

执行：

```powershell
New-Item -ItemType Directory -Force C:\ArrivalLedger\profiles\pdd | Out-Null
New-Item -ItemType Directory -Force C:\ArrivalLedger\profiles\1688 | Out-Null
```

严禁把两个平台设置成同一个目录，也不要使用日常 Chrome 的 User Data 目录。

## 5. 自动创建 `.env.local`

确认仍在 `sync-agent` 目录：

```powershell
Set-Location C:\ArrivalLedger\app\sync-agent
```

把下面整个 PowerShell 区块一次性复制执行，包括开头的 `@'` 和结尾的 `'@`：

```powershell
@'
ARRIVAL_API_BASE_URL=http://192.168.1.5:8766
ARRIVAL_WORKER_ID=win-arrival-01

PDD_PROFILE_DIR=C:/ArrivalLedger/profiles/pdd
ALI1688_PROFILE_DIR=C:/ArrivalLedger/profiles/1688

PDD_ACCOUNT_KEY=pdd-main
ALI1688_ACCOUNT_KEY=1688-main

SYNC_MAX_PAGES=3
SYNC_MAX_RECORDS=30
SYNC_PAGE_DELAY_MS=2500
SYNC_MIN_INTERVAL_MINUTES=15

ARRIVAL_STATE_DIR=state
ARRIVAL_LOG_DIR=logs
'@ | Set-Content -Encoding UTF8 .env.local
```

检查文件：

```powershell
Get-Content .env.local
```

为 profile、配置、报告和诊断文件设置只允许当前 Windows 用户与 SYSTEM 访问的 NTFS ACL：

```powershell
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
New-Item -ItemType Directory -Force .\state, .\logs | Out-Null
icacls C:\ArrivalLedger\profiles /inheritance:r /grant:r "${currentUser}:(OI)(CI)F" /grant:r "*S-1-5-18:(OI)(CI)F"
icacls .\state /inheritance:r /grant:r "${currentUser}:(OI)(CI)F" /grant:r "*S-1-5-18:(OI)(CI)F"
icacls .\logs /inheritance:r /grant:r "${currentUser}:(OI)(CI)F" /grant:r "*S-1-5-18:(OI)(CI)F"
icacls .\.env.local /inheritance:r /grant:r "${currentUser}:F" /grant:r "*S-1-5-18:F"
```

注意：

- 当前故意不设置 `ARRIVAL_SYNC_WORKER_KEY`。
- `dry-run` 不需要 worker key。
- 不要把拼多多或 1688 的密码、Cookie、手机号写入此文件。
- `.env.local` 不要发给别人，也不要提交 Git。

## 6. 运行自检

先运行不启动浏览器的检查：

```powershell
npm.cmd run doctor -- --offline
```

Worker key 未设置和 Chromium 被跳过显示 `WARN` 是正常的，但不能有 `FAIL`。

再运行 Chromium 启动检查：

```powershell
npm.cmd run doctor
```

预期 Chromium 显示 `OK`。

如果 Chromium 是 `FAIL`，执行：

```powershell
npx.cmd playwright install chromium
npm.cmd run doctor
```

## 7. 运行 Windows 本机代码测试

执行：

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

三项全部通过后再继续。若失败，停止并只发送错误文本，不要发送订单报告或登录信息。

## 8. 登录拼多多

执行：

```powershell
npm.cmd run login-check -- --platform pdd
```

操作顺序：

1. 程序会打开可见的 Chromium 窗口。
2. 只在拼多多官方页面内手工登录。
3. 确认页面中已经能看到“我的订单”。
4. 回到 PowerShell，按一次 Enter。
5. 最终状态应为 `OK`。

状态处理：

- `NEEDS_LOGIN`：继续在浏览器内完成登录，再回 PowerShell 按 Enter。
- `CAPTCHA_OR_BLOCKED`：`login-check` 不做任何自动操作，只保留当前可见窗口；如平台允许，
  由你本人完成页面上的人工验证后回 PowerShell 按 Enter。无法通过时按 Ctrl+C，至少等待 12–24 小时，
  不刷新、不连续重试、不绕过验证码。
- 其他状态：停止并记录终端提示；`login-check` 只负责登录/验证状态，不解析订单结构。

登录态只保存在：

```text
C:\ArrivalLedger\profiles\pdd
```

## 9. 登录 1688

执行：

```powershell
npm.cmd run login-check -- --platform 1688
```

操作顺序：

1. 在打开的 Chromium 中手工登录实际采购账号。
2. 确认能看到 1688 买家订单列表。
3. 回到 PowerShell，按一次 Enter。
4. 最终状态应为 `OK`。

> `login-check`、`capture-page` 和 dry-run 共用同一账号的页面访问冷却（默认 15 分钟）。
> 登录成功后不要立刻运行 dry-run，等 15 分钟；如果这个独立 profile 本来已经登录，跳过
> `login-check`，只执行一次 dry-run，避免重复打开订单页。

登录态只保存在：

```text
C:\ArrivalLedger\profiles\1688
```

## 10. 拼多多 `dry-run`（只读，不上传）

执行：

```powershell
npm.cmd run sync-once -- --platform pdd --mode dry-run
```

程序最多读取 3 页、30 条订单，并在 Windows 本机生成报告和快照。

状态处理：

- `OK`：继续检查本地报告。
- `SCHEMA_CHANGED`：安全停止，没有上传；不要运行 commit。
- `NEEDS_LOGIN`：重新执行拼多多 `login-check`。
- `CAPTCHA_OR_BLOCKED`：dry-run 会立即关闭并熔断；不要刷新或立即重跑，人工处理只能通过单独的 `login-check`。
- `DISABLED` / 配置错误：按终端固定错误码检查网络、URL 和本机配置；不要立即连续重跑平台页面。

## 11. 1688 `dry-run`（只读，不上传）

执行：

```powershell
npm.cmd run sync-once -- --platform 1688 --mode dry-run
```

状态判断与拼多多相同。

1688 自动流程严格 list-only：只读取当前订单列表和正常分页，不点击“订单详情”“平台提醒”或
“查看物流”。因此列表不展示运单号时，报告中的 `packages` 为空是预期结果，不代表解析失败。
若返回 `SCHEMA_CHANGED` 且需要结构诊断，等待同一账号 15 分钟冷却后只执行一次：

```powershell
npm.cmd run capture-page -- --platform 1688
```

诊断文件位于 `state\diagnostics`，不含自由文本、原始 class、属性值或真实 URL 路径；分享前仍需
在本机人工检查。命令不会进入详情、翻页或上传。

## 12. 只在 Windows 本机查看报告

> [!WARNING]
> 报告中包含真实订单号、商品和运单号，严禁发送、截图外发或提交 Git。

打开最新拼多多报告：

```powershell
$pddReport = Get-ChildItem .\state\report-pdd-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1
notepad.exe $pddReport.FullName
```

打开最新 1688 报告：

```powershell
$aliReport = Get-ChildItem .\state\report-1688-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1
notepad.exe $aliReport.FullName
```

需要人工抽查：

1. 网页订单数量与报告数量是否一致。
2. 订单号、店铺、商品标题、规格、数量、状态是否正确。
3. 同一订单多个商品是否全部保留。
4. PDD：页面可见的快递公司、运单号和拆包是否完整，纯数字运单号是否保留。
5. 1688：只核对列表字段；列表不展示物流时 `packages=[]` 合格，后续由待认领/人工绑定处理。
6. 是否混入其他订单、隐藏模板或无关页面内容。

## 13. 把脱敏摘要发回

不要发送 report/snapshot 文件、真实订单号、真实运单号或订单截图。

只复制下面模板填写数量和状态：

```text
Windows doctor：0 FAIL，WARN 数量：
Windows 测试：通过 / 失败

拼多多：
login-check：OK / 其他
dry-run 状态：
读取订单数：
解析成功数：
页数：
多商品订单：正确 / 不正确 / 未发现样本
多包裹订单：正确 / 不正确 / 未发现样本
字段完整率大约：
异常信息：

1688：
login-check：OK / 其他
dry-run 状态：
读取订单数：
解析成功数：
页数：
多商品订单：正确 / 不正确 / 未发现样本
packages：有列表可见单号 / 空（允许）
列表字段完整率大约：
异常信息：
```

## 本轮禁止执行

不要执行任何包含以下内容的命令：

```text
--mode commit
--from-report
--yes
```

不要执行：

- 配置 Windows Task Scheduler。
- 自动定时运行。
- 把 profile、`.env.local`、`state` 或 `logs` 上传 Git。
- 把真实报告发给 Codex、DeepSeek、Issue 或聊天群。
- 合并 `main`。
- 部署新的同步后端。

先按页面访问冷却完成两平台 `login-check` 与 dry-run，再根据真实页面结果决定下一步。

## 常见错误

### `node` 或 `git` 不是可识别命令

安装对应软件后，关闭并重新打开 PowerShell。

### `npm.ps1` 被执行策略阻止

使用本教程中的 `npm.cmd` 和 `npx.cmd`，不需要修改 PowerShell 执行策略。

### Chromium executable 不存在

```powershell
npx.cmd playwright install chromium
```

### `profile locked` 或 profile 被占用

关闭该平台由程序打开的所有 Chromium 窗口，确认没有同时运行两个同步命令后重试。

### `NEEDS_LOGIN`

重新执行对应平台 `login-check`，并在可见官方页面中手工登录。

### `CAPTCHA_OR_BLOCKED`

dry-run/capture 会立即停止；不要高频重试或绕过验证码。需要人工处理时，等待冷却后单独运行
`login-check`，只在可见官方页面中由账号持有人完成验证。

### `SCHEMA_CHANGED`

这是安全停止，不会上传。只回报平台、状态、读取数量和脱敏错误摘要。
