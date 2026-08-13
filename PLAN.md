# arrival-ledger（「到货管家」）采购包裹到货确认系统

## 总体实施计划 v1.0（2026-08-13）

> 这份文档是当前方案的唯一事实来源。它把手机收货页面、订单导入、平台同步和公网访问拆成可以分别验收的模块。平台同步失败时，核心的拍照收货功能仍必须可用。

## 0. 当前结论（先看这一节）

### 0.1 产品结论

- 这是个人/固定协作者私用工具，不开放注册，不做 SaaS，不对外售卖。
- 每天约 10–30 个包裹；每个包裹都必须拍一张面单或包裹照片。
- 系统要证明的是“我在某个时间实际拿到了这个包裹”，不是快递平台的“已签收”状态。
- 订单和包裹不是同一个对象。面单上通常能读到的是快递运单号，不是拼多多或 1688 的平台订单号。
- 收货主键优先使用“快递公司 + 标准化运单号”；一个订单可以拆成多个包裹，一个包裹也可以合并多个订单行。
- 第一版不接快递 100、快递鸟，不做实时物流轨迹，不做开箱质量/数量核验。

### 0.2 访问和设备结论

| 场景 | 入口 | 是否需要密码 | 当前状态 |
|---|---|---:|---|
| 仓库局域网 | 微信 H5，访问 http://192.168.1.5:8766 | 否 | `.5` 已部署并通过服务端健康检查，待真机完整验收 |
| 外网/异地 | HTTPS 临时 Quick Tunnel（无域名） | 是 | `.5` 已启用临时隧道并通过公网健康检查；等待手机登录/拍照验收 |
| 平台订单采集 | 闲置 Windows 上的两个独立 Chrome profile + `sync-agent` | 平台登录只留在 Windows | MVP 正在设计，先手动 dry-run |

服务器是纯 Server，不需要安装桌面环境。Windows 电脑只承担“保持 PDD/1688 浏览器登录并同步订单”的工作；Mac 不参与采集，也不需要一直开着。

### 0.3 平台结论

#### 1688 与拼多多（统一浏览器自动化路线）

本项目明确**不申请、不实现、不依赖 1688 或拼多多的官方平台 API**。此前调研过的开放平台、OAuth、AppKey、AppSecret、access token、官方订单导出等路径全部从实现计划中移除；它们不应出现在同步端代码、配置或部署步骤里。

两个平台统一由 Windows 闲置电脑上的 Node.js/TypeScript + Playwright headed worker 读取用户已经打开并登录的可见网页：

1. 用户在两个独立 Chrome profile 中手工登录；
2. worker 打开订单列表，只读取用户可见 DOM/无障碍文本和正常分页；
3. 先生成 dry-run 预览，用户明确确认后才上传结构化订单；
4. 到货管家服务器按订单/商品/运单号幂等入库；
5. 手机扫码得到快递运单号，再反查订单和商品。

浏览器同步是非官方、可失效的实验增强能力，可能因页面改版、登录过期、验证码、风控或平台规则而停止。禁止调用平台内部 API、抓包、网络拦截、验证码/滑块绕过、代理池、IP 轮换和高频抓取；遇到阻断必须熔断并人工处理。完整规格见 [`docs/BROWSER_SYNC_SPEC.md`](docs/BROWSER_SYNC_SPEC.md)。

CSV、截图/OCR和手工录入是降级路径，不依赖平台 API，也不阻塞 P0 收货闭环。

### 0.4 当前最重要的取舍

不把“自动获得平台订单”作为 P0 前置条件。先让系统稳定记录“照片 + 运单号 + 服务端时间 + 收货事件”，再逐个平台降低订单录入成本。这样即使拼多多浏览器同步某天失效，已经确认的包裹和照片仍然完整。

## 1. 目标、非目标与成功定义

### 1.1 目标

1. 收货人用微信打开链接即可连续拍摄 10–30 个包裹。
2. 手机在本地完成图片压缩、条码初识别和离线暂存。
3. 服务器保存照片、SHA-256、服务器接收时间、运单号、匹配关系和事件历史。
4. 通过预先导入的订单数据，把“运单号”反查为平台、订单和商品。
5. 网络中断、重复点击、页面重载都不会制造重复记录或丢失照片。
6. 订单导入可支持几百条数据，重复导入幂等，并能识别退款、未知物流和拆包。

### 1.2 第一版明确不做

- 不从面单照片“猜”出不存在于面单上的平台订单号；
- 不依赖大模型 API 才能完成普通条码识别；
- 不绕过拼多多登录、验证码、风控或接口权限；
- 不在服务器保存拼多多密码、浏览器 Cookie 或完整 Chrome profile；
- 不自动下单、付款、退款、确认收货或修改平台订单；
- 不把快递“已签收”自动改成“本人已收到”；
- 不把局域网免登录模式直接暴露到公网；
- 不承诺拼多多网页同步长期不受页面改版影响。

