# arrival-ledger 前端（到货管家）

面向 iPhone、Android 微信内置浏览器的 Vue 3 移动 H5。照片会先压缩并写入 IndexedDB，再尝试识别一维条码和串行上传。

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
- `PATCH /api/receipts/:id/tracking`：JSON `{ tracking_no }`；
- `GET /api/receipts/:id/photo`：鉴权后的图片响应。

前端兼容 API 将用户/收货响应直接返回，或分别包装为 `{ user }` / `{ receipt }` 的形式。
