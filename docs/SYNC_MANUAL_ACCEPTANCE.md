# 平台订单同步手工验收清单

验收范围分成两条互不依赖的路线：1688 在服务器调用官方 Open API；拼多多在 Windows headed
Chrome 页面同步。不要在 Windows 上运行 1688 浏览器命令。真实页面、token、订单号、运单号和截图不得
进入 Git、Issue 或聊天。

## A. 1688 服务器 API 验收

按 [`ALI1688_OPEN_API.md`](ALI1688_OPEN_API.md) 创建 `secrets/ali1688.json`，先完成
`config-doctor`，确认至少两个授权账号的 `account_key` 不重复；不要在命令行传 AppSecret 或 token。

```bash
docker compose run --rm backend python -m app.cli config-doctor
docker compose run --rm backend python -m app.cli sync-once --account <account_key> --dry-run
docker compose run --rm backend python -m app.cli sync-once --all --dry-run
```

核对 dry-run 的数量、状态和错误摘要，不应写入订单、批次或游标。确认后再执行一次单账号提交，随后
执行全账号提交：

```bash
docker compose run --rm backend python -m app.cli sync-once --account <account_key>
docker compose run --rm backend python -m app.cli sync-once --all
```

验收至少包含：两个账号互相隔离；订单使用字符串 `idOfStr`；多商品不合并 SKU；多包裹全部保留；
`logisticsBillNo` 优先且缺失时安全回退；重复运行不新增订单/商品/包裹；地址、电话、买卖双方联系方式
不出现在数据库和日志；一个账号失败不影响其它账号。

## B. 拼多多 Windows 验收

在 Windows 10/11 按 [`WINDOWS_SYNC_FROM_SCRATCH.md`](WINDOWS_SYNC_FROM_SCRATCH.md) 安装，仅配置
PDD profile：

```powershell
npm.cmd run doctor -- --offline
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run login-check -- --platform pdd
npm.cmd run sync-once -- --platform pdd --mode dry-run
```

dry-run 后人工在本机核对 20–30 条订单的订单号、商品、规格、数量、店铺、状态和页面可见物流。确认后
才可以使用同一 snapshot commit：

```powershell
npm.cmd run sync-once -- --platform pdd --mode commit --from-report .\state\snapshot-pdd-pdd-main-<batch_id>.json --yes
```

浏览器必须始终可见、只读；登录失效、验证码、系统繁忙或结构变化必须熔断。commit 不得重新访问页面，
快照过期、hash 改变或游标不一致必须拒绝。重复提交不产生重复数据，停止 Windows worker 后手机收货
仍可用。

## C. 统一验收表

| 项目 | 通过标准 |
|---|---|
| 1688 多账号 | 至少两个账号独立同步、独立游标与错误状态 |
| 1688 多商品/多包裹 | SKU 不合并，所有可用运单均保留 |
| PDD 页面 | 20–30 条真实订单字段完整率达到项目目标，页面只读可见 |
| 幂等 | 同一批次重放不增加数据库行，新增运行记录为 skipped/已处理 |
| PII | DB、日志、snapshot 之外的服务器数据不含地址、电话、Cookie、密码 |
| 风控 | 不绕过验证；状态明确且不无限重试 |
| 收货闭环 | 面单运单号可匹配 PDD/1688 订单；无匹配时进入待认领 |
| 故障隔离 | 任一平台或账号失败不影响手机拍照收货和其它账号 |

## D. 交接格式

只填写数量和状态，不粘贴报告原文：

```text
1688 config-doctor：OK / FAIL（应用数 N，账号数 N）
1688 dry-run：账号标签 A/B；读取 N；解析 N；失败 N
1688 commit：created / updated / skipped / errors
1688 多商品/多包裹：正确 / 不正确 / 未发现样本
PDD doctor/test/typecheck/build：通过 / 失败
PDD login-check：OK / NEEDS_LOGIN / CAPTCHA_OR_BLOCKED
PDD dry-run/commit：读取 N；解析 N；结果摘要
收货匹配：通过 / 失败
异常：<脱敏状态码和处理方式>
```

只有服务器 API 与 PDD 手工验收都通过后，才评估 1688 服务端定时器和 PDD Windows Task Scheduler；
两者都必须低频、串行、可停止，默认仍关闭。