### 1.3 成功定义

一条正常收货记录至少包含：

- 可查看的包裹照片；
- 服务端接收时间；
- 一个标准化运单号，或明确标记为“待补单号”；
- 事件操作者/设备信息；
- 若已有订单映射，则显示平台、订单和商品；
- 若暂时没有映射，也必须进入待认领区而不是丢弃。

## 2. 业务概念与匹配规则

### 2.1 三类记录

1. 应收订单：从平台、CSV、截图或手工方式导入的采购订单。
2. 物流包裹：承运商运单号对应的一个实际包裹。
3. 实收事件：某台设备在某个时间拍照并确认“我拿到了这个包裹”。

### 2.2 匹配原则

面单上的主条码/二维码优先提供承运商运单号。例如此前提供的面单中，能识别出类似 SF5154076435411 的顺丰运单号；二维码里还可能有仓内路由码、隐私号或校验字段。它们不能直接当作 1688/PDD 订单号。

匹配过程：

1. 从照片中提取所有条码候选值；
2. 统一去空格、短横线和大小写；
3. 先与已导入订单的 carrier + tracking_no 精确比对；
4. 一个候选对应一个订单时自动建议匹配；
5. 多候选、拆包、合包或无候选时交给用户确认；
6. 保留原始照片、原始识别值和修正事件。

ZXing/条码库足以处理规则清晰的条码；OCR 或大模型只作为破损面单、非标准文本和人工复核的后续兜底。P0 不调用大模型，因此没有额外 API 费用和数据外发。

### 2.3 状态

采购订单：

    ACTIVE      有效，仍可能有包裹未收到
    RECEIVED    关联包裹全部确认收到
    CANCELLED   取消、关闭或退款，不再等待

包裹匹配：

    MATCHED     已关联订单
    UNMATCHED   已有运单/实收记录但暂时没有订单

实收事件：

    PENDING     事件或照片仍在本地队列/服务端处理中
    RECEIVED    照片已保存并完成凭证校验
    REVOKED     最近一次确认已撤销，事件历史保留

同步任务：

    OK
    NEEDS_LOGIN
    CAPTCHA_OR_BLOCKED
    SCHEMA_CHANGED
    NETWORK_ERROR
    DISABLED

## 3. 用户交互流程

### 3.1 订单进入系统

~~~text
平台订单/CSV/截图/手工
          ↓
解析与预览（不直接覆盖已有数据）
          ↓
用户确认导入
          ↓
订单、商品行、运单号和包裹关系入库
~~~

导入页面必须显示：新增、更新、跳过、退款/取消、未知物流、错误行和敏感字段丢弃情况。

### 3.2 收货

~~~text
微信打开页面
  → 点击开始收货
  → 拍一张面单照片
  → 手机压缩 + ZXing 初识别
  → 本地队列保存照片和 client_event_id
  → 在线时上传服务器
  → 服务端哈希、幂等处理、匹配订单
  → 显示商品/平台/状态
  → 自动回到下一件
~~~

分支反馈：

- 单号已匹配：绿色显示商品和平台，记录为已收到；
- 单号未知：照片先保存，进入待认领；
- 单号无法识别：进入待补单号；
- 单号重复：显示首次确认时间和原照片，不重复计数；
- 网络断开：显示“本机已保存，待同步”，不能显示为服务器已完成。

### 3.3 查询和纠错

支持按平台、订单号、运单号、商品关键词和日期查询。详情页显示照片、首次确认、后续撤销/重新匹配事件和当前匹配状态。第一版不保存收货人电话/地址，因此不提供按电话查询。

## 4. 总体架构

~~~text
手机 iPhone/Android
  └─ 微信 H5：拍照、压缩、ZXing、IndexedDB 队列、清单与反馈
                │
                │ 局域网 HTTP（当前）/未来 HTTPS
                ▼
Ubuntu 服务器 192.168.1.5
  ├─ Nginx 前端网关 :8766
  ├─ FastAPI 业务 API
  ├─ SQLite（订单、包裹、事件、同步任务）
  ├─ 本地照片目录与备份
  └─ 内部 sync ingest API（只接收 Windows 结构化批次）
                ▲
                │ Windows 主动出站，最小字段
                │
闲置 Windows 电脑
  ├─ 独立 Chrome profile：PDD
  ├─ 独立 Chrome profile：1688
  ├─ Node.js/TypeScript + Playwright headed worker
  └─ Task Scheduler（MVP 验收后才启用）
~~~

### 4.1 手机 H5 负责什么

- 调起后置相机；
- 压缩照片和生成本地事件 ID；
- 用 ZXing 识别条码，必要时允许手工补录；
- 通过 IndexedDB 保留待上传照片；
- 展示匹配结果、重复提示、待认领和同步状态。

### 4.2 服务器负责什么

