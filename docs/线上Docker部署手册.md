# 线上 Docker 部署手册

按顺序做完下面步骤，即可在「只装了 Docker 的云服务器」上用域名 + HTTPS 跑通本项目。

约定（全文替换，不要留占位符）：

| 占位符 | 换成 |
|--------|------|
| `YOUR_DOMAIN` | 你的域名，例如 `kb.example.com` |
| `YOUR_SERVER_IP` | 云服务器公网 IPv4 |
| `YOUR_DB_PASSWORD` | 自拟的数据库强密码（三处必须相同） |
| `YOUR_DASHSCOPE_KEY` | 百炼 API Key |
| `YOUR_EMAIL` | 申请证书用的邮箱 |
| `YOUR_REPO_URL` | 本仓库的 Git 地址 |

本仓库**没有**现成的生产镜像文件。步骤 6～8 会让你在服务器上新建它们。根目录 `docker-compose.yml` 只给本机开发起 Postgres，**不要**在生产机上直接 `docker compose up` 那份文件。

最终访问路径：

```
浏览器 --HTTPS:443--> nginx 容器 --HTTP:3001--> app 容器 --SQL:5432--> postgres 容器
                              app 再出网调用通义千问
```

---

## 步骤 1：SSH 登录服务器

**这一步是为了：** 后面所有命令都在这台机器上执行，先确认你能稳定登录。

在你自己的电脑上：

```bash
ssh root@YOUR_SERVER_IP
```

（若你买的是非 root 用户，改成实际用户名。）建议用密钥登录。登录成功后一直待在这台机器的终端里做步骤 2 起的操作。

---

## 步骤 2：确认 Docker Compose 能用

**这一步是为了：** Docker 引擎只能跑单个容器。本项目要同时跑数据库、应用、Nginx 三个容器，必须用 `docker compose`。

```bash
docker version
docker compose version
```

两条都有版本号再继续。若第二条报错，Ubuntu/Debian 安装插件：

```bash
sudo apt-get update
sudo apt-get install -y docker-compose-plugin
docker compose version
```

---

## 步骤 3：安装 Git

**这一步是为了：** 把项目代码拉到服务器上，才能在机器上构建镜像（镜像构建需要完整的 `client/` 和 `server/` 目录）。

```bash
sudo apt-get update
sudo apt-get install -y git
```

可选，日志时间与你本地一致：

```bash
sudo timedatectl set-timezone Asia/Shanghai
```

---

## 步骤 4：放开 22 / 80 / 443，关掉数据库端口

**这一步是为了：** 你能 SSH、用户能打开网站、Let’s Encrypt 能验证域名；同时避免 Postgres（5432）和 Node（3001）被公网扫描。

云厂商控制台里找到这台机器的**安全组**，入站只保留：

- TCP 22
- TCP 80
- TCP 443

不要放行 3001、5432。

若系统开了 ufw（Ubuntu 常见）：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

安全组和 ufw 是两层，两层都要放行 80/443，否则会出现「容器在跑，外网打不开」。

---

## 步骤 5：域名解析到这台机器

**这一步是为了：** 浏览器用域名访问；后面申请 HTTPS 证书时，Let’s Encrypt 会访问 `http://YOUR_DOMAIN`，解析错了证书一定失败。

在域名服务商 DNS 里增加 **A 记录**：

- 主机记录：`@` 或 `www` 或你想用的子域（例如 `kb`）
- 记录值：`YOUR_SERVER_IP`
- TTL：可先设 600 秒

等几分钟，在你**自己电脑**上检查（应打出 `YOUR_SERVER_IP`）：

```bash
dig +short YOUR_DOMAIN
```

没有域名可以先用 `http://YOUR_SERVER_IP` 把步骤 11 做通，但步骤 12 的证书申请做不了。

---

## 步骤 6：克隆代码并建 `deploy` 目录

