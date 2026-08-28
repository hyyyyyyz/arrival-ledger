# 部署与运维（arrival-ledger）

本文是部署、备份、公网访问与故障排查的操作手册。项目介绍与快速开始见根目录 [README.md](../README.md)。

## 1. 当前部署状态：服务器已迁移到 192.168.1.5

目标实例部署在 `192.168.1.5:8766`；旧 `.4` arrival 栈已停止，旧代码/数据暂存为带时间戳的可恢复
归档，待手机真机拍照上传验收后最终删除。目标机已有 Caddy/cash-save 占用 80、443 和
`127.0.0.1:8000`，本项目不得修改它们。迁移仅使用宿主机 8766。

迁移前必须在所有手机的旧页面确认本机待上传、失败和上传中均为 0，因为 IP 变化会形成新的浏览器
origin，IndexedDB 队列不会自动迁移。然后在旧机生成一致性备份，代码以 Git 仓库为准，只迁移
db/media/uploads 和私有 `.env`；目标机 `.env` 的 TRUSTED_HOSTS 改为 192.168.1.5。

目标机服务端健康检查已通过；只有手机真机上传、重启持久化和备份恢复均通过后，才可停止旧栈。
清理旧机时只能删除本项目的旧 Compose 容器/网络/镜像以及旧应用/数据目录；不得使用全局 prune、
不得执行 down -v，也不得影响 pharos:8848。删除前另存最终归档及 SHA-256。

> 兼容性说明：服务器已经使用 `/home/jackson/arrival-manager`、`/home/jackson/arrival-manager-data`
> 和 `/data/db/arrival-manager.db`，手机浏览器也已有 `arrival-manager-*` 本地存储键。这些运行期
> 名称暂时保留，避免升级时出现空数据库、丢失待上传队列或与旧容器冲突。首次把新工程名版本部署到
> 服务器前，必须先备份并执行一次性 Compose 栈迁移。

## 2. 部署结构

```text
手机 / 微信浏览器
       |
       v
0.0.0.0:8766 -> frontend (Nginx :80) -> /api/* -> backend (:8000)
                                              |
                                              +-> SQLite / 照片持久化目录
```

只有前端网关映射到宿主机；后端端口不会直接暴露。现有 `pharos:8848` 不会被修改或占用。

持久数据默认位于：

```text
/home/jackson/arrival-manager-data/
├── db/
├── media/
├── uploads/   # 预留给后续分片/导入任务
└── backups/
```

## 3. 首次部署

以下命令均在项目根目录执行。

1. 创建数据目录。后端容器使用固定 UID/GID `10001:10001`；备份目录由当前 SSH 用户维护：

   ```bash
   sudo install -d -m 0750 -o "$(id -u)" -g 10001 \
     /home/jackson/arrival-manager-data
   sudo install -d -m 0750 -o 10001 -g 10001 \
     /home/jackson/arrival-manager-data/db \
     /home/jackson/arrival-manager-data/media \
     /home/jackson/arrival-manager-data/uploads
   sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" \
     /home/jackson/arrival-manager-data/backups
   ```

