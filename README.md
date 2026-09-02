# arrival-ledger（到货管家）

私有包裹到货确认系统：仓库收货人用手机微信拍照签收，系统保存「照片 + 运单号 + 服务器时间」
作为实物到达凭证，并按预先导入的订单数据反查商品。个人/固定协作者私用，不开放注册、不做 SaaS。

## 它解决什么问题

每天收 10–30 个包裹时，「到底收没收到、什么时候收到」靠人脑和聊天记录不可靠。到货管家把收货变成
一条可查询、可纠错、有照片证据的记录：

- 微信打开链接即可连续拍照收货，也可从相册一次选择多张后统一上传，无需安装 App；
- 断网、重复点击、页面重载都不会丢照片或产生重复记录；
- 面单上的快递运单号自动反查平台订单和商品（规划中：查不到订单的包裹进入待认领区、撤销与重新匹配等纠错操作保留事件历史）。

订单和包裹是两个概念：面单上读到的是快递运单号，不是平台订单号。一个订单可以拆多个包裹，
一个包裹也可以关联多个订单。

## 功能

### 手机收货（已完成）

- 微信 H5，iPhone/Android 直接打开；
- 拍摄面单照片，本机压缩到约 0.5–1 MB，ZXing 本地条码识别；
- IndexedDB 离线队列：网络断开时「本机已保存，待同步」，恢复后自动补传；
- 服务端以 `client_event_id` 幂等，保存 SHA-256、服务器接收时间、设备 ID；
- 重复运单号提示首次确认时间和原照片，不重复计数；
- 上传成功后按运单号显示已匹配的平台/店铺/商品（候选匹配会明确标注）。
- 每位同事使用独立账号；照片、运单修正和人工收货纠正均记录责任人与服务器时间；
- 订单可人工在“未收货/已收货”之间纠正，照片证据与人工结论分层保存，操作可审计；
- 管理员可在手机端新增、停用和重新启用公司人员账号，停用不会抹掉历史责任记录。
- 1688/PDD 之外的包裹可手工录入运单号、商品、物流公司和备注；订单列表显示来源、录入人并参与同一套收货与责任审计。

> 待认领区、待补单号区、按平台/单号/关键词搜索、撤销与重新匹配属于 P0 阶段规划，尚未实现。

人员责任与人工纠正的使用及数据语义见
[`docs/RESPONSIBILITY_AND_MANUAL_ARRIVAL.md`](docs/RESPONSIBILITY_AND_MANUAL_ARRIVAL.md)。

### 订单数据

| 路线 | 状态 |
|---|---|
| CSV 批量导入（幂等、忽略 PII、退款/取消明确状态） | 规划中（P1） |
| 1688 官方 Open API 多账号同步（后端） | 已在生产配置首个授权账号；可继续追加账号 |
| Mac/Windows 可见浏览器同步 PDD（`sync-agent`，一账号一 profile） | 多账号第一阶段代码完成，待真实账号手工验收 |
| 第三方/线下采购手工录入（运单号、商品、物流与备注） | 已完成 |
| 第三方订单批量粘贴及 `.xlsx` / CSV 预览导入 | 已完成 |
| 截图 / OCR 批量导入 | 兜底路径 |

1688 订单使用服务器官方 Open API；PDD 使用 Mac 或 Windows 同步电脑上的可见 Playwright 持久化 profile，
每个采购账号拥有独立 profile、游标和锁。用户手工登录，程序只读可见页面，先 dry-run 预览、用户确认后才提交最小必要的结构化订单批次到自家服务器。批次包含
订单号、商品和运单号，但不包含密码、Cookie、地址、电话或原始页面；同步失败
不影响拍照收货。

### 安全与隐私

- 局域网免登录（可信 Wi-Fi）与公网 HTTPS 认证两种模式，公网启用前必须关闭免登录；
- 照片、数据库只在自家服务器，不保存收件人电话和完整地址；
- PDD 密码、Cookie、登录态和 profile 只留在同步电脑，永不上传、不进日志、不进 Git；1688 的 AppSecret
  和 access token 只保存在服务器受限、只读挂载的 secret 文件中；
- 同步接口使用独立 worker token：明文只存在于服务器 `.env`（`SYNC_WORKER_TOKENS`）与同步电脑 `.env.local`，数据库只记录 token 摘要，可撤销/轮换。

## 系统架构

```text
手机 / 微信浏览器
  │  拍照、压缩、ZXing 识别、IndexedDB 队列
  ▼
Ubuntu 服务器（纯 Server，无桌面）
  ├─ Nginx 网关 :8766 ──► FastAPI 业务 API ──► SQLite + 照片目录
  ├─ 1688 官方 Open API（多应用、多授权账号、独立游标）
  └─ 内部同步接口（只接收同步电脑主动提交的结构化批次和账号状态）
                      ▲
                      │ 可见页面只读同步（可失效的增强能力）
Mac 或闲置 Windows 同步电脑
  ├─ 每个 PDD 账号一个独立、持久化、可见的 Playwright profile（用户手工登录）
  └─ sync-agent：Node 20 + TypeScript + Playwright headed
```