**这一步是为了：** 代码在服务器上；生产用的 Dockerfile / Compose / Nginx 单独放在 `deploy/`，不和本地开发的 `docker-compose.yml` 混用。

```bash
mkdir -p /opt
cd /opt
git clone YOUR_REPO_URL ai-knowledge-demo
cd /opt/ai-knowledge-demo
mkdir -p deploy
```

若 Git 仓库是私有的，按平台要求先配 SSH key 或 HTTPS token 再 clone。

确认目录里有 `client/`、`server/`、根目录 `docker-compose.yml`。

---

## 步骤 7：写生产环境变量 `prod.env`

**这一步是为了：** 把 API Key、库密码交给应用容器。不能写进 Git，也不能写进 Dockerfile（会进镜像历史）。

连接串里的主机名必须是 `postgres`（下一步 Compose 里数据库服务的名字），不能写 `localhost`（那是容器自己，里面没有数据库）。

```bash
nano /opt/ai-knowledge-demo/prod.env
```

写入（三处 `YOUR_DB_PASSWORD` 保持一致，下一步 Compose 里还要再写一次）：

```env
DASHSCOPE_API_KEY=YOUR_DASHSCOPE_KEY
QWEN_MODEL=qwen-plus
PORT=3001
DATA_DIR=/app/data
DATABASE_URL=postgresql://kb_user:YOUR_DB_PASSWORD@postgres:5432/ai_knowledge
```

保存后：

```bash
chmod 600 /opt/ai-knowledge-demo/prod.env
```

`DATA_DIR` 用来持久化 Prompt 实验室的 `prompts.json`。会话和知识库在 Postgres 里，不靠这个目录。

---

## 步骤 8：创建三个生产文件

**这一步是为了：** 仓库里目前没有这些文件。有了它们，才能「构建带前端的 Node 镜像 + 起带 pgvector 的库 + 用 Nginx 对外」。

三个文件都放在 `/opt/ai-knowledge-demo/deploy/`。

### 8.1 `deploy/Dockerfile`

**这一步是为了：** 在镜像里先构建前端 `client/dist`，再启动后端。Express 会按「仓库根目录 / client/dist」找页面；只拷 `server/` 的话，打开网站会变成一段 API JSON，没有界面。

```bash
nano /opt/ai-knowledge-demo/deploy/Dockerfile
```

全文粘贴：

```dockerfile
FROM node:18-bookworm-slim AS client-build
WORKDIR /src
COPY client/package.json client/package-lock.json ./client/
RUN cd client && npm ci
COPY client ./client
RUN cd client && npm run build

FROM node:18-bookworm-slim AS server-deps
WORKDIR /src
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

FROM node:18-bookworm-slim
WORKDIR /src
ENV NODE_ENV=production
COPY --from=server-deps /src/server/node_modules ./server/node_modules
COPY server ./server
COPY --from=client-build /src/client/dist ./client/dist
EXPOSE 3001
WORKDIR /src/server
CMD ["node", "src/app.js"]
```

### 8.2 `deploy/nginx-http.conf`（先只开 HTTP）

**这一步是为了：** 证书还没有时，先用 80 端口把站点跑通，并留给 Let’s Encrypt 校验路径。此时不要写 443，否则 Nginx 会因找不到证书文件而起不来。

```bash
sudo tee /opt/ai-knowledge-demo/deploy/nginx-http.conf > /dev/null << 'EOF'
（这里粘贴手册 8.1 的 Dockerfile 全文）
EOF

```

把 `YOUR_DOMAIN` 全部换成你的域名后粘贴：

