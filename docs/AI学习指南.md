# AI 学习指南：从前端开发知识库理解 AI 应用开发

本文档帮助你通过这个前端开发知识库项目，理解 AI 应用开发的核心概念，覆盖从基础对话到 Agent 自主任务编排、再到知识库检索增强的完整链路。

---

## 一、整体架构

```
┌─────────────┐         ┌──────────────┐         ┌──────────────┐
│   前端      │  HTTP   │   后端       │  HTTP   │   通义千问   │
│  React      │ ──────> │  Express     │ ──────> │   大模型     │
│  (Vite)     │  SSE    │  Node.js     │  流式   │  (Qwen)      │
└─────────────┘ <────── └──────────────┘ <────── └──────────────┘
     浏览器              本地 3001 端口         阿里云云端
                          │
                          │ 读写
                          ▼
                   ┌──────────────┐
                   │  本地文件     │
                   │  history.json│  会话历史
                   │ knowledge.json│ 知识库条目
                   └──────────────┘
```

**三种工作模式**：

1. **对话模式**（`/api/chat`）：用户问、AI 答，纯文本交互，SSE 流式输出。
2. **Agent 模式**（`/api/agent`）：AI 自主决定是否调用工具（查 npm 包、搜知识库、分析代码），多步推理直到给出最终答案，前端可视化"思考过程"。
3. **知识库管理**（`/api/knowledge`）：CRUD 知识条目，存到 `knowledge.json`，Agent 的搜索工具立即可用。

**数据流（以 Agent 为例）**：

1. 用户输入任务（如"对比 react 和 vue 的体积"）
2. 前端 POST `/api/agent`，建立 SSE 连接
3. 后端组装 messages + tools 定义，调用通义千问
4. 模型返回 `tool_calls`（要调 `get_npm_package_info`）→ 后端执行真实函数 → 结果作为 `tool` 消息回传
5. 模型再次推理，可能再调一次工具（查 vue）→ 循环直到模型给出最终答案
6. 全程通过 SSE 推送 `thinking` / `tool` / `content` 事件，前端实时渲染步骤和答案
7. 完整记录（含工具步骤）存入 `history.json`

---

## 二、AI 核心概念

### 1. 大语言模型 (LLM)

大语言模型是一种基于 Transformer 架构的 AI，通过海量文本训练，能理解和生成人类语言。
通义千问 (Qwen) 是阿里云推出的大模型系列，本项目的 `qwen-turbo` 是最快最便宜的版本。

**模型选择建议**：

| 模型 | 速度 | 价格 | 智力 | 适用场景 |
|------|------|------|------|----------|
| qwen-turbo | ⚡⚡⚡ | 💰 | ⭐⭐ | 学习、调试、简单问答 |
| qwen-plus | ⚡⚡ | 💰💰 | ⭐⭐⭐ | 日常问答、内容生成、Agent |
| qwen-max | ⚡ | 💰💰💰 | ⭐⭐⭐⭐⭐ | 复杂推理、专业任务 |

> 注：Agent 模式需要模型支持 Function Calling，qwen-turbo/plus/max 均支持。

### 2. Token：AI 的"计量单位"

Token 是模型处理文本的最小单位，**不是字符也不是词**：

- 1 个中文字 ≈ 1.5~2 个 token
- 1 个英文单词 ≈ 1~2 个 token
- 1 个空格/标点 ≈ 1 个 token

**为什么重要**：

- 计费按 token 计算（输入 + 输出分别计费）
- 模型有上下文长度限制（如 8K、32K、128K tokens）
- 在代码中能看到 `prompt_tokens`（输入）和 `completion_tokens`（输出）
- Agent 多轮调用工具会累积 token，需控制迭代次数（本项目限 8 轮）

### 3. Messages 数组：对话的"剧本"

调用 Chat Completions API 的核心是 messages 数组：

```javascript
const messages = [
  { role: 'system', content: '你是前端助手小码...' },     // 系统提示词
  { role: 'user', content: 'useEffect 怎么用？' },         // 用户历史
  { role: 'assistant', content: '用于处理副作用...' },     // AI 历史
  { role: 'user', content: '和 useLayoutEffect 有何区别？' }, // 当前问题
]
```

**四种角色**（Agent 模式会多一种）：

- `system`：设定 AI 人设，整段对话只出现一次（在最前面）
- `user`：用户的发言
- `assistant`：AI 之前的回复
- `tool`：**Agent 专属**，工具执行结果回传给模型

**多轮对话的原理**：每次请求都把历史消息一起发过去，AI 才能"记住"上下文。
所以历史越长，消耗 token 越多，费用越高。本项目代码见 [ai.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/services/ai.service.js)。

### 4. System Prompt：AI 的"人设"

System Prompt 是控制 AI 行为的关键，本项目在 [system.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/prompts/system.js) 中定义。

**写好 System Prompt 的技巧**：

1. 明确角色：`你是前端开发知识库助手小码`
2. 列出职责：`1. 解答前端技术问题 2. 提供最佳实践与代码示例`
3. 给出规范：`语气专业友好、优先给方案、代码用 Markdown 代码块`
4. 提供知识：`覆盖的语言、框架、工程化工具等知识范围`
5. 划定边界：`不处理后端/运维等非前端问题`

### 5. Temperature：创造性的"旋钮"

`temperature` 控制回答的随机性，范围 0~2：

