# 1688 官方 Open API：多应用、多账号同步

1688 订单由后端调用官方 Open API；拼多多仍由 Windows headed Chrome 同步。1688 不需要浏览器窗口、
Playwright 或 Windows profile。服务器是纯 Server，凭证只以私有文件挂载到 backend 容器。

## 1. 平台准备

在 1688 开放平台创建/使用企业自用应用，申请买家订单列表和买家订单详情能力，并为每个需要同步的
采购账号完成授权。当前企业自用应用界面显示每个应用最多 5 个授权账号，程序也按此上限校验；以控制台
实际显示的权限和额度为准。一个应用达到授权上限时创建第二个应用，配置
文件可包含多个应用。应用与账号的对应关系由 `account_key` 明确记录，不能根据手机号猜测。

测试期间如果 token、AppSecret 曾出现在截图、聊天或剪贴板，先在开放平台重置/重新授权，再继续配置。

## 2. Secret 文件

在服务器项目根目录执行：

```bash
cp secrets/ali1688.example.json secrets/ali1688.json
sudo chown "$(id -u):10001" secrets/ali1688.json
sudo chmod 0640 secrets/ali1688.json
```

编辑 `secrets/ali1688.json`，用控制台真实值替换占位符；不要把值放入命令行、`.env`、Issue、截图或
日志。后端会拒绝软链接、非普通文件以及 POSIX 权限不是 `0600`/`0640` 的凭证文件。一个应用可以
授权多个账号，多个应用按同样结构并列：

```json
{
  "apps": [
    {
      "app_key": "<app-key>",
      "app_secret": "<app-secret>",
      "display_label": "采购应用 A",
      "accounts": [
        {"account_key": "buyer-main", "display_label": "主账号", "access_token": "<token-A>"},
        {"account_key": "buyer-2", "display_label": "采购账号 2", "access_token": "<token-B>"}
      ]
    },
    {
      "app_key": "<second-app-key>",
      "app_secret": "<second-app-secret>",
      "display_label": "采购应用 B",
      "accounts": [
        {"account_key": "buyer-3", "display_label": "采购账号 3", "access_token": "<token-C>"}
      ]
    }
  ]
}
```

`account_key` 必须唯一、稳定且不含手机号；同一个订单号出现在两个账号下是两条独立订单。Compose 默认
挂载已跟踪的空文件 `secrets/ali1688.empty.json`，因此不会因缺文件启动失败；启用同步前，在服务器
`.env` 设置：

```dotenv
ALI1688_API_ENABLED=true
ALI1688_SECRET_FILE=./secrets/ali1688.json
ALI1688_SYNC_INTERVAL_SECONDS=0
```

变更 secret 文件后重建 backend 使只读挂载和配置生效：

```bash
docker compose config --quiet
docker compose up -d --build backend
```

## 3. 检查与第一次同步

`config-doctor` 只输出是否已配置、应用数和账号数，不输出任何 key/secret/token：

```bash
docker compose run --rm backend python -m app.cli config-doctor
```

先对单个账号执行 dry-run。它按修改时间窗口读列表、按需读订单详情，只在内存映射，不写订单、批次、
游标或平台数据：

```bash
docker compose run --rm backend python -m app.cli sync-once --account buyer-main --dry-run
```

确认输出的读取数、解析数、错误摘要后，再提交单账号；全部账号确认后再提交全量：

```bash
docker compose run --rm backend python -m app.cli sync-once --account buyer-main
docker compose run --rm backend python -m app.cli sync-once --all
```

API 映射规则：列表订单使用 `baseInfo.idOfStr` 字符串；详情使用 `alibaba.trade.get.buyerView` 和
`includeFields=NativeLogistics`；商品以 SKU/子商品键区分；物流优先取
`nativeLogistics.logisticsItems[].logisticsBillNo`，缺失时才使用合规的 `logisticsCode` 回退。
地址、收件人、手机号、买卖双方联系方式和原始响应不会进入订单库或日志。

## 4. 多账号、游标和定时器

每个 `account_key` 有独立的修改时间游标、运行记录和锁；失败账号不推进游标，也不影响其它账号。
窗口带重叠时间，避免边界丢单；单次页数有上限，达到上限时不错误推进游标。订单/批次/游标在同一
事务中提交，重复运行按平台、账号和订单 ID 幂等。

默认 `ALI1688_MAX_PAGES=25`，按平台每页 20 条计算可覆盖每账号 500 条修改记录；超过时命令返回
`PARTIAL` 且不推进游标。此时结合开放平台当日额度，分账号运行并逐步提高页数（最大 100）或缩短首次
回溯天数，直到该账号返回 `OK`，不要把 `PARTIAL` 当作成功。

确认至少一次人工 dry-run + commit、两个账号隔离及收货运单匹配后，再开启服务端定时器：

```dotenv
ALI1688_API_ENABLED=true
ALI1688_SYNC_INTERVAL_SECONDS=900
```

建议间隔不少于 300 秒；设置为 `0` 关闭。定时器只在 backend 内运行，不需要额外桌面或浏览器。查看已
认证的同步状态：

```bash
curl --cookie '<本机会话 Cookie>' http://127.0.0.1:8766/api/sync/v1/status
```

不要把 Cookie 放入 shell 历史、文档或报告；公网访问必须使用 HTTPS 和 `AUTH_REQUIRED=true`。

## 5. 令牌轮换

1. 在开放平台重新授权/重置受影响账号，获取新 token；如 AppSecret 暴露，同时重置 AppSecret。
2. 在服务器受限编辑 `secrets/ali1688.json`，只替换对应值，不改变稳定的 `account_key`。
3. 恢复该文件的受限属主/权限、运行 `config-doctor`，确认应用/账号数量不变且无 secret 输出。
4. `docker compose up -d --build backend`，先单账号 dry-run，再按确认流程提交。
5. 旧 token 不再使用；不要把旧 token 留在备份、剪贴板或聊天中。

## 6. 禁用、回滚和排障

暂停 1688 API 而保留已入库订单：

```bash
docker compose stop backend
# 在 .env 设置 ALI1688_API_ENABLED=false 或 ALI1688_SYNC_INTERVAL_SECONDS=0
docker compose up -d backend
```

PDD Windows 同步和手机拍照收货不依赖 1688 API，暂停不会影响它们。版本回滚前先执行部署文档中的
备份，恢复上一已验证 backend 镜像；数据库迁移失败应自动回滚，不要删除数据库或照片。常见状态：

- `config-doctor` 失败：修正 JSON、重复 `account_key` 或文件权限，不要复制 token 到命令行；
- 401/403/权限错误：停止重试，重新授权/检查能力与账号绑定；
- 超时、网络错误、429/5xx：客户端只做有限退避，连续失败后等待；
- 返回结构不符合 allowlist：标记 schema/error，不猜字段、不写半批数据；
- 单账号失败：查看该账号状态，修复后从其游标继续，其它账号无需回滚。

## 7. 验收标准

- 至少两个 1688 采购账号可分别 dry-run/commit，订单号、商品、SKU、数量和状态正确；
- 多商品不合并，多包裹运单全部保留；同一运单可与 PDD 订单共存并正确匹配；
- 同一账号重复同步不新增重复订单、商品、包裹；失败不推进该账号游标；
- 服务器数据库和日志没有 AppSecret、access token、密码、Cookie、地址或电话；
- 关闭 1688 定时器后 PDD Windows 同步与手机收货仍正常。
