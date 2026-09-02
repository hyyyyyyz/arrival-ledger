# 拼多多服务器可见浏览器 Agent

本文说明如何把拼多多浏览器同步端运行在 Linux 服务器，并从 Mac 通过 SSH 隧道进入 noVNC 桌面完成
扫码、短信或人机验证。到货管家后端仍是独立服务；拼多多登录态只存在 Agent 的持久化 Profile 中。

## 1. 适用范围与安全边界

该方案使用：

- `mcr.microsoft.com/playwright:v1.62.1-noble`；
- 非 root 用户运行的 Playwright headed Chromium；
- Linux 上显式启用 Chromium 沙箱，并使用与 Playwright `v1.62.1` 对应的 seccomp 配置；
- 容器丢弃全部能力后仅恢复 Chromium 沙箱所需的 `SYS_CHROOT`；
- Xvfb + openbox + x11vnc + noVNC；
- 每个采购账号一个独立的 `/data/profiles/<account_key>`；
- 仓库现有的账号级锁和 PDD 浏览器全局锁，确保所有账号严格串行；
- noVNC 只发布到服务器 `127.0.0.1:6080`，必须经过 SSH 隧道访问。

镜像构建使用 `Dockerfile.dockerignore` 白名单；私有 `.env.local`、账号 Profile、状态、报告、数据库和
1688 密钥不会进入 Docker build context，也不会成为镜像层。

它不会自动填写密码、提取或注入 Cookie、自动处理验证码，也不会通过 stealth/指纹伪造绕过平台风控。
Profile 等同长期登录凭证：不得进入 Git、聊天记录、普通未加密备份或现有后端容器。

云服务器机房网络与采购账号原来的登录环境不同，可能增加验证码或平台限制。先用一个账号低频验收；如果
持续出现“系统繁忙”、验证码失败或账号受限，应停止访问并等待人工处理。不要快速重试，也不要同时打开
多个账号。必要时应退回原局域网的 Mac/Windows 同步节点，而不是尝试绕过平台限制。

## 2. 前置条件

理想服务器建议至少具备：

- 2 vCPU、4 GiB 内存；
- 5–10 GiB 可用磁盘空间；
- 1–2 GiB swap；
- Docker Engine 与 Docker Compose v2；
- Mac 到服务器的 SSH 密钥登录。

当前目标机约 1.6 GiB 内存，低于理想值，只适合先运行一个浏览器的监督式试验。默认 900 MiB 容器上限
是为了不给主应用挤占全部内存；开始前应确认 swap 可用，并在登录和 dry-run 期间观察 `docker stats`。
出现 OOM、明显卡顿或主应用内存压力时应停止 Agent，而不是放宽并发。

检查服务器资源：

```bash
nproc
free -h
df -h / /srv
docker version
docker compose version
```

当前目标机的保守默认值是 1.5 CPU、900 MiB 内存、256 个 PID 和 256 MiB `/dev/shm`。可以通过
`PDD_AGENT_CPU_LIMIT`、`PDD_AGENT_MEMORY_LIMIT`、`PDD_AGENT_PIDS_LIMIT` 和
`PDD_AGENT_SHM_SIZE` 调整，但不要通过并发多个浏览器提高速度。

## 3. 初始化服务器私有目录

在仓库根目录执行：

```bash
sudo env PDD_AGENT_DATA_ROOT=/var/lib/arrival-ledger/pdd \
  ./deploy/scripts/pdd-agent.sh init
```

该命令只在文件不存在时创建：

```text
/var/lib/arrival-ledger/pdd/
  config/.env.local
  config/pdd-accounts.json
  config/vnc-password
  profiles/
  state/
  logs/
```

`vnc-password` 会在服务器本机随机生成。初始化不会覆盖已有配置、Profile 或同步状态。容器默认使用
UID/GID `10002:10002`，与主应用后端账号隔离；如服务器冲突，可在初始化、构建和启动时同时设置 `PDD_AGENT_UID`、
`PDD_AGENT_GID`。VNC 协议只使用八个密码字符；脚本因此生成八字符随机值，SSH 隧道仍是主要访问边界。

## 4. 配置到货管家和账号

编辑 `/var/lib/arrival-ledger/pdd/config/.env.local`：

```dotenv
ARRIVAL_API_BASE_URL=http://backend:8000
ARRIVAL_SYNC_WORKER_KEY=服务器后端配置的私有同步密钥
ARRIVAL_WORKER_ID=pdd-server-01

PDD_ACCOUNTS_FILE=/data/config/pdd-accounts.json
ARRIVAL_STATE_DIR=/data/state
ARRIVAL_LOG_DIR=/data/logs

SYNC_MAX_PAGES=1
SYNC_MAX_RECORDS=20
SYNC_PAGE_DELAY_MS=3000
SYNC_MIN_INTERVAL_MINUTES=30
```

不要把同步密钥贴到命令行、截图或聊天中。该私有文件只挂载到 PDD Agent，不进入镜像层。

`backend` 是主 Compose 网络中的后端服务名，因此必须先启动主到货管家 Compose 项目，并确认 Docker 网络
`arrival-ledger_app` 存在。可以用 `ARRIVAL_LEDGER_APP_NETWORK` 覆盖网络名；不要改成公网地址，除非确实
无法连接主 Compose 网络。

编辑 `/var/lib/arrival-ledger/pdd/config/pdd-accounts.json`。账号键必须与到货管家“人员 → 拼多多账号”中
登记的 `account_key` 完全一致；每个账号必须使用不同的 Profile：

