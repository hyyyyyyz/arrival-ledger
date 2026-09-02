# sync-agent（到货管家可见浏览器拼多多同步端）

本包只从用户已经登录的拼多多可见网页低频读取订单，dry-run 预览后把规范化批次
上传到到货管家自己的 `/api/sync/v1/batches`。1688 已迁移到后端官方 Open API；本包不调用
1688 浏览器同步，也不调用任何平台官方 API、OAuth、抓包或验证码绕过。完整边界见
[`docs/BROWSER_SYNC_SPEC.md`](../docs/BROWSER_SYNC_SPEC.md)。

## 当前进度（多账号第一阶段代码完成，真实账号手工验收待执行）

已实现：

- 统一订单/批次模型与客户端校验（`src/models.ts`）；
- 纯函数字符串/日期/数量规范化（`src/normalize.ts`）；
- 本机配置加载与脱敏展示，配置错误 fail-closed（`src/config.ts`）；
- 可选的拼多多多账号清单：每个账号使用独立 `account_key`、浏览器 profile、锁、访问冷却和游标；
  配置文件拒绝未知字段、重复账号/目录、符号链接、危险权限和非法路径；未配置清单时继续兼容原来的
  `PDD_ACCOUNT_KEY` + `PDD_PROFILE_DIR` 单账号方式；
- 平台游标按 `(platform, account_key)` 原子读写、单实例锁、脱敏 JSON Lines 日志（`src/state/`、`src/log.ts`）；
- 内部批次传输客户端（`src/transport.ts`：401/403/409/422 不重试；429/5xx 有限退避；`Retry-After ≥ 60s` 直接放弃）；
- `doctor --offline`、`accounts`、`login-check`、`capture-page`、`sync-once --mode dry-run|commit --from-report`、
  `sync-all --mode dry-run`（`src/cli.ts`）；
- 多账号 `sync-all` 严格按 JSON 数组顺序串行执行，绝不并发打开多个拼多多账号；单个账号出现
  `NEEDS_LOGIN`、验证码/风控、页面变化或网络错误时继续记录后续账号，但整个命令最终返回非零；
- `login-check` 和每次 dry-run 会尽力把账号状态上报到到货管家的
  `/api/sync/v1/account-status`。没有 worker key 或状态接口暂时不可用只产生警告，不影响本机报告，
  也不会输出 worker key；
- 同步编排 `src/run.ts`：dry-run 不上传并落盘私有 snapshot；commit 只上传 snapshot 字节、
  绝不重新打开网页；`--yes` 缺失、快照完整性校验失败、超过 30 分钟 TTL、或快照 cursor_before
  与当前游标不一致都会拒绝并要求重新 dry-run；空列表不覆盖服务器数据；所有会打开平台页面的
  `login-check`、`capture-page`、dry-run 共用按账号冷却（默认 15 分钟，预留在浏览器启动前落盘）；
- 历史 1688 适配器代码与 fixture 仍保留用于兼容性测试；1688 的 operational CLI 已禁用，
  请改用后端官方 API（见 [`docs/ALI1688_OPEN_API.md`](../docs/ALI1688_OPEN_API.md)）；
- 单次 `capture-page` 诊断：只加载一页，保存固定标签、捕获内匿名 class、ARIA 名称和结构标记，不保存原始 HTML、
  自由文本、截图、Cookie、表单值、URL query，也不翻页或进入详情；
- 拼多多订单页适配器（卡片式结构：标签提取 + 结构化 class 兜底，`加载更多` 分页）；
- 跨语言契约锁定：TS 序列化 golden fixture 与后端 pytest 直接互验（`tests/fixtures/batch_contract.json`）；
- 契约级端到端测试：真实 HTTP 模拟服务器验证上传、幂等重放、409、401、429 与游标推进。

待手工验收（唯一剩余项）：