- 认证或可信局域网访问控制；
- 保存照片、哈希和服务器时间；
- 以 client_event_id 做幂等；
- 保存订单、包裹、商品行和多对多关系；
- 查询、去重、匹配、事件时间线和备份；
- 接收 Windows 浏览器同步批次；
- 不负责把拼多多账号登录到网页，也不保存浏览器会话。

### 4.3 Windows 同步端负责什么

- 在真实用户已登录的 1688/拼多多网页环境中读取订单展示数据；
- 只上传必要的非 PII 字段；
- 记录同步游标、结果和错误状态；
- 登录失效/验证码/页面改版时停止并提示人工；
- 不做支付、下单、退款、确认收货等写操作。

Windows 端不需要把 Chrome 窗口交给服务器控制，也不要求 Mac 同时运行。服务器是纯 Server，没有桌面依赖。

## 5. 订单进入路线

### 5.1 主路线：Windows 浏览器自动化

平台订单的主路线统一是 `sync-agent`：Windows 上两个独立、可见的 Chrome profile，用户手工登录，程序读取可见订单页面，先 dry-run 预览再提交。PDD 和 1688 只在各自 adapter 内处理页面差异，服务器不运行浏览器。

第一测试版固定为：

```text
doctor → login-check → sync-once --mode dry-run → 用户确认 → --mode commit
```

每个平台最多先读取 3–5 页/30 条，默认从最新订单向旧订单读取。两次成功同步后才设计游标增量；MVP 不启用无人值守定时任务。

### 5.2 降级路线：CSV 批量导入

用户此前提供的拼多多测试导出样本约有 10 条数据、34 列，包含订单号、下单时间、状态、商品名称/规格/数量、店铺、快递公司和运单号；其中约 9 条有有效运单号，另有退款/未知物流记录。这证明 CSV 已经足够建立订单—包裹映射，不必逐单录入，也不必购买多多开才能导入已有文件。

导入器要求：

- 支持 UTF-8、UTF-8 BOM 和常见 CSV 引号；
- 清理 Excel 包装格式，例如 “="464689789940513"”，结果按字符串保存；
- 订单号、商品 ID、规格 ID、运单号均不得转换为 JavaScript Number；
- 忽略收件人、电话、完整地址等 PII，不进入业务数据库；
- 显示预览、字段映射、错误行和导入报告；
- 幂等键为 platform + platform_account + platform_order_id；
- 重复导入只更新变化，不产生重复订单/包裹；
- 退款成功、取消、未知物流进入明确状态，不被误认为待收；
- 支持一个订单多个运单号，并保留未来合包关联能力；
- 记录文件哈希和 import_batch，方便追踪来源。

第一批实现应先导入该样本，再用 100、500、1000 行合成数据验证性能和幂等。

### 5.3 浏览器同步详细规则

这是用户当前希望采用的免费方案，但必须标记为“非官方、可失效增强能力”。

初始配置：

- Windows 10/11 闲置电脑；
- 两个独立 Chrome 数据目录：`C:/ArrivalLedger/profiles/pdd`、`C:/ArrivalLedger/profiles/1688`；
- 不复用日常 Chrome profile，不同时打开同一个 profile；
- 第一次由用户在可见窗口中手工登录；
- 首次同步前显示当前账号的脱敏标识和订单数量，由用户确认“这是采购账号”后才允许导入；
- 如果误登录测试账号，只在这个独立 profile 内切换账号或清除拼多多站点数据，不能清理日常 Chrome profile；
- 密码、Cookie、profile 永不上传服务器，也不进入服务器备份；
- 单账号、只读、低频；MVP 只允许手动运行，不启用定时任务；
- 首次运行最多前台回补 30 条（后续经用户确认才允许扩大到几百条）；
- Windows 关机/休眠时不运行，任务计划属于验收后的后续阶段；
- 始终 headed、窗口可见，不做隐藏式无人值守。

同步流程：

~~~text
检查 Chrome/profile 是否可用
  → 打开订单列表
  → 读取当前页面可见的订单字段
  → 规范化并本地校验
  → 用专用 sync worker token 调服务器
  → 服务器幂等写入并返回导入报告
  → 写本地日志/显示同步状态
~~~

状态和处理：

- OK：成功完成；
- NEEDS_LOGIN：登录过期，提示用户在 Windows 窗口重新登录；
- CAPTCHA_OR_BLOCKED：出现验证码/风控，立即停止，不自动处理；
- SCHEMA_CHANGED：页面结构无法确认，保留日志和上次成功游标；
- NETWORK_ERROR：网络失败，有限退避后停止；
- DISABLED：用户手动停用同步。

绝不实现：

- 验证码/滑块绕过；
- 代理池、IP 轮换、多账号并发；
- 高频轮询或伪造用户行为；
- 自动支付、下单、退款、确认收货；
- 把内部同步接口当成平台 API 或控制通道；它只接收 worker 主动提交的结构化批次。