- **0**：几乎确定性回答，每次问同样的问题答案几乎一样（适合数据提取、分类）
- **0.3~0.7**：平衡，适合技术问答（本项目默认 0.7）
- **1.0~2.0**：富有创造性，适合写诗、头脑风暴

### 6. 流式输出 (Streaming)

**为什么要流式**：AI 生成 200 字回答可能要 5 秒，如果等全部生成完再返回，用户体验很差。
流式输出让 AI 一边生成一边推送，用户立即看到"打字机"效果。

**技术原理 (SSE)**：

```
后端 → 前端
data: {"content":"你"}\n\n
data: {"content":"好"}\n\n
data: {"content":"！"}\n\n
data: [DONE]\n\n
```

代码位置：

- 后端流式（对话）：[chat.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/routes/chat.js)
- 后端流式（Agent）：[agent.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/agent/agent.service.js)
- 前端接收：[api.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/client/src/utils/api.js)

---

## 三、Function Calling 与 Agent

### 1. 什么是 Function Calling

普通 Chat 只能让 AI "说话"，无法"做事"。
Function Calling 让模型返回一个结构化的 `tool_calls`（工具名 + 参数 JSON），由后端执行真正的函数，再把结果作为 `tool` 角色消息回传给模型，模型基于结果继续推理——这就是 Agent 的核心循环。

**循环流程**：

```
用户任务 → 模型推理 → 返回 tool_calls？
                        ├─ 是 → 执行工具 → 结果作为 tool 消息回传 → 再次推理（循环）
                        └─ 否 → 返回最终答案 → 结束
```

### 2. 本项目的三个工具

定义在 [tools.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/agent/tools.js)：

| 工具 | 作用 | 数据来源 |
|------|------|----------|
| `search_frontend_kb(keyword)` | 搜索前端知识库 | 本地 `knowledge.json`（可通过界面增删改查） |
| `get_npm_package_info(packageName)` | 查 npm 包版本/依赖数/体积 | 真实调用 npm registry API |
| `analyze_code(code)` | 分析代码特征（行数/JSX/异步/Hooks） | 本地分析 |

### 3. 工具定义（JSON Schema）

模型不直接执行函数，而是返回"我想调哪个工具 + 参数"。后端用 JSON Schema 告诉模型有哪些工具可用：

```javascript
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_npm_package_info',
      description: '查询 npm 包的最新版本、依赖数、体积等信息',
      parameters: {
        type: 'object',
        properties: {
          packageName: { type: 'string', description: 'npm 包名，如 react' }
        },
        required: ['packageName']
      }
    }
  }
];
```

模型据此返回可解析的参数 JSON，后端执行对应函数。

### 4. Agent 编排核心

[agent.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/agent/agent.service.js) 实现 Agent 循环（最多 8 轮防死循环）：

1. 把 system + 历史 + 任务 + 工具定义发给模型
2. 模型返回 `tool_calls` → 执行工具 → 结果作为 `role: 'tool'` 消息回传 → 继续循环
3. 模型返回 `stop`（无 tool_calls）→ 最终答案按字符分片流式推送

### 5. SSE 事件类型

Agent 路由 [agent.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/routes/agent.js) 推送以下事件，前端据此渲染"思考过程"：

| 事件 | 说明 |
|------|------|
| `session` | 会话 ID |
| `thinking` | Agent 计划调用哪些工具 |
| `tool` | 工具执行结果 |
| `content` | 最终答案的流式分片 |
| `usage` | token 用量 |
| `aborted` | 用户中断 |
| `done` | 完成 |

### 6. 中断处理的关键细节

初版用 `req.on('close')` 触发中断，但它在请求体读完后立即触发，导致模型调用一发出就被中止。
正确做法是监听 `res.on('close')` + `finished` 守卫，仅在客户端真实断开（如点"停止"）时才中断。

---

## 四、RAG：检索增强生成

### 1. 什么是 RAG

RAG（Retrieval-Augmented Generation，检索增强生成）= **先检索相关知识，再让模型据此生成答案**。

为什么不直接让模型回答？因为模型有两类问题：
- **知识截止**：训练数据有时间限制，不知道最新信息
- **私有知识**：模型不知道你公司文档、项目专属配置

RAG 的做法：把你的知识存成库，提问时检索最相关的几条，拼进 prompt，模型就有了"参考资料"。

```
用户提问 → ① 检索知识库（找最相关的 Top-K 条）→ ② 把检索结果拼进 prompt → ③ 模型据此生成答案
```

### 2. Embedding：把文本变成向量

**Embedding（向量化/embedding）** 是把文本映射成一组高维浮点数（本项目用 1024 维）。语义相近的文本，向量在空间中也相近。

```javascript
"闭包"               → [0.12, -0.34, 0.56, ..., 0.07]  // 1024 个数
"函数怎么记住外部变量" → [0.11, -0.32, 0.55, ..., 0.08]  // 与上面很接近！
"虚拟 DOM"           → [-0.45, 0.21, ...]              // 与上面距离远
```

本项目用通义千问 `text-embedding-v3` 模型，通过同一个 OpenAI 兼容端点调用（只是端点从 `/chat/completions` 换成 `/embeddings`）。代码见 [embedding.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/services/embedding.service.js)。

### 3. 余弦相似度：衡量"有多像"

两个向量的相似度用**余弦相似度**衡量，范围 [-1, 1]，越接近 1 越相似：

```
cos(a, b) = (a · b) / (|a| × |b|)
        ↑            ↑       ↑
    向量点积      向量长度乘积
```

