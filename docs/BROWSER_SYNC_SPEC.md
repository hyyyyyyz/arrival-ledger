# 浏览器自动化同步技术规格（Browser Sync MVP）

版本：1.0（2026-08-13）
适用仓库：`arrival-ledger`
状态：实现前冻结的技术约定

## 1. 目的与边界

本模块把用户已经登录的 1688、拼多多网页订单，低频同步成到货管家的采购订单数据。它不是官方开放平台适配器，也不是通用爬虫。第一版只做“可见页面、只读、单账号、低频、人工可恢复”的测试能力。

平台页面、账号状态和网站规则都可能变化，因此浏览器同步永远是增强能力。即使同步完全失效，手机拍照收货、CSV 导入和已有历史数据仍必须可用。

### 明确不做

- 不再申请、实现或依赖 1688 官方订单 API；当前方案中删除 AppKey、AppSecret、OAuth、access token 相关任务。
- 不读取或上传密码、Cookie、localStorage、sessionStorage、浏览器 profile、支付信息、完整地址或电话。
- 不调用平台内部 JSON/API、拦截网络请求、修改请求参数或伪造设备指纹。
- 不自动下单、支付、退款、确认收货、评价或修改任何平台数据。
- 不绕过验证码、滑块、登录保护、风控或人机校验；出现这些页面立即停止并等待人工。
- 不使用代理池、IP 轮换、多账号并发、隐藏窗口、无限滚动高频轮询或“反检测”技术。

## 2. 总体架构

```text
Windows 10/11（闲置电脑）
  ├─ Node.js 20 LTS + TypeScript 同步程序
  ├─ Playwright + 可见 Chrome
  ├─ C:\ArrivalLedger\profiles\pdd       # 拼多多独立登录态
  ├─ C:\ArrivalLedger\profiles\1688      # 1688 独立登录态
  ├─ C:\ArrivalLedger\state               # 游标、批次、锁
  └─ C:\ArrivalLedger\logs                # 脱敏日志
          │ 仅上传订单必要字段
          ▼
Ubuntu 192.168.1.5
  ├─ Nginx/FastAPI :8766
  ├─ sync worker token API
  ├─ SQLite：订单、商品行、包裹、批次、错误
  └─ 手机收货 H5：运单匹配与照片凭证
```

服务器是纯 Server，不安装桌面环境，也不反向控制 Windows 浏览器。Windows 端主动发起请求；服务器只接受结构化订单批次。

### 2.1 两个独立浏览器 profile

必须为两个平台使用不同的 `user-data-dir`，不得复用用户日常 Chrome profile：

```text
C:\ArrivalLedger\profiles\pdd
C:\ArrivalLedger\profiles\1688
```

首次运行由用户在可见窗口中登录。程序只检查是否已登录，不自动填写密码、不保存密码、不代做短信/扫码确认。profile 目录永远只留在 Windows，不能进入 Git、服务器备份或同步接口。

## 3. 第一测试版本（MVP-1）

第一版本只提供手动命令，不先做后台常驻和定时任务：

```powershell
npm run doctor
npm run login-check -- --platform pdd
npm run login-check -- --platform 1688
npm run sync-once -- --platform pdd --mode dry-run
npm run sync-once -- --platform 1688 --mode dry-run
npm run sync-once -- --platform pdd --mode commit --from-report .\state\snapshot-pdd-pdd-main-<batch_id>.json --yes
```

`sync-once` 运行时浏览器保持可见（始终 headed，无隐藏运行模式）；用户能看到当前页面和进度。
首次同步默认最近 90 天、最多 30 条，允许通过参数回补到 500 条。每个平台先手动跑通 20–30 条
真实订单，再考虑 Task Scheduler。

本机配置只保存非敏感连接信息和路径，例如：