```nginx
upstream app_upstream {
    server app:3001;
}

server {
    listen 80;
    server_name YOUR_DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location /api/chat {
        proxy_pass http://app_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location /api/agent {
        proxy_pass http://app_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location /api/compare {
        proxy_pass http://app_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location / {
        proxy_pass http://app_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

`/api/chat`、`/api/agent`、`/api/compare` 必须 `proxy_buffering off`。否则对话会「卡很久然后一次性出字」（SSE 被 Nginx 攒着）。

### 8.3 `deploy/docker-compose.prod.yml`

**这一步是为了：** 声明三个容器、内部网络、数据卷。Postgres 必须用 `pgvector/pgvector:pg16`（普通 postgres 镜像没有向量扩展，应用启动会直接退出）。`app` 等库健康后再启动。5432、3001 都不映射到公网。

```bash
sudo tee /opt/ai-knowledge-demo/deploy/docker-compose.prod.yml > /dev/null << 'EOF'
（这里粘贴手册 8.3 的 Dockerfile 全文）
EOF

nano /opt/ai-knowledge-demo/deploy/docker-compose.prod.yml
```

把下面两处 `YOUR_DB_PASSWORD` 换成与 `prod.env` **完全相同**的密码：

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: kb_user
      POSTGRES_PASSWORD: YOUR_DB_PASSWORD
      POSTGRES_DB: ai_knowledge
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U kb_user -d ai_knowledge']
      interval: 5s
      timeout: 5s
      retries: 10

  app:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    restart: unless-stopped
    env_file:
      - ../prod.env
    environment:
      DATABASE_URL: postgresql://kb_user:YOUR_DB_PASSWORD@postgres:5432/ai_knowledge
      DATA_DIR: /app/data
      PORT: '3001'
    volumes:
      - app_data:/app/data
    depends_on:
      postgres:
        condition: service_healthy
    expose:
      - '3001'

  nginx:
    image: nginx:1.27-alpine
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./nginx-http.conf:/etc/nginx/conf.d/default.conf:ro
      - certbot_www:/var/www/certbot
      - certbot_certs:/etc/letsencrypt
    depends_on:
      - app

  certbot:
    image: certbot/certbot
    volumes:
      - certbot_www:/var/www/certbot
      - certbot_certs:/etc/letsencrypt

volumes:
  pgdata:
  app_data:
  certbot_www:
  certbot_certs:
```

`certbot` 服务平时不常驻，步骤 12 用 `compose run` 跑一次即可。

---

## 步骤 9：构建并启动容器

**这一步是为了：** 真正把库、应用、Nginx 跑起来。第一次会下载镜像并 `npm ci` / 构建前端，可能要几分钟。

```bash
cd /opt/ai-knowledge-demo/deploy
docker compose -f docker-compose.prod.yml up -d --build
```

第一次必须三个一起起。以后只想动某一个服务，见文末「单独部署前端 / 后端」。

看是否都在跑：

```bash
docker compose -f docker-compose.prod.yml ps
```

`postgres`、`app`、`nginx` 应为 `running` / `healthy`。`certbot` 没有常驻是正常的。

看应用是否完成建表：

```bash
docker compose -f docker-compose.prod.yml logs -f app
```

出现「前端开发知识库后端服务已启动」即可 `Ctrl+C` 退出跟随（容器还在跑）。若 `app` 不断 Restarting，看日志是不是密码不一致或没用 pgvector 镜像。

---

## 步骤 10：检查健康接口和页面

**这一步是为了：** 确认数据库已通、前端产物已打进镜像，再去申请证书（证书失败和业务失败要分开查）。

在服务器上：

```bash
cd /opt/ai-knowledge-demo/deploy
docker compose -f docker-compose.prod.yml exec app wget -qO- http://127.0.0.1:3001/api/health
curl -sS http://YOUR_DOMAIN/api/health
```

两处都应类似：`"status":"ok"` 且 `"db":"ok"`。

在你自己电脑浏览器打开 `http://YOUR_DOMAIN`，应看到本项目界面，而不是一段 JSON。

打不开时按文末「出问题对照」查，不要先去做证书。

---

## 步骤 11：申请 HTTPS 证书

**这一步是为了：** 给域名签发 Let’s Encrypt 证书。必须先完成步骤 5（解析已生效）和步骤 10（80 端口 Nginx 已能访问）。证书不装在 Node 里，由 Nginx 对外终止 TLS。