本项目在 [embedding.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/services/embedding.service.js) 的 `cosineSimilarity` 中用纯 JS 实现，条目量小（几十~几百条）时性能完全够用，无需向量数据库。

### 4. 语义检索流程

[kbStore.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/data/kbStore.js) 的 `searchEntriesSemantic(query, topK, threshold)`：

1. **懒补齐**：先调用 `ensureEmbeddings()`，给没有向量的条目生成向量（首次检索或新建条目时触发）
2. **查询向量化**：把用户查询用同一个 embedding 模型转向量
3. **算相似度**：与每条条目的向量算余弦相似度
4. **过滤 + 排序**：取相似度 ≥ `threshold`（默认 0.3）的，按相似度降序
5. **返回 Top-K**：默认返回最多 3 条

**关键参数**：
- `topK`：返回条数上限。太小可能漏召回，太大拼进 prompt 浪费 token
- `threshold`：相似度下限。太低会塞入无关结果干扰模型，太高可能漏掉相关结果

### 5. 关键词检索 vs 语义检索（本项目两种都支持）

| 对比项 | 关键词检索 | 语义检索 |
|--------|-----------|----------|
| 原理 | 字面子串匹配 | 向量余弦相似度 |
| "函数记住外部变量" → "闭包" | ❌ 召回不到（字面不重叠） | ✅ 召回（语义相近） |
| 速度 | 极快（纯字符串） | 略慢（需向量化查询） |
| 依赖 | 零 | 需 embedding API |
| 准确性 | 字面匹配，懂同义词时差 | 理解语义，召回更全 |

前端知识库管理界面有**检索对比面板**，输入同一查询并排展示两种结果，直观看差异。代码见 [KnowledgeBase.jsx](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/client/src/components/KnowledgeBase.jsx)。

### 6. 两种 RAG 实现策略（本项目踩坑总结）

**策略 A：Agentic RAG（让模型自己调检索工具）**
- 模型通过 Function Calling 自主决定是否调用 `search_frontend_kb`
- 优点：灵活，无关问题（如问候）不浪费检索
- 缺点：**依赖模型的工具调用可靠性**。本项目用 qwen-turbo 测试发现它对概念类问题常"自以为知道"不调工具，甚至**编造"据知识库"的措词**（答成 BERT/768 维，实际知识库是 text-embedding-v3/1024 维）
- 还尝试过用 `tool_choice` 强制首轮调工具，但 DashScope 对强制工具调用支持不佳，返回异常

**策略 B：Retrieval-then-Generate（后端先检索再生成）** ← 本项目最终采用
- 后端在调模型**之前**先做语义检索，把结果**注入 system prompt**
- 模型拿到的是"已检索好的参考资料"，无需自己决定检索
- 优点：**RAG 必然生效**，不依赖模型的"判断"，彻底消除幻觉
- 缺点：对所有非问候查询都检索一次（无关问题也检索，略有浪费）

本项目最终采用 **策略 B 为主 + 策略 A 为辅**：预检索注入保证 RAG 必然生效，同时保留 `search_frontend_kb` 工具，模型在预检索未命中时可再主动调一次。代码见 [agent.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/agent/agent.service.js) 的 `runAgent`。

> 这个对比本身就是 RAG 的重要学习点：**不是所有 RAG 都要让模型决定检索**。小模型用"总是先检索"更可靠，大模型（qwen-plus/max）才适合 Agentic RAG。

### 7. 数据结构（含向量）

每条知识库条目现在多一个 `embedding` 字段（向量，对前端不可见，剥离后返回）：

```javascript
{
  id: 'kb_1787575769002_8ycg6c',
  title: '闭包',
  keywords: ['闭包', 'closure'],
  category: '原理',
  content: '闭包是函数与其词法环境的组合...',
  embedding: [0.12, -0.34, 0.56, ...],  // 1024 维向量，create/update 时自动生成
  createdAt: '2026-08-24T12:49:29.002Z',
  updatedAt: '2026-08-24T12:49:29.002Z'
}
```

### 8. 闭环价值

通过界面新建/编辑的知识条目，保存时**自动向量化**，Agent **立即可语义检索**——无需重启、无需手动重新生成（也提供"重新生成全部向量"按钮用于换模型时）。这正是知识库 + RAG 的关键价值。

代码位置：

- 向量化服务：[embedding.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/services/embedding.service.js)
- 存储层（向量存储 + 语义检索）：[kbStore.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/data/kbStore.js)
- REST API（含检索对比/向量化统计）：[routes/knowledge.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/routes/knowledge.js)
- Agent 预检索注入：[agent.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/agent/agent.service.js) 的 `runAgent`
- Agent 检索工具：[tools.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/agent/tools.js) 的 `searchFrontendKb`
- 前端管理界面（含检索对比面板）：[KnowledgeBase.jsx](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/client/src/components/KnowledgeBase.jsx)

---

## 五、长对话上下文管理

### 1. 为什么需要管理上下文

模型本身无状态，每次请求都把历史消息重新发给模型，它才能"记得"上下文（见上文「二.3 Messages 数组」）。但随着对话变长，messages 线性膨胀，带来三个问题：

| 问题 | 说明 |
|------|------|
| Token 消耗 O(n²) 增长 | 第 N 轮请求要带前 N-1 轮历史，累计消耗是等差数列求和 |
| 超上下文上限 | qwen-turbo 上下文 8K，长对话会被截断或报错 |
| 费用飙升 | 输入 token 也计费，历史越久越贵 |

