import OpenAI from 'openai'
import { config } from '../config/index.js'
import { AGENT_TOOLS, executeTool } from './tools.js'
import { searchEntriesSemantic, formatSearchResultText } from '../data/kbStore.js'

/**
 * Agent 服务
 *
 * 【AI 学习要点 - Agent 的核心循环】：
 * 普通 Chat：用户问 → AI 答（一次性）
 * Agent：用户给任务 → AI 规划 → 调用工具 → 拿结果 → 继续推理 → ... → 给最终答案
 *
 * 循环步骤：
 *   1. 把 (system + 历史 + 当前任务 + 工具定义) 发给模型
 *   2. 模型返回两种情况：
 *      a) finish_reason === 'tool_calls'：模型要求调用工具
 *         → 执行每个工具，把结果作为 role:'tool' 消息追加进 messages
 *         → 回到第 1 步继续
 *      b) finish_reason === 'stop'：模型给出最终答案
 *         → 流式输出给前端（打字机效果），结束循环
 *
 * 为了让前端能看到 Agent 的"思考过程"，循环中通过 yield 推送事件：
 *   - thinking: 模型决定调用的工具（计划）
 *   - tool: 单个工具的执行结果
 *   - content: 最终答案的文本片段（流式）
 *   - usage: token 用量
 */

const client = new OpenAI({
  apiKey: config.dashscope.apiKey,
  baseURL: config.dashscope.baseURL,
})

// Agent 的系统提示词：在前端助手基础上，告知它有工具可用
const AGENT_SYSTEM_PROMPT = `你是前端开发知识库助手"小码"，具备自主调用工具完成任务的能力。

你可以使用以下工具来辅助回答：
1. search_frontend_kb(keyword) - 搜索前端开发知识库（用户维护的条目，含概念解释、最佳实践等）
2. get_npm_package_info(packageName) - 查询 npm 包的真实信息（版本、体积、依赖数等）
3. analyze_code(code) - 分析一段代码的结构特征

## 工作方式（必须严格遵守）
- **遇到以下任何一种问题，必须先调用 search_frontend_kb 检索知识库，再回答**：
  1. 前端概念、原理、最佳实践类问题（如闭包、虚拟 DOM、事件循环、useEffect 等）
  2. 任何关于"知识库 / 本项目 / 检索配置 / 工具"本身的问题（模型不可能凭训练数据知道这些，必须查）
- **绝不在未调用 search_frontend_kb 的情况下，凭记忆回答上述问题，更不能编造"据知识库"的措辞**
- 调用后：若知识库命中，以知识库内容为准回答，标注"据知识库"
- 若知识库明确返回"未找到"，才可用自身通用知识补充，并标注"知识库未收录，以下为通用知识"
- 遇到需要查证的事实（如包大小、版本），调用 get_npm_package_info 获取真实数据，不要凭记忆编造
- 可以连续调用多个工具，分步完成任务
- 拿到工具结果后，综合分析再给出最终回答
- 如果工具返回错误或未找到，诚实告知用户

## 回答规范
- 最终答案用 Markdown，代码用代码块
- 引用工具返回的数据时标注来源（如"据知识库"/"据 npm registry"）
- 语气专业友好，称呼对方为"你"

当前时间：${new Date().toLocaleString('zh-CN')}
`

// 最大循环次数，防止模型陷入无限调用
const MAX_ITERATIONS = 8

/**
 * 运行 Agent
 * @param {object} params
 * @param {string} params.task - 用户的任务
 * @param {Array} params.history - 历史消息 [{role:'user'|'assistant', content}]
 * @param {AbortSignal} params.signal - 中断信号
 * @returns {AsyncGenerator} 事件流
 */
