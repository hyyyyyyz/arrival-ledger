# arrival-ledger（到货管家）

GitHub 仓库名与工程标识为 `arrival-ledger`；中文产品名继续使用“到货管家”。

## 服务器迁移到 192.168.1.5

目标实例已部署在 192.168.1.5:8766；旧 `.4` arrival 栈已停止，旧代码/数据暂存为带时间戳的可恢复归档，待手机真机拍照上传验收后最终删除。目标机已有 Caddy/cash-save 占用 80、443 和 127.0.0.1:8000，本项目不得修改它们。迁移仅使用宿主机 8766。

迁移前必须在所有手机的旧页面确认本机待上传、失败和上传中均为 0，因为 IP 变化会形成新的浏览器 origin，IndexedDB 队列不会自动迁移。然后在旧机生成一致性备份，代码以本 Git 仓库为准，只迁移 db/media/uploads 和私有 .env；目标机 .env 的 TRUSTED_HOSTS 改为 192.168.1.5。

目标机服务端健康检查已通过；只有手机真机上传、重启持久化和备份恢复均通过后，才可停止旧栈。清理旧机时只能删除本项目的旧 Compose 容器/网络/镜像以及旧应用/数据目录；不得使用全局 prune、不得执行 down -v，也不得影响 pharos:8848。删除前另存最终归档及 SHA-256。

> 兼容性说明：服务器已经使用 `/home/jackson/arrival-manager`、`/home/jackson/arrival-manager-data` 和 `/data/db/arrival-manager.db`，手机浏览器也已有 `arrival-manager-*` 本地存储键。这些运行期名称暂时保留，避免升级时出现空数据库、丢失待上传队列或与旧容器冲突。首次把新工程名版本部署到服务器前，必须先备份并执行一次性 Compose 栈迁移。

面向手机和微信内置浏览器的私有包裹到货确认工具。当前部署目标是 Ubuntu 22.04 + Docker Compose，迁移后的局域网入口为 `http://192.168.1.5:8766`。当前局域网原型采用免登录直达模式，打开链接即可拍照；该模式不能用于公网。

## 部署结构

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

## 首次部署

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

   把生成的随机值写入 `.env` 的 `SESSION_SECRET`，并替换管理员密码。不要提交或发送 `.env`。如果密码含 `$`，在 Compose 的 `.env` 中写成 `$$`。

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

局域网原型保持 `COOKIE_SECURE=false`，并可使用 `AUTH_REQUIRED=false` 免登录直达。正式外网访问需要 HTTPS 且必须把 `AUTH_REQUIRED` 改为 `true`；不能直接把家庭公网 IP 或 `192.168.1.5` 发给异地手机。

## 日常更新

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
- Nginx 安全响应头、16 MiB 请求上限和120秒弱网上传超时；
- 后端最终按 `MAX_UPLOAD_BYTES`（默认12 MiB）校验单个上传文件。

## 临时 Quick Tunnel

Quick Tunnel 只用于临时外网拍照测试：地址随机、没有 SLA，默认 profile 不会启动它。启动前必须让登录 Cookie 只经 HTTPS 发送：

```bash
sudo env AUTH_REQUIRED=true COOKIE_SECURE=true docker compose --profile quick-tunnel up -d --force-recreate backend frontend quick-tunnel
sudo docker compose --profile quick-tunnel logs -f quick-tunnel
```

日志中会出现 `https://*.trycloudflare.com`。该地址公开可达，必须使用强管理员密码，测试结束立即停止：

```bash
sudo docker compose --profile quick-tunnel stop quick-tunnel
sudo docker compose rm -f quick-tunnel
sudo docker compose up -d --force-recreate backend frontend
```

最后一条命令会重新采用局域网配置中的 `AUTH_REQUIRED=false` 和 `COOKIE_SECURE=false`，恢复打开即用的局域网模式。不要把 Quick Tunnel 当正式入口；稳定公网方案应使用自有域名的 Named Tunnel，且先实测中国大陆网络质量。

## 备份和恢复

一致性备份会短暂停止后端，压缩 `db/`、`media/`、`uploads/`，完成后自动恢复服务：

```bash
deploy/scripts/backup.sh
BACKUP_ROOT=/另一块磁盘/arrival-ledger-backups deploy/scripts/backup.sh
```

默认备份写入 `/home/jackson/arrival-manager-data/backups/`。这仍与主数据在同一磁盘，不足以防磁盘损坏；至少每天把备份同步到另一台设备或异地存储。`.env` 含密钥，应单独保存到密码管理器，不进入普通照片备份。

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

## 应用版本回滚

发布更新前，可先给当前镜像增加可恢复标签：

```bash
STAMP="$(date +%Y%m%d-%H%M%S)"
sudo docker image tag "$(sudo docker compose images -q backend)" "arrival-ledger-backend:rollback-${STAMP}"
sudo docker image tag "$(sudo docker compose images -q frontend)" "arrival-ledger-frontend:rollback-${STAMP}"
echo "rollback tag: ${STAMP}"
```

如果新版本失败，使用上一步打印的时间标签回滚；若新版本升级过数据库结构，同时恢复更新前的数据备份：

```bash
sudo env BACKEND_IMAGE=arrival-ledger-backend:rollback-时间标签 FRONTEND_IMAGE=arrival-ledger-frontend:rollback-时间标签 docker compose up -d --no-build --force-recreate
deploy/scripts/verify.sh
```

需要长期保持回滚版本时，把这两个镜像名写入 `.env`。

## 故障排查

```bash
# 端口是否被占用
sudo ss -lntp | grep -E ':(8766|8848)\\b'

# 健康状态与最近日志
sudo docker compose ps
sudo docker compose logs --since=15m backend frontend

# 数据目录权限（应显示 UID/GID 10001）
sudo stat -c '%u:%g %a %n' /home/jackson/arrival-manager-data/{db,media,uploads}

# 磁盘空间
df -h /home/jackson/arrival-manager-data
du -sh /home/jackson/arrival-manager-data/*
```

不要执行 `docker compose down -v`、不要手工删除 SQLite 的 `-wal`/`-shm` 文件，也不要清理 `media/` 中未核对的照片。