```dotenv
ARRIVAL_API_BASE_URL=http://192.168.1.5:8766
ARRIVAL_SYNC_WORKER_KEY=填入本机密钥，不提交 Git
PDD_PROFILE_DIR=C:/ArrivalLedger/profiles/pdd
ALI1688_PROFILE_DIR=C:/ArrivalLedger/profiles/1688
SYNC_MAX_PAGES=5
SYNC_MAX_RECORDS=30
SYNC_PAGE_DELAY_MS=2500
```

密码、短信验证码、二维码登录内容和平台 Cookie 不得出现在配置文件、命令行参数、进程标题或日志中。Windows 上的密钥文件应由 ACL 只允许当前用户读取；若通过公网隧道传输，`ARRIVAL_API_BASE_URL` 必须使用 `https://`。

### MVP-1 完成条件

1. 两个独立 profile 均可由用户手工登录并通过 `login-check`。
2. PDD、1688 各成功读取至少 20 条真实订单，字段完整率不低于 95%。
3. 同一批次重复运行不新增重复订单、商品行或包裹。
4. 至少一个带运单号的订单能在手机收货页面按运单号显示商品。
5. 登录过期、验证码、页面改版均产生明确状态，不静默写入错误数据。
6. 服务器数据库/日志中不存在密码、Cookie、worker token、完整地址和原始 HTML（worker token 只以明文存在于 Windows 受 ACL 保护的本机配置）。
7. 关闭 Windows 同步程序后，P0 收货页面仍可正常使用。

`dry-run` 只读取、解析、校验并把完整记录集保存为本地私有 snapshot（含 payload hash），不能写服务器；
`commit` 必须通过 `--from-report <snapshot>` 读取该 snapshot 上传，**不能重新打开网页抓取**；
snapshot 内容或 hash 变化时拒绝 commit，要求重新 dry-run。用户输入明确的 `yes` 或等价确认后才
允许 commit；取消、超时或报告变化都回到 dry-run。

## 4. 目录与程序边界

建议新增目录（按 Node.js/TypeScript 实现；不要把浏览器同步端改成 Python）：

```text
sync-agent/
  README.md
  package.json / package-lock.json / tsconfig.json
  src/
    cli.ts                 # doctor/login-check/sync-once
    config.ts              # 本机配置，不含密码/Cookie
    models.ts              # 统一订单与批次类型
    run.ts                 # dry-run/commit 编排
    normalize.ts           # 纯函数规范化
    transport.ts           # 到货管家内部接口客户端
    browser/
      context.ts          # persistent headed context
      guards.ts           # 登录/验证码/结构守卫
    adapters/
      base.ts
      pdd.ts
      ali1688.ts
    extract/
      text.ts
      dates.ts
      tracking.ts
      order.ts
    state/
      cursor.ts
      lock.ts
      redact.ts
    report.ts
  tests/
    fixtures/pdd/
    fixtures/1688/
    test_normalize.ts
    test_state.ts
    test_adapters.ts
```

同步程序与现有 `backend/`、`frontend/` 解耦。服务器端的批量接收接口和数据库迁移可以在现有后端中实现，但不能把 Playwright、Chromium 或任何平台登录逻辑放入 Docker 后端。

## 5. 适配器契约

两个平台必须实现同一个只读接口，页面选择器和解析细节封装在适配器内部：

```ts
interface PlatformAdapter {
  readonly platform: "pdd" | "1688";
  openOrders(page: Page, window: SyncWindow): Promise<void>;
  detectLogin(page: Page): Promise<LoginState>;
  detectBlock(page: Page): Promise<BlockState>;
  collectVisibleOrders(page: Page): Promise<RawOrder[]>;
  advancePage(page: Page): Promise<boolean>;
}
```

适配器只能从用户可见的页面 DOM、可见文本、链接和表格字段读取数据。不得调用站点内部接口或读取浏览器存储。每次页面动作后都要重新检查登录/阻断状态。

### 5.1 页面入口（可配置，不得写死为唯一真相）

默认入口可配置为：

- 拼多多：`https://mobile.yangkeduo.com/orders.html`
- 1688：`https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html`