### 2. 四种主流策略

| 策略 | 思路 | 优点 | 缺点 |
|------|------|------|------|
| 1. 滑动窗口 | 只带最近 N 轮原文 | 实现极简 | 早期上下文完全丢失 |
| 2. 摘要压缩 | 早期历史压成一段摘要 | 兼顾上下文与 token | 多次摘要会失真；额外 LLM 调用 |
| 3. 分层记忆 | 摘要 + 结构化事实抽取 | 可做个性化 | 实现复杂 |
| 4. Memory RAG | 把历史向量化，按相关性检索 | 长对话不丢上下文 | 工程量大；需要向量库 |

本项目**已实现策略 2**，代码见 [chat.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/routes/chat.js)。

### 3. 本项目实现：摘要压缩策略

**数据结构**（[store.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/data/store.js) 的 session 对象）：

```javascript
session = {
  id, title,
  messages: [...],     // 原始消息全量保留（用于审计/重放）
  summary: '',          // 早期对话的压缩摘要
  summaryUpTo: 0,       // 摘要覆盖到第几条 user/assistant 消息
  ...
}
```

**触发时机**（[chat.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/routes/chat.js) 的 `/api/chat`）：

1. 取全量 user/assistant 历史 `allHistory`
2. 分割：`earlier = allHistory.slice(0, -6)` + `recentHistory = allHistory.slice(-6)`
3. 当 `earlier.length - session.summaryUpTo >= 2` 时触发摘要
4. 调用 `summarizeHistory(earlier, session.summary)` 生成新摘要（合并旧摘要）
5. 写回 store：`updateSessionSummary(sessionId, newSummary, earlier.length)`
6. 构造最终 messages：`system(人设) + system(摘要) + 最近6条原文 + 当前问题`

**为什么阈值用 2 而不是 1**：避免每轮都触发摘要（成本太高）。每新增 2 条早期历史才合并一次，是个折中。

### 4. 摘要函数设计要点

[ai.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/services/ai.service.js) 的 `summarizeHistory`：

- **复用非流式 `chat()`**：用户看不到摘要过程，不需要打字机效果
- **合并式摘要**：把旧 summary + 新历史一起喂给模型，避免多次摘要导致信息逐次丢失
- **限定字数**：200 字以内，避免摘要自身膨胀变成新的长文本
- **纯文本输出**：禁止列表、代码块，避免污染 messages 数组结构

### 5. 兜底与边界

- 历史不足 6 条：`earlier` 为空数组，不触发摘要，等同滑动窗口
- 摘要调用失败：`catch` 兜底，沿用旧 summary 或退化为滑动窗口，不阻塞主流程
- Agent 模式：暂未套用摘要，仍带全量历史（涉及 tool 角色消息，需要单独设计）

### 6. 进阶：升级到 Memory RAG

策略 2 解决了"早期上下文不丢失"，但仍有局限：摘要会失真、无法精确回溯某条历史。下一步升级到策略 4（Memory RAG）：

1. 把每条历史消息向量化（复用 [embedding.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/services/embedding.service.js)）
2. 存到一个"会话记忆库"（复用 [kbStore.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/data/kbStore.js) 的语义检索逻辑）
3. 每次请求前，按当前问题做余弦相似度检索，召回最相关的 3~5 条历史
4. 把召回的历史拼进 messages

ChatGPT 的"记忆"功能就是这个思路。

---

## 六、Prompt 工程与可视化调试

### 1. 为什么 Prompt 需要"工程化"

Prompt 是控制模型行为的核心手段（见第二章 System Prompt），但传统开发方式有两个痛点：

| 痛点 | 传统做法 | 问题 |
|------|----------|------|
| 改 Prompt | 改代码里的字符串常量 → 重启服务 → 发消息测试 | 一次迭代要几分钟，无法快速对比 |
| 看 Prompt 效果 | 模型只返回最终回答 | 看不到"实际发给模型的 messages 数组"，黑盒调试 |

本项目围绕 Prompt 调试实现了五个方案，从「改一下立刻看效果」逐步进化到「客观量化对比」：

- **方案 A：Prompt 在线编辑器**（左侧栏「🧪 Prompt 实验室」）—— Prompt 不再硬编码
- **方案 B：消息预览面板**（聊天区横条）—— 最终 messages 白盒可见
- **方案 C：参数调节面板**（聊天区横条）—— temperature / max_tokens 滑块即时生效
- **方案 D：A/B 对比**（左侧栏「🔬 A/B 实验室」）—— 同一问题两套参数并排赛跑
- **方案 E：LLM 自动评分**（A/B 实验室内）—— 裁判模型按 4 维度自动打分

### 2. 方案 A：Prompt 在线编辑器

**数据从代码搬到数据文件**：System Prompt 从 [system.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/prompts/system.js) 硬编码，改为存在 [prompts.json](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/data/prompts.json)，按场景（scenario）组织：

```json
{ "id": "frontend_dev", "name": "前端开发助手", "content": "你是一个名叫\"小码\"的..." }
```

**运行时链路**：

1. [promptStore.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/data/promptStore.js) 负责读写 prompts.json + **变量插值**
2. `getSystemPrompt(scenario)` 优先读 prompts.json，读不到才回退硬编码（兜底）
3. REST API：`GET /api/prompts`（列表）、`GET /api/prompts/:id`（单个）、`PUT /api/prompts/:id`（保存）
4. 前端 [PromptLab.jsx](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/client/src/components/PromptLab.jsx) 提供编辑界面，保存后**下一次对话立即生效**，无需重启

