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

初始化规则：只有 `users` 表为空时，服务才会读取 bootstrap 管理员配置并创建密码哈希。之后重启不会用环境变量覆盖账号或密码；数据库已有用户时，可以删除 `BOOTSTRAP_ADMIN_PASSWORD` 后正常启动。若数据库为空且没有提供该密码，服务会拒绝启动，避免产生无人能登录的实例。

容器以 UID/GID `10001:10001` 运行，数据库和媒体 bind mount 必须允许该 UID 写入。上传临时文件位于 `MEDIA_DIR/.tmp`，校验后在同一文件系统内原子重命名。

## API 摘要

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `POST /api/receipts`（multipart 照片到货凭证）
- `GET /api/receipts`
- `PATCH /api/receipts/{id}/tracking`
- `GET /api/receipts/{id}/photo`

当 `AUTH_REQUIRED=true` 时，除健康检查和登录外均要求服务端会话 Cookie。将其设为 `false` 后，服务会先校验 `TRUSTED_HOSTS` 和 `TRUSTED_LAN_CIDRS`，再把 `TRUSTED_USER_USERNAME` 对应的启用用户作为固定操作人，打开局域网页面即可使用，不再要求账号密码。免登录模式的写请求还必须带内部前端标识头；这不是身份认证，只是降低跨站伪造风险。免登录模式只适用于可信局域网；任何公网、Quick Tunnel 或端口转发前都必须恢复为 `AUTH_REQUIRED=true`。Cookie 为 `HttpOnly`、`SameSite=Lax`，`Secure` 由 `COOKIE_SECURE` 控制。

上传表单字段：

- `photo`：JPEG、PNG、WebP 或 HEIC/HEIF；同时检查声明类型、文件魔数和大小；
- `client_event_id`：客户端生成的幂等键；
- `captured_at`：带时区的 ISO 8601 时间，也兼容字段名 `occurred_at`；
- `device_id`：客户端持久设备标识；
- `tracking_no`：可选快递单号；
- `barcode_candidate`：可选识别候选；
- `input_method`：当前只接受 `PHOTO_CAPTURE`。

相同 `client_event_id` 重试返回既有记录，不重复写照片或数据库行。不同事件使用相同标准化快递单号时仍保存新照片以供审计，并通过 `is_duplicate`、`duplicate_of_id` 和 `duplicate_of` 指向首次记录。

## 测试

```bash
python -m pytest
```
