# arrival-ledger 后端（到货管家）

FastAPI + SQLite 的 P-1 后端。默认容器启动命令：

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## 必要配置

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `SESSION_SECRET` | 会话令牌 HMAC 密钥，至少 32 个字符 | 无，必须设置 |
| `AUTH_REQUIRED` | 是否要求登录；私有局域网原型可设为 `false` | `true`（Compose 局域网模板为 `false`） |
| `TRUSTED_USER_USERNAME` | 免登录模式下记录操作人的现有用户名 | `admin` |
| `TRUSTED_LAN_CIDRS` | 免登录模式允许的客户端网段，逗号分隔 | `192.168.1.0/24` |
| `TRUSTED_HOSTS` | 免登录模式允许的 Host，逗号分隔 | `192.168.1.5` |
| `BOOTSTRAP_ADMIN_USERNAME` | 首次启动创建的管理员用户名 | `admin` |
| `BOOTSTRAP_ADMIN_PASSWORD` | 首次启动创建管理员所用密码 | 无 |
| `BOOTSTRAP_ADMIN_DISPLAY_NAME` | 首次管理员显示名 | `管理员` |
| `COOKIE_SECURE` | 局域网 HTTP 使用 `false`；HTTPS 时改为 `true` | `false` |
| `DATABASE_PATH` | SQLite 文件 | `/data/db/arrival-manager.db` |
| `MEDIA_DIR` | 凭证照片目录 | `/data/media` |
| `MAX_UPLOAD_BYTES` | 单张照片最大字节数 | `12582912`（12 MiB） |
| `SESSION_TTL_SECONDS` | 登录会话有效期 | `2592000`（30 天） |
| `SYNC_WORKER_TOKENS` | Windows 同步端 worker token，逗号分隔、每个至少 16 字符；**明文只保存在服务器 `.env` 与 Windows 本机 `.env.local`**，数据库仅存 HMAC 摘要，从列表移除即撤销。为空时同步接口返回 503 | 无（默认关闭同步） |
| `SYNC_RATE_LIMIT_PER_HOUR` | 每个 token 每小时最多接受的批次数（1–60） | `6` |
| `SYNC_MAX_BATCH_ORDERS` | 单批次最大订单数（1–100） | `100` |
| `SYNC_MAX_BATCH_BYTES` | 单批次请求体最大字节数（4096–2097152） | `262144` |
| `ALI1688_API_ENABLED` | 启用 1688 服务端官方 API | `false` |
| `ALI1688_CONFIG_PATH` | 只读 JSON secret 文件路径 | `/run/secrets/ali1688.json` |
| `ALI1688_SYNC_INTERVAL_SECONDS` | 定时同步间隔；0 关闭 | `0` |
| `ALI1688_TIMEOUT_SECONDS` / `ALI1688_RETRIES` | API 超时和有限重试 | `15` / `2` |
| `ALI1688_MAX_PAGES` / `ALI1688_BACKFILL_DAYS` | 每账号单次页数和首次回溯窗口 | `25` / `30` |

初始化规则：只有 `users` 表为空时，服务才会读取 bootstrap 管理员配置并创建密码哈希。之后重启不会用环境变量覆盖账号或密码；数据库已有用户时，可以删除 `BOOTSTRAP_ADMIN_PASSWORD` 后正常启动。若数据库为空且没有提供该密码，服务会拒绝启动，避免产生无人能登录的实例。

容器以 UID/GID `10001:10001` 运行，数据库和媒体 bind mount 必须允许该 UID 写入。上传临时文件位于 `MEDIA_DIR/.tmp`，校验后在同一文件系统内原子重命名。

