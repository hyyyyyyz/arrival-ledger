# Windows 浏览器同步手工验收清单

状态：**自动化代码已完成（`feat/browser-sync-mvp`），Windows 真机验收待执行**。
以下步骤必须在 **Windows 10/11 真机**上执行，全部通过前不要合并 main、不要启用定时任务。
真实页面、真实订单、截图、登录态不得进入 Git、Issue 或聊天；测试报告只写数量与脱敏摘要。

## 0. 前置准备

```powershell
# Windows 上（不要求开发环境，只需要 Node 20 LTS 与 git）
cd C:\ArrivalLedger
git clone --branch feat/browser-sync-mvp https://github.com/hyyyyyz/arrival-ledger.git app
cd app\sync-agent
npm ci
npx playwright install chromium

# 本机私密配置（不提交 Git）
New-Item -ItemType Directory -Force C:\ArrivalLedger\profiles\pdd, C:\ArrivalLedger\profiles\1688 | Out-Null
notepad .env.local
```

`.env.local` 最少内容（`ARRIVAL_SYNC_WORKER_KEY` 与服务器 `.env` 的 `SYNC_WORKER_TOKENS` 一致，最少 16 字符，
建议 `openssl rand -hex 24` 生成；服务器在 `.5` 上更新 `.env` 后 `sudo docker compose up -d backend` 生效）：

```dotenv
ARRIVAL_API_BASE_URL=http://192.168.1.5:8766
ARRIVAL_SYNC_WORKER_KEY=<与服务器一致>
ARRIVAL_WORKER_ID=win-arrival-01
PDD_PROFILE_DIR=C:/ArrivalLedger/profiles/pdd
ALI1688_PROFILE_DIR=C:/ArrivalLedger/profiles/1688
PDD_ACCOUNT_KEY=pdd-main
ALI1688_ACCOUNT_KEY=1688-main
```

> 服务器端安全约束：token 只存摘要；从 `SYNC_WORKER_TOKENS` 移除即撤销（重启后生效）；
> 每个 token 每小时最多接受 6 个批次；单批 ≤100 订单、≤256 KiB。公网隧道使用时必须把
> `ARRIVAL_API_BASE_URL` 换成 `https://*.trycloudflare.com`。

## 1. 本机自检（doctor）

```powershell
npm run doctor
```

预期全部 `[OK]`（worker key 为 WARN 可接受）。出现 `[FAIL]` 先修复，不要继续。

## 2. 登录检查（每个平台）

```powershell
npm run login-check -- --platform pdd
npm run login-check -- --platform 1688
```

- 浏览器窗口必须可见（始终 headed，无隐藏运行模式）；本工具**绝不**自动输入密码、
  不处理短信/扫码/验证码；
- 未登录时窗口会打开登录页并保持打开，终端提示你手工完成登录后按 Enter，
  程序重新检测登录状态，可反复执行直到成功（Ctrl+C 随时中止）；
- 出现验证码/风控页面 → 输出 `CAPTCHA_OR_BLOCKED`，立即停止，不要尝试绕过。

## 3. 只读 dry-run（每个平台）

```powershell
npm run sync-once -- --platform pdd --mode dry-run
npm run sync-once -- --platform 1688 --mode dry-run
```

- dry-run 不上传任何数据，只写两个本地文件：
  - `state\report-*.json`：供人工核对的完整报告（订单号、状态、店铺、每个商品的
    标题/规格/数量/单价、每个包裹的快递与运单号）；
  - `state\snapshot-*.json`：规范化记录的私有快照（含 payload hash），供 commit 使用；
- 记录：读取订单数、解析成功数、字段缺失情况、用时、是否出现登录保护；
- 页面结构与程序假设不一致 → 状态 `SCHEMA_CHANGED` 并停止，保留游标；需要按真实页面调整对应
  adapter 选择器并补充脱敏 fixture（改完必须重新通过 `npm test`）；
- 空列表 → 提示 `empty`，不会上传也不会覆盖服务器数据，先人工确认账号和筛选条件。

## 4. 确认后 commit（每个平台）

```powershell
npm run sync-once -- --platform pdd --mode commit --from-report .\state\snapshot-pdd-pdd-main-<batch_id>.json --yes
npm run sync-once -- --platform 1688 --mode commit --from-report .\state\snapshot-1688-1688-main-<batch_id>.json --yes
```

- commit **不会重新打开网页抓取**：它只上传 dry-run 快照的原始字节；
  `<batch_id>` 与 dry-run 输出的 snapshot 文件名一致；
- 快照的 payload hash 用于**完整性校验**（不是防篡改承诺）：内容或 hash 不一致会被拒绝
  （`SNAPSHOT_INVALID`）；
- 快照有效期为 **30 分钟**（`EXPIRED_SNAPSHOT`），且快照记录时的游标必须与当前账户游标
  完全一致（`CURSOR_MISMATCH`），否则都必须重新 dry-run；
- 必须在核对 dry-run 报告后执行；`--yes` 缺失会直接拒绝；
- 同一平台 15 分钟内重复 commit 会被本地低频限制拦截（`SYNC_MIN_INTERVAL_MINUTES`）；
- 重复提交同一批次内容不产生重复订单（服务器幂等 + 409 冲突保护）。

## 5. 验收标准（对应 PLAN 11.3）

| 项目 | 标准 | 记录 |
|---|---|---|
| 独立 profile 手工登录 | 两平台均可通过 login-check | 平台/账号脱敏标识 |
| 各 20–30 条真实订单 | dry-run 报告数量一致 | 订单数/页数 |
| 字段完整率 | 订单号/商品/规格/数量/店铺/快递/运单 ≥95% | 逐字段统计 |
| 重复同步 | 第二次 commit `skipped` 增加、`created` 为 0 | 服务端行数不变 |
| 服务器无敏感数据 | DB 无 Cookie/密码/地址/电话 | 抽查 sync_batches/purchase_orders |
| 登录过期/验证码 | 明确状态，不静默写错 | 记录状态与处理方式 |
| dry-run 与 commit 集合一致 | commit 复用同一份记录集 | 报告对比 |
| 停止同步端后 P0 正常 | 收货拍照不受影响 | 真机操作确认 |

只有以上全部通过后，才允许评估 Windows Task Scheduler 低频定时（每天 1–2 次，另开任务）。

## 5.5 本地报告的隐私边界

- `state\report-*.json` 和 `state\snapshot-*.json` 包含**真实订单号与运单号**，
  只允许在 Windows 本机人工核对；严禁分享到聊天、Issue、工单或提交 Git；
- 交接内容只填写脱敏摘要（数量、完整率、状态），不粘贴报告原文。

## 6. 安全红线（任何一步违反都立即停止）


- 不上传密码、Cookie、profile、截图、HTML、网络日志；
- 不绕过验证码、滑块、风控；出现即熔断，人工处理；
- 不自动下单、支付、退款、确认收货；
- 报告、日志中的手机号/地址/长数字串已被自动打码；发现未打码内容立即停止并报告。

## 7. 完成后的交接内容

每个平台回填以下内容（脱敏）：

```text
平台：pdd / 1688
账号：<account_key 标签，不含真实手机号>
login-check：OK / NEEDS_LOGIN / CAPTCHA_OR_BLOCKED
dry-run：读取 N 条、解析 N 条、失败 N 条、用时 M 分钟
字段完整率：订单号 %、商品 %、数量 %、店铺 %、快递 %、运单号 %
commit：created / updated / skipped / errors
重复运行：created 0、skipped N（幂等确认）
异常：SCHEMA_CHANGED / 验证码 / 登录过期及处理方式
```
