# 快递面单识别

## 识别顺序

上传照片时始终先在手机浏览器本地尝试 `BarcodeDetector`、ZXing 和内置 zbar
解码。这个路径不上传照片，通常在几百毫秒内完成。

本地没有得到单号时，如果配置了 `ZHIPU_VL_API_KEY`，后端才会对这一次照片发起
一次 GLM-V 请求。当前默认模型是 `glm-4.1v-thinking-flash`（智谱免费视觉模型）。
模型输出只是“不可信候选”；后端只会保存同时存在于 `packages` 订单库中的候选，
因此订单号、手机号、邮编或模型幻觉不会被自动绑定。服务商不可用、超时、限流或
余额不足时，照片仍然保存为“待补快递单号”，不会丢失。

## 配置

在部署机的私有 `.env` 中设置（不要提交到 Git）：

```dotenv
ZHIPU_VL_API_KEY=在智谱控制台生成的密钥
ZHIPU_VL_MODEL=glm-4.1v-thinking-flash
ZHIPU_VL_TIMEOUT_SECONDS=12
```

修改后仅重建并重启后端即可：

```bash
docker compose -p arrival-ledger build backend
docker compose -p arrival-ledger up -d --no-deps backend
docker compose -p arrival-ledger ps
```

不要执行 `docker compose down -v`；照片和 SQLite 数据位于宿主机绑定目录。

## 成本与风控

- 本地识别成功的照片不会调用智谱。
- 每张本地识别失败的照片最多调用一次，超时上限由
  `ZHIPU_VL_TIMEOUT_SECONDS` 控制。
- 后端不会记录 API key、原始模型响应或照片 base64；日志只记录错误类型。
- 免费模型可能返回 429（繁忙或额度策略），这是可接受的降级路径；需要人工确认
  的照片应在“收货记录”中补录单号。

## 验收建议

先用一张订单库中已存在的面单验证自动匹配，再用一张不在订单库中的面单验证
“待补单号”降级。检查重复上传仍然幂等、网络失败仍保留本机队列，以及模型不可用
时不会阻塞上传。
