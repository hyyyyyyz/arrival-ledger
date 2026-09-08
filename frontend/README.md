# arrival-ledger 前端（到货管家）

面向 iPhone、Android 微信内置浏览器的 Vue 3 移动 H5。拍摄后先读取完整照片字节并写入 IndexedDB，确认本机保存后即可继续拍下一件；独立队列负责压缩、Worker 一维条码识别和串行上传，服务器保留既有识别兜底。

上传中断/超时自动退避重试，只有服务器返回对应事件 ID 的有效确认才移除本机照片。同一照片重试复用事件 ID；用户切换后只上传当前拍摄人的队列。旧版已暂停的失败记录可点「失败」或「待上传」计数一次性继续同步，不需要重新拍摄。

网页需保持打开：锁屏、关闭页面或微信切后台可能暂停任务，返回后继续。不要清理网站数据或待上传照片。阶段超时、历史故障证据和真机验收要求见 [上传可靠性说明](../docs/UPLOAD_RELIABILITY.md)。

## 本地开发

```bash
npm install
npm run dev
```

Vite 默认把 `/api` 转发到 `http://127.0.0.1:8000`；可通过 `VITE_DEV_API_TARGET` 修改。

## 验证

```bash
npm run test
npm run typecheck
npm run build
```

## API 契约

- `POST /api/auth/login`：JSON `{ username, password }`，通过 HttpOnly Cookie 建立会话；
- `GET /api/auth/me`、`POST /api/auth/logout`；
- `GET /api/receipts?limit=80`：返回数组或 `{ items: [] }`；
- `GET /api/orders?limit=20&offset=0&query=&platform=`：分页查询已同步采购订单，不直接访问采购平台；
- `POST /api/receipts`：multipart，字段为 `client_event_id`、`captured_at`、`input_method`、`device_id`、可选 `tracking_no` 和必填 `photo`；
- `PATCH /api/receipts/:id/tracking`：JSON `{ tracking_no, expected_tracking_no, client_event_id }`；同一次用户修改在网络重试时必须复用 `client_event_id`，`409` 后刷新记录再由用户确认重试；
- `GET /api/receipts/:id/photo`：鉴权后的图片响应。

前端兼容 API 将用户/收货响应直接返回，或分别包装为 `{ user }` / `{ receipt }` 的形式。