只有手动同步在两个平台各 20–30 个真实订单上验证字段完整率、去重和登录失效提示后，才允许交给 Windows 任务计划定时运行。

### 5.4 截图/OCR/手工兜底

订单页或物流页截图可以上传，OCR 结果必须在页面上由用户确认后入库。面单照片中的条码识别失败时，可以手工补录运单号。大模型 API 仅作为后续低频疑难图片辅助，不作为第一版依赖。

## 6. 浏览器自动化实现方案

### 6.1 MVP 技术选型

- Windows 10/11；
- Node.js 20 LTS + TypeScript strict；
- Playwright（锁定版本）+ `chromium.launchPersistentContext`；
- headed Chrome，两个独立 `user-data-dir`；
- CLI 先支持 `doctor`、`login-check`、`sync-once --mode dry-run|commit`；
- 服务器只增加内部 `/api/sync/v1/batches` 接收接口，不把平台 API 误称为“不要 API”。

### 6.2 适配器分层

```text
browser/guards      登录、验证码、风控、页面状态守卫
adapters/pdd.ts     拼多多页面入口、订单卡片、详情和分页
adapters/ali1688.ts 1688 页面入口、订单行、详情和分页
extract/            纯函数：文本、日期、数量、运单号、订单模型
state/              游标、批次、单实例锁、失败状态
transport/          到货管家内部批次上传
run/                dry-run 预览、用户确认、commit 编排
```

适配器只能读取用户可见 DOM/无障碍文本和正常分页；不允许 `page.on('request')`、`evaluate(fetch(...))`、抓取隐藏接口或注入脚本改变页面。页面结构不确定时返回 `SCHEMA_CHANGED`，保留游标，不猜数据。

### 6.3 统一状态

```text
OK
NEEDS_LOGIN
CAPTCHA_OR_BLOCKED
SCHEMA_CHANGED
NETWORK_ERROR
DISABLED
```

只有 `OK` 才能推进游标。验证码、滑块、异常登录或风控状态不重试；网络错误最多有限退避；连续解析失败熔断并要求人工检查。

### 6.4 内部同步接口

“不用平台 API”不等于“不要内部 HTTP 接口”。Windows 端必须通过本项目自己的接口把规范化订单安全、幂等地送到服务器：

```http
POST /api/sync/v1/batches
Authorization: Bearer <worker-token>
Idempotency-Key: <run-id>
```

请求只允许 `platform`、`account_key`、订单/商品/包裹、游标和批次统计；拒绝密码、Cookie、token、地址、电话、HTML、截图和未知敏感字段。服务器保存 worker token 摘要，按 `(platform, account_key, platform_order_id)` 幂等 upsert，订单与包裹采用多对多关系。详细 JSON 契约见 [`docs/BROWSER_SYNC_SPEC.md`](docs/BROWSER_SYNC_SPEC.md)。

### 6.5 账户与人工确认

`account_key` 由用户在 Windows 本地配置，不能依赖抓取手机号。首次 `login-check` 显示脱敏账号标识和订单数量，用户确认后才可 `commit`。程序不自动输入密码、不处理短信/二维码登录，不上传 profile。

## 7. 数据模型（目标模型）

当前代码已完成收货事件核心；采购订单和平台导入表属于下一阶段数据库迁移。

~~~sql
platform_accounts(
  id, platform, account_key, account_label,
  source, created_at, updated_at
)

purchase_orders(
  id, platform_account_id,
  platform_order_id, title_summary, ordered_at,
  order_status, source, source_batch_id,
  note, created_at, updated_at,
  UNIQUE(platform_account_id, platform_order_id)
)

order_items(
  id, order_id, title, sku_text, product_id,
  sku_id, quantity, unit_price, shop_name
)

packages(
  id, courier,
  tracking_no, tracking_no_normalized,
  match_status, receipt_status, source,
  first_received_at, created_at, updated_at
)

package_order_links(
  package_id, order_id, order_item_id,
  created_at, UNIQUE(package_id, order_id, order_item_id)
)

import_batches(
  id, platform, source, file_sha256,
  started_at, finished_at, status,
  records_seen, records_created, records_updated,
  records_skipped, error_count, report_json
)

sync_runs(
  id, run_id, platform, account_key, worker_id, source,
  started_at, finished_at,
  status, cursor, records_seen, records_changed,
  error_code, error_message
)
~~~

现有 receipt_events 继续追加式保存 RECEIVE、REVOKE、REMATCH 事件，并关联照片、SHA-256、设备 ID 和操作人。物理包裹优先按 `courier_normalized + tracking_no_normalized` 建立全局候选，同一包裹可同时关联 PDD/1688 订单；未知承运商时先保留候选，不覆盖已有关系。

