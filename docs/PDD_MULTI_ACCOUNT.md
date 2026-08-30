# 拼多多多账号同步（第一阶段）

本文说明当前已经实现、可以验收的拼多多多账号方案。第一阶段由一台 **Mac 或 Windows 同步电脑**
运行可见 Playwright 浏览器；服务器保存账号登记、同步状态和结构化订单，但不运行拼多多浏览器。

## 当前能力与边界

- 每个拼多多账号使用一个唯一、长期不变的 `account_key`；
- 每个账号使用一个独立、持久化、可见的 Playwright `profile_dir`；
- 登录、扫码、短信或人机验证由用户在同步电脑的可见窗口中完成；
- profile、Cookie、localStorage、sessionStorage、密码和验证码永远不上传服务器；
- 多账号 dry-run 严格按配置文件顺序逐个执行，不并发打开浏览器；
- 管理员网页只登记 `account_key` 和显示名称，并展示同步器上报的状态、时间和订单数；
- 每次仍遵守 **dry-run → 人工核对 snapshot → 单账号 commit**，`sync-all` 不支持 commit。

当前**没有实现**远程 noVNC 登录窗口、服务器端 Playwright、自动 Cookie 注入、定时 commit 或无人值守
验证码处理。不要把 profile 复制到云服务器，也不要把 Cookie 粘贴到网页或配置文件。

## 1. 先在到货管家登记账号

管理员登录到货管家，进入“人员”页下方的“拼多多账号”，逐个登记：

- 账号名称：给人看的名称，例如“主采购账号”；
- 账号标识：稳定内部键，例如 `pdd-main`。

账号标识只能使用小写字母、数字、`.`、`_`、`-`，最长 64 位，并以字母或数字开头。它不是拼多多
手机号或用户名，不应包含敏感信息。网页登记不会创建登录态；下一步仍需在同步电脑配置同一个键。

## 2. 在同步电脑创建账号清单

在 `sync-agent` 下创建本机私有文件，例如 `config/pdd-accounts.json`：

```json
{
  "schema_version": 1,
  "accounts": [
    {
      "account_key": "pdd-main",
      "display_label": "主采购账号",
      "profile_dir": "../profiles/pdd-main"
    },
    {
      "account_key": "pdd-backup",
      "display_label": "备用采购账号",
      "profile_dir": "../profiles/pdd-backup"
    }
  ]
}
```

约束：

- `schema_version` 当前必须是 `1`；
- `accounts` 至少 1 个、最多 50 个；
- `account_key` 不能重复，且必须与管理员网页登记的键完全一致；
- `display_label` 可省略；填写时建议与网页名称一致；
- `profile_dir` 相对路径以该 JSON 文件所在目录为基准，每个账号必须不同；
- profile 不能是文件系统根目录、普通文件，也不能让自身或任一已有父目录经过符号链接/Windows junction；程序会按最终真实路径去重，并在启动 Chromium 前再次检查；
- profile 与其父目录必须位于仅同步器操作系统用户可写的位置；不要放在共享目录、公共临时目录、网络盘或由其他用户可改名/替换的目录中；
- JSON 不能增加密码、Cookie、Token 等额外字段，程序会拒绝未知字段。

macOS/Linux 建议执行：

```bash
chmod 600 config/pdd-accounts.json
chmod 700 profiles
```

Windows 应使用 NTFS ACL，仅允许实际运行同步端的 Windows 用户读取账号清单、profiles、`state` 和
`logs`。

## 3. 配置 `.env.local`

```dotenv
ARRIVAL_API_BASE_URL=https://<到货管家服务器地址>
ARRIVAL_SYNC_WORKER_KEY=由服务器管理员提供的同步密钥
ARRIVAL_WORKER_ID=pdd-sync-computer-01
PDD_ACCOUNTS_FILE=config/pdd-accounts.json
SYNC_MAX_PAGES=5
SYNC_MAX_RECORDS=30
SYNC_PAGE_DELAY_MS=2500
SYNC_MIN_INTERVAL_MINUTES=15
ARRIVAL_STATE_DIR=state
ARRIVAL_LOG_DIR=logs
```

不要把 `.env.local` 或账号清单提交 Git。配置 `PDD_ACCOUNTS_FILE` 后，多账号命令以该文件为准；旧的
`PDD_ACCOUNT_KEY` 和 `PDD_PROFILE_DIR` 只用于兼容单账号安装。

## 4. 安装并检查配置

```bash
cd sync-agent
npm ci
npm run doctor -- --offline --platform pdd
npm run accounts -- --platform pdd
```

`accounts` 不打开浏览器，只列出账号、profile、游标和最近状态。先确认每个 `account_key` 和
`profile_dir` 都正确且互不重复。

## 5. 逐个完成人工登录

```bash
npm run login-check -- --platform pdd --account pdd-main
npm run login-check -- --platform pdd --account pdd-backup
```

浏览器会保持可见。登录或验证只在对应窗口内人工完成；程序不会填写密码、读取 Cookie、处理验证码或
绕过风控。一个账号登录后，其登录态只留在该账号的 `profile_dir`。遇到 `NEEDS_LOGIN`、
`CAPTCHA_OR_BLOCKED` 或系统繁忙时停止，不连续重试；等待平台冷却后再人工处理。

## 6. 先逐账号 dry-run，再单独 commit

首次验收建议逐账号执行：

```bash
npm run sync-once -- --platform pdd --account pdd-main --mode dry-run
```

核对本机报告和 snapshot 中的数量、订单号、商品、规格、状态和物流。不要把真实报告粘贴到聊天、Issue
或 Git。确认无误后，在 30 分钟 snapshot 有效期内执行：

```bash
npm run sync-once -- --platform pdd --account pdd-main --mode commit \
  --from-report ./state/snapshot-pdd-pdd-main-<batch_id>.json --yes
```

commit 只上传已经核对的 snapshot，不会重新打开拼多多。snapshot 内容、hash、账号或游标不一致时会
拒绝提交，必须重新 dry-run。

## 7. 严格串行检查全部账号

所有账号分别完成登录和首次单账号验收后，可以运行：

```bash
npm run sync-all -- --platform pdd --mode dry-run
```

它按照 JSON `accounts` 数组顺序逐个运行，每次只打开一个账号 profile。某个账号失败时会记录状态并
继续检查后续账号，但整个命令最终返回非零。每个账号会生成独立 snapshot；仍须逐个核对，并使用
第 6 节的单账号 commit 命令提交。不存在 `sync-all --mode commit`。

## 8. 网页状态的含义

| 状态 | 含义与处理 |
|---|---|
| 正常 | 最近一次检查成功；仍应关注最近检查时间 |
| 需登录 | 在同步电脑运行该账号的 `login-check` 并人工登录 |
| 需要验证 | 人工处理平台验证；程序不会代做或重试 |
| 页面变化 | 适配器无法可靠读取，停止 commit，先修复并重新 dry-run |
| 网络错误 | 检查同步电脑网络和服务器地址，避免高频重开平台页面 |
| 本次未执行 | 本次因配置、冷却或本机互斥保护未进入有效读取；查看提示后再处理，不代表账号被停用 |
| 未同步 | 账号已登记，但同步电脑尚未上报成功状态 |

网页的“刷新状态”只重新读取服务器已有状态，不会远程启动同步电脑或浏览器。

## 9. 当前运行方式

第一阶段只支持人工命令。远程 noVNC、云服务器浏览器、定时 dry-run/commit 和失败通知都未交付。
即使未来增加定时任务，也必须先完成本文件的真机验收，保持账号串行、登录人工处理，并保留
dry-run → 人工确认 → commit 的安全边界。
