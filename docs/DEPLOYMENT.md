# 部署指南

本文档描述 arrival-ledger 当前的长期公网部署方式。生产服务器为
`root@120.26.124.126`，应用目录为 `/opt/arrival-ledger`，持久化数据目录为
`/var/lib/arrival-ledger`。

生产流量路径如下：

```text
公网客户端
  -> Nginx :80（ACME 校验；其余请求跳转 HTTPS）
  -> Nginx :443（TLS）
  -> 127.0.0.1:8766（arrival-ledger 前端容器）
  -> backend:8000（Docker 内部网络）
```

生产环境必须启用登录保护和安全 Cookie，并通过 1688 官方开放平台 API 同步订单。
任何密码、Token、Cookie、AppSecret 或私钥都只保存在服务器的受限环境文件或密钥文件中，
不得写入仓库、部署文档、镜像或命令历史。

## 1. 目录与权限

首次部署时准备目录：

```bash
sudo install -d -m 0755 -o root -g root /opt/arrival-ledger
sudo install -d -m 0750 -o root -g 10001 /var/lib/arrival-ledger
sudo install -d -m 0750 -o 10001 -g 10001 \
  /var/lib/arrival-ledger/db \
  /var/lib/arrival-ledger/media \
  /var/lib/arrival-ledger/uploads \
  /var/lib/arrival-ledger/backups
```

后端容器使用固定 UID/GID `10001:10001`；目录属主不能省略，否则容器可能无法写入数据库或照片。

代码放在 `/opt/arrival-ledger`。生产环境配置文件应限制为仅管理员可读，例如：

```bash
sudo install -m 0600 /dev/null /opt/arrival-ledger/.env
```

编辑 `/opt/arrival-ledger/.env` 时至少设置以下非敏感部署项，并在同一文件中另行配置真实凭据：

```dotenv
BIND_ADDRESS=127.0.0.1
APP_PORT=8766
DATA_ROOT=/var/lib/arrival-ledger
AUTH_REQUIRED=true
COOKIE_SECURE=true
```

`BIND_ADDRESS=127.0.0.1` 很重要：容器端口只供宿主机 Nginx 访问，不直接暴露到公网。

## 2. Docker Compose 部署

在服务器上构建并启动：

```bash
cd /opt/arrival-ledger
docker compose config
docker compose build
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8766/api/health
```

持久化数据库、照片和上传文件均位于 `/var/lib/arrival-ledger`。重建或替换容器不会删除这些数据，
但部署前仍应执行备份。

## 3. 1688 官方 API

生产订单同步使用 1688 官方开放平台 API。按应用实际需要在服务器受限配置中设置应用标识、
回调地址和密钥；不要在仓库中创建包含真实值的 `.env`、JSON 或示例文件。多账号 JSON 格式、
令牌轮换和状态映射见 [ALI1688_OPEN_API.md](ALI1688_OPEN_API.md)。正式启用前依次执行：

```bash
cd /opt/arrival-ledger
docker compose run --rm backend python -m app.cli config-doctor
docker compose run --rm backend python -m app.cli sync-once --all --dry-run
```

部署后应确认：

- 回调地址使用公网 HTTPS 地址；
- 服务器时间同步正常；
- 访问令牌刷新失败会写入服务日志，但日志不会输出完整令牌或 AppSecret；
- API 权限、应用状态和授权账号均在 1688 官方控制台中有效。

## 4. Nginx 与公网 HTTPS

宿主机 Nginx 负责 80/443 端口。先准备 ACME webroot：

```bash
sudo install -d -m 0755 /var/www/acme/.well-known/acme-challenge
```

证书签发前，80 端口站点可使用：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name 120.26.124.126;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type text/plain;
    }

    location / {
        return 308 https://$host$request_uri;
    }
}
```

安装支持 IP 地址短期证书的新版 Certbot（Snap 渠道应保持 `certbot >= 5.4`）：

```bash
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/local/bin/certbot
certbot --version
```

先用 Let’s Encrypt staging 验证 webroot 和公网连通性，再签发正式 IP 地址短期证书：

```bash
sudo certbot certonly --staging --webroot -w /var/www/acme \
  --cert-name arrival-ledger-ip \
  --preferred-profile shortlived --ip-address 120.26.124.126

sudo certbot certonly --webroot -w /var/www/acme \
  --cert-name arrival-ledger-ip \
  --preferred-profile shortlived --ip-address 120.26.124.126
```

证书签发后，443 站点代理到仅监听回环地址的应用：

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name 120.26.124.126;

    ssl_certificate /etc/letsencrypt/live/arrival-ledger-ip/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/arrival-ledger-ip/privkey.pem;

    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:8766;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
    }
}
```

启用配置前检查并平滑加载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

云安全组和主机防火墙需允许公网 TCP 22/80/443；8766 不应对公网开放。当前主机使用 UFW 时可核对：

```bash
sudo ufw status verbose
sudo ss -lntp
```

正式签发前还需从外部网络验证
`http://120.26.124.126/.well-known/acme-challenge/...` 能直接到达本机 Nginx，且未被上游代理或错误的默认站点截获。

## 5. 证书自动续期

短期 IP 证书依赖频繁自动续期。Snap 安装会提供 `snap.certbot.renew.timer`：