原始平台文件和原始响应如需短期留存，必须单独隔离、限制权限并设置删除周期；业务表不保存收件人姓名、电话和完整地址。

## 8. 当前实现与部署事实

### 8.1 已完成代码

- FastAPI + SQLite 后端；
- 管理员密码认证、HttpOnly 会话 Cookie，及可信局域网免登录开关；
- 照片上传、类型/大小校验、SHA-256、幂等 client_event_id；
- 重复运单号检测；
- Vue 3 微信 H5；
- 标准相机入口、图片压缩、ZXing 条码识别；
- IndexedDB 本地待上传队列、断网重传；
- 最近到货记录、手工补录单号；
- Docker Compose 部署文件、健康检查和备份脚本。

### 8.2 服务器部署现状与迁移目标

目标服务器：jackson@192.168.1.5
目标应用目录：/home/jackson/arrival-ledger
目标数据目录：/home/jackson/arrival-manager-data（数据库/数据路径暂时兼容旧名）
迁移后入口：http://192.168.1.5:8766
目标机现有 cash-save：80/443 和 127.0.0.1:8000（不得修改或占用）
旧机 192.168.1.4 上的 pharos：8848（清理 arrival 项目时不得修改）

- `.5` 已安装 Docker/Compose，`arrival-ledger-backend-1` 与 `arrival-ledger-frontend-1` 已启动并健康；
- `.5` 的 `/healthz`、`/api/health`、前端首页已通过 Mac 端检查；公网测试期间 `AUTH_REQUIRED=true`，未登录 `/api/auth/me` 正确返回 401；
- 数据已从 `.4` 的一致性归档恢复到兼容路径，当前历史收货记录数量为 0，仍保留空数据库结构；
- 旧机 `.4` 的 arrival Compose 栈已停止，旧代码/数据已移到带时间戳的 `*.retired-*` 归档目录，等待真机验收后最终删除；
- 目标机 8766 对外提供入口，后端容器端口仍不直接暴露，由前端 Nginx 负责网关；
- 尚未配置正式域名或 Named Tunnel；
- `.5` 当前运行宿主机 `cloudflared` Quick Tunnel，使用 IPv4 + HTTP/2 转发到 `127.0.0.1:8766`，未重启 arrival backend/frontend；URL 为随机 `trycloudflare.com`，仅用于本轮测试；
- 公网测试期间 `.env` 为 `AUTH_REQUIRED=true`、`COOKIE_SECURE=true`。直接 HTTP 局域网地址会要求登录，Secure Cookie 不能通过 HTTP 发送；测试应使用隧道 HTTPS。

### 8.3 最近本地验证

- 后端：5 passed；
- 前端：3 passed；
- TypeScript 检查通过；
- 生产构建通过；
- 尚未完成真实 iPhone/Android 微信连续 30 件验收；
- 尚未完成 Windows 浏览器同步端和内部批次接收接口；
- 尚未完成采购订单/CSV 导入模块；
- 浏览器自动化文档、数据契约和 DeepSeek 交接规范已冻结，尚未开始真实平台采集；
- Git 回滚基线已建立并推送到 GitHub `hyyyyyyz/arrival-ledger`（提交 `d431654`）。

### 8.4 服务器迁移：192.168.1.4 → 192.168.1.5

目标机 .5 已有 cash-save/Caddy 使用 80、443 和 127.0.0.1:8000；arrival-ledger 继续使用 8766，不修改 Caddy 和 cash-save。Docker 已安装并启动。

迁移必须遵循：

1. 先在所有手机的旧链接确认“待上传/失败/上传中”均为 0；.4 和 .5 是不同浏览器 origin，IndexedDB 队列不会自动迁移；
2. 暂停旧机收货写入，在 .4 生成 SQLite/media/uploads 一致性备份并计算 SHA-256；
3. 单独安全复制 .env，只把 TRUSTED_HOSTS 更新为 192.168.1.5；
4. 在 .5 安装 Docker/Compose，代码放 /home/jackson/arrival-ledger（已完成）；
5. 还原数据到兼容路径 /home/jackson/arrival-manager-data 并恢复 UID/GID 10001 权限；
6. 在 .5 启动并验证健康、页面、历史照片、上传、重启和备份（服务端检查已完成，真机上传待验收）；
7. 手机确认 http://192.168.1.5:8766 可用后，停止 .4 的 arrival-manager Compose 栈（已完成）；
8. 保存最终离机备份后，仅清理 .4 上本项目的容器、网络、镜像、代码目录和数据目录（已做可恢复归档，待真机确认后删除）；
9. 严禁清理 .4 的 pharos:8848、Docker 全局资源或其他目录。

在第 6–7 步验收完成之前，任何“清理 .4”操作都不允许执行。

## 9. 访问、安全、隐私与备份

### 9.1 两种访问模式

局域网模式（恢复免登录时）：