- 按 [`docs/PDD_MULTI_ACCOUNT.md`](../docs/PDD_MULTI_ACCOUNT.md) 和
  [`docs/SYNC_MANUAL_ACCEPTANCE.md`](../docs/SYNC_MANUAL_ACCEPTANCE.md) 在实际 Mac/Windows 同步电脑或本文所述
  受控 Linux X display 上仅对 PDD 执行：逐账号 login-check 手工登录 → dry-run 20–30 条真实订单 → 核对报告 → 单账号
  commit --from-report；1688 改在服务器按 [`docs/ALI1688_OPEN_API.md`](../docs/ALI1688_OPEN_API.md) 验收；
- 真实页面结构不一致时程序会以 `SCHEMA_CHANGED` 熔断，需按真实页面调整对应 adapter 选择器并补充脱敏 fixture 后重新跑测试；
- PDD 手工验收通过后才评估系统计划任务；1688 是否定时由 backend 的独立配置控制。

本包在开发机上不连接真实平台页面；`doctor` 的非离线模式只检查本机 Chromium 是否可启动。

## 环境要求

- Node.js 20 LTS（或更高）；
- macOS、Windows 10/11，或带受控 X display 的 Linux；同步时必须能看到真实浏览器窗口；
- Linux Server 只能按本文“Linux 服务器人工试验”配置 Xvfb/noVNC。没有 `DISPLAY` 的纯无头模式仍不支持。

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
npm run accounts -- --platform pdd              # 列出账号，不启动浏览器
npm run login-check -- --platform pdd --account pdd-main
npm run login-check -- --platform pdd --account pdd-main --wait-seconds 900 # SSH/noVNC：无需终端按 Enter
npm run sync-once -- --platform pdd --account pdd-main --mode dry-run
npm run sync-once -- --platform pdd --account pdd-main --mode commit --from-report .\state\snapshot-pdd-pdd-main-<batch_id>.json --yes
npm run sync-all -- --platform pdd --mode dry-run # 严格串行检查全部账号；不支持 commit
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
PDD_ACCOUNTS_FILE=C:/ArrivalLedger/config/pdd-accounts.json
SYNC_MAX_PAGES=5
SYNC_MAX_RECORDS=30
SYNC_PAGE_DELAY_MS=2500
SYNC_MIN_INTERVAL_MINUTES=15
ARRIVAL_STATE_DIR=state
ARRIVAL_LOG_DIR=logs
# Linux 服务器使用 Xvfb 时设置：PDD_BROWSER_DISPLAY=:99
# 二选一；通常都不设置，使用 Playwright 随包 Chromium
# PDD_BROWSER_CHANNEL=chrome
# PDD_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
```

### 拼多多多账号配置

默认仍在运行同步端的 Mac/Windows 上保留真实、可见、持久化的 Playwright profile；受控 Linux
服务器试验也必须把 profile 保存在运行同步端的专用本地目录。无论运行位置，服务端业务 API 都只接收
规范化订单和账号状态，不接收 Cookie、localStorage 或 profile。创建
`C:\ArrivalLedger\config\pdd-accounts.json`：

```json
{
  "schema_version": 1,
  "accounts": [
    {
      "account_key": "pdd.main",
      "display_label": "拼多多采购主账号",
      "profile_dir": "../profiles/pdd-main"
    },
    {
      "account_key": "pdd.backup",
      "display_label": "拼多多采购备用账号",
      "profile_dir": "../profiles/pdd-backup"
    }
  ]
}
```

- `account_key` 会转成小写，须以字母或数字开头，只能包含小写字母、数字、`.`、`_`、`-`，最长 64；
- `display_label` 可省略，最长 128，只用于到货管家展示；它会随 dry-run snapshot/commit 批次和
  账号状态一起发送，但不会用于文件名或账号识别；
- `profile_dir` 相对路径以 JSON 文件所在目录为基准；每个账号必须唯一，不能指向文件系统根目录、
  普通文件，且路径任一已有父组件都不能是符号链接或 Windows junction。程序按最近已有父目录的
  native realpath 计算最终路径并去重，Chromium 真正启动前还会再次复检。目录不存在时
  `login-check` 会以 POSIX `0700` 创建；profile 根目录及其父目录必须只有当前 OS 用户可写，
  已有目录建议执行 `chmod 700 <profile_dir>`；
- JSON 只能包含示例中的字段，最多 50 个账号。POSIX 建议 `chmod 600 pdd-accounts.json`；Windows
  请用 NTFS ACL 只授权运行同步端的用户；
- JSON 数组顺序就是 `sync-all` 顺序。程序在一个进程内严格串行，任何时候只打开一个账号；不要同时
  启动多个 `sync-all`，也不要让两个账号共用 profile；
- 第一次逐个执行 `login-check --account <key>`，由本人处理扫码、短信或验证码。程序不填写密码、
  不扫描二维码、不读取 Cookie/storage；之后可用 `sync-all --mode dry-run` 顺序检查所有账号；
- 当前 `sync-all` 故意只支持 dry-run。每个账号生成独立 snapshot，人工核对后再逐个执行带
  `--account` 和 `--from-report` 的 `sync-once --mode commit --yes`。

管理员网页中的“拼多多账号”只登记相同的稳定 `account_key` 和显示名称，并展示同步器上报的状态；
网页不会保存 `profile_dir`、密码、Cookie 或登录态，也不会远程启动浏览器。Linux 服务器试验的 noVNC、
X display 和 CLI 由服务器管理员通过 SSH 管理；网页控制浏览器、Cookie 注入和定时 dry-run/commit 均未实现。

### 浏览器运行配置

- 默认不配置选择器，使用 `npx playwright install chromium` 安装的 Playwright Chromium；
- `PDD_BROWSER_CHANNEL=chrome` 可选择 Playwright 支持的已安装 Chrome/Edge channel；
- `PDD_BROWSER_EXECUTABLE_PATH=/绝对路径` 可选择 Chromium 系可执行文件；它与 channel 互斥；
- Linux 可用 `PDD_BROWSER_DISPLAY=:99` 指定 Xvfb display。未设置时继承进程的 `DISPLAY`；
- 同步始终是 `headless: false`。这些配置不会启用隐藏浏览器，也不会改变验证码人工处理边界；
- 浏览器子进程不会继承名称含 `TOKEN`、`SECRET`、`PASSWORD`、`CREDENTIAL` 的环境变量或
  `ARRIVAL_SYNC_WORKER_KEY`，但会保留 `PATH`、`HOME`、`DISPLAY` 等运行所需变量；
- 非离线 `doctor` 会用临时 profile 真实启动并关闭一次同样的可见 persistent browser，但不会访问拼多多。

## Linux 服务器人工试验

这条路径用于先验证服务器 IP、真实页面结构和登录风控，暂不代表可以无人值守。建议使用专用、非 root
系统用户运行同步端，并把账号清单、profiles、state、logs 都放在该用户的私有目录（目录 `0700`，文件
`0600`）。不要复用到货管家后端容器，也不要把 profile 加入服务器常规备份。

1. 安装 Node.js 20+，在 `sync-agent` 执行：

   ```bash
   npm ci
   npx playwright install --with-deps chromium
   ```

2. 在服务器启动一个持久 Xvfb display、轻量窗口管理器和 VNC/noVNC。VNC 与 noVNC 必须只监听
   `127.0.0.1`，并设置 VNC 密码；禁止把 5900/6080 直接开放到公网。示意拓扑：

   ```text
   Chromium (DISPLAY=:99) → Xvfb :99 → x11vnc 127.0.0.1:5900
                                          ↑
   Mac 浏览器 ← SSH tunnel 6080 ← noVNC 127.0.0.1:6080
   ```

3. Mac 建立 SSH 隧道后再打开 noVNC：

   ```bash
   ssh -L 6080:127.0.0.1:6080 <server-user>@<server-ip>
   ```

   浏览器只访问 `http://127.0.0.1:6080/vnc.html`。SSH 连接断开后入口随即不可达。