**模板变量插值**：prompt 里可以写 `{{datetime}}`、`{{date}}`、`{{weekday}}`，渲染时替换为实际值。原理就是字符串替换：

```javascript
content.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`)
```

**多角色联动**：聊天页顶部的「角色」下拉框从 `GET /api/prompts` 加载场景列表——在实验室新建一个场景，下拉框自动出现新角色。发对话时前端把 `scenario` 传给 `/api/chat`，后端按它选 prompt。

### 3. 方案 B：消息预览面板

模型每次请求真正看到的 messages 数组，是后端**运行时拼装**出来的：

```
system（人设 prompt）
+ system（长对话摘要，如有）          ← 第五章的摘要策略
+ 最近 6 条历史原文（user/assistant）
+ RAG 检索到的知识（Agent 模式）       ← 第四章的 RAG
+ 当前用户问题
```

这些拼装逻辑分布在多个模块里，不抓出来看就是黑盒。方案 B 在后端**调用模型之前**，把最终 messages 通过 SSE 推给前端：

```javascript
// chat.js：session 事件之后、streamChat 之前
res.write(`data: ${JSON.stringify({
  type: 'messages',
  messages: previewMessages,   // 每条含 role / content / chars / tokens
  totalTokens,                 // 总 token 估算
  summary: session.summary,    // 是否注入了摘要
})}\n\n`)
```

前端 [MessagePreview.jsx](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/client/src/components/MessagePreview.jsx) 渲染成可折叠面板，展开后能看到：

- 每条消息的**角色 badge**（系统=蓝 / 用户=绿 / 助手=紫 / 摘要=黄）
- 每条消息的**字数和估算 token**
- 摘要触发时的黄色提示条："已注入早期对话摘要（XX 字）"
- 总 token 估算

### 4. 方案 C：参数调节面板

System Prompt 之外，影响模型输出的另一组关键变量是**采样参数**：temperature（随机性）和 max_tokens（输出长度上限）。它们原本写死在 [.env](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/.env) / [config/index.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/config/index.js) 里，改一次要重启服务，也无法针对单条消息临时调整。

方案 C 在聊天区加了一条与消息预览同款的折叠横条 [ParamPanel.jsx](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/client/src/components/ParamPanel.jsx)，提供两个滑块：

- **temperature**（0~2，步长 0.1）：滑块下方实时显示语义提示——0.3 以下「稳定精确 · 适合事实/代码」，1.3 以上「高度随机 · 适合创意写作（可能不稳定）」
- **max_tokens**（256~4096，步长 128）：限制单次回复长度，防止过长或成本失控

参数随请求体传给 `/api/chat`，后端 [ai.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/services/ai.service.js) 的 `streamChat` 接收 `options.temperature` / `options.maxTokens`，**按请求覆盖** config 默认值：

```javascript
export async function* streamChat(messages, signal, options = {}) {
  const temperature = typeof options.temperature === 'number'
    ? options.temperature
    : config.dashscope.temperature
  const maxTokens = typeof options.maxTokens === 'number'
    ? options.maxTokens
    : config.dashscope.maxTokens
  // ...
}
```

关键设计：

1. **即时生效**——改完滑块不用保存，下一条消息就用新参数（区别于改 .env 再重启）
2. **偏好持久化**——参数存 localStorage，刷新页面不丢
3. **校验在后端**——前端可任意调，但 [compare.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/routes/compare.js) / chat.js 都会用 `normalizeVariant` 把非法值钳制回合法范围（temperature 0~2、max_tokens 100~8192）
4. **不污染会话**——参数是请求级覆盖，不写进会话历史，切换话题自然回到默认

方案 C 把「调参」从改配置文件变成了拖滑块，是方案 D（A/B 对比）的单变量版预演。

### 5. 方案 D：A/B 对比

方案 C 只能一次调一组参数、肉眼对比「这次 vs 上次」，无法排除问题本身差异。方案 D 把对比变成**同一问题的并排赛跑**：两套配置并行请求，左右两栏同时逐字渲染，直观看出参数对风格、速度、长度的影响。

入口在左侧栏「🔬 A/B 实验室」（[CompareLab.jsx](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/client/src/components/CompareLab.jsx)）。两路默认配置是「低温精确 vs 高温发散」：

```
方案 A · 低温（稳定精确）  temperature=0.2  maxTokens=1024
方案 B · 高温（发散创意）  temperature=1.5  maxTokens=1024
```

两路的 temperature / max_tokens / 角色场景都可自由修改。

**单连接双流的工程难点**：两个流式请求不能开两条 SSE 连接（前端要协调两个 reader），本项目用**一条 SSE 连接、事件带 variant 字段区分**的方案：

```javascript
// compare.js：同一 res 上交错写两路事件
send({ type: 'content', variant: 0, content: chunkA })
send({ type: 'content', variant: 1, content: chunkB })
```

后端用 `Promise.all([runVariant(0), runVariant(1)])` 并发两个 `streamChat`，它们各自 `for await` 推 chunk；由于 JS 单线程事件循环，`res.write` 天然交错到同一条 TCP 连接上。前端按 `parsed.variant` 把 chunk 分发到左右两栏。

**为保证对比公平**，A/B 对比刻意「干净单轮」：

- 不读写会话历史（不带上下文干扰）
- 不触发摘要、不注入 RAG（聚焦对比变量本身，不混入检索增强）
- 两路默认用同一个 system prompt（除非你单独改了某一路的场景）

中断处理遵循项目约定（见第五章）：`res.on('close')` + `finished` 守卫，客户端断开时 `controller.abort()` 同时中止两路流。

每路回答下方显示**用时、字符数、token 用量**——低温路往往更短更稳，高温路更长更发散，肉眼可量化的差异正是 A/B 对比的价值。

### 6. 方案 E：LLM 自动质量评分

方案 D 解决了「并排看」，但谁更好仍是主观判断。方案 E 让一个**裁判模型**充当评审，按 4 个维度给两路回答打分，把「主观对比」量化成「客观分数 + 理由」。

在 A/B 实验室勾选「⚖ 启用 AI 裁判评分」即可。两路流式回答完成后，后端再发起一次**非流式**裁判调用（[judge.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/services/judge.service.js)），SSE 事件流：

```
variant_done(0) → variant_done(1) → judge_start → judge_done
```

**评分维度（rubric）**——评分标准必须具体可操作，不能只说「回答好不好」：

| 维度 | 含义 |
|------|------|
| 准确性 accuracy | 技术内容是否正确，有无事实性错误或误导 |
| 完整性 completeness | 是否完整回应了问题，有无关键遗漏 |
| 清晰度 clarity | 表达是否条理清晰、结构分明、易于理解 |
| 实用性 usefulness | 对前端开发者是否有实际帮助（代码示例、可操作建议） |

每维 1-10 分，总分 40。前端用分数条 + 胜者 banner 呈现，领先的一路进度条高亮。

**裁判 prompt 的工程要点**（[judge.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/services/judge.service.js) 的 `buildJudgePrompt`）：

1. **XML 标签分段**——`<role>` / `<task>` / `<dimensions>` / `<input>` / `<output_format>` 把指令、维度、待评内容、输出格式物理隔离，降低模型把待评内容当成指令执行的「指令注入」风险，也让格式更稳定
2. **低温稳定**——裁判用 `temperature: 0.1`，保证同一组回答多次评分基本一致（可复现）
3. **强制结构化 JSON**——`<output_format>` 里给出确切 JSON 模板，并声明「只输出 JSON、不要 markdown 包裹」
4. **声明抗偏**——prompt 里明确写「不受回答出现顺序影响」，缓解模型的**位置偏好**（已知 LLM 倾向选先出现的 A；工业界更稳的做法是交换 A/B 顺序跑两次取平均，即「镜像消偏」）
5. **JSON 解析三级兜底**——模型未必听话，可能用 ```json 包裹或夹带说明文字，`extractJson` 依次尝试：直接 parse → 剥代码块 → 截取第一个 `{` 到最后一个 `}`
6. **字段归一化**——`normalizeVerdict` 把分数钳制到 0-10、缺失字段补默认值；模型若没给合法 `winner`，按总分裁定

