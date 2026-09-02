# 平台订单同步手工验收清单

验收范围分成两条互不依赖的路线：1688 在服务器调用官方 Open API；拼多多在 Mac/Windows 桌面或
Linux 服务器 Xvfb/noVNC 的可见 Playwright 浏览器中同步。不要在同步端运行 1688 浏览器命令。真实页面、
token、订单号、运单号和截图不得进入 Git、Issue 或聊天。

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

## B. 拼多多可见浏览器多账号验收

先按 [`PDD_MULTI_ACCOUNT.md`](PDD_MULTI_ACCOUNT.md) 在管理员网页登记相同的稳定账号键，再在一台有
桌面会话的 Mac/Windows 同步电脑，或按 [`PDD_SERVER_AGENT.md`](PDD_SERVER_AGENT.md) 在 Linux
服务器 Agent 中配置 `PDD_ACCOUNTS_FILE`。Windows 首次安装细节另见
[`WINDOWS_SYNC_FROM_SCRATCH.md`](WINDOWS_SYNC_FROM_SCRATCH.md)。每个账号必须使用不同的持久化 profile。

```bash
npm run doctor -- --offline --platform pdd
npm test
npm run typecheck
npm run build
npm run accounts -- --platform pdd
npm run login-check -- --platform pdd --account pdd-main
npm run login-check -- --platform pdd --account pdd-backup
npm run sync-once -- --platform pdd --account pdd-main --mode dry-run
```

逐账号 dry-run 后人工在本机核对 20–30 条订单的订单号、商品、规格、数量、店铺、状态和页面可见物流。
确认后才可以使用该账号的同一 snapshot commit：

```bash
npm run sync-once -- --platform pdd --account pdd-main --mode commit \
  --from-report ./state/snapshot-pdd-pdd-main-<batch_id>.json --yes
```

浏览器必须始终可见、只读；登录失效、验证码、系统繁忙或结构变化必须熔断。commit 不得重新访问页面，
快照过期、hash 改变、账号或游标不一致必须拒绝。重复提交不产生重复数据，停止同步电脑 worker 后手机收货
仍可用。

每个账号分别完成 login-check、dry-run、核对和首次 commit 后，再验证全账号串行 dry-run：

```bash
npm run sync-all -- --platform pdd --mode dry-run
```

必须确认浏览器从不同时打开两个账号，执行顺序与 JSON 数组一致，每个账号产生独立 snapshot；某个账号失败
时后续账号仍被检查，但命令最终返回非零。`sync-all` 当前不支持 commit，生成的 snapshot 仍须逐个核对并用
带 `--account` 的 `sync-once --mode commit` 提交。

## C. 统一验收表

| 项目 | 通过标准 |
|---|---|
| 1688 多账号 | 至少两个账号独立同步、独立游标与错误状态 |
| 1688 多商品/多包裹 | SKU 不合并，所有可用运单均保留 |
| PDD 多账号 | 至少两个账号的 key/profile/游标互相隔离，运行始终严格串行 |
| PDD 页面 | 每个验收账号 20–30 条真实订单字段完整率达到项目目标，页面只读可见 |
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
PDD accounts：账号 N；key/profile 一致 / 不一致
PDD login-check：账号 A/B；OK / NEEDS_LOGIN / CAPTCHA_OR_BLOCKED
PDD 单账号 dry-run/commit：账号 A/B；读取 N；解析 N；结果摘要
PDD sync-all dry-run：严格串行 / 失败；失败账号 N
收货匹配：通过 / 失败
异常：<脱敏状态码和处理方式>
```

当前有仅经 SSH 隧道访问的服务器 noVNC 监督式 Agent，但没有 Cookie 注入或计划任务 commit。只有服务器
API 与以上 PDD 手工验收都通过后，才能把定时任务作为新的开发阶段评估；仍须低频、串行、可停止，且
不能跳过 dry-run → 人工核对 → 单账号 commit。
