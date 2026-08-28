# 给实现协作者的任务单：1688 Open API + 拼多多浏览器同步

请先阅读并遵守：

1. `PLAN.md`；
2. `docs/ALI1688_OPEN_API.md`；
3. `docs/BROWSER_SYNC_SPEC.md`；
4. `CONTRIBUTING.md`。

## 当前架构（必须保持）

- 1688：后端调用官方 Open API，支持多个应用、每个应用多个授权买家账号；`AppKey/AppSecret/access_token`
  只存在服务器私有 secret 文件，不进入代码、数据库、日志、截图或提交。
- 拼多多：仅在闲置 Windows 电脑上运行 headed Chrome/Playwright，用户手工登录，程序只读取可见订单页面；
  不调用平台内部接口，不抓包，不绕过验证码/滑块/风控。
- 手机收货、数据库和内部批次接口必须保持兼容。1688 API 同步失败不能影响拍照收货或拼多多同步。

## 交付顺序

### A1：1688 配置与客户端

- 实现严格校验的多应用/多账号 JSON 配置和 `config-doctor`；账号以唯一 `account_key` 隔离。
- 实现官方请求签名、超时、有限重试、HTTP 与业务错误分类；默认不发送未被官方请求参数要求的字段。
- 任何错误、日志和状态输出都必须脱敏，不能输出 secret、token、地址、电话或原始响应。

### A2：1688 同步编排

- 使用 `alibaba.trade.getBuyerOrderList` 按修改时间窗口分页；订单 ID 使用 `idOfStr` 字符串。
- 对订单详情调用 `alibaba.trade.get.buyerView`，按 allowlist 读取商品、SKU 和
  `nativeLogistics.logisticsItems[].logisticsBillNo`，支持多商品、多包裹。
- 每个账号独立游标、锁、运行记录和错误状态；失败账号不推进游标，不影响其它账号。
- `dry-run` 不写订单/批次/游标；`sync-once --account <key>` 和 `--all` 均幂等。

### A3：拼多多同步端回归

- `sync-agent` 只保留 PDD operational 命令：`doctor`、`login-check`、`capture-page`、
  `sync-once`；1688 不得再从 Windows 打开页面。
- 页面始终 headed、可见、只读；遇到登录过期、验证码、系统繁忙或结构变化立即熔断。
- dry-run 生成本地私有 snapshot，commit 只能复用 snapshot，不得重新抓取页面。

### A4：验证、文档和交接

- 后端覆盖配置、签名、重试、日期、映射、PII 丢弃、双账号隔离、游标/事务、幂等和 page cap。
- Windows 只按 `docs/WINDOWS_SYNC_FROM_SCRATCH.md` 验收拼多多；1688 按
  `docs/ALI1688_OPEN_API.md` 在服务器执行离线 doctor、dry-run 和单账号 API 验证。
- 只提交脱敏测试数据；真实 token、订单号、运单号和报告文件不得进入 Git 或聊天。

## 不得扩展的范围

- 不实现 1688 浏览器适配器或让 Windows 端访问 1688；历史适配器如需保留，只能用于脱敏 fixture 回归，
  并明确标注为历史兼容代码。
- 不调用平台内部 API、抓包、网络拦截、代理池、IP 轮换、验证码识别或反检测技术。
- 不修改订单、支付、退款、确认收货或物流状态；不自动登录或保存平台密码/Cookie。
- 不自动清理旧数据、不删除照片、不为了测试关闭认证或跳过权限。

## 每阶段交付模板

```text
阶段：A?
提交：<commit hash 或未提交>
文件：...
命令：...
测试：通过/失败（附数量）
人工步骤：...
已知限制：...
是否可部署：是/否
```