```json
{
  "schema_version": 1,
  "accounts": [
    {
      "account_key": "pdd-main",
      "display_label": "拼多多主采购账号",
      "profile_dir": "/data/profiles/pdd-main"
    },
    {
      "account_key": "pdd-backup",
      "display_label": "拼多多备用采购账号",
      "profile_dir": "/data/profiles/pdd-backup"
    }
  ]
}
```

确认权限没有被编辑器放宽：

```bash
sudo chown root:10002 /var/lib/arrival-ledger/pdd/config
sudo chmod 750 /var/lib/arrival-ledger/pdd/config
sudo chown 10002:10002 /var/lib/arrival-ledger/pdd/config/.env.local \
  /var/lib/arrival-ledger/pdd/config/pdd-accounts.json \
  /var/lib/arrival-ledger/pdd/config/vnc-password
sudo chmod 600 /var/lib/arrival-ledger/pdd/config/.env.local \
  /var/lib/arrival-ledger/pdd/config/pdd-accounts.json \
  /var/lib/arrival-ledger/pdd/config/vnc-password
```

## 5. 构建并启动桌面 Agent

先确认主应用已经运行且创建了默认网络：

```bash
cd /opt/arrival-ledger
docker compose up -d
docker network inspect arrival-ledger_app >/dev/null
```

然后在包含本部署资产的发布目录运行：

```bash
./deploy/scripts/pdd-agent.sh build
./deploy/scripts/pdd-agent.sh start
./deploy/scripts/pdd-agent.sh status
```

确认端口只监听回环地址：

```bash
ss -lntp | grep 6080
```

正确结果应包含 `127.0.0.1:6080`，不能是 `0.0.0.0:6080` 或 `[::]:6080`。云安全组和服务器防火墙
也不应开放 5900/6080。`5900` 只在容器内部回环地址上供 websockify 使用。

运行离线配置和浏览器检查：

```bash
./deploy/scripts/pdd-agent.sh doctor
./deploy/scripts/pdd-agent.sh accounts
```

## 6. 从 Mac 打开服务器桌面

Mac 新开一个终端并保持运行：

```bash
ssh -N -L 6080:127.0.0.1:6080 <ssh-user>@<server-ip>
```

浏览器打开：

```text
http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale
```

noVNC 会要求 VNC 密码。密码保存在服务器
`/var/lib/arrival-ledger/pdd/config/vnc-password`；不要通过聊天发送。SSH 隧道是主要访问边界，VNC 密码是
附加保护。

仅在自己的 SSH 会话中查看一次密码：

```bash
sudo cat /var/lib/arrival-ledger/pdd/config/vnc-password
```

## 7. 逐账号人工登录

保持 noVNC 页面打开，在另一个 SSH 终端的仓库根目录运行：

```bash
./deploy/scripts/pdd-agent.sh login-check pdd-main 3600
```

命令会在 noVNC 桌面打开对应账号的可见浏览器，并在最多 3600 秒内只轮询当前页面的可见状态，不刷新
页面。仅在拼多多官方页面手工扫码、接收短信或处理验证码。识别到订单页后浏览器会自动关闭，但登录态
留在该账号自己的 Profile。若省略末尾的等待秒数，则改为登录完成后回 SSH 终端按 Enter。依次处理其他
账号，不能并行运行两个 `login-check`。

如果显示 `CAPTCHA_OR_BLOCKED`、系统繁忙或验证持续失败，立即停止该账号。不要自动拖动滑块、连续刷新
或反复重开浏览器。

## 8. 单次只读验收

`login-check` 也计入平台访问冷却。默认等待至少 30 分钟，再运行：

```bash
./deploy/scripts/pdd-agent.sh dry-run pdd-main
```

该命令最多读取一页、20 条订单，只在服务器私有 `state/` 目录生成报告和 snapshot，不上传到到货管家。
先核对订单号、商品、规格、状态、物流和账号归属，再沿用现有的人工 snapshot commit 流程。不要把真实
snapshot 下载到公共电脑、上传 Issue 或粘贴到聊天中。

确认 snapshot 文件名后，在 30 分钟有效期内上传该次快照（不会重新打开拼多多）：

```bash
./deploy/scripts/pdd-agent.sh commit pdd-main \
  snapshot-pdd-pdd-main-<dry-run 输出的 batch_id>.json
```

脚本只接受 Agent 私有 `state/` 目录中的普通文件；快照内容、账号和摘要仍会由同步程序再次校验。提交成功后
快照会被删除，失败时不会推进游标。

首个账号连续观察 3–7 天且没有平台限制、页面结构错误或字段丢失后，才逐个添加其他账号。每次仍只运行
一个账号。

## 9. 日常运维

```bash
# 状态
./deploy/scripts/pdd-agent.sh status

# 桌面服务日志；不会记录网页画面
./deploy/scripts/pdd-agent.sh logs

# 停止服务；不会删除 Profile、状态或配置
./deploy/scripts/pdd-agent.sh stop
```

不要对 `/var/lib/arrival-ledger/pdd` 执行递归删除或通过 `docker compose down -v` 清理。Profile 不建议进入
普通服务器备份；如果必须备份，应使用单独的加密备份和严格访问控制。Profile 丢失时最安全的恢复方式是
重新人工登录。

当前部署资产没有自动定时同步、后台 commit、验证码识别或管理网页远程执行 Shell。真实账号监督式验收
稳定后，才能另行增加低频定时任务；定时任务必须在登录失效、验证码、页面变化或解析失败时 fail-closed，
不得推进游标或快速重试。