- AUTH_REQUIRED=false；
- 仅允许 192.168.1.0/24 等配置网段和指定 Host；
- 微信页面直接打开，不要求密码；
- 同一可信 Wi-Fi 内的其他设备理论上也能查看、上传和修改；
- X-Arrival-Client 只是降低跨站误触发的防护，不是身份认证；
- 所有操作暂归固定 warehouse operator，并记录 device_id，不能证明具体是谁操作。

公网模式（当前临时测试）：

- 先设置 AUTH_REQUIRED=true、COOKIE_SECURE=true；
- 必须使用 HTTPS；当前可用的 Quick Tunnel 仅为随机临时地址，不是稳定域名；
- 图片读取、订单导入和同步接口都需要鉴权；
- 不得把 8766 端口或局域网免登录模式直接端口映射到公网；隧道 ingress 只允许指向 `127.0.0.1:8766`，不得指向 Caddy/cash-save。

### 9.2 Windows 同步端信任边界

- 拼多多密码、Cookie、二维码登录态和 profile 只存在 Windows；
- Windows 只向服务器发起出站 HTTPS/局域网请求；
- 使用可撤销、可轮换的专用 sync worker API key；
- API key 不与管理员会话共用；
- 服务器只接受订单必要字段和同步批次，不接受浏览器控制指令；
- profile 目录不备份到服务器、不上传聊天、不放 Git；
- Windows 日志不得打印 Cookie、Authorization header 或完整地址。

### 9.3 照片和备份

- 手机先压缩到最长边约 1600–2000 px，目标约 0.5–1 MB；
- 每日 30 件约 15–30 MB，全年约 5.5–11 GB（实际以照片策略为准）；
- 每晚做 SQLite 一致性快照，照片做增量备份；
- 至少一份备份放另一台设备或异地存储；
- 建议 7 个日备、4 个周备、12 个月备；
- 每月执行恢复演练；
- .env 和 sync worker key 单独保存，不进入普通照片备份；平台密码、Cookie 和 profile 只在 Windows 本地。

## 10. 分阶段实施计划

### 阶段 P-1：原型与局域网部署（服务端已完成，待真机验收）

- [x] FastAPI/SQLite/H5/Docker 原型；
- [x] 拍照、压缩、条码识别、上传、哈希、幂等和重复提示；
- [x] IndexedDB 离线队列；
- [x] 192.168.1.4:8766 旧机局域网部署（迁移前基线）；
- [x] 代码/数据迁移并在 192.168.1.5:8766 启动，服务端健康检查通过；
- [ ] 手机/微信真机在 192.168.1.5:8766 拍摄并上传 1 件；
- [ ] 连续 30 件、断网重传、多个条码验收；
- [ ] 交互式检查容器日志、备份和磁盘告警。

### 阶段 P0：不依赖平台的收货闭环

- [ ] 采购订单手工创建/编辑；
- [ ] 订单—包裹—商品多对多关系；
- [ ] 待收清单、待认领区、待补单号区；
- [ ] 收货记录搜索、详情和撤销事件；
- [ ] 无订单映射时仍可拍照收货；
- [ ] 导出/备份基础数据。

验收：没有任何平台同步时，仍能完整处理 30 个包裹，并能查询、纠错和恢复。

### 阶段 P1：CSV 批量导入（立即优先）

- [ ] 导入 API、预览页、字段映射和 dry-run；
- [ ] 支持拼多多样本 CSV；
- [ ] 清洗 Excel 字符串包装；
- [ ] 忽略 PII；
- [ ] 订单、商品行、快递单号和包裹关系入库；
- [ ] 重复导入幂等；
- [ ] 生成 import report 和错误下载。

验收：

- 样本文件导入后订单数、有效运单数、退款/未知物流数与预览一致；
- 100/500/1000 行导入成功；
- 同一文件重复导入不增加重复订单；
- 订单号、商品 ID、规格 ID 和运单号始终按字符串保存；
- 数据库中不存在收件人电话和完整地址；
- 用面单照片扫描出的运单号能反查商品。

### 阶段 P2：拼多多低频同步（实际优先级最高的平台增强）

拼多多是当前必须覆盖的平台，因此在 CSV 导入完成后优先验证 Windows 浏览器路线；这项能力仍然是非官方实验，不能阻塞 P0/P1。

- [ ] Windows 10/11 安装独立 `pdd` profile；
- [ ] 首次人工登录并确认账号不是测试号；
- [ ] `login-check` 和 `sync-once --mode dry-run` 可见运行；
- [ ] 读取最近 20–30 个真实订单；
- [ ] 字段完整率、运单匹配率、重复幂等验收；
- [ ] 加入 NEEDS_LOGIN/CAPTCHA_OR_BLOCKED/SCHEMA_CHANGED/NETWORK_ERROR 状态；
- [ ] 用户确认 dry-run 报告后再执行 commit；
- [ ] 稳定后才评估 Windows Task Scheduler，每天 1–2 次；
- [ ] 首次扩大回补范围前先做备份和人工抽样。