4. 在服务器的 `.env.local` 设置 `PDD_BROWSER_DISPLAY=:99`，然后验证真实可见启动：

   ```bash
   npm run doctor -- --platform pdd
   npm run accounts -- --platform pdd
   ```

   `doctor` 必须显示 `headed chromium: OK`。只运行 `doctor --offline` 不能证明 X display 可用。

5. noVNC 窗口保持打开，服务器终端执行：

   ```bash
   npm run login-check -- --platform pdd --account pdd-main --wait-seconds 900
   ```

   程序只轮询当前页面的可见 DOM，最多等待 900 秒；不会刷新页面、填写账号、扫描二维码或处理验证码。
   登录完成会提前退出；超时会关闭浏览器并保留 profile，下次等待账号冷却后重试。交互式 SSH 终端也可
   省略 `--wait-seconds`，完成登录后按 Enter。

6. 首次只验证一个账号。等页面访问冷却结束后执行一次 `dry-run`，人工检查报告，再在 30 分钟内按原
   命令 commit。服务器 IP 若出现风控或验证码，立即停止，不连续重试，回退到 Mac/Windows 同步电脑。

当前仍没有 `sync-all --mode commit`、后台自动确认或无人值守登录。真实单账号稳定验收完成前，不要添加
systemd 定时任务。

