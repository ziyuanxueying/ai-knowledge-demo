# 前端开发知识库 (AI Frontend Knowledge Base)

一个用于学习 AI 应用开发的全栈项目，前后端分离架构，接入通义千问大模型。从基础对话到 Agent 自主任务编排，再到知识库检索增强，覆盖 AI 应用的核心链路。

## 📚 项目结构

```
ai-knowledge-demo/
├── client/              # 前端：React + Vite
├── server/              # 后端：Node.js + Express + 通义千问
├── docs/                # 文档
│   ├── AI学习指南.md
│   ├── 前端开发指南.md
│   ├── 后端开发指南.md
│   └── Sealos部署手册.md
├── docker-compose.yml   # 本地 PostgreSQL + pgvector
└── README.md
```

## ✨ 功能特性

- 💬 **对话模式**：基于通义千问，支持多轮对话，SSE 流式输出
- 🤖 **Agent 模式**：AI 自主调用工具（查 npm 包、搜知识库、分析代码），多步推理，可视化思考过程
- 📚 **知识库管理**：CRUD 知识条目，保存时自动向量化，Agent 立即可语义检索
- 🔍 **RAG 检索增强**：基于 Embedding 向量 + 余弦相似度的语义检索，附关键词 vs 语义检索对比面板
- 🧪 **Prompt 实验室**：在线编辑 System Prompt（支持变量插值、多角色切换），保存即时生效无需重启
- 👁 **消息预览面板**：可视化最终发给模型的 messages 数组，含每条消息角色/字数/token 估算，调试黑盒变白盒
- 📡 **流式输出**：SSE 协议，逐字返回 AI 回复
- 📝 **Markdown 渲染**：支持代码高亮、表格、列表等富文本
- 💾 **对话历史保存**：PostgreSQL 持久化会话与消息
- ⚖️ **A/B 对比实验室**：同一问题两套参数并行流式输出，可选 LLM 裁判打分
- 🎛 **参数调节**：对话模式可调 temperature / max_tokens，单次请求生效
- 🎨 **简洁界面**：仿 ChatGPT 风格，侧边栏切换对话 / 知识库 / Prompt / A/B

## 🚀 快速开始

### 1. 准备通义千问 API Key

