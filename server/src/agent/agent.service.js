import OpenAI from 'openai'
import { config } from '../config/index.js'
import { estimateTokens } from '../services/ai.service.js'
import { AGENT_TOOLS, invokeTool } from './tools.js'
import { retrieveHybrid, toDisplayHits } from '../rag/retrieve.js'

/**
 * Agent 服务
 *
 * 【AI 学习要点 - Agent 的核心循环】：
 * 普通 Chat：用户问 → AI 答（一次性）
 * Agent：用户给任务 → AI 规划 → 调用工具 → 拿结果 → 继续推理 → ... → 给最终答案
 *
 * 循环步骤：
 *   0. 先让模型只输出执行计划（要调哪些工具、为什么），再进入循环
 *   1. 把 (system + 计划 + 早期摘要 + 最近原文 + 当前任务 + 工具定义) 发给模型
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
- 调用后：若知识库命中，以知识库内容为准回答，并用来源编号 [1]、[2] 标注，编号必须和检索结果一致
- 若知识库明确返回"未找到"，才可用自身通用知识补充，并写明"知识库未收录"。不要在没有对应编号时说内容来自知识库
- 遇到需要查证的事实（如包大小、版本），调用 get_npm_package_info 获取真实数据，不要凭记忆编造
- 若后面给出了执行计划，按计划调用工具；计划之外不要另起工具，除非计划中的工具失败
- 可以连续调用多个工具，分步完成任务
- 拿到工具结果后，综合分析再给出最终回答
- 如果工具返回错误或未找到，诚实告知用户

## 回答规范
- 最终答案用 Markdown，代码用代码块
- 引用知识库时使用检索结果里的 [编号]；引用 npm 时标注"据 npm registry"
- 语气专业友好，称呼对方为"你"

当前时间：${new Date().toLocaleString('zh-CN')}
`

// 最大循环次数，防止模型陷入无限调用
const MAX_ITERATIONS = 8
const PLAN_TOOLS = new Set(AGENT_TOOLS.map((item) => item.function.name))

function parseJsonObject(text) {
  if (!text) return null
  const attempts = [text]
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) attempts.push(fenced[1])
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) attempts.push(text.slice(start, end + 1))
  for (const item of attempts) {
    try {
      return JSON.parse(item)
    } catch {
      // 换下一种切法
    }
  }
  return null
}

/**
 * 执行前的计划：只决定工具和原因，不在这一步调用工具。
 */
async function draftPlan({ task, alreadyRetrieved, signal }) {
  const catalog = AGENT_TOOLS.map((item) => `- ${item.function.name}：${item.function.description}`).join('\n')
  const retrieved = alreadyRetrieved
    ? '知识库已经预检索过。除非需要换一个关键词补检索，否则不要再列入 search_frontend_kb。'
    : '若问题依赖知识库里的概念，计划里应包含 search_frontend_kb。'
  const response = await client.chat.completions.create(
    {
      model: config.dashscope.model,
      temperature: 0.1,
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: `你只负责规划，不回答用户。根据任务列出要调用的工具。只输出 JSON：{"steps":[{"toolName":"工具名","why":"一句话原因"}]}。
可用工具：
${catalog}
${retrieved}
toolName 必须是上面列出的名字。不需要工具时 steps 为空数组。不要输出其他文字。`,
        },
        { role: 'user', content: task },
      ],
    },
    { signal }
  )
  const parsed = parseJsonObject(response.choices?.[0]?.message?.content || '')
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : []
  return steps
    .filter((step) => step && PLAN_TOOLS.has(step.toolName))
    .slice(0, 4)
    .map((step) => ({
      toolName: step.toolName,
      why: String(step.why || '执行该工具').slice(0, 80),
    }))
}

/**
 * 运行 Agent
 * @param {object} params
 * @param {string} params.task - 用户的任务
 * @param {Array} params.history - 最近原文 [{role:'user'|'assistant', content}]，不含本轮工具消息
 * @param {string} params.summary - 早期对话摘要；为空则不注入
 * @param {string} params.memory - 按当前问题召回的记忆；为空则不注入
 * @param {Array} params.memories - 召回明细，随 messages 预览推给前端
 * @param {AbortSignal} params.signal - 中断信号
 * @returns {AsyncGenerator} 事件流
 */