兼容旧安装：如果没有设置 `PDD_ACCOUNTS_FILE`，原来的 `PDD_ACCOUNT_KEY`、`PDD_PROFILE_DIR` 和
不带 `--account` 的命令保持原样。设置多账号文件后，若清单包含多个账号，单账号命令必须明确传
`--account`，防止误用其他账号 profile。

- 安全下限/上限：`SYNC_PAGE_DELAY_MS` 最小 1500（不可关闭）、`SYNC_MAX_PAGES` 1–5、
  `SYNC_MIN_INTERVAL_MINUTES` 最小 1（账号访问冷却不允许 0）；默认值：`SYNC_MAX_PAGES=5`、
  `SYNC_MAX_RECORDS=30`（上限 100，与单批接收上限一致）、`SYNC_PAGE_DELAY_MS=2500`、`SYNC_MIN_INTERVAL_MINUTES=15`；
- 平台页面冷却在浏览器启动前预留；进程崩溃也不会立刻重试。同一账号刚执行完 `login-check`
  时，需等待冷却结束才能 dry-run；若 profile 已登录，应直接执行一次 dry-run，避免重复打开订单页；
- 游标、锁和访问冷却按 `(platform, account_key)` 隔离；账号键强制规范化为小写，且不能与 1688
  账号键冲突；多账号必须用 `--account <key>` 选择，不会复用其它账号的 profile 或游标；
- 账号状态只在实际读到平台页面状态后上报；本地锁、冷却或配置失败不会把已有登录状态覆盖成
  `DISABLED`。只有可靠的 `OK` 结果携带订单数，失败结果不会用 `0` 覆盖上次可靠数量；
- 崩溃遗留的死进程主锁会安全回收；空白或损坏主锁先保留 30 秒以避开另一个进程正在写入的窗口，
  超时后通过独占回收守卫和原子改名清理。`*.lock.reclaim` 回收守卫严格禁止自动删除：若 doctor
  报告它存在，必须先人工确认所有 sync-agent 进程均已退出，再手工删除对应守卫文件并重新运行；
- 配置值“设置了但非法”会直接报错退出（fail-closed），不会静默回退默认值；
- 只有 PDD 需要浏览器 profile；1688 授权配置和游标由后端管理；
- worker key 的明文只保存在同步电脑受权限保护的 `.env.local` 和服务器受限 `.env`；
  数据库只保存其摘要，日志和输出中始终脱敏；