1. 访问 [阿里云百炼控制台](https://bailian.console.aliyun.com/)
2. 注册/登录账号，开通模型服务
3. 在「API-KEY 管理」中创建 API Key
4. 复制 API Key 备用

### 2. 启动 PostgreSQL（pgvector）

本地推荐用 Docker：

```bash
docker compose up -d
# 或：npm run db:up
# 默认 DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_knowledge
```

也可改用本机或云上已启用 pgvector 的 Postgres，把连接串写进 `server/.env`。

### 3. 启动后端

```bash
cd server
cp .env.example .env
# 编辑 .env，填入你的 DASHSCOPE_API_KEY（DATABASE_URL 默认同 docker compose）
npm install
npm run dev
# 后端运行在 http://localhost:3001
```

### 4. 启动前端

```bash
cd client
npm install
npm run dev
# 前端运行在 http://localhost:5173
```

打开浏览器访问 http://localhost:5173 即可开始对话。也可在项目根目录执行 `npm run install:all` 后 `npm run dev`，前后端一起起。

## 🏗 整体架构

```
浏览器 (Vite :5173)                    后端 Express (:3001)                 外部服务
┌─────────────────────┐               ┌──────────────────────────┐         ┌─────────────┐
│ 对话 / Agent        │  SSE          │ 限流 → 路由              │  HTTP   │ 通义千问    │
│ Prompt 实验室       │ ────────────> │  /api/chat  对话+摘要    │ ──────> │ Chat        │
│ 知识库管理          │  REST         │  /api/agent RAG+工具循环 │         │ Embeddings  │
│ A/B 对比 + 裁判     │ <──────────── │  /api/knowledge  CRUD    │         └─────────────┘
└─────────────────────┘               │  /api/compare  双路流    │         ┌─────────────┐
                                      │  /api/history  会话      │  SQL    │ PostgreSQL  │
                                      │  /api/prompts  人设文件  │ ──────> │ + pgvector  │
                                      └──────────────────────────┘         │ sessions    │
                                                                           │ messages    │
                                                                           │ kb_entries  │
                                                                           └─────────────┘
                                      prompts.json ← DATA_DIR（仅人设文件）
```

**四条主链路**：

| 模式 | 入口 | 实现要点 |
|------|------|----------|
| 对话 | `POST /api/chat` | 读会话 → 必要时摘要压缩 → 拼 messages → SSE 推预览再流式生成 → 写入 `messages` |
| Agent | `POST /api/agent` | 非问候先语义预检索注入 system → Function Calling 循环（最多 8 轮）→ 写入历史（含 toolSteps） |
| 知识库 / RAG | `/api/knowledge` | 条目存 Postgres；`embedding vector(1024)`；检索用 pgvector `<=>` 余弦距离 + HNSW |
| A/B | `POST /api/compare` | 不读写会话、不注入 RAG；两路配置并行 SSE；可选低温裁判 JSON 打分 |

模块与代码位置见 [后端开发指南](docs/后端开发指南.md)、界面结构见 [前端开发指南](docs/前端开发指南.md)。

## 📖 文档导航

| 文档 | 适合读者 | 内容 |
|------|----------|------|
| [AI学习指南](docs/AI学习指南.md) | AI 初学者 | LLM、Token、Prompt、流式、Function Calling、Agent、知识库等核心概念 |
| [前端开发指南](docs/前端开发指南.md) | 前端开发者 | React 组件架构、Hooks、SSE 接收、样式、无障碍规则 |
| [后端开发指南](docs/后端开发指南.md) | 后端开发者 | Express 架构、API、Postgres + pgvector、Agent、SSE |
| [Sealos部署手册](docs/Sealos部署手册.md) | 部署 | DevBox 上线、`DATABASE_URL`、持久卷（`prompts.json`） |

## 🧠 AI 学习要点

本项目适合 AI 初学者，涵盖了构建 AI 应用的核心知识点：

| 知识点 | 说明 | 代码位置 |
|--------|------|----------|
| 大模型 API 调用 | 如何调用通义千问 Chat Completions | `server/src/services/ai.service.js` |
| System Prompt | 通过系统提示词定义 AI 角色 | `server/src/prompts/system.js` |
| Prompt 在线编辑 | Prompt 存 JSON 动态加载 + 变量插值，改完即时生效 | `server/src/data/promptStore.js` |
| 消息预览与 Token 估算 | SSE 推送最终 messages，黑盒变白盒 | `client/src/components/MessagePreview.jsx` |
| 流式输出 (SSE) | Server-Sent Events 实现逐字输出 | `server/src/routes/chat.js` |
| Function Calling | 让 AI 调用工具函数 | `server/src/agent/tools.js` |
| Agent 编排 | AI 自主规划任务步骤的循环 | `server/src/agent/agent.service.js` |
| Embedding 向量化 | 把文本转 1024 维向量 | `server/src/services/embedding.service.js` |
| RAG 语义检索 | pgvector 余弦距离 + Top-K + 阈值过滤 | `server/src/data/kbStore.js` |
| 两种 RAG 策略 | Agentic RAG vs 预检索注入的取舍 | `server/src/agent/agent.service.js` |
| 多轮对话上下文 | 维护 messages 数组实现上下文 | `server/src/services/ai.service.js` |
| 长对话摘要压缩 | 历史超阈值自动压成摘要，避免 token 爆涨 | `server/src/routes/chat.js` |
| Token 与计费 | 理解 Token 概念和用量统计 | `server/src/routes/chat.js` |
| 温度参数 | temperature 控制回答随机性 | `server/src/config/index.js` |

## 🛠 技术栈

**后端**：Node.js 18+ / Express / openai SDK（兼容通义千问）/ `pg` / PostgreSQL + pgvector

**基础设施**：Docker Compose（`pgvector/pgvector:pg16`）或任意已启用 pgvector 的 Postgres

**前端**：React 18 / Vite / react-markdown / highlight.js

## 📖 学习资源

- [通义千问官方文档](https://help.aliyun.com/zh/model-studio/)
- [OpenAI 兼容接口说明](https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api)
- [Prompt 工程指南](https://platform.openai.com/docs/guides/prompt-engineering)
- [Function Calling 指南](https://platform.openai.com/docs/guides/function-calling)