2. 创建私有配置：

   ```bash
   cp .env.example .env
   chmod 600 .env
   openssl rand -hex 32
   ```

   把生成的随机值写入 `.env` 的 `SESSION_SECRET`，并替换管理员密码。不要提交或发送 `.env`。
   如果密码含 `$`，在 Compose 的 `.env` 中写成 `$$`。

   启用 Windows 订单同步时，用 `openssl rand -hex 24` 生成 worker token 写入
   `SYNC_WORKER_TOKENS`（逗号分隔、每个至少 16 字符）；明文只保存在服务器 `.env` 与 Windows
   本机 `.env.local`，数据库仅存 HMAC 摘要，从列表移除即撤销。
   未配置时同步接口返回 503。

   1688 使用后端官方 Open API，不需要在 Windows 或服务器安装浏览器。需要启用时，在服务器项目根目录
   创建受限 secret 文件并在 `.env` 指向它：

   ```bash
   cp secrets/ali1688.example.json secrets/ali1688.json
   sudo chown "$(id -u):10001" secrets/ali1688.json
   sudo chmod 0640 secrets/ali1688.json
   # 编辑文件，填入已授权应用和买家账号；不要把内容放入命令行或提交 Git
   ```

   ```dotenv
   ALI1688_API_ENABLED=true
   ALI1688_SECRET_FILE=./secrets/ali1688.json
   ALI1688_SYNC_INTERVAL_SECONDS=0
   ```

   先检查和 dry-run，再提交：

   ```bash
   sudo docker compose run --rm backend python -m app.cli config-doctor
   sudo docker compose run --rm backend python -m app.cli sync-once --account <account_key> --dry-run
   sudo docker compose run --rm backend python -m app.cli sync-once --all --dry-run
   ```

   多账号、令牌轮换、定时器、回滚和 API 验收见 [`ALI1688_OPEN_API.md`](ALI1688_OPEN_API.md)。PDD
   仍按 Windows 教程运行，不能用 1688 API 命令替代 PDD 浏览器同步。

3. 静态检查并构建：

   ```bash
   sudo docker compose config --quiet
   sudo docker compose build --pull
   ```

4. 启动默认的局域网服务：

   ```bash
   sudo docker compose up -d
   sudo docker compose ps
   sudo docker compose logs --tail=100 backend frontend
   ```

5. 验证：

   ```bash
   deploy/scripts/verify.sh http://127.0.0.1:8766
   curl -fsS http://192.168.1.5:8766/api/health
   ```

局域网免登录时保持 `COOKIE_SECURE=false`、`AUTH_REQUIRED=false`；正式外网访问必须使用 HTTPS，
并把 `AUTH_REQUIRED` 改为 `true`。当前目标机已经处于公网测试配置，因此直接访问
`http://192.168.1.5:8766` 会要求登录且 Secure Cookie 不会在 HTTP 上传送；测试请使用下面的
HTTPS 隧道地址。不能把家庭公网 IP 或 `192.168.1.5` 当作 Cloudflare 固定公网地址。

## 4. 日常更新

更新代码前先备份，再重建有变化的镜像：

```bash
deploy/scripts/backup.sh
sudo docker compose build
sudo docker compose up -d --remove-orphans
deploy/scripts/verify.sh
```

查看状态与日志：

```bash
sudo docker compose ps
sudo docker compose logs -f --tail=200 backend frontend
sudo docker stats --no-stream
```

Compose 已设置：

- `restart: unless-stopped`，服务器或 Docker 重启后自动恢复；
- 每个容器日志最多约 `5 x 10 MiB`，防止日志占满磁盘；
- 前后端健康检查；
- 非 root 后端、只读容器根文件系统、`no-new-privileges`；
- Nginx 安全响应头、16 MiB 请求上限和 120 秒弱网上传超时；
- 后端最终按 `MAX_UPLOAD_BYTES`（默认 12 MiB）校验单个上传文件。

## 5. 临时 Quick Tunnel

本项目当前使用宿主机上的 Cloudflare `cloudflared` 临时隧道，入口只转发到到货管家
`127.0.0.1:8766`，不会经过目标机现有 Caddy/cash-save（80/443/8000）。启动隧道本身不需要重启
backend/frontend：

```bash
/usr/local/bin/cloudflared tunnel --no-autoupdate \
  --edge-ip-version 4 --protocol http2 \
  --url http://127.0.0.1:8766
```

当前公网测试配置为 `AUTH_REQUIRED=true`、`COOKIE_SECURE=true`，所以必须从生成的
`https://*.trycloudflare.com` 地址打开并登录；不要把 SSH 的 sudo 密码当作应用登录密码。隧道 URL
会在进程重启后变化，日志和启动输出是唯一可靠的地址来源。当前运行实例的 URL 不写入仓库，避免把
一次性地址误当成固定入口。