仍在 `/opt/ai-knowledge-demo/deploy`：

```bash
docker compose -f docker-compose.prod.yml run --rm certbot \
  certonly --webroot -w /var/www/certbot \
  -d YOUR_DOMAIN \
  --email YOUR_EMAIL \
  --agree-tos --no-eff-email
```

成功日志里会有 `Congratulations`。失败先查：`dig +short YOUR_DOMAIN` 是否已是本机 IP；云安全组 80 是否开放；不要把 ACME 路径 301 到 HTTPS（当前 `nginx-http.conf` 没有 301，是对的）。

---

## 步骤 12：换成 HTTPS 配置并重载 Nginx

**这一步是为了：** 证书文件已经在卷里了，让 Nginx 监听 443，并把普通访问跳到 HTTPS。

```bash
nano /opt/ai-knowledge-demo/deploy/nginx.conf
```

粘贴（替换全部 `YOUR_DOMAIN`）：

```nginx
upstream app_upstream {
    server app:3001;
}

server {
    listen 80;
    server_name YOUR_DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name YOUR_DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/YOUR_DOMAIN/privkey.pem;

    client_max_body_size 1m;

    location /api/chat {
        proxy_pass http://app_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location /api/agent {
        proxy_pass http://app_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location /api/compare {
        proxy_pass http://app_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }

    location / {
        proxy_pass http://app_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

改 Compose，让 Nginx 挂这份新配置：把 `docker-compose.prod.yml` 里 nginx 的这一行

```yaml
      - ./nginx-http.conf:/etc/nginx/conf.d/default.conf:ro
```

改成

```yaml
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
```

然后：

```bash
cd /opt/ai-knowledge-demo/deploy
docker compose -f docker-compose.prod.yml up -d nginx
```

浏览器打开 `https://YOUR_DOMAIN`，应出现锁标和本项目界面。健康检查：

```bash
curl -sS https://YOUR_DOMAIN/api/health
```

---

## 步骤 13：设置证书自动续期

**这一步是为了：** Let’s Encrypt 证书约 90 天过期。到期前自动换证并让 Nginx 重新读文件。

```bash
sudo crontab -e
```

加一行（每天凌晨 3 点尝试续期，未到期时 certbot 会直接跳过）：

```cron
0 3 * * * cd /opt/ai-knowledge-demo/deploy && docker compose -f docker-compose.prod.yml run --rm certbot renew && docker compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

---

## 上线之后怎么用

以下不是首次部署的必做项，日常维护时按需执行。命令都在服务器 `/opt/ai-knowledge-demo/deploy` 下。

### 更新代码上线

**为了：** 把 Git 上的新前端/后端打进新镜像。只重启旧容器看不到界面变化。数据库卷不会丢。

```bash
cd /opt/ai-knowledge-demo
git pull
cd deploy
docker compose -f docker-compose.prod.yml up -d --build --no-deps app
```

`--no-deps` 只重建并重启 `app`，不会顺带动 `postgres` / `nginx`。

注意：`deploy/` 里你手写的文件若不在 Git 里，`git pull` 不会覆盖它们，这是预期行为。

### 单独部署前端 / 后端

**为了：** 已经整套跑着之后，只更新某一层，不必再 `up -d --build` 全部服务。

生产里**没有**独立的前端容器。浏览器看到的页面是构建进 `app` 镜像的 `client/dist`，由 Node 和 API 一起提供；`nginx` 只做反向代理和 HTTPS。所以：

- 改 `client/`（界面）或改 `server/`（接口）→ 都是重建 **`app`**
- 改 Nginx 配置或证书挂载 → 只动 **`nginx`**
- 数据库一般不要重建，数据在 `pgdata` 卷里

所有命令都在 `/opt/ai-knowledge-demo/deploy` 下执行。

只重建并重启应用（覆盖「只更前端」和「只更后端」）：

```bash
docker compose -f docker-compose.prod.yml up -d --build --no-deps app
```

Docker 会按 Dockerfile 分层缓存：只改了 `client/` 时，后端 `npm ci` 那一层通常不会重跑；只改了 `server/` 里的 JS 时，前端 `npm run build` 通常不会重跑。最终镜像都会重新 COPY，所以界面和接口都会变成新的。

不想用缓存、强制整镜像重打（排构建异常时用）：

```bash
docker compose -f docker-compose.prod.yml build --no-cache app
docker compose -f docker-compose.prod.yml up -d --no-deps app
```

只启动 / 重启 Nginx（改完 `nginx.conf` 或 `nginx-http.conf` 之后）：

```bash
docker compose -f docker-compose.prod.yml up -d nginx
```

配置已挂进容器、只想让 Nginx 重新读文件、不重建容器：

```bash
docker compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

