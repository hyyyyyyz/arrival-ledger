# sync-agent（到货管家 Windows 同步端）

从用户已经登录的 1688 / 拼多多可见网页低频读取订单，dry-run 预览后把规范化批次
上传到到货管家自己的 `/api/sync/v1/batches`。本包不调用任何平台官方 API、OAuth、
抓包或验证码绕过。完整边界见仓库根目录 [`docs/BROWSER_SYNC_SPEC.md`](../docs/BROWSER_SYNC_SPEC.md)。

## 当前进度（自动化代码完成，Windows 真机验收待执行）

已实现：

- 统一订单/批次模型与客户端校验（`src/models.ts`）；
- 纯函数字符串/日期/数量规范化（`src/normalize.ts`）；
- 本机配置加载与脱敏展示，配置错误 fail-closed（`src/config.ts`）；
- 平台游标按 `(platform, account_key)` 原子读写、单实例锁、脱敏 JSON Lines 日志（`src/state/`、`src/log.ts`）；
- 内部批次传输客户端（`src/transport.ts`：401/403/409/422 不重试；429/5xx 有限退避；`Retry-After ≥ 60s` 直接放弃）；
- `doctor --offline`、`login-check`、`sync-once --mode dry-run|commit --from-report`（`src/cli.ts`）；
- 同步编排 `src/run.ts`：dry-run 不上传并落盘私有 snapshot；commit 只上传 snapshot 字节、
  绝不重新打开网页；`--yes` 缺失、快照完整性校验失败、超过 30 分钟 TTL、或快照 cursor_before
  与当前游标不一致都会拒绝并要求重新 dry-run；空列表不覆盖服务器数据；低频限制（默认 15 分钟）；
- 1688 买家订单页适配器（表头列映射 + 行内标签两种解析模式）；
- 拼多多订单页适配器（卡片式结构：标签提取 + 结构化 class 兜底，`加载更多` 分页）；
- 跨语言契约锁定：TS 序列化 golden fixture 与后端 pytest 直接互验（`tests/fixtures/batch_contract.json`）；
- 契约级端到端测试：真实 HTTP 模拟服务器验证上传、幂等重放、409、401、429 与游标推进。

待手工验收（唯一剩余项）：

- 按 [`docs/SYNC_MANUAL_ACCEPTANCE.md`](../docs/SYNC_MANUAL_ACCEPTANCE.md) 在 Windows 真机上执行：login-check 手工登录 → 各平台 dry-run 20–30 条真实订单 → 核对报告 → commit --from-report；
- 真实页面结构不一致时程序会以 `SCHEMA_CHANGED` 熔断，需按真实页面调整对应 adapter 选择器并补充脱敏 fixture 后重新跑测试；
- 全部通过后才评估 commit 与 Task Scheduler。

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
npm run login-check -- --platform 1688          # 打开可见浏览器检查登录/风控状态；
                                                # 未登录时保持窗口，按 Enter 后重新检测
npm run login-check -- --platform pdd
npm run sync-once -- --platform 1688 --mode dry-run
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
ALI1688_PROFILE_DIR=C:/ArrivalLedger/profiles/1688
PDD_ACCOUNT_KEY=pdd-main
ALI1688_ACCOUNT_KEY=1688-main
SYNC_MAX_PAGES=5
SYNC_MAX_RECORDS=30
SYNC_PAGE_DELAY_MS=2500
SYNC_MIN_INTERVAL_MINUTES=15
ARRIVAL_STATE_DIR=state
ARRIVAL_LOG_DIR=logs
```

- 安全下限/上限：`SYNC_PAGE_DELAY_MS` 最小 1500（不可关闭）、`SYNC_MAX_PAGES` 1–5、
  `SYNC_MIN_INTERVAL_MINUTES` 最小 1（定时同步不允许 0）；默认值：`SYNC_MAX_PAGES=5`、
  `SYNC_MAX_RECORDS=30`（上限 500）、`SYNC_PAGE_DELAY_MS=2500`、`SYNC_MIN_INTERVAL_MINUTES=15`；
- 游标与锁按 `(platform, account_key)` 隔离；`*_ACCOUNT_KEY` 强制规范化为小写，且两个平台必须不同；
  切换账号时修改对应 `*_ACCOUNT_KEY` 即可，不会复用旧账号游标；
- 配置值“设置了但非法”会直接报错退出（fail-closed），不会静默回退默认值；
- PDD 与 1688 的 profile 目录必须不同；Windows 上默认 `C:/ArrivalLedger/profiles/<platform>`，其他平台为 `./profiles/<platform>`；
- worker key 只以明文保存在 Windows 本机受 ACL 保护的 `.env.local`，日志和输出中始终脱敏；
- 公网隧道使用时 `ARRIVAL_API_BASE_URL` 必须为 `https://`。

## 目录

```text
src/
  cli.ts          doctor / login-check / sync-once 命令入口
  config.ts       本机配置（fail-closed），不含密码/Cookie
  models.ts       统一订单与批次类型、校验
  normalize.ts    纯函数规范化
  transport.ts    到货管家内部批次接口客户端（响应校验、有限重试）
  snapshot.ts     dry-run 私有快照（payload hash 完整性校验，30 分钟 TTL）
  login_check.ts  手工登录等待与状态复检流程
  run.ts          dry-run / commit 编排、游标推进、低频限制
  log.ts          JSON Lines 日志（自动脱敏）
  state/
    redact.ts     敏感字段打码
    lock.ts       单实例锁（按 platform + account_key 互斥）
    cursor.ts     游标原子读写（按 platform + account_key 隔离）
  browser/
    context.ts    persistent headed context
    dom.ts        标签提取 + 结构化兜底字段提取
    guards.ts     登录/验证码/页面状态守卫
  adapters/
    base.ts       适配器契约
    ali1688.ts    1688 只读适配器（表头列映射 + 标签提取）
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
- `logs\sync-agent.jsonl` 已自动脱敏，但报告文件是明文业务数据，处理时按真实订单对待。

## 安全红线


- 密码、Cookie、登录态、profile 永远只留在 Windows 本机，不上传、不提交 Git、不写日志；
- 日志采用 JSON Lines 并自动打码 Authorization/手机号/长数字串/敏感键名；
- 同一平台同一 profile 同时只允许一个同步进程（lock 文件）；
- 只读、低频、手动确认；出现验证码/风控必须停止并人工处理。