export async function* runAgent({ task, history = [], signal }) {
  // 【AI 学习要点 - RAG 两种实现策略】：
  //   策略 A（Agentic RAG）：让模型自己决定是否调用 search_frontend_kb 检索
  //     → 依赖模型的工具调用可靠性，小模型（qwen-turbo）常"自以为知道"不调，甚至编造"据知识库"
  //   策略 B（Retrieval-then-Generate）：后端先检索，把结果注入 system 上下文，再让模型回答
  //     → 不依赖模型的"判断"，RAG 必然生效，更可靠
  //
  // 本项目对非问候类查询采用策略 B（预检索注入），同时保留 search_frontend_kb 工具
  // （策略 A）：模型在预检索未命中时仍可主动调用工具补充检索。

  // 步骤 1：预检索（retrieval）—— 用语义检索从知识库找相关内容
  let ragContext = ''
  if (shouldForceKbRetrieve(task)) {
    try {
      const results = await searchEntriesSemantic(task, 3, 0.3)
      if (results.length > 0) {
        ragContext = formatSearchResultText(task, results)
        // 推送一个"检索"步骤给前端展示（与工具调用同款 UI）
        yield { type: 'thinking', step: 1, plan: [{ toolName: 'search_frontend_kb', args: { keyword: task } }] }
        yield { type: 'tool', step: 1, toolName: 'search_frontend_kb', args: { keyword: task }, result: ragContext }
      }
    } catch {
      // 预检索失败（如未配 API Key）不阻断，退化为无 RAG 上下文
    }
  }

  // 组装初始 messages：system + RAG 上下文 + 历史 + 当前任务
  const systemContent = ragContext
    ? `${AGENT_SYSTEM_PROMPT}\n\n## 已检索到的知识库内容（请据此回答，标注"据知识库"）\n${ragContext}`
    : AGENT_SYSTEM_PROMPT
  const messages = [
    { role: 'system', content: systemContent },
    ...history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: task },
  ]

  let totalUsage = null
  // 步骤编号：预检索若已用 step 1，模型循环从 step 2 起接着编号
  const stepBase = ragContext ? 1 : 0

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal?.aborted) return

    // 非流式调用，便于完整解析 tool_calls
    let response
    try {
      response = await client.chat.completions.create(
        {
          model: config.dashscope.model,
          messages,
          tools: AGENT_TOOLS,
          tool_choice: 'auto',
          temperature: config.dashscope.temperature,
          max_tokens: config.dashscope.maxTokens,
        },
        { signal }
      )
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'APIUserAbortError') {
        yield { type: 'aborted' }
        return
      }
      throw err
    }

    const choice = response.choices[0]
    const message = choice.message

    if (response.usage) {
      totalUsage = accumulateUsage(totalUsage, response.usage)
    }

    // 情况 A：模型要求调用工具
    if (choice.finish_reason === 'tool_calls' && message.tool_calls) {
      // 推送"思考"事件：告诉前端 Agent 准备调用哪些工具
      const plan = message.tool_calls.map(tc => ({
        toolName: tc.function.name,
        args: safeParseArgs(tc.function.arguments),
      }))
      yield { type: 'thinking', step: i + 1 + stepBase, plan }

      // 把 assistant 的 tool_calls 消息加入历史（模型要求必须回传）
      messages.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.tool_calls,
      })

      // 执行每个工具，推送结果，并把结果作为 tool 消息回传
      for (const toolCall of message.tool_calls) {
        if (signal?.aborted) return
        const toolName = toolCall.function.name
        const args = safeParseArgs(toolCall.function.arguments)

        const result = await executeTool(toolName, args)

        yield {
          type: 'tool',
          step: i + 1 + stepBase,
          toolName,
          args,
          result,
        }

        // 把工具结果作为 tool 角色消息回传给模型
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        })
      }

      // 继续下一轮循环，让模型基于工具结果推理
      continue
    }

    // 情况 B：模型给出最终答案（finish_reason === 'stop' 或无 tool_calls）
    // 用流式重新请求一次相同的 messages（不带 tools，确保只输出最终答案且打字机效果）
    const finalText = message.content || ''
    if (finalText) {
      // 为了打字机效果，按字符分片推送
      // （真实场景也可再次流式请求，这里直接拆分已有内容，避免额外调用）
      const chunks = splitToChunks(finalText, 4)
      for (const chunk of chunks) {
        if (signal?.aborted) return
        yield { type: 'content', content: chunk }
        // 微小延迟模拟打字机节奏
        await sleep(15)
      }
    }

    if (totalUsage) {
      yield { type: 'usage', usage: totalUsage }
    }
    return // 结束循环
  }

  // 达到最大循环次数仍未给出最终答案
  yield {
    type: 'content',
    content: `\n\n_（已达到最大工具调用次数 ${MAX_ITERATIONS} 次，Agent 终止。已完成的工具调用见上方步骤。）_`,
  }
  if (totalUsage) {
    yield { type: 'usage', usage: totalUsage }
  }
}

/**
 * 判断是否应在第一轮强制检索知识库（always-retrieve 策略）
 * 纯问候/闲聊不强制；其余查询都先检索，保证 RAG 生效。
 */
function shouldForceKbRetrieve(task) {
  const t = String(task || '').trim()
  if (!t) return false
  // 纯问候 / 闲聊 / 自我介绍请求，不强制检索
  if (/^(你好|您好|hi|hello|嗨|在吗|谢谢|再见|你是谁|介绍下你自己|你是干什么的)/i.test(t)) {
    return false
  }
  return true
}

/**
 * 累加 token 用量
 */
function accumulateUsage(acc, cur) {
  if (!acc) return cur
  return {
    prompt_tokens: acc.prompt_tokens + (cur.prompt_tokens || 0),
    completion_tokens: acc.completion_tokens + (cur.completion_tokens || 0),
    total_tokens: acc.total_tokens + (cur.total_tokens || 0),
  }
}

/**
 * 安全解析模型返回的工具参数 JSON
 */
function safeParseArgs(jsonStr) {
  if (!jsonStr) return {}
  try {
    return JSON.parse(jsonStr)
  } catch {
    return { _raw: jsonStr }
  }
}

/**
 * 把文本按每 chunkSize 个字符切分（保留换行完整）
 */
function splitToChunks(text, chunkSize) {
  const chunks = []
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize))
  }
  return chunks
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