**裁判是非阻塞的**——裁判失败不阻塞主流程，前端仍能看到两路回答，只是评分报告区显示「裁判评分失败」提示。

方案 E 是 Prompt 工程闭环的最后一块拼图：方案 A/B/C 让你「改得快、看得见、调得动」，方案 D 让你「并排比」，方案 E 让你「客观量」——从此改 prompt 不再凭感觉，而是有数据支撑。

### 7. Token 估算

请求前如何知道会消耗多少 token？精确算法要用 tokenizer（如 tiktoken），依赖较重。本项目用经验公式粗估（[ai.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/services/ai.service.js) 的 `estimateTokens`）：

- 中文字 ≈ 1.5 token
- 英文单词 ≈ 1.3 token
- 标点/数字/空格 ≈ 0.5 token

**实测误差**（测试 prompt 验证）：估算 155 tokens vs 模型实际 `prompt_tokens` 132，偏差 +17%。估算**偏高**是有意为之（保守估计，不会低估导致超限），官方误差范围 ±20%。

### 8. 完整调试工作流

```text
① 在 Prompt 实验室改人设/规则 → 保存（立即生效，无需重启）        ← 方案 A
② 回到聊天，发一个测试问题
③ 展开「发给模型的消息预览」横条                                  ← 方案 B
   → 确认 system 卡片里就是你刚写的 prompt
   → 确认变量 {{datetime}} 已被替换成真实时间
   → 看总 token 估算是否合理
④ 看 AI 回答是否符合新规则
⑤ 不符合就回实验室改，重复 ①-④
```

方案 C/D/E 引入了**参数对比 + 量化评分**的进阶工作流：

```text
⑥ 展开「模型参数」横条拖滑块 → 下一条消息立即用新参数             ← 方案 C
⑦ 想对比两套参数：进「🔬 A/B 实验室」，同一问题两路并排赛跑       ← 方案 D
⑧ 勾选「⚖ 启用 AI 裁判」→ 两路完成后自动按 4 维度打分            ← 方案 E
⑨ 看胜者 banner + 分数条，确认哪路更好、好在哪里
⑩ 改 prompt / 参数后重跑，对比分数变化，形成「改 → 评」回归闭环
```

**可视化工具的关系**：

