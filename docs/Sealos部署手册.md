# Sealos 部署操作手册

> 本文档记录将 AI 知识库 Demo 项目部署到 Sealos 云平台的完整过程，包含代码适配、DevBox 开发、entrypoint.sh 配置、应用管理发布、计费说明等全部环节。
>
> ⚠️ 本文档基于实际部署过程中踩过的坑整理，请重点关注标注 **【关键】** 的步骤。

## 目录

- [一、项目概述](#一项目概述)
- [二、部署前代码适配](#二部署前代码适配)
- [三、Sealos 注册与环境准备](#三sealos-注册与环境准备)
- [四、DevBox 云端开发部署](#四devbox-云端开发部署)
- [五、配置 entrypoint.sh（上线关键）](#五配置-entrypointsh上线关键)
- [六、上线发布到应用管理](#六上线发布到应用管理)
- [七、环境变量配置](#七环境变量配置)
- [八、计费说明与省钱策略](#八计费说明与省钱策略)
- [九、常见问题排查](#九常见问题排查)
- [十、更新代码后的重新部署](#十更新代码后的重新部署)

---

## 一、项目概述

### 项目结构

```
ai-knowledge-demo/
├── client/          # React + Vite 前端
├── server/          # Node.js + Express 后端
│   ├── src/
│   │   ├── app.js   # Express 入口（已适配静态托管）
│   │   └── ...
│   └── .env         # 环境变量（不入库）
├── Dockerfile       # 容器构建文件（备用，DevBox 上线不需要）
├── .dockerignore    # Docker 构建忽略规则
└── package.json     # 根目录脚本
```

### 技术栈

- 前端：React 18 + Vite 5 + react-markdown
- 后端：Node.js + Express 4
- AI：通义千问（DashScope API）
- 部署：Sealos（DevBox + entrypoint.sh 上线 + 应用管理）

### 核心特性

- SSE 流式输出 AI 回复
- Markdown 渲染（代码高亮、表格、列表）
- 对话历史保存（JSON 文件）
- Agent 模式 + 工具调用
- RAG 知识库检索
- A/B 模型对比

### 部署架构说明

Sealos 部署分两个阶段：

| 阶段 | 环境 | 用途 | 计费 |
|------|------|------|------|
| 开发调试 | DevBox | 拉代码、装依赖、构建、测试 | 运行中计费，暂停仍收存储费 |
| 正式上线 | 应用管理 | 长期运行，对外提供服务 | 最小实例 0 时无人访问不计费 |

**上线机制**：DevBox 通过项目根目录的 `entrypoint.sh` 脚本启动应用。点击"上线"后，Sealos 把 DevBox 环境打包，用 `entrypoint.sh` 作为容器启动命令部署到应用管理。

---

## 二、部署前代码适配

### 2.1 Express 托管前端静态文件

修改 `server/src/app.js`，让 Express 同时托管前端构建产物：

```javascript
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

// 托管前端静态资源
app.use(express.static(CLIENT_DIST));

// SPA 路由回退：非 /api 请求返回 index.html
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'));
});
```

### 2.2 根目录 package.json 添加部署脚本

```json
{
  "scripts": {
    "build": "npm run install:all && npm run build --prefix client",
    "start": "npm start --prefix server"
  }
}
```

### 2.3 确认端口从环境变量读取 【关键】

`server/src/config/index.js`：

```javascript
// 不要写死端口，云平台会自动注入 PORT 环境变量
const PORT = process.env.PORT || 3001;
```

> ⚠️ **不要把端口写死成 3001**。Sealos 上线后会自动注入 `PORT=8080`，服务必须监听 8080 才能被外网访问到。

### 2.4 （可选）创建 Dockerfile

> DevBox 上线方式**不需要** Dockerfile（DevBox 环境没有 docker 命令）。Dockerfile 仅在通过镜像仓库部署时使用，这里作为备用。

```dockerfile
FROM node:20-alpine

RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app

COPY package.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm run install:all

COPY . .

RUN npm run build --prefix client

EXPOSE 8080

CMD ["npm", "start"]
```

---

## 三、Sealos 注册与环境准备

### 3.1 注册账号

1. 访问 https://cloud.sealos.run
2. 使用微信扫码或 GitHub 登录
3. 注册后赠送 **5 元**免费额度
4. 完成实名认证再得 **5 元**（共 10 元）

### 3.2 可用区选择

| 可用区 | 云厂商 | 适合地区 |
|--------|--------|---------|
| 杭州 | 阿里云 | 华东 |
| 北京 | 火山引擎 | 华北 |
| 广东 | 腾讯云 | 华南 |
| 新加坡 | 谷歌云 | 海外 |

---

## 四、DevBox 云端开发部署

DevBox 是 Sealos 提供的云端开发环境，适合首次部署和调试。

### 4.1 创建 DevBox

1. 左侧菜单选择 **「DevBox」**
2. 点击 **「创建项目」**
3. 选择模板：**Node.js**
4. 资源配置：
   - CPU：2 核
   - 内存：4 GB
   - 网络端口：添加 `3001`（调试用，上线后用 8080）
5. 点击创建，等待 30 秒环境就绪

### 4.2 进入终端

项目创建完成后，点击进入 **Web 终端**。

### 4.3 确认工作目录 【关键】

DevBox 的项目根目录是 `/home/devbox/project/`。**所有操作都在这个目录下进行**。

```bash
# 查看当前目录
pwd
# 应输出：/home/devbox/project

# 查看目录内容
ls
```

### 4.4 拉取代码

```bash
cd /home/devbox/project
git clone https://github.com/ziyuanxueying/ai-knowledge-demo.git
```

拉取后项目路径为：

```
/home/devbox/project/ai-knowledge-demo/
```

> ⚠️ 注意：项目在 `ai-knowledge-demo` **子目录**里，不是直接在 `/home/devbox/project/` 下。后续 entrypoint.sh 的路径要与此对应。

### 4.5 安装依赖

```bash
cd /home/devbox/project/ai-knowledge-demo
npm run install:all
```

> 预计耗时 2-3 分钟，如遇网络问题可重试。

### 4.6 配置环境变量

在 `server/` 目录下创建 `.env` 文件：

```bash
cd /home/devbox/project/ai-knowledge-demo
cat > server/.env << 'EOF'
DASHSCOPE_API_KEY=你的通义千问API_KEY
QWEN_MODEL=qwen-turbo
TEMPERATURE=0.7
MAX_TOKENS=2048
PORT=3001
EOF
```

> 调试阶段 PORT 用 3001；上线后 Sealos 会自动注入 PORT=8080 覆盖此值。

### 4.7 构建前端 【关键】

**上线前必须先构建前端**，entrypoint.sh 只负责启动，不负责构建：

```bash
cd /home/devbox/project/ai-knowledge-demo
npm run build --prefix client
```

验证构建成功：

```bash
ls client/dist/index.html
# 能看到文件路径说明构建成功
```

> 如果提示 `No such file or directory`，说明前端没构建，上线后页面会白屏或 404。

### 4.8 启动后端调试

```bash
cd /home/devbox/project/ai-knowledge-demo/server
npm start
```

看到以下输出表示启动成功：

```
Server running on port 3001
```

按 `Ctrl+C` 停止调试服务。

### 4.9 获取调试访问地址

1. 回到 DevBox 项目页面
2. 找到 **「网络」** 或 **「端口」** 设置
3. 开启端口 `3001` 的外网访问
4. 获得 `https://xxx.sealos.run` 调试地址

> 此地址仅用于开发调试，DevBox 暂停后失效。正式上线见第六章。

---

## 五、配置 entrypoint.sh（上线关键）

### 5.1 entrypoint.sh 是什么？

`entrypoint.sh` 是 Sealos DevBox 上线时的**启动脚本**。点击"上线"按钮后，Sealos 会：

1. 把整个 DevBox 环境打包成镜像
2. 用 `/home/devbox/project/entrypoint.sh` 作为容器启动命令
3. 部署到应用管理

**如果 entrypoint.sh 不存在或路径错误，上线后会出现：**
- 显示 Sealos 默认的 "hello world" 页面
- 日志报错 `cd: no such file or directory`
- 日志报错 `Could not read package.json`

### 5.2 entrypoint.sh 的位置 【关键】

Sealos 上线时固定读取这个路径的脚本：

```
/home/devbox/project/entrypoint.sh
```

⚠️ **不是**项目子目录里的 `/home/devbox/project/ai-knowledge-demo/entrypoint.sh`，而是 **project 根目录**下的。

### 5.3 创建 entrypoint.sh

在 DevBox 终端执行：

```bash
cat > /home/devbox/project/entrypoint.sh << 'EOF'
#!/bin/bash
cd /home/devbox/project/ai-knowledge-demo/server
npm start
EOF
```

### 5.4 赋予执行权限 【关键】

```bash
chmod +x /home/devbox/project/entrypoint.sh
```

> 如果不赋执行权限，上线后脚本无法运行。

### 5.5 验证 entrypoint.sh

```bash
cat /home/devbox/project/entrypoint.sh
```

确认输出为：

```bash
#!/bin/bash
cd /home/devbox/project/ai-knowledge-demo/server
npm start
```

### 5.6 手动测试 entrypoint.sh（可选但推荐）

上线前先在 DevBox 里手动跑一遍，确认脚本能正常启动：

```bash
bash /home/devbox/project/entrypoint.sh
```

看到 `Server running on port` 输出说明脚本正确，按 `Ctrl+C` 停止。

### 5.7 entrypoint.sh 路径对照表

| 路径 | 说明 |
|------|------|
| `/home/devbox/project/` | DevBox 工作根目录 |
| `/home/devbox/project/entrypoint.sh` | **上线脚本（必须在这个位置）** |
| `/home/devbox/project/ai-knowledge-demo/` | 项目代码目录 |
| `/home/devbox/project/ai-knowledge-demo/server/` | 后端目录（entrypoint.sh 里 cd 到这里） |
| `/home/devbox/project/ai-knowledge-demo/client/dist/` | 前端构建产物（必须提前构建） |

### 5.8 常见错误写法

❌ **错误 1：路径写成 project/server（项目实际在子目录）**

```bash
#!/bin/bash
cd /home/devbox/project/server    # 错误！server 在 ai-knowledge-demo 子目录里
npm start
```

报错：`cd: /home/devbox/project/server: No such file or directory`

❌ **错误 2：entrypoint.sh 放在项目子目录里**

放在 `/home/devbox/project/ai-knowledge-demo/entrypoint.sh`，Sealos 找不到，用默认模板启动 → 显示 hello world。

✅ **正确写法**：

```bash
#!/bin/bash
cd /home/devbox/project/ai-knowledge-demo/server
npm start
```

且文件放在 `/home/devbox/project/entrypoint.sh`。

---

## 六、上线发布到应用管理

### 6.1 上线前检查清单

上线前逐项确认：

- [ ] 前端已构建：`ls /home/devbox/project/ai-knowledge-demo/client/dist/index.html` 存在
- [ ] entrypoint.sh 已创建：`/home/devbox/project/entrypoint.sh` 存在
- [ ] entrypoint.sh 有执行权限：`chmod +x` 已执行
- [ ] entrypoint.sh 内容正确：cd 路径指向 `ai-knowledge-demo/server`
- [ ] 后端能手动启动：`bash entrypoint.sh` 测试通过
- [ ] `.env` 文件已配置：`server/.env` 存在且 API Key 正确

### 6.2 点击上线

1. 回到 DevBox **项目详情页**（不是终端）
2. 找到 **「上线」** 按钮（部分版本叫「发布」「部署」「Release」，可能在页面右上角或「更多」菜单里）
3. 点击上线，Sealos 自动打包部署
4. 等待 2-5 分钟

### 6.3 配置应用管理参数

上线后进入 **应用管理**，找到新部署的应用，点击 **「变更」** 或 **「编辑」**，配置以下参数：

#### 基础配置

| 配置项 | 值 |
|--------|-----|
| 应用名称 | `ai-knowledge-demo` |
| CPU | 1 核 |
| 内存 | 1 GB |

#### 弹性伸缩配置

| 配置项 | 值 | 说明 |
|--------|-----|------|
| 部署模式 | 弹性伸缩 | 按需扩缩容 |
| 最小实例 | `0` | 无请求时缩容到 0，不计费 |
| 最大实例 | `1` | 最多 1 个实例 |
| CPU 目标值 | `60` | CPU 使用率超过 60% 时扩容 |
| 内存目标值 | `60` | 内存使用率超过 60% 时扩容 |

#### 网络配置 【关键】

| 配置项 | 值 | 说明 |
|--------|-----|------|
| 容器端口 | **`8080`** | Sealos 上线后服务监听 8080 |
| 协议 | `HTTP` | 先选 HTTP，HTTPS 由平台域名提供 |
| 外网访问 | 开启 | 生成公网域名 |

> ⚠️ **容器端口必须填 8080，不是 3001**。Sealos 上线时自动注入 `PORT=8080`，服务实际监听 8080。如果填 3001，会导致端口不匹配、地址一直"准备中"或无法访问。

### 6.4 配置应用管理环境变量 【关键】

应用管理的环境变量**不会继承** DevBox 里的 `.env` 文件，必须在应用管理控制台单独配置。

在 **「环境变量」** 区域添加：

```
DASHSCOPE_API_KEY=你的通义千问API_KEY
QWEN_MODEL=qwen-turbo
TEMPERATURE=0.7
MAX_TOKENS=2048
```

> ⚠️ **不要设置 PORT 变量**。Sealos 会自动注入 `PORT=8080`，手动设置可能导致冲突。

### 6.5 保存并等待部署

1. 保存配置，Sealos 自动重新部署
2. 等待 2-3 分钟，状态变为 **Running**
3. 公网地址生成后（约 1 分钟），浏览器打开访问

### 6.6 验证上线

浏览器打开公网地址，检查：

- [ ] 首页显示聊天界面（不是 hello world）
- [ ] 发送消息，AI 流式回复正常
- [ ] Agent 模式工具调用正常
- [ ] 刷新页面不 404

### 6.7 查看应用日志

应用详情页点 **「日志」**，正常应看到：

```
Server running at http://0.0.0.0:8080/
```

> 注意端口是 **8080**。如果显示 3001，说明 PORT 环境变量没被正确注入，检查应用管理环境变量。

---

## 七、环境变量配置

### 7.1 DevBox 调试阶段（server/.env 文件）

| 变量名 | 必填 | 值 | 说明 |
|--------|------|-----|------|
| `DASHSCOPE_API_KEY` | ✅ | 你的 API Key | 通义千问密钥 |
| `QWEN_MODEL` | ❌ | `qwen-turbo` | 模型名称 |
| `TEMPERATURE` | ❌ | `0.7` | 采样温度 |
| `MAX_TOKENS` | ❌ | `2048` | 最大 Token 数 |
| `PORT` | ❌ | `3001` | 调试端口 |

### 7.2 应用管理上线阶段（控制台配置）

| 变量名 | 必填 | 值 | 说明 |
|--------|------|-----|------|
| `DASHSCOPE_API_KEY` | ✅ | 你的 API Key | 通义千问密钥 |
| `QWEN_MODEL` | ❌ | `qwen-turbo` | 模型名称 |
| `TEMPERATURE` | ❌ | `0.7` | 采样温度 |
| `MAX_TOKENS` | ❌ | `2048` | 最大 Token 数 |
| ~~`PORT`~~ | ❌ | **不要设置** | Sealos 自动注入 8080 |

> ⚠️ 应用管理的环境变量与 DevBox 的 `.env` 文件**互相独立**，两边都要配。

---

## 八、计费说明与省钱策略

### 8.1 免费额度

| 项目 | 金额 |
|------|------|
| 注册赠送 | 5 元（一次性） |
| 实名认证赠送 | 5 元（一次性） |
| 每日增加 | ❌ 无 |

### 8.2 DevBox 计费

| 状态 | CPU+内存 | 存储 |
|------|----------|------|
| 运行中 | ✅ 计费 | ✅ 计费 |
| 已暂停 | ❌ 不计费 | ✅ **仍计费** |
| 已销毁 | ❌ 不计费 | ❌ 不计费 |

> DevBox 暂停后仍收存储费（代码和依赖占磁盘）。上线成功后建议**直接销毁 DevBox**。

### 8.3 应用管理计费（最小实例 0）

| 状态 | 费用 |
|------|------|
| 无访问（缩容到 0） | 仅存储费 ≈ 0.1 元/天 |
| 有访问（1 核 1G 运行） | ≈ 0.04 元/小时 |
| 冷启动 | 首次访问 10-30 秒延迟 |

### 8.4 省钱策略

1. **应用管理最小实例设 0**：无人访问时不计计算费
2. **上线成功后销毁 DevBox**：避免 DevBox 存储费持续扣除
3. **实名认证**：多得 5 元额度
4. **合理设置资源**：1 核 1G 足够 Demo 使用
5. **CPU 目标值设 60**：平衡伸缩灵敏度

### 8.5 5 元能用多久？

| 使用频率 | 预估时长 |
|---------|---------|
| 几乎不用（缩容到 0） | ≈ 50 天 |
| 偶尔使用 | ≈ 1-2 个月 |
| 频繁使用 | ≈ 1-2 周 |

---

## 九、常见问题排查

### 9.1 上线后显示 "hello world"

**原因**：Sealos 没找到 entrypoint.sh，用了默认 Node.js 模板启动。

**解决**：
1. 确认 entrypoint.sh 在 `/home/devbox/project/entrypoint.sh`（不是项目子目录里）
2. 确认有执行权限：`chmod +x /home/devbox/project/entrypoint.sh`
3. 删除应用管理里的旧服务，重新上线

### 9.2 日志报错 `cd: no such file or directory`

**现象**：
```
/home/devbox/project/entrypoint.sh: line 1: cd: /home/devbox/project/server: No such file or directory
```

**原因**：entrypoint.sh 里的 cd 路径错误。项目在 `ai-knowledge-demo` 子目录里，不是直接在 project 下。

**解决**：重写 entrypoint.sh：

```bash
cat > /home/devbox/project/entrypoint.sh << 'EOF'
#!/bin/bash
cd /home/devbox/project/ai-knowledge-demo/server
npm start
EOF
chmod +x /home/devbox/project/entrypoint.sh
```

### 9.3 日志报错 `Could not read package.json`

**现象**：
```
npm error path /home/devbox/project/package.json
npm error enoent Could not read package.json
```

**原因**：entrypoint.sh 没有 cd 到 server 目录就执行 npm start。

**解决**：同 9.2，确认 entrypoint.sh 里有 `cd /home/devbox/project/ai-knowledge-demo/server`。

### 9.4 公网地址一直"准备中"

**原因**：容器端口配置与服务实际监听端口不匹配。

**解决**：
1. 查看应用日志，确认服务监听的端口（上线后是 **8080**）
2. 应用管理 → 变更 → 容器端口改成 `8080`
3. 不要在环境变量里手动设 PORT

### 9.5 页面白屏

**排查**：
1. 确认前端已构建：`ls /home/devbox/project/ai-knowledge-demo/client/dist/index.html`
2. 如果不存在，在 DevBox 里执行 `npm run build --prefix client`，然后重新上线
3. 确认 `app.js` 中静态托管路径正确

### 9.6 AI 回复报错

**排查**：
1. 应用管理环境变量里 `DASHSCOPE_API_KEY` 是否配置（应用管理不读 .env 文件）
2. API Key 是否正确、有额度
3. 查看应用日志中的错误信息

### 9.7 刷新页面 404

**排查**：确认 `app.js` 中 SPA 路由回退配置正确（非 /api 请求返回 index.html）。

### 9.8 DevBox 里 docker 命令不存在

**现象**：`bash: docker: command not found`

**原因**：DevBox 的 Node.js 模板没有预装 Docker。

**说明**：DevBox 上线**不需要 docker 命令**，Sealos 自动打包。只需配置好 entrypoint.sh 后点"上线"按钮即可。

### 9.9 找不到"上线"按钮

**排查位置**：
- DevBox 项目详情页右上角
- 项目名称旁边
- 「更多」菜单（三个点图标）
- 按钮可能叫「上线」「发布」「部署」「Release」

### 9.10 SSE 流式中断

**排查**：
1. 流式过程中实例不会缩容（有活跃连接）
2. 检查网络稳定性
3. 查看应用日志确认是否正常输出

### 9.11 冷启动慢

**现象**：首次访问需要等 10-30 秒。

**原因**：最小实例设为 0，首次访问需要启动容器。

**解决**：
- 接受冷启动（省钱）
- 或把最小实例设为 1（一直运行，多耗资源）

---

## 十、更新代码后的重新部署

### 10.1 方式一：DevBox 更新后重新上线（推荐）

1. 进入 DevBox 终端
2. 拉取最新代码：
   ```bash
   cd /home/devbox/project/ai-knowledge-demo
   git pull
   ```
3. 重新安装依赖（如有变更）：
   ```bash
   npm run install:all
   ```
4. 重新构建前端：
   ```bash
   npm run build --prefix client
   ```
5. 确认 entrypoint.sh 仍在 `/home/devbox/project/entrypoint.sh`
6. 在 DevBox 项目页面点 **「上线」**
7. 应用管理自动更新

### 10.2 方式二：销毁重建（最干净）

1. 销毁当前 DevBox 和应用管理服务
2. 创建新 DevBox
3. 重新执行 [第四章](#四devbox-云端开发部署)、[第五章](#五配置-entrypointsh上线关键)、[第六章](#六上线发布到应用管理) 全部步骤

> 适合大版本更新或环境出问题时使用。

### 10.3 更新后的检查

- [ ] 应用日志显示 `Server running at http://0.0.0.0:8080/`
- [ ] 公网地址能正常打开
- [ ] 新功能生效
- [ ] 环境变量未丢失

---

## 附录：关键文件清单

| 文件 | 位置 | 说明 | 是否入库 |
|------|------|------|---------|
| `entrypoint.sh` | `/home/devbox/project/entrypoint.sh` | **上线启动脚本（DevBox 中创建）** | ❌（DevBox 环境内） |
| `server/.env` | `/home/devbox/project/ai-knowledge-demo/server/.env` | DevBox 调试环境变量 | ❌（不入库） |
| `Dockerfile` | 项目根目录 | 容器构建配置（备用） | ✅ |
| `.dockerignore` | 项目根目录 | Docker 忽略规则 | ✅ |
| `server/src/app.js` | 项目内 | Express 入口（含静态托管） | ✅ |
| `package.json` | 项目根目录 | 根目录部署脚本 | ✅ |
| `client/dist/` | 项目内 | 前端构建产物（上线前必须生成） | ❌（构建生成） |

---

## 附录：部署完整命令速查

在 DevBox 终端依次执行：

```bash
# 1. 拉取代码
cd /home/devbox/project
git clone https://github.com/ziyuanxueying/ai-knowledge-demo.git

# 2. 安装依赖
cd ai-knowledge-demo
npm run install:all

# 3. 配置环境变量
cat > server/.env << 'EOF'
DASHSCOPE_API_KEY=你的API_KEY
QWEN_MODEL=qwen-turbo
TEMPERATURE=0.7
MAX_TOKENS=2048
PORT=3001
EOF

# 4. 构建前端
npm run build --prefix client

# 5. 创建 entrypoint.sh（注意：在 project 根目录，不是项目子目录）
cat > /home/devbox/project/entrypoint.sh << 'EOF'
#!/bin/bash
cd /home/devbox/project/ai-knowledge-demo/server
npm start
EOF
chmod +x /home/devbox/project/entrypoint.sh

# 6. 测试 entrypoint.sh
bash /home/devbox/project/entrypoint.sh
# 看到 Server running 后 Ctrl+C

# 7. 回 DevBox 项目页面点「上线」
# 8. 应用管理配置：容器端口 8080、最小实例 0、环境变量（不含 PORT）
```

---

## 参考链接

- [Sealos 官方文档](https://sealos.run/docs)
- [Sealos DevBox entrypoint.sh 指南](https://sealos.run/docs/guides/devbox/entrypoint-sh)
- [Sealos 应用管理指南](https://sealos.run/docs/guides/app-management)
- [Sealos 计价标准](https://sealos.run/docs/billing)