只有以下条件同时满足，才允许定时启用：

- 不上传密码、Cookie 或 profile；
- 不绕过验证码和风控；
- 20–30 条真实订单字段完整率达到 95% 以上；
- 重复运行不产生重复订单；
- 登录失效能明确提示而不是静默写错；
- CSV/手工导入仍可独立使用。

### 阶段 P3：1688 可见浏览器同步

1688 与拼多多使用完全相同的 worker 信任边界；不申请官方开放平台权限，不保存 AppKey/AppSecret/OAuth/token。

- [ ] Windows 10/11 安装独立 `1688` profile；
- [ ] 用户在可见窗口手工登录实际采购账号；
- [ ] 适配订单列表、详情、分页/加载更多和物流字段；
- [ ] 读取最近 20–30 条真实订单并先 dry-run；
- [ ] 用户确认后 commit，验证订单—包裹—商品关系；
- [ ] 页面改版、登录失效、验证码均进入明确状态并保留游标；
- [ ] 与 PDD 共用内部批次接口，但账号 profile、account_key 和状态完全隔离。

平台页面无法读取时回退 CSV/截图/OCR/手工录入，不绕过页面保护。

### 阶段 P4：公网和运维

- [x] 临时 Quick Tunnel（无域名）连通性和未登录 401 验收；
- [ ] 手机通过隧道 HTTPS 登录、拍照、上传验收；
- [ ] 选择长期域名/访问方案（当前不购买域名）；
- [x] 认证模式切换到 `AUTH_REQUIRED=true`、`COOKIE_SECURE=true`；
- [ ] Named Tunnel/DDNS/VPS 三选一；
- [ ] 两个运营商网络和一个 Wi-Fi 连续 7 天测试；
- [ ] 异机备份和恢复演练；
- [ ] 日志、磁盘、同步失败告警。

公网不是 P0/P1 的前置条件；在公网启用前，必须关闭免登录模式。

### 阶段 P5：后续增强

- [ ] 更强 OCR/疑难图片辅助；
- [ ] 物流轨迹；
- [ ] 商品数量/开箱核验；
- [ ] 仓库位置备注；
- [ ] 微信小程序或 Capacitor 客户端（仅当 H5 真机体验不足）。

## 11. 验收标准

### 11.1 收货核心

1. iPhone 和 Android 微信 H5 可打开同一份局域网清单；
2. 连续 30 件拍照后照片、事件和服务端记录数量一致；
3. 断网、重载和重复点击不会丢失或重复计数；
4. 识别失败的包裹可进入待补录/待认领；
5. 每条完整凭证有照片、SHA-256、服务器时间和设备 ID；
6. 撤销和重新匹配保留完整事件历史。

### 11.2 CSV

1. 支持 UTF-8/BOM、引号和 Excel 字符串包装；
2. 10、100、500、1000 行文件均可导入；
3. 重复文件和重复行幂等；
4. 退款、取消、未知物流有明确状态；
5. PII 不进入业务表；
6. 导入报告能解释每一行的结果；
7. 运单号能和收货照片识别结果匹配。

### 11.3 Windows 浏览器同步（PDD 与 1688）

1. 独立 profile 首次人工登录成功；
2. 两个平台各手动同步 20–30 条真实订单；
3. 订单号、商品、规格、数量、店铺、快递和运单字段完整率 ≥95%；
4. 重复同步不增加重复记录；
5. 服务器收不到密码、Cookie 或完整 profile；
6. 登录过期/验证码/页面改版进入明确错误状态；
7. dry-run 与 commit 的记录集合一致，重复 commit 幂等；
8. 停止同步端时，P0/P1 功能仍正常；
9. 只有验收通过后，才允许 Task Scheduler 低频运行。

### 11.4 公网

1. AUTH_REQUIRED=true、HTTPS、非公开图片；
2. 7 天连续测试页面和照片上传；
3. Tunnel/网关重启后可恢复；
4. 异机备份可恢复数据库和照片；
5. 不影响现有 pharos:8848。

## 12. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| PDD/1688 网页改版/风控 | 同步停止 | CSV、截图/OCR、手工导入；同步熔断 |
| 拼多多协议限制 | 账号或工具风险 | 只读、低频、单账号、人工登录，不绕过验证 |
| 浏览器登录失效/验证码 | 同步不可用 | Windows 窗口人工处理；不自动重试或绕过 |
| 页面结构变化 | 错误订单入库 | `SCHEMA_CHANGED` 熔断，保留游标和脱敏诊断 |
| 面单无平台订单号 | 无法直接反查 | 预先建立运单映射，未知单号进入待认领 |
| 同一订单拆包/合包 | 错误打勾 | 多对多链接和包裹级确认 |
| 手机浏览器清理本地数据 | 待上传照片丢失 | 尽快上传、显示未同步、服务器/异机备份 |
| 局域网免登录被误用 | 同网设备可修改 | 明确可信网络边界；公网前启用认证 |
| 照片增长过快 | 磁盘不足 | 压缩、告警、保留策略、异机归档 |
| Windows 休眠/关机 | 定时任务错过 | 开机补跑，记录最后成功游标 |
| 服务器 IP 变化 | 手机打不开 | 路由器 DHCP 保留，后续域名/Tunnel |