| 功能 | 章节 | 在预览面板里能观察到 |
|------|------|---------------------|
| System Prompt 在线编辑 | 本章方案 A | 第 1 条「系统」卡片内容随编辑变化 |
| 长对话摘要 | 第五章 | 黄色摘要提示条 + 多一条「系统」摘要消息 |
| RAG 知识注入 | 第四章 | Agent 模式下 system 中出现检索到的知识 |
| 参数即时生效 | 本章方案 C | 横条显示当前 temperature / max_tokens |
| 参数影响量化 | 本章方案 D/E | 两路并排 + 裁判分数条 |

### 9. 小结：Prompt 工程的进阶方向

本项目已实现从编辑到量化评分的完整闭环：

| 方案 | 能力 | 本章 |
|------|------|------|
| A · Prompt 在线编辑器 | 改 prompt 不重启 | 第 2 节 |
| B · 消息预览面板 | 最终 messages 白盒可见 | 第 3 节 |
| C · 参数调节面板 | temperature / max_tokens 滑块即时生效 | 第 4 节 |
| D · A/B 对比 | 同一问题两套参数并排赛跑 | 第 5 节 |
| E · LLM 自动评分 | 裁判模型按 4 维度打分 | 第 6 节 |

工业界 Prompt 平台还可以继续延伸：

- **评估集**：方案 E 是单题打分，工业界会准备一组（几十到几百）标准问题，每次改 prompt 后**批量跑**，用 LLM-as-a-judge 自动打分并算通过率，形成「改 prompt → 跑评估集 → 看分数变化」的回归闭环
- **镜像消偏**：交换 A/B 顺序跑两次裁判取平均，消除模型的位置偏好
- **多裁判交叉**：用多个裁判模型交叉评分，或先用 Rerank 模型对回答排序再评分
- **版本管理**：prompt 存 git 或带版本号，可回滚、可 diff

---

## 七、动手实验建议

### 实验 1：修改 AI 人设（在线编辑）

打开左侧栏「🧪 Prompt 实验室」，把 `frontend_dev` 场景的提示词改成"你是一个幽默的程序员段子手，每条回复必须以 😄 开头"，点保存。
**不用重启**，回到聊天发"你好"，观察 AI 行为变化；再展开消息预览面板，确认 system 卡片里就是你写的新 prompt。

### 实验 2：调整温度

修改 `.env` 中 `TEMPERATURE=0.1` 或 `TEMPERATURE=1.5`，问同一个问题看回答差异。

### 实验 3：切换模型

修改 `.env` 中 `QWEN_MODEL=qwen-max`，对比回答质量。

### 实验 4：观察 Token 消耗

聊天时注意消息下方的 token 用量，思考：

- 为什么长对话 token 会越来越多？
- Agent 多轮调用工具时 token 如何累积？
- 如何优化（提示：只保留最近几轮历史、控制 Agent 迭代次数）

### 实验 5：观察消息预览与摘要注入

发一条消息后，点击聊天区顶部的「发给模型的消息预览」横条展开：

- **新对话**：能看到 2 条消息——「系统」（人设 prompt 全文 + token 估算）+「用户」（你的问题）
- **连续聊 5 轮以上**：第 6 轮起展开预览，会看到**黄色摘要提示条**和**两条「系统」消息**（人设 + 早期对话摘要），最早的历史原文不再发送，但 AI 仍记得早期内容
- 对比横条上的「估算 tokens」与回答下方实际 usage 里的 `prompt_tokens`，验证 token 估算误差

### 实验 6：扩展知识库（验证 RAG 闭环）

在左侧菜单点「📚 知识库」进入管理界面，新增一条知识（如标题"Solid.js"，内容写几句你自己的理解）。

保存时后端会**自动向量化**（顶部状态条会从"待向量化"变为"已向量化 X/Y 条"）。然后切到 Agent 模式问相关问题，看 Agent 是否能基于你刚添加的内容回答。

注意观察 AI 回复上方的「Agent 执行步骤」——第 1 步就是 `search_frontend_kb` 检索，这就是预检索注入的 RAG 流程。

### 实验 7：观察 Agent 思考过程

切到 Agent 模式，输入"查一下 react 和 vue 两个 npm 包的版本和依赖数，对比哪个更轻量"，

观察 AI 回复上方的「🤖 Agent 执行步骤」面板：

- 第 1 步：调用 `get_npm_package_info({packageName:"react"})` → 真实返回版本/依赖数
- 第 2 步：调用 `get_npm_package_info({packageName:"vue"})` → 真实返回
- 最终：模型综合两次工具结果给出对比答案

### 实验 8：自定义工具

在 [tools.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/agent/tools.js) 中添加新工具（如查 GitHub star 数），

需要三步：

1. 写工具函数 `async function getGithubStars(repoName) { ... }`
2. 在 `TOOLS` 对象中注册：`get_github_stars: getGithubStars`
3. 在 `tools` 数组中加 JSON Schema 定义

重启后端，Agent 即可自主决定是否调用新工具。

### 实验 9：观察关键词 vs 语义检索的差异

在知识库管理界面的「检索对比面板」输入「函数怎么记住外部变量」点搜索对比，你会看到：

- **左列（关键词检索）**：0 条（"函数""记住""外部""变量"字面不出现在任何条目里）
- **右列（语义检索）**：召回「闭包」，带相似度分（约 0.5x），相似度进度条直观显示

这正是 RAG 的核心价值：**语义相近但字面不重叠也能召回**。试试其他示例词（打包去无用代码 → Tree Shaking、框架高效更新 DOM → 虚拟 DOM）。