export async function* runAgent({ task, history = [], summary = '', memory = '', memories = [], signal }) {
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
      const found = await retrieveHybrid(task, { history, topK: 5, threshold: 0.3 })
      yield {
        type: 'retrieval',
        rewrittenQuery: found.rewrittenQuery || task,
        embeddingModel: config.dashscope.embeddingModel,
      }
      if (found.hits.length > 0) {
        ragContext = found.text
        yield { type: 'citations', citations: found.citations }
        yield { type: 'thinking', step: 1, plan: [{ toolName: 'search_frontend_kb', args: { keyword: task } }] }
        yield {
          type: 'tool',
          step: 1,
          toolName: 'search_frontend_kb',
          args: { keyword: task },
          result: ragContext,
          hits: toDisplayHits(found.hits),
        }
      }
    } catch {
      // 预检索失败（如未配 API Key）不阻断，退化为无 RAG 上下文
    }
  }

  // 组装初始 messages：system + 早期摘要 + 召回记忆 + 最近原文 + 当前任务
  // 执行计划在规划完成后插到人设后面。本轮 tool 消息只在循环里追加，不进摘要，也不进记忆。
  const systemContent = ragContext
    ? `${AGENT_SYSTEM_PROMPT}\n\n## 已检索到的知识库内容（请据此回答，用来源编号 [n] 标注）\n${ragContext}`
    : AGENT_SYSTEM_PROMPT
  const summaryMessages = summary
    ? [{ role: 'system', content: `## 早期对话摘要（请据此理解上下文）\n${summary}` }]
    : []
  const memoryMessages = memory ? [{ role: 'system', content: memory }] : []
  const messages = [
    { role: 'system', content: systemContent },
    ...summaryMessages,
    ...memoryMessages,
    ...history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: task },
  ]

  let totalUsage = null
  // 步骤编号：预检索占 step 1 时，计划接在后面，工具循环再往后排
  let stepBase = ragContext ? 1 : 0
  let planSteps = []
  let planFailed = false
  try {
    planSteps = await draftPlan({ task, alreadyRetrieved: Boolean(ragContext), signal })
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'APIUserAbortError' || signal?.aborted) {
      yield { type: 'aborted' }
      return
    }
    planFailed = true
  }
  if (planFailed) {
    planSteps = [{ toolName: 'reply', why: '规划未完成，按已有上下文继续' }]
  } else if (planSteps.length === 0) {
    planSteps = [{ toolName: 'reply', why: ragContext ? '预检索已有结果，直接回答' : '不必调用工具，直接回答' }]
  }
  stepBase += 1
  yield { type: 'thinking', step: stepBase, plan: planSteps }

  const executable = planSteps.filter((step) => step.toolName !== 'reply')
  const planBody = planFailed
    ? '规划未完成。按系统提示决定是否调用工具。'
    : executable.length
      ? `${executable.map((step, index) => `${index + 1}. ${step.toolName}：${step.why}`).join('\n')}\n请按此计划调用工具。计划之外不要另起工具，除非计划中的工具失败。`
      : '不必调用工具，根据已有上下文直接回答。'
  messages.splice(1, 0, { role: 'system', content: `## 执行计划\n${planBody}` })

  const previewMessages = messages.map((m) => ({
    role: m.role,
    content: m.content || '',
    chars: (m.content || '').length,
    tokens: estimateTokens(m.content || ''),
  }))
  yield {
    type: 'messages',
    messages: previewMessages,
    totalTokens: previewMessages.reduce((sum, m) => sum + m.tokens, 0),
    summary: summary || null,
    memories: memories || [],
  }

  // 本轮任务内连续失败的工具不再调用。下一次用户消息会重新开始。
  const stoppedTools = new Set()

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

      // 同一轮的多个 tool_calls 并行执行，回填仍按原顺序对齐 tool_call_id
      let executed
      try {
        executed = await Promise.all(message.tool_calls.map(async (toolCall) => {
          if (signal?.aborted) {
            const err = new Error('已中断')
            err.name = 'AbortError'
            throw err
          }
          const toolName = toolCall.function.name
          const args = safeParseArgs(toolCall.function.arguments)
          const outcome = await invokeTool(toolName, args, {
            signal,
            stopped: stoppedTools.has(toolName),
          })
          return { toolCall, toolName, args, ...outcome }
        }))
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'APIUserAbortError') {
          yield { type: 'aborted' }
          return
        }
        throw err
      }

      for (const item of executed) {
        if (item.failed && !item.stopped) stoppedTools.add(item.toolName)
        if (item.toolName === 'search_frontend_kb') {
          yield {
            type: 'retrieval',
            rewrittenQuery: String(item.args?.keyword || ''),
            embeddingModel: config.dashscope.embeddingModel,
          }
          if (item.citations?.length) {
            yield { type: 'citations', citations: item.citations.map((cite) => ({ ...cite })) }
          }
        }
        yield {
          type: 'tool',
          step: i + 1 + stepBase,
          toolName: item.toolName,
          args: item.args,
          result: item.content,
          hits: item.hits?.length ? item.hits : undefined,
        }
        messages.push({
          role: 'tool',
          tool_call_id: item.toolCall.id,
          content: item.content,
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
