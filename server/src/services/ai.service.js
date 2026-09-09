import OpenAI from 'openai'
import { config } from '../config/index.js'

/**
 * AI 服务层
 *
 * 【AI 学习要点】：
 * 1. OpenAI SDK 可以兼容调用通义千问，只需修改 baseURL 和 apiKey
 * 2. Chat Completions API 的核心是 messages 数组，包含 system/user/assistant 三种角色
 *    - system: 系统提示词，设定 AI 人设
 *    - user: 用户消息
 *    - assistant: AI 之前的回复（用于多轮对话上下文）
 * 3. 流式输出：设置 stream: true，模型会逐个 token 返回
 */

// 创建 OpenAI 兼容客户端（实际指向通义千问）
const client = new OpenAI({
  apiKey: config.dashscope.apiKey,
  baseURL: config.dashscope.baseURL,
})

/**
 * 流式聊天
 * @param {Array} messages - 消息数组 [{role, content}]
 * @param {AbortSignal} signal - 中断信号
 * @param {object} [options] - 可选的采样参数覆盖（方案 C 参数面板）
 * @param {number} [options.temperature] - 温度 0~2，覆盖 config 默认值
 * @param {number} [options.maxTokens] - 最大输出 token，覆盖 config 默认值
 * @returns {AsyncGenerator} 异步迭代器，每次 yield 一个文本片段
 *
 * 【AI 学习要点 - 流式输出】：
 * 流式输出是 AI 应用的核心体验。原理是：
 * - 客户端发起请求，服务端保持连接不断开
 * - 模型每生成一个 token，就立即推送给你
 * - 前端收到后实时渲染，实现"打字机"效果
 *
 * 这里用 async generator 函数，让调用方可以 for await 遍历。
 *
 * 【AI 学习要点 - 采样参数】：
 * temperature 控制随机性：低(0.1)→确定性回答(代码/事实)；高(1.5)→发散(创作)。
 * max_tokens 限制输出长度，防止回复过长或成本失控。
 * 参数应由调用方按请求传入，而不是写死，这样前端滑块调参才能立即生效。
 */
export async function* streamChat(messages, signal, options = {}) {
  const temperature = typeof options.temperature === 'number' ? options.temperature : config.dashscope.temperature
  const maxTokens = typeof options.maxTokens === 'number' ? options.maxTokens : config.dashscope.maxTokens

  let stream
  try {
    stream = await client.chat.completions.create(
      {
        model: config.dashscope.model,
        messages,
        stream: true, // 开启流式输出
        temperature,
        max_tokens: maxTokens,
        // 在最后一个 chunk 中返回 Token 用量
        stream_options: { include_usage: true },
      },
      { signal }
    )
  } catch (err) {
    // 调用建立前就被中断（如网络取消），直接结束，不再抛错
    if (err.name === 'AbortError' || err.name === 'APIUserAbortError') {
      return
    }
    throw err
  }

  let usage = null

  try {
    for await (const chunk of stream) {
      // 正常内容 chunk
      if (chunk.choices && chunk.choices.length > 0) {
        const delta = chunk.choices[0].delta
        const content = delta?.content || ''
        if (content) {
          yield { type: 'content', content }
        }
      }
      // 最后一个 chunk 包含 Token 用量
      if (chunk.usage) {
        usage = chunk.usage
      }
    }
  } catch (err) {
    // 流式读取过程中被中断，正常结束
    if (err.name === 'AbortError' || err.name === 'APIUserAbortError') {
      return
    }
    throw err
  }

  // 流结束后返回用量信息
  if (usage) {
    yield { type: 'usage', usage }
  }
}

/**
 * 普通聊天（非流式，一次性返回完整内容）
 * 适用于不需要流式效果的场景（摘要、裁判评分等内部调用）
 * @param {Array} messages - 消息数组
 * @param {object} [options] - 可选采样参数 { temperature, maxTokens }
 */
export async function chat(messages, options = {}) {
  const response = await client.chat.completions.create({
    model: config.dashscope.model,
    messages,
    temperature: typeof options.temperature === 'number' ? options.temperature : config.dashscope.temperature,
    max_tokens: typeof options.maxTokens === 'number' ? options.maxTokens : config.dashscope.maxTokens,
  })

  return {
    content: response.choices[0].message.content,
    usage: response.usage,
  }
}

/**
 * 生成对话历史摘要
 * @param {Array} messages - 待摘要的历史消息 [{role, content}]
 * @param {string} [prevSummary=''] - 已有的旧摘要，用于合并增量
 * @returns {Promise<string>} 摘要文本
 *
 * 【AI 学习要点 - 摘要压缩策略】：
 * 当历史消息超过阈值时，把更早的消息压缩成一段摘要，
 * 之后构造 messages 时用摘要替代早期原文，token 消耗从 O(n²) 降到 O(1)。
 *
 * 设计要点：
 * - 复用非流式 chat（用户看不到摘要过程，不需要打字机效果）
 * - 让模型"合并"旧摘要与新历史，避免多次摘要导致信息丢失
 * - 限定字数避免摘要自身膨胀
 */
export async function summarizeHistory(messages, prevSummary = '') {
  const historyText = messages.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n')

  const prompt = `请把以下对话历史压缩成 200 字以内的摘要，
保留关键技术点、用户意图、已确认的结论、出现过的代码片段要义。
${prevSummary ? `已有旧摘要，请在它基础上合并增量内容：\n旧摘要：\n${prevSummary}\n\n` : ''}
对话历史：
${historyText}

输出要求：纯文本摘要，不要列表、不要 Markdown 代码块、不要标题。`

  const { content } = await chat([
    { role: 'system', content: '你是对话摘要助手，擅长把长对话压缩成精炼摘要。' },
    { role: 'user', content: prompt },
  ])

  return content.trim()
}

/**
 * 粗略估算文本的 token 数
 *
 * 【AI 学习要点 - Token 估算】：
 * 模型按 token 计费 + 有上下文上限，但请求前需预估 token 防止超限。
 * 精确算法要用 tokenizer（如 OpenAI 的 tiktoken），但需引入较大依赖。
 * 这里用经验公式粗估，仅供 UI 预览（让用户看到"将发多少 token"）：
 *   - 中文字 1 字 ≈ 1.5 token（BPE 切分通常 1~2 个）
 *   - 英文单词 ≈ 1.3 token（常见词 1 个，长词可能拆多个）
 *   - 标点/数字/空格 ≈ 0.5 token
 *
 * 注意：实际 token 以模型返回的 usage 为准，此估算可能有 ±20% 误差。
 */
export function estimateTokens(text) {
  if (!text) return 0
  const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const enWords = (text.match(/[a-zA-Z]+/g) || []).length
  const enChars = (text.match(/[a-zA-Z]/g) || []).length
  const otherChars = text.length - cn - enChars
  return Math.ceil(cn * 1.5 + enWords * 1.3 + otherChars * 0.5)
}