页面 URL、选择器、字段标签必须放在适配器配置/常量中，不能散落在业务层。页面改版时只修改对应适配器和 fixture。

### 5.2 统一订单对象

所有 ID 和单号都按字符串处理，禁止转换成 JavaScript `Number` 后再保存：

```json
{
  "platform": "pdd|1688",
  "platform_account_key": "pdd-main",
  "platform_order_id": "string",
  "ordered_at": "ISO-8601|null",
  "status": "PENDING|PAID|SHIPPED|COMPLETED|REFUNDED|CANCELLED|UNKNOWN",
  "shop_name": "string|null",
  "items": [
    {
      "item_key": "string|null",
      "title": "string",
      "sku_text": "string|null",
      "quantity": 1,
      "unit_price": "string|null"
    }
  ],
  "packages": [
    {
      "courier": "string|null",
      "tracking_no": "string",
      "status": "string|null"
    }
  ],
  "observed_at": "ISO-8601"
}
```

只保存完成匹配所需的最小字段。价格不是 P0 必需字段；解析不稳定时可留空，不得为了价格字段扩大权限或保存支付信息。

### 5.3 页面读取策略

1. 打开订单列表并等待页面稳定；
2. 先调用 `detect_login` 和 `detect_block`；
3. 读取当前可见订单卡片/行；
4. 按字段标签、语义角色和相对 DOM 结构解析，不依赖随机 CSS 类名；
5. 记录当前页面已观察到的订单 ID，避免同页重复；
6. 通过“下一页”或明确的加载更多控件推进；最多处理配置的页数/条数；
7. 若页面结构无法确认，返回 `SCHEMA_CHANGED`，保存本地脱敏诊断，不猜字段；
8. 每完成一个页面就本地落盘，网络上传失败可从批次继续。

不要以“找到任意 18 位数字”作为订单号；订单 ID、商品 ID、运单号必须依据字段标签和页面上下文识别。面单匹配只使用 `packages[].tracking_no`。

### 5.4 平台页面适配要求

适配器的最小读取范围如下；实际页面字段以真机页面为准，不能凭猜测补值：

| 平台 | 列表阶段 | 详情阶段 | 必须抽取 |
|---|---|---|---|
| PDD | 已登录订单列表、状态筛选、分页/加载更多 | 必要时打开订单详情再返回列表 | 订单号、状态、下单/更新时间、店铺、商品标题/规格/数量、可见快递公司/运单号 |
| 1688 | 已登录买家订单列表、分页 | 必要时打开订单详情再返回列表 | 订单号、状态、下单/更新时间、供应商/店铺、商品标题/规格/数量、可见物流公司/运单号 |

适配器必须：

1. 以页面标签、表格语义、ARIA role/label 和稳定 `data-*` 属性为首选；随机 CSS 类名只能作为最后一层且必须有 fixture 测试；
2. 进入详情前保存列表页订单 ID，返回后校验仍在同一页，避免把详情内容错配到下一条订单；
3. 一个订单出现多个包裹时全部保留；没有运单号时写空数组，不伪造单号；
4. 订单号、商品 ID、规格 ID、运单号先做字符串清洗，再做长度/字符集校验；
5. 页面显示“暂无订单”时先确认账号和筛选条件，不得用空结果覆盖服务器已有订单；
6. 每页抽取失败一条以上即停止本次运行并报告，不静默提交半截字段。

## 6. 本地状态、游标和失败熔断

本地状态文件建议使用 SQLite 或原子替换 JSON，至少包含：

```json
{
  "platform": "pdd",
  "account_key": "pdd-main",
  "last_success_at": "ISO-8601|null",
  "last_cursor": "string|null",
  "last_batch_id": "uuid|null",
  "last_status": "OK|NEEDS_LOGIN|CAPTCHA_OR_BLOCKED|SCHEMA_CHANGED|NETWORK_ERROR|DISABLED",
  "consecutive_failures": 0
}
```

规则：