测试结束可只停止隧道（不影响后端）：

```bash
kill "$(cat /home/jackson/arrival-ledger-cloudflared.pid)"
```

Quick Tunnel 是 Cloudflare 的临时开发/测试能力，没有固定地址或 SLA；参见
[Cloudflare Quick Tunnels 文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。
不购买域名就不能得到稳定的自定义公网地址；长期使用应另行配置域名 + Named Tunnel，或继续使用
局域网 IP。恢复局域网免登录前，需修改目标机私有 `.env` 并重新创建前后端容器，不能在公网隧道仍
运行时关闭认证。

## 6. 备份和恢复

一致性备份会短暂停止后端，压缩 `db/`、`media/`、`uploads/`，完成后自动恢复服务：

```bash
deploy/scripts/backup.sh
BACKUP_ROOT=/另一块磁盘/arrival-ledger-backups deploy/scripts/backup.sh
```

默认备份写入 `/home/jackson/arrival-manager-data/backups/`。这仍与主数据在同一磁盘，不足以防
磁盘损坏；至少每天把备份同步到另一台设备或异地存储。`.env` 含密钥，应单独保存到密码管理器，
不进入普通照片备份。

恢复会替换当前业务数据，因此先停止服务并保留现状目录，确认备份文件的绝对路径后再执行：

```bash
sudo docker compose down
STAMP="$(date +%Y%m%d-%H%M%S)"
sudo mv /home/jackson/arrival-manager-data/db "/home/jackson/arrival-manager-data/db.before-${STAMP}"
sudo mv /home/jackson/arrival-manager-data/media "/home/jackson/arrival-manager-data/media.before-${STAMP}"
sudo mv /home/jackson/arrival-manager-data/uploads "/home/jackson/arrival-manager-data/uploads.before-${STAMP}"
sudo tar -xzf /绝对路径/arrival-ledger-YYYYMMDDTHHMMSSZ.tar.gz -C /home/jackson/arrival-manager-data
sudo chown -R 10001:10001 \
  /home/jackson/arrival-manager-data/db \
  /home/jackson/arrival-manager-data/media \
  /home/jackson/arrival-manager-data/uploads
sudo docker compose up -d
deploy/scripts/verify.sh
```

确认恢复正确后再手工清理 `.before-*` 目录。

## 7. 应用版本回滚

发布更新前，可先给当前镜像增加可恢复标签：

```bash
STAMP="$(date +%Y%m%d-%H%M%S)"
sudo docker image tag "$(sudo docker compose images -q backend)" "arrival-ledger-backend:rollback-${STAMP}"
sudo docker image tag "$(sudo docker compose images -q frontend)" "arrival-ledger-frontend:rollback-${STAMP}"
echo "rollback tag: ${STAMP}"
```

如果新版本失败，使用上一步打印的时间标签回滚；若新版本升级过数据库结构，同时恢复更新前的
数据备份：

```bash
sudo env BACKEND_IMAGE=arrival-ledger-backend:rollback-时间标签 FRONTEND_IMAGE=arrival-ledger-frontend:rollback-时间标签 docker compose up -d --no-build --force-recreate
deploy/scripts/verify.sh
```

需要长期保持回滚版本时，把这两个镜像名写入 `.env`。

## 8. 故障排查

```bash
# 端口是否被占用
sudo ss -lntp | grep -E ':(8766|8848)\b'

# 健康状态与最近日志
sudo docker compose ps
sudo docker compose logs --since=15m backend frontend

# 数据目录权限（应显示 UID/GID 10001）
sudo stat -c '%u:%g %a %n' /home/jackson/arrival-manager-data/{db,media,uploads}

# 磁盘空间
df -h /home/jackson/arrival-manager-data
du -sh /home/jackson/arrival-manager-data/*
```

不要执行 `docker compose down -v`、不要手工删除 SQLite 的 `-wal`/`-shm` 文件，也不要清理
`media/` 中未核对的照片。