只启动数据库（库还没起、或只想先起 Postgres）：

```bash
docker compose -f docker-compose.prod.yml up -d postgres
```

只启动应用、且数据库已经在跑（首次没有 `--build` 会用已有镜像；代码有改动仍要加 `--build`）：

```bash
docker compose -f docker-compose.prod.yml up -d app
```

对照：

| 你想做的事 | 命令 |
|------------|------|
| 只更新前端（`client/`） | `up -d --build --no-deps app` |
| 只更新后端（`server/`） | 同上，还是重建 `app` |
| 只更新 Nginx 配置 | `up -d nginx` 或 `exec nginx nginx -s reload` |
| 只启动 Postgres | `up -d postgres` |
| 三个一起（首次部署） | 步骤 9 的 `up -d --build` |

### 看日志

```bash
docker compose -f docker-compose.prod.yml logs -f --tail=200 app
```

### 备份数据库

**为了：** 会话、知识库、向量都在 Postgres 里。容器可以重建，这个备份不能丢。

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U kb_user ai_knowledge > /root/kb-backup-$(date +%Y%m%d).sql
```

### 安全提醒

本 Demo **没有登录**。能打开网站的人共用知识库和对话历史，只适合自己或小范围演示。Postgres 不要映射 5432 到公网；Key 只放在 `prod.env`。

---

## 出问题对照

做到某一步失败时，先对这一表，不要跳步。

| 你看到的 | 多半是 | 做什么 |
|----------|--------|--------|
| `docker compose` 不是命令 | 没装插件 | 回步骤 2 |
| `app` 一直 Restarting，日志有 vector / extension | 没用 pgvector 镜像 | 确认 Compose 的 image 是 `pgvector/pgvector:pg16` |
| `app` 一直 Restarting，日志有 password / connection | 三处密码不一致，或 `DATABASE_URL` 写成了 localhost | 对齐 `prod.env` 和 Compose 里的 `POSTGRES_PASSWORD` |
| `/api/health` 里 `db` 不是 ok | 库还没好或连错 | `logs postgres`；等 `ps` 里 postgres 为 healthy |
| 网站是一段 JSON（name、endpoints） | 镜像里没有 `client/dist` | 确认 Dockerfile 有 COPY dist；构建 context 是仓库根 `..` |
| 页面有，对话报 Key / 鉴权错误 | `prod.env` 没进容器 | `docker compose -f docker-compose.prod.yml exec app printenv DASHSCOPE_API_KEY` |
| 对话卡很久再一次性出字 | SSE 被缓冲 | 确认 nginx 里三个 `/api/...` 有 `proxy_buffering off` |
| 本机 curl 通、外网不通 | 安全组或 ufw | 回步骤 4 |
| certbot 失败 | DNS 或 80 不通 | 回步骤 5、10；先 `curl http://YOUR_DOMAIN` |
| nginx 起不来，抱怨 ssl 证书文件 | 还没申请证书就挂了 `nginx.conf` | 先用步骤 8.2 的 HTTP 配置，做完步骤 11 再换 |

后端原理见 [后端开发指南](./后端开发指南.md)。