```bash
systemctl status snap.certbot.renew.timer
systemctl list-timers snap.certbot.renew.timer
sudo certbot renew --dry-run
```

配置续期成功后的 Nginx reload hook，例如：

```bash
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
```

定期检查 timer、最近续期日志和证书到期时间。不要把短期证书当作可人工按月处理的证书。

## 6. 日常发布与回滚

常规发布：

```bash
cd /opt/arrival-ledger
docker compose build
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8766/api/health
```

发布后同时验证公网 HTTP 跳转和 HTTPS 页面/API。回滚时切回已经验证过的代码版本或镜像，重新执行
`docker compose up -d`；不要删除 `/var/lib/arrival-ledger`。

## 7. 自动备份

仓库提供以下 systemd 单元：

- `deploy/systemd/arrival-ledger-backup.service`
- `deploy/systemd/arrival-ledger-backup.timer`

安装并启用：

```bash
sudo install -m 0644 deploy/systemd/arrival-ledger-backup.service /etc/systemd/system/
sudo install -m 0644 deploy/systemd/arrival-ledger-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arrival-ledger-backup.timer
systemctl list-timers arrival-ledger-backup.timer
```

定时器每天 `03:20` 触发，并带最多 15 分钟随机延迟；备份保存在
`/var/lib/arrival-ledger/backups`，保留最近 14 天。服务单元已经显式设置生产项目和数据目录，
执行时会短暂停止后端以获得一致备份，随后恢复并检查健康状态。每个 `.tar.gz` 归档同时生成
同名 `.sha256` 文件；恢复前先在备份目录执行 `sha256sum --check 文件名.tar.gz.sha256`。

手工验证：

```bash
sudo systemctl start arrival-ledger-backup.service
systemctl status arrival-ledger-backup.service
sudo journalctl -u arrival-ledger-backup.service --since today
sudo find /var/lib/arrival-ledger/backups -maxdepth 1 -type f -printf '%TY-%Tm-%Td %TH:%TM %f\n'
```

应定期把备份复制到另一台机器或对象存储，并实际演练恢复。单机同盘备份无法防止磁盘或整机故障。

恢复前必须先校验归档路径和 SHA-256，并保留当前目录作为可回滚副本。恢复操作会短暂停服：

```bash
cd /opt/arrival-ledger
sudo systemctl stop arrival-ledger-backup.timer
docker compose stop frontend backend
STAMP="$(date +%Y%m%d-%H%M%S)"
sudo mv /var/lib/arrival-ledger/db "/var/lib/arrival-ledger/db.before-${STAMP}"
sudo mv /var/lib/arrival-ledger/media "/var/lib/arrival-ledger/media.before-${STAMP}"
sudo mv /var/lib/arrival-ledger/uploads "/var/lib/arrival-ledger/uploads.before-${STAMP}"
sudo tar -xzf /绝对路径/arrival-ledger-YYYYMMDDTHHMMSSZ.tar.gz -C /var/lib/arrival-ledger
sudo chown -R 10001:10001 \
  /var/lib/arrival-ledger/db \
  /var/lib/arrival-ledger/media \
  /var/lib/arrival-ledger/uploads
docker compose up -d
curl --fail http://127.0.0.1:8766/api/health
sudo systemctl start arrival-ledger-backup.timer
```

确认数据库、订单、照片和上传均正确后，才能手工清理 `.before-*` 目录。

## 8. 排障检查

```bash
cd /opt/arrival-ledger
docker compose ps
docker compose logs --tail=200 frontend backend
curl -v http://127.0.0.1:8766/api/health
sudo nginx -t
sudo journalctl -u nginx --since today
sudo journalctl -u snap.certbot.renew.service --since '7 days ago'
systemctl status snap.certbot.renew.timer arrival-ledger-backup.timer
```

常见问题：

- 登录后立即失效：确认公网访问使用 HTTPS，且 `AUTH_REQUIRED=true`、`COOKIE_SECURE=true`；
- 页面出现 502：先检查容器健康状态，再检查 `127.0.0.1:8766`；
- 证书签发失败：检查公网 80 端口、安全组、UFW、ACME webroot 和 Nginx server 匹配；
- 订单为空或同步失败：检查 1688 官方 API 授权状态、回调地址和服务日志中的脱敏错误；
- 备份失败：检查 `/var/lib/arrival-ledger` 空间、权限、Docker 状态及 systemd 日志。

## 9. 可选的历史访问方案

以下方案不属于当前长期公网生产部署，只适合临时调试或受控环境：

- **局域网直连**：可临时把 `BIND_ADDRESS` 改为内网网卡地址，再通过局域网 IP 和 8766 端口访问。
  此时应限制防火墙来源，且安全 Cookie/HTTPS 行为需按实际入口调整。
- **Cloudflare Quick Tunnel**：Compose 中仍保留 quick-tunnel profile，可用于临时演示。随机域名和隧道生命周期
  不适合作为长期生产入口，也不能替代固定 HTTPS、证书续期和备份方案。
- **Caddy**：曾作为替代反向代理方案使用；当前生产入口统一由宿主机 Nginx 管理。若在独立环境选用 Caddy，
  必须避免与 Nginx 争用 80/443，并重新验证 IP 证书能力和续期策略。