- 同一平台同一 profile 同时只能有一个同步进程，使用 lock 文件；
- 网络错误最多做有限次退避重试（例如 2 次），不能无限刷新页面；
- 出现验证码、滑块、异常登录或风控提示立即熔断，当次不再重试；
- 连续两次解析失败进入 `SCHEMA_CHANGED`，等待人工检查；
- 不因为订单列表变少就删除服务器已有订单；
- 只有服务器确认批次成功后才推进 `last_cursor`；
- 每次运行生成本地报告，包含读取数、有效数、跳过数、上传数、错误数和状态。

## 7. Windows → Server 接口契约

同步端不使用管理员会话 Cookie，使用单独、可撤销、可轮换的 worker token。token 只放 Windows 私密配置和服务器 `.env`，不进源码。

### 7.1 批次请求

```http
POST /api/sync/v1/batches
Authorization: Bearer <sync-worker-token>
Content-Type: application/json
Idempotency-Key: <batch_id>
```

请求体：

```json
{
  "schema_version": 1,
  "batch_id": "uuid",
  "worker_id": "win-arrival-01",
  "platform": "pdd|1688",
  "platform_account_key": "pdd-main|1688-main",
  "started_at": "ISO-8601",
  "finished_at": "ISO-8601",
  "cursor_before": "string|null",
  "cursor_after": "string|null",
  "mode": "commit",
  "orders": [
    {
      "platform_order_id": "string",
      "ordered_at": "ISO-8601|null",
      "status": "PAID|SHIPPED|COMPLETED|REFUNDED|CANCELLED|UNKNOWN",
      "shop_name": "string|null",
      "items": [
        {
          "item_key": "string|null",
          "title": "string",
          "sku_text": "string|null",
          "quantity": 1,
          "unit_price": "string|null"
        }
      ],
      "packages": [
        {"courier": "string|null", "tracking_no": "string"}
      ]
    }
  ]
}
```

`mode` 为 `dry_run` 时客户端不得调用该接口；服务端只接受 `commit` 批次。每批最多 100 个订单，字段长度、日期、数量和运单号格式均须校验。响应必须返回：`batch_id`、`created`、`updated`、`skipped`、`errors`、`cursor_accepted`。重复提交同一 `batch_id` 必须返回原结果，不重复写入。

### 7.2 服务器安全要求

- worker token 只允许访问同步批次接口，不能调用管理员登录、照片读取或删除接口；
- token 明文仅存在于服务器 `.env`（`SYNC_WORKER_TOKENS`）与 Windows 本机 `.env.local`；数据库只存 HMAC 摘要，支持撤销和轮换；
- 限制请求体大小、批次订单数和请求频率；
- 记录 `worker_id`、平台、批次、时间和结果，不记录 Authorization 原文；
- 公网使用时必须 HTTPS；局域网 HTTP 只用于首次测试且不得把端口转发公网；
- 原始页面、截图、Cookie 和密码不上传；解析失败证据只保存在 Windows 本地且默认自动删除。

建议响应码：`401` worker key 缺失/无效，`403` key 已撤销或 scope 不允许，`409` 批次内容与已记录的同一 `batch_id` 不一致，`413` 超过大小/条数限制，`422` 字段校验失败，`429` 频率限制，`5xx` 服务暂时不可用。客户端只对网络错误和 `5xx/429` 做有限退避；`401/403/409/422` 直接停止并显示人工可读错误。

## 8. 服务器数据与幂等规则

建议新增/迁移以下表（字段可按现有 SQLite 风格调整）：

迁移必须使用编号文件或等价的 `schema_migrations` 记录。迁移前先执行现有备份脚本；只能新增表/索引和兼容字段，不能重建或删除已有 `users`、`sessions`、`receipt_events`。若迁移失败，事务回滚并保持 P0 收货 API 可用。