## 13. 当前待确认事项

这些事项不会阻塞 P0：

1. 闲置 Windows 的版本（Windows 10/11）及是否允许长期接电运行；
2. PDD、1688 两个独立 profile 对应的 `account_key` 标签；
3. 服务器照片的异机备份目标；
4. 是否在临时隧道验收后恢复局域网免登录，还是继续保留认证模式；
5. 首次手动同步的最大订单数（MVP 默认 30）。

## 14. 下一步执行顺序

1. 先完成微信真机拍摄一件和连续 30 件局域网验收；
2. 实现 CSV 预览、导入、去重和订单—包裹匹配；
3. 用现有拼多多样本验证扫描运单号能反查商品；
4. DeepSeek 按 [`DEEPSEEK_HANDOFF.md`](DEEPSEEK_HANDOFF.md) 完成 sync-agent 骨架和内部批次接口；
5. Windows 上分别对 PDD、1688 执行 `doctor → login-check → dry-run → commit`；
6. 手动同步稳定后才启用每天 1–2 次任务计划；
7. 最后决定公网访问策略，并在公网前切换认证。

## 15. 变更记录

### v1.0（2026-08-13）

- 根据实际账号权限结果，正式废弃 1688/PDD 官方平台 API、OAuth、AppKey/AppSecret 和 token 路线；不再把申请平台权限作为任务或前置条件；
- 将 PDD 与 1688 统一为 Windows 独立 Chrome profile + Node.js/TypeScript + Playwright headed 浏览器同步；
- 冻结可见 DOM、只读、低频、人工登录、验证码/风控熔断等安全边界；
- 新增 [`docs/BROWSER_SYNC_SPEC.md`](docs/BROWSER_SYNC_SPEC.md)：浏览器适配器、订单模型、游标、批次接口、数据表、测试矩阵和 MVP 验收；
- 新增 [`DEEPSEEK_HANDOFF.md`](DEEPSEEK_HANDOFF.md) 与 [`CONTRIBUTING.md`](CONTRIBUTING.md)，规定实现顺序、提交格式、测试门槛和禁止事项；
- 明确“不要平台 API”不等于“不要到货管家内部同步接口”：Windows 端只上传规范化订单批次，服务器负责幂等和匹配。

### v0.8（2026-08-13）

- 将 Windows 闲置电脑 + 独立 Chrome profile 定为拼多多同步端；
- 仓库/工程名改为 arrival-ledger；现有服务器路径、数据库文件名和浏览器存储命名空间暂时兼容旧名；
- 明确服务器是纯 Server，Mac 不参与采集；
- 明确拼多多普通买家无可依赖的公开订单 API，个人开发者申请不作为路线；
- 增加 CSV 清洗、PII 丢弃、批量幂等和导入验收；
- （历史）曾记录平台官方接口调研；v1.0 已明确不实现这些接口；
- 将平台同步从核心 P0 中剥离，增加失败时的人工降级；
- 修正局域网免登录的威胁边界、公网认证要求和 Windows 凭据边界；
- 校正当前部署、测试和未完成项；
- 完成 GitHub 基线、代码/数据从 `192.168.1.4` 迁移到 `192.168.1.5`，并记录旧机待真机验收后清理的边界。
- 已停止 `.4` 旧 arrival 栈并保留最终归档，确认 `.4:8848` pharos 仍在监听。

### v0.9（2026-08-13）

- 在不重启 arrival backend/frontend 的前提下，于 `.5` 启动宿主机 `cloudflared` Quick Tunnel；
- 使用 `--edge-ip-version 4 --protocol http2` 规避当前网络的 QUIC/IPv6 不稳定；隧道只转发到 `127.0.0.1:8766`，不触碰 Caddy/cash-save；
- 完成公网 `/healthz` 200、首页 200、未登录 `/api/auth/me` 401 验收；
- 明确无域名时 URL 为随机临时地址，公网测试必须登录，长期稳定入口仍未配置；
- 更新 README/PLAN 的认证、隧道启动/停止和验收说明。

### v0.7（历史，2026-08-13）

方案重整和平台调研内容已合并到 v0.8；保留该版本号用于对应此前的部署基线。

### v0.6（历史）

- 完成 FastAPI/SQLite + Vue H5 原型、局域网部署、照片幂等上传、ZXing 和 IndexedDB 离线队列。