- 经公网访问到货管家 API 时 `ARRIVAL_API_BASE_URL` 必须为 `https://`；与后端位于同一台服务器、同一条
  私有 Docker 网络时可使用内部地址 `http://backend:8000`。

## 目录

```text
src/
  cli.ts          doctor / accounts / login-check / capture-page / sync-once / sync-all 命令入口
  config.ts       本机配置（fail-closed），不含密码/Cookie
  models.ts       统一订单与批次类型、校验
  normalize.ts    纯函数规范化
  transport.ts    到货管家内部批次接口客户端（响应校验、有限重试）
  pdd_multi.ts    PDD 多账号严格串行编排与账号状态尽力上报
  snapshot.ts     dry-run 私有快照（payload hash 完整性校验，30 分钟 TTL）
  login_check.ts  手工登录等待与状态复检流程
  capture_page.ts 单次列表结构诊断流程（零详情/零分页）
  run.ts          dry-run / commit 编排、游标推进、低频限制
  log.ts          JSON Lines 日志（自动脱敏）
  state/
    redact.ts     敏感字段打码
    lock.ts       单实例锁（按 platform + account_key 互斥）
    cursor.ts     游标原子读写（按 platform + account_key 隔离）
    platform_access.ts 平台页面访问预留与按账号冷却
  browser/
    context.ts    persistent headed context
    dom.ts        标签提取 + 结构化兜底字段提取
    guards.ts     登录/验证码/页面状态守卫
  diagnostics/
    dom_capture.ts 只保留结构证据的严格清洗器
  adapters/
    base.ts       适配器契约
    ali1688.ts    历史 1688 只读适配器（operational CLI 已禁用）
    pdd.ts        拼多多只读适配器（标签提取 + class 兜底）
  extract/
    text.ts       标签/文本纯函数
    dates.ts      日期解析
    tracking.ts   运单号规范化
    order.ts      RawOrder -> UnifiedOrder 严格转换
tests/            脱敏 fixture 与单元/适配器测试
```

## 隐私警告

- `state\report-*.json` 与 `state\snapshot-*.json` 包含**真实订单号、商品标题和运单号**；
  这些文件只属于实际同步运行端，严禁分享、截图外发或提交 Git（已被 .gitignore 排除）。
- `state\diagnostics\structure-*.json` 不含自由文本、原始 class、属性值或 URL 路径，但分享前仍应
  人工检查；POSIX 使用 `0700/0600`，Windows 必须按安装教程用 NTFS ACL 限制 `state`/`logs`。
- `logs\sync-agent.jsonl` 已自动脱敏，但报告文件是明文业务数据，处理时按真实订单对待。

## 安全红线


- 密码、Cookie、登录态、profile 永远只留在实际同步运行端，不进入后端 API/业务数据库、不提交 Git、
  不写日志；桌面端 profile 不复制到 Linux，服务器 profile 只通过服务器官方登录页生成；
- 日志采用 JSON Lines 并自动打码 Authorization/手机号/长数字串/敏感键名；
- 同一平台同一 profile 同时只允许一个同步进程（lock 文件）；
- 只读、低频、手动确认；`login-check` 只保留可见窗口供用户本人处理验证，任何 dry-run/capture
  检测到验证码或风控都会立即熔断，不点击、不刷新、不重试。
- 1688 不在本同步端中运行；后端 API 的网络/429/5xx 重试和风控错误见
  [`docs/ALI1688_OPEN_API.md`](../docs/ALI1688_OPEN_API.md)。
- Linux 服务器只允许通过回环地址 + SSH 隧道访问管理员自行配置的 noVNC；产品网页不会暴露或控制它。
  没有 Cookie 注入或定时 commit；不要用自建脚本绕开 dry-run → 人工核对 → commit。