```sql
platform_accounts(
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  account_key TEXT NOT NULL,
  display_label TEXT,
  source TEXT NOT NULL DEFAULT 'WINDOWS_BROWSER',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform, account_key)
)

purchase_orders(
  id INTEGER PRIMARY KEY,
  platform_account_id INTEGER NOT NULL,
  platform_order_id TEXT NOT NULL,
  ordered_at TEXT,
  order_status TEXT NOT NULL,
  shop_name TEXT,
  source TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform_account_id, platform_order_id)
)

order_items(
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  item_key TEXT,
  title TEXT NOT NULL,
  sku_text TEXT,
  quantity TEXT NOT NULL,
  unit_price TEXT,
  UNIQUE(order_id, item_key, title, sku_text)
)

packages(
  id INTEGER PRIMARY KEY,
  courier TEXT,
  courier_normalized TEXT NOT NULL DEFAULT '',
  tracking_no TEXT NOT NULL,
  tracking_no_normalized TEXT NOT NULL,
  package_status TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(courier_normalized, tracking_no_normalized)
)

package_order_links(
  package_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  order_item_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(package_id, order_id, order_item_id)
)

sync_batches(
  id INTEGER PRIMARY KEY,
  batch_id TEXT NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_key TEXT NOT NULL,
  status TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  cursor_before TEXT,
  cursor_after TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
)
```

订单状态同步只能更新“平台观察到的状态”，不能自动产生 `RECEIVED` 收货事件。收货状态必须由手机照片凭证产生。平台订单缺少运单号时仍保存订单，收货后进入待认领。

`packages` 是物理包裹候选表，不按平台账号拆开：同一个快递单号可能同时出现在 PDD 和 1688 订单中，应通过 `package_order_links` 关联多个订单。未知承运商统一用空字符串作为 `courier_normalized`，避免 SQLite `NULL` 唯一约束产生重复候选。

## 9. 日志、隐私和诊断

本地日志使用 JSON Lines，字段包括时间、平台、worker、batch、状态、计数和错误码。以下内容一律打码或禁止记录：密码、Cookie、Authorization、完整手机号、完整地址、原始 HTML、整页截图、支付信息。

页面改版诊断默认只保存：URL 主机名、标题、元素计数、缺失字段名称和脱敏文本片段。若必须保存截图供人工修复，用户显式执行 `--save-debug` 后才保存，7 天自动删除，且不得提交 Git。

## 10. 后续定时任务（不属于 MVP-1）

MVP-1 手动同步稳定后，才配置 Windows Task Scheduler：

- 每天 02:00 和 14:00 各一次，开机延迟 5 分钟补跑；
- 使用同一独立 profile 和 lock 文件，禁止并发；
- 任务失败只写状态并通知，不连续重试；
- `NEEDS_LOGIN`、`CAPTCHA_OR_BLOCKED`、`SCHEMA_CHANGED` 必须人工处理后再恢复；
- 任务计划不保存明文密码，profile 目录不复制到服务器。

## 11. 测试矩阵

### 自动测试（CI 可执行）

- 单号、订单号、日期、数量的字符串规范化；
- PDD/1688 脱敏 HTML fixture 解析；
- 多页、重复卡片、缺失字段、拆包/合包；
- 状态映射和退款/取消处理；
- 本地游标原子保存、锁和失败恢复；
- 批次 JSON schema、大小限制、幂等接口和 token 权限；
- 不把敏感字段写入日志的测试。

### 人工验收

- 两个平台分别登录正确账号；
- 每个平台手动同步 20–30 条真实订单；
- 关闭/重新运行同步，计数不重复；
- 账号退出或登录过期显示 `NEEDS_LOGIN`；
- 人工触发验证码时程序停止，不尝试处理；
- 面单扫码后能按运单号显示商品；
- Windows 关机后重新启动可继续，不破坏服务器已有收货数据。

## 12. 版本演进

- MVP-1：手动、可见、单平台/全平台 `sync-once`；
- MVP-2：批次历史、预览确认、PDD/1688 字段差异修复；
- MVP-3：Task Scheduler 低频增量同步和失败通知；
- 后续：仅在官方许可、稳定性和实际收益明确时评估其他接入方式。官方 API 不再列入当前实现计划。
