# sync-agent（到货管家 Windows 同步端）

本包只从用户已经登录的拼多多可见网页低频读取订单，dry-run 预览后把规范化批次
上传到到货管家自己的 `/api/sync/v1/batches`。1688 已迁移到后端官方 Open API；本包不调用
1688 浏览器同步，也不调用任何平台官方 API、OAuth、抓包或验证码绕过。完整边界见
[`docs/BROWSER_SYNC_SPEC.md`](../docs/BROWSER_SYNC_SPEC.md)。

## 当前进度（自动化代码完成，Windows 真机验收待执行）

已实现：

- 统一订单/批次模型与客户端校验（`src/models.ts`）；
- 纯函数字符串/日期/数量规范化（`src/normalize.ts`）；
- 本机配置加载与脱敏展示，配置错误 fail-closed（`src/config.ts`）；
- 平台游标按 `(platform, account_key)` 原子读写、单实例锁、脱敏 JSON Lines 日志（`src/state/`、`src/log.ts`）；
- 内部批次传输客户端（`src/transport.ts`：401/403/409/422 不重试；429/5xx 有限退避；`Retry-After ≥ 60s` 直接放弃）；
- `doctor --offline`、`login-check`、`capture-page`、`sync-once --mode dry-run|commit --from-report`（`src/cli.ts`）；
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

- 按 [`docs/SYNC_MANUAL_ACCEPTANCE.md`](../docs/SYNC_MANUAL_ACCEPTANCE.md) 在 Windows 真机上仅对 PDD 执行：login-check 手工登录 → dry-run 20–30 条真实订单 → 核对报告 → commit --from-report；1688 改在服务器按 [`docs/ALI1688_OPEN_API.md`](../docs/ALI1688_OPEN_API.md) 验收；
- 真实页面结构不一致时程序会以 `SCHEMA_CHANGED` 熔断，需按真实页面调整对应 adapter 选择器并补充脱敏 fixture 后重新跑测试；
- PDD 手工验收通过后才评估 Task Scheduler；1688 是否定时由 backend 的独立配置控制。

本包在开发机上不连接真实平台页面；`doctor` 的非离线模式只检查本机 Chromium 是否可启动。

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
npm run login-check -- --platform pdd
npm run sync-once -- --platform pdd --mode dry-run
npm run sync-once -- --platform pdd --mode commit --from-report .\state\snapshot-pdd-pdd-main-<batch_id>.json --yes
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
PDD_ACCOUNT_KEY=pdd-main
SYNC_MAX_PAGES=5
SYNC_MAX_RECORDS=30
SYNC_PAGE_DELAY_MS=2500
SYNC_MIN_INTERVAL_MINUTES=15
ARRIVAL_STATE_DIR=state
ARRIVAL_LOG_DIR=logs
```

- 安全下限/上限：`SYNC_PAGE_DELAY_MS` 最小 1500（不可关闭）、`SYNC_MAX_PAGES` 1–5、
  `SYNC_MIN_INTERVAL_MINUTES` 最小 1（定时同步不允许 0）；默认值：`SYNC_MAX_PAGES=5`、
  `SYNC_MAX_RECORDS=30`（上限 100，与单批接收上限一致）、`SYNC_PAGE_DELAY_MS=2500`、`SYNC_MIN_INTERVAL_MINUTES=15`；
- 平台页面冷却在浏览器启动前预留；进程崩溃也不会立刻重试。同一账号刚执行完 `login-check`
  时，需等待冷却结束才能 dry-run；若 profile 已登录，应直接执行一次 dry-run，避免重复打开订单页；
- 游标与锁按 `(platform, account_key)` 隔离；`*_ACCOUNT_KEY` 强制规范化为小写，且两个平台必须不同；
  切换账号时修改对应 `*_ACCOUNT_KEY` 即可，不会复用旧账号游标；
- 配置值“设置了但非法”会直接报错退出（fail-closed），不会静默回退默认值；
- 只有 PDD 需要浏览器 profile；1688 授权配置和游标由后端管理；
- worker key 的明文只保存在 Windows 本机受 ACL 保护的 `.env.local` 和服务器受限 `.env`；
  数据库只保存其摘要，日志和输出中始终脱敏；
- 公网隧道使用时 `ARRIVAL_API_BASE_URL` 必须为 `https://`。

## 目录

```text
src/
  cli.ts          doctor / login-check / capture-page / sync-once 命令入口
  config.ts       本机配置（fail-closed），不含密码/Cookie
  models.ts       统一订单与批次类型、校验
  normalize.ts    纯函数规范化
  transport.ts    到货管家内部批次接口客户端（响应校验、有限重试）
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
  这些文件只属于本机，严禁分享、截图外发或提交 Git（已被 .gitignore 排除）。
- `state\diagnostics\structure-*.json` 不含自由文本、原始 class、属性值或 URL 路径，但分享前仍应
  人工检查；POSIX 使用 `0700/0600`，Windows 必须按安装教程用 NTFS ACL 限制 `state`/`logs`。
- `logs\sync-agent.jsonl` 已自动脱敏，但报告文件是明文业务数据，处理时按真实订单对待。

## 安全红线


- 密码、Cookie、登录态、profile 永远只留在 Windows 本机，不上传、不提交 Git、不写日志；
- 日志采用 JSON Lines 并自动打码 Authorization/手机号/长数字串/敏感键名；
- 同一平台同一 profile 同时只允许一个同步进程（lock 文件）；
- 只读、低频、手动确认；`login-check` 只保留可见窗口供用户本人处理验证，任何 dry-run/capture
  检测到验证码或风控都会立即熔断，不点击、不刷新、不重试。
- 1688 不在本 Windows agent 中运行；后端 API 的网络/429/5xx 重试和风控错误见
  [`docs/ALI1688_OPEN_API.md`](../docs/ALI1688_OPEN_API.md)。