技术栈：FastAPI + SQLite（后端）、Vue 3 + IndexedDB + ZXing（手机 H5）、
Node 20 + TypeScript + Playwright（同步端）。

## 快速开始

需要 Docker + Compose，目标机为 Ubuntu（详细部署见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)）：

```bash
git clone https://github.com/hyyyyyyz/arrival-ledger.git
cd arrival-ledger
cp .env.example .env          # chmod 600 .env，替换 SESSION_SECRET 和管理员密码
sudo docker compose config --quiet
sudo docker compose build --pull
sudo docker compose up -d
deploy/scripts/verify.sh http://127.0.0.1:8766
```

局域网免登录模式用手机打开 `http://<服务器IP>:8766`；外网/公网必须使用 HTTPS 隧道并保持
`AUTH_REQUIRED=true`。

## 1688 与拼多多订单同步

1688 在服务器使用官方 Open API，支持多个应用和多个授权买家账号；详细配置、令牌轮换、dry-run、
单账号/全账号同步和定时器见 [`docs/ALI1688_OPEN_API.md`](docs/ALI1688_OPEN_API.md)。同步电脑不需要
安装或登录 1688，也不承载 1688 授权信息。

拼多多浏览器订单同步（Mac/Windows，多账号第一阶段）

固定流程：

```text
管理员网页登记同一个 account_key/名称
→ 同步电脑配置 PDD_ACCOUNTS_FILE（一账号一 profile）
→ accounts / doctor
→ 逐账号 login-check --account <key>
→ sync-once --account <key> --mode dry-run
→ 用户核对 snapshot
→ sync-once --account <key> --mode commit --from-report <snapshot> --yes
```

- 多账号从头配置：[`docs/PDD_MULTI_ACCOUNT.md`](docs/PDD_MULTI_ACCOUNT.md)
- 规格与边界：[`docs/BROWSER_SYNC_SPEC.md`](docs/BROWSER_SYNC_SPEC.md)
- 手工验收清单：[`docs/SYNC_MANUAL_ACCEPTANCE.md`](docs/SYNC_MANUAL_ACCEPTANCE.md)
- 运行与配置说明：[`sync-agent/README.md`](sync-agent/README.md)

首次运行必须在可见窗口逐账号手工登录；程序不自动填密码、不绕过验证码、不隐藏窗口。当前
`sync-all` 只支持严格串行 dry-run，commit 仍须逐账号人工确认。远程 noVNC、服务器浏览器、Cookie
注入和 PDD 定时 commit 均未实现。1688 定时同步由服务器单独控制，两者互不依赖。

## 仓库结构

```text
backend/     FastAPI + SQLite：收货凭证、认证、订单/包裹数据模型、同步批次接收
frontend/    Vue 3 微信 H5：拍照、压缩、条码、离线队列、清单
sync-agent/  Mac/Windows 同步端：PDD accounts / login-check / capture-page / sync-once / sync-all
deploy/      Nginx 模板、备份/验证脚本
docs/        计划、规格、部署、验收文档
```

## 开发

```bash
# 后端（Python 3.11+）
cd backend && python -m pytest tests

# 前端
cd frontend && npm test -- --run && npm run typecheck && npm run build

# 同步端
cd sync-agent && npm ci && npm test && npm run typecheck && npm run build && npm run doctor -- --offline
```

提交规范、测试门槛与安全红线见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 文档

- [总体实施计划](PLAN.md) —— 产品结论、数据模型、分阶段计划与验收标准
- [部署与运维](docs/DEPLOYMENT.md) —— 迁移、备份恢复、公网隧道、回滚、故障排查
- [1688 官方 Open API 多账号配置](docs/ALI1688_OPEN_API.md)
- [拼多多多账号同步（第一阶段）](docs/PDD_MULTI_ACCOUNT.md)
- [人员责任与人工收货纠正](docs/RESPONSIBILITY_AND_MANUAL_ARRIVAL.md)
- [浏览器同步技术规格](docs/BROWSER_SYNC_SPEC.md)
- [平台同步手工验收清单](docs/SYNC_MANUAL_ACCEPTANCE.md)
- [DeepSeek 实现任务单](DEEPSEEK_HANDOFF.md)

## 项目状态

- 当前生产入口使用公网 HTTPS，服务器部署与回滚流程见 `docs/DEPLOYMENT.md`；
- 1688 Open API 已通过首个真实采购账号导入订单，多账号可在同一应用授权上继续追加；
- 拍照收货、人工状态纠正和人员责任审计已完成代码与自动测试，仍需按实际仓库流程持续真机验收；
- PDD 多账号浏览器同步第一阶段代码已完成但尚待真实账号验收；远程 noVNC、服务器浏览器和定时
  commit 尚未实现；CSV 导入尚未开始；
- 详细状态与决策记录见 [PLAN.md](PLAN.md) 第 0 节和变更记录。