## API 摘要

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/dashboard/stats`（已认证的首页只读业务统计）
- `GET /api/orders`（已认证的订单列表；支持 `limit`、`offset`、`query`、`platform`）
- `POST /api/receipts`（multipart 照片到货凭证）
- `GET /api/receipts`
- `PATCH /api/receipts/{id}/tracking`
- `GET /api/receipts/{id}/photo`
- `POST /api/sync/v1/batches`（Windows 同步端批次接收，Bearer worker token，幂等/限频/严格校验）
- `GET /api/sync/v1/status`（已认证的 1688 同步状态，不返回 secret）

首页统计只把 `evidence_status=READY` 且 `duplicate_of_receipt_id IS NULL` 的首张有效凭证
算作一次到货，重复拍照不会虚增数字。一个运单号仅关联一个订单时，该订单才计入
`matched_orders`；关联多个订单的首张有效凭证计入 `candidate_photos`，不能视为已确认到货。
`linked_orders` 包含确认和候选关联，`unmatched_photos` 表示无任何订单关联的首张有效凭证。
`unlinked_orders` 是尚无唯一确认关联的订单数；兼容字段 `pending_orders` 与其同值，不代表
采购或物流平台的“待发货/待到货”状态。

订单列表按 `ordered_at DESC, id DESC` 稳定排序，`platform` 只接受 `pdd` 或 `1688`。
`query` 可检索订单号、店铺、账号标签、订单状态、商品/SKU、快递和运单号。每单批量返回
商品和包裹；账号没有显示标签时返回稳定的 `账号 {内部账号 ID}`，搜索也覆盖 `account_key`。
只有查询词完全由 ASCII 字母、数字、空格或横线组成且标准化后至少 6 位时，才额外启用
标准化运单号搜索。

同一订单内相同标准化运单号的多行按一个物理包裹返回。包裹的 `arrival_status` 为
`PENDING`、`ARRIVED` 或 `CANDIDATE`；只有 READY、非重复的首张有效凭证对应的运单号在
全库唯一关联一个订单时才是 `ARRIVED`。关联多个订单时计入 `candidate_package_count` 和
`candidate_photo_count`，不会增加 `arrived_package_count` 或 `arrival_photo_count`。

## 1688 Open API 运维命令

1688 由 backend 直接调用官方 Open API，不需要桌面环境或浏览器。凭证文件通过 Compose 只读挂载，
详细申请、配置、令牌轮换、回滚和验收见 [`../docs/ALI1688_OPEN_API.md`](../docs/ALI1688_OPEN_API.md)。

```bash
docker compose run --rm backend python -m app.cli config-doctor
docker compose run --rm backend python -m app.cli sync-once --account <account_key> --dry-run
docker compose run --rm backend python -m app.cli sync-once --all --dry-run
docker compose run --rm backend python -m app.cli sync-once --account <account_key>
docker compose run --rm backend python -m app.cli sync-once --all
```

`config-doctor` 不打印 key/secret/token；`dry-run` 不写订单、批次或游标。首次配置至少先做单账号
dry-run，再按账号确认后提交。每个账号有独立游标和锁，失败账号不会推进游标；PDD 仍在 Windows
`sync-agent` 中运行，不能用这些 backend 命令代替 PDD 浏览器验收。

当 `AUTH_REQUIRED=true` 时，除健康检查和登录外均要求服务端会话 Cookie。将其设为 `false` 后，服务会先校验 `TRUSTED_HOSTS` 和 `TRUSTED_LAN_CIDRS`，再把 `TRUSTED_USER_USERNAME` 对应的启用用户作为固定操作人，打开局域网页面即可使用，不再要求账号密码。免登录模式的写请求还必须带内部前端标识头；这不是身份认证，只是降低跨站伪造风险。免登录模式只适用于可信局域网；任何公网、Quick Tunnel 或端口转发前都必须恢复为 `AUTH_REQUIRED=true`。Cookie 为 `HttpOnly`、`SameSite=Lax`，`Secure` 由 `COOKIE_SECURE` 控制。

上传表单字段：

- `photo`：JPEG、PNG、WebP 或 HEIC/HEIF；同时检查声明类型、文件魔数和大小；
- `client_event_id`：客户端生成的幂等键；
- `captured_at`：带时区的 ISO 8601 时间，也兼容字段名 `occurred_at`；
- `device_id`：客户端持久设备标识；
- `tracking_no`：可选快递单号；
- `barcode_candidate`：可选识别候选；
- `input_method`：接受 `PHOTO_CAPTURE`（相机拍摄）或 `PHOTO_LIBRARY`（相册选择）。

第三方或线下采购可通过认证接口 `POST /api/manual-orders` 录入。必填字段是稳定的
`client_event_id`、`tracking_no` 和 `product_name`，`courier`、`remark` 可选。标准化运单号全局去重；
若已属于 1688/PDD 订单则返回 `409`，不会误建重复订单。创建人和创建时间会随统一订单列表返回。

多单可通过 `POST /api/manual-orders/batch` 批量录入。接口接受逗号、中文逗号、分号或换行
分隔的 `tracking_text`，也接受前端从 `.xlsx` / CSV 解析后的 `rows`。单批最多 500 条、JSON
请求体最多 512 KiB；每行独立校验并返回创建、幂等重放、批内重复或失败结果。已存在的平台运单
和既有手工运单只会报告冲突，不会被覆盖。`client_batch_id` 绑定原始负载和操作人，网络重试不会
重复建单，也不能由另一名用户复用。

相同 `client_event_id` 重试返回既有记录，不重复写照片或数据库行。不同事件使用相同标准化快递单号时仍保存新照片以供审计，并通过 `is_duplicate`、`duplicate_of_id` 和 `duplicate_of` 指向首次记录。

## 测试

```bash
python -m pytest
```