### 实验 10：体会两种 RAG 策略的差异

在 Agent 模式问"小码知识库用的是什么 embedding 模型"——这是模型不可能从训练数据知道的项目专属信息。

- 用**策略 B（当前实现）**：Agent 第一步预检索，找到"小码知识库的检索配置"条目，正确回答 text-embedding-v3/1024 维
- 想体会策略 A 的不可靠：可临时注释掉 [agent.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/agent/agent.service.js) 中预检索那段代码（只保留 `tool_choice: 'auto'`），重启后问同样问题，观察 qwen-turbo 是否会编造答案（可能答成 BERT/768 维的幻觉）

### 实验 11：参数面板即时生效（方案 C）

展开聊天区「模型参数」横条，把 temperature 拖到 0.2，问"写一段冒泡排序的 JavaScript 代码"——回答通常简洁规整。

再把 temperature 拖到 1.5，问同一问题——回答可能更啰嗦、加注释、甚至发散到排序算法对比。

观察两次回答下方的 token 用量差异（低温通常更少）。参数只对下一条消息生效，刷新页面后回到默认（除非 localStorage 存了偏好）。

> 对比实验 2：实验 2 改 `.env` 改的是**全局默认值**（要重启）；本实验改的是**本次会话临时参数**（即时生效、不持久化到配置）。两者一个管默认、一个管单次。

### 实验 12：A/B 对比 + AI 裁判（方案 D + E）

打开左侧栏「🔬 A/B 实验室」，保持默认两路配置（A=0.2 低温 / B=1.5 高温），输入"讲讲 React 的 Fiber 架构"，勾选「⚖ 启用 AI 裁判评分」，点发送。

观察：

- 两栏同时开始逐字输出（同一 SSE 连接、事件按 variant 区分）
- 两路完成后，裁判开始"阅读两路回答并打分"
- 评分报告区出现：胜者 banner（总分 X vs Y）+ 4 个维度的分数条（领先的一路高亮）+ 两路简评 + 裁判总结

思考：

- 低温路在「准确性」「清晰度」上是否常领先？高温路在「完整性」上是否反超？
- 同样两路回答，多跑几次裁判分数是否稳定？（低温裁判应基本一致）
- 想验证位置偏好：把两路配置的 A/B 顺序对调（A=1.5 / B=0.2），看裁判是否仍倾向"先出现的那路"

---

## 八、进阶方向

学完本项目后，可以探索：

1. **RAG 进阶**：接入向量数据库（如 Chroma、Milvus、pgvector）支持海量条目；加 Rerank 二次排序提升精度；用 RAG 评估集量化检索质量
2. **上下文管理**：本项目第五章已实现滑窗 + 摘要压缩的基础版；进阶是接 tokenizer（如 tiktoken）实时精确统计 token，动态决定何时触发摘要
3. **多模态**：让 AI 看图片、听语音（通义千问 VL 模型）
4. **ReAct 模式**：让 Agent 在每一步都"思考-行动-观察"并记录推理链
5. **多 Agent 协作**：多个 Agent 分工（如一个负责搜索、一个负责总结）
6. **可观测性**：记录每次请求的完整 trace（输入/工具调用/耗时/token/输出）；方案 E 已实现单题 LLM-as-a-judge 评分，进阶是搭评估集批量跑做回归测试
7. **微调**：用业务数据训练专属模型

---

## 九、常见问题

**Q: API 调用报 401 错误？**
A: API Key 错误或未配置，检查 `.env` 文件中的 `DASHSCOPE_API_KEY`。

**Q: 流式输出不工作，一次性返回？**
A: 检查后端是否设置了正确的 SSE 响应头，浏览器 Network 面板查看响应类型。

**Q: 历史对话太长导致报错？**
A: 达到了模型上下文上限，可以在 [chat.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/routes/chat.js) 中限制只传最近 N 条历史。

**Q: Agent 模式一直转圈不返回？**
A: 可能是模型陷入工具调用死循环。本项目已限制最多 8 轮迭代（[agent.service.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/agent/agent.service.js) 的 `MAX_ITERATIONS`），可调小此值。

**Q: Agent 调用工具时报错？**
A: 检查工具函数是否异步、是否正确处理异常。网络工具（如查 npm）可能因网络问题失败，工具函数应 try/catch 并返回错误信息给模型。

**Q: 想换成其他大模型？**
A: 修改 [config/index.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/config/index.js) 中的 `baseURL` 和 `apiKey` 即可，OpenAI 兼容接口通用。

**Q: 知识库新增条目后 Agent 搜不到？**
A: 本项目用**语义检索**（向量余弦相似度），不再依赖字面匹配。搜不到通常是：
1. 未配置 `DASHSCOPE_API_KEY` → 向量化失败，退化为关键词检索（顶部状态条会显示"待向量化"）
2. 相似度低于阈值 0.3 → 调低 [kbStore.js](file:///Users/anyi/Desktop/AIDemos/ai-knowledge-demo/server/src/data/kbStore.js) 的 `threshold`
3. 条目内容与查询语义确实无关 → 补充内容描述

**Q: Agent 回答说"据知识库"但内容是编的（幻觉）？**
A: 这是 Agentic RAG 的不可靠性。本项目已用"预检索注入"（策略 B）规避：后端先检索再注入 prompt。若仍出现，检查预检索代码是否被注释，或模型是否在预检索未命中后凭记忆回答（应标注"知识库未收录"）。
