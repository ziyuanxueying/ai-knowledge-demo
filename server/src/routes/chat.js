import { Router } from 'express'
import { streamChat, summarizeHistory, estimateTokens } from '../services/ai.service.js'
import { config } from '../config/index.js'
import { getSystemPrompt, QUICK_QUESTIONS } from '../data/knowledge.js'
import { createSession, getSession, appendMessage, updateSessionSummary } from '../data/store.js'

const router = Router()

/**
 * 聊天路由
 *
 * 【AI 学习要点 - SSE 流式输出】：
 * Server-Sent Events (SSE) 是实现流式输出的标准方式：
 * 1. 设置响应头：Content-Type: text/event-stream
 * 2. 保持连接不断开
 * 3. 用 res.write(`data: ${JSON}\n\n`) 推送数据
 * 4. 结束时发送 res.write('data: [DONE]\n\n') 再 res.end()
 *
 * 前端用 fetch + ReadableStream 读取（不能用 EventSource，因为要 POST）
 */

/**
 * POST /api/chat
 * 流式聊天接口
 *
 * 请求体：
 * {
 *   "sessionId": "xxx",        // 会话ID，不传则创建新会话
 *   "message": "用户问题",      // 用户消息
 *   "scenario": "frontend_dev"  // 场景，默认前端开发知识库
 * }
 */
router.post('/', async (req, res) => {
  try {
    const { message, scenario = 'frontend_dev', sessionId } = req.body

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message 不能为空' })
    }

    // 【方案 C - 参数调节面板】前端滑块传入的采样参数，校验后覆盖默认值
    // 不合法时静默回退到 config 默认值，保证请求不被错误参数打断
    let temperature = config.dashscope.temperature
    if (typeof req.body.temperature === 'number' && req.body.temperature >= 0 && req.body.temperature <= 2) {
      temperature = Math.round(req.body.temperature * 10) / 10
    }
    let maxTokens = config.dashscope.maxTokens
    if (typeof req.body.maxTokens === 'number' && req.body.maxTokens >= 100 && req.body.maxTokens <= 8192) {
      maxTokens = Math.round(req.body.maxTokens)
    }
    const sampleParams = { temperature, maxTokens }

    // 1. 获取或创建会话
    let session = sessionId ? getSession(sessionId) : null
    if (!session) {
      session = createSession('新对话')
    }

    // 2. 构造发送给 AI 的消息数组
    // 第一条必须是 system 消息（定义 AI 人设）
    const systemPrompt = getSystemPrompt(scenario)

    // 【AI 学习要点 - 长对话摘要压缩策略】：
    // 模型本身无状态，多轮对话靠"每次把历史拼回 messages"实现。
    // 但历史越久 messages 越长，token 消耗 O(n²) 增长，且可能超出上下文上限。
    //
    // 策略 2 = 摘要压缩：
    //   - 最近 N 条原文照常带（保留下文连贯性）
    //   - 更早的历史用一段"摘要"替代（由模型生成，存 session.summary）
    //   - 与策略 1（滑动窗口）的区别：早期上下文不会完全丢失
    //   - 触发条件：未摘要的早期历史 ≥ 2 条（避免每轮都触发，降低 LLM 调用成本）
    //   - 摘要用非流式 chat，用户看不到过程
    const MAX_HISTORY_MESSAGES = 6 // 最近保留 6 条原文 ≈ 3 轮对话

    // 全量 user/assistant 历史
    const allHistory = session.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }))

    // 分割：早期（待摘要） + 最近（保留原文）
    // 当历史不足 N 条时，slice(0, -N) 返回空数组，earlier 为空
    const earlier = allHistory.slice(0, -MAX_HISTORY_MESSAGES)
    const recentHistory = allHistory.slice(-MAX_HISTORY_MESSAGES)

    // 触发摘要：未摘要的早期历史 ≥ 2 条
    if (earlier.length - session.summaryUpTo >= 2) {
      try {
        const newSummary = await summarizeHistory(earlier, session.summary)
        // 写回 store 并重新拿到最新 session（含新 summary）
        session = updateSessionSummary(session.id, newSummary, earlier.length)
        console.log(`[摘要] 触发: 压缩前 ${earlier.length} 条历史 -> ${newSummary.length} 字摘要`)
      } catch (err) {
        // 摘要失败不阻塞主流程，沿用旧 summary 或退化为滑动窗口
        console.error('生成对话摘要失败:', err.message)
      }
    }

    // 构造最终 messages：system + (摘要) + 最近原文 + 当前问题
    const summaryMessages = session.summary
      ? [{ role: 'system', content: `## 早期对话摘要（请据此理解上下文）\n${session.summary}` }]
      : []

    const messages = [
      { role: 'system', content: systemPrompt },
      ...summaryMessages,
      ...recentHistory,
      // 当前用户消息
      { role: 'user', content: message },
    ]

    // 3. 先把用户消息存入历史
    appendMessage(session.id, { role: 'user', content: message })

    // 4. 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // 禁用 Nginx 缓冲

    // 先发送会话ID，前端需要用它维护会话
    res.write(`data: ${JSON.stringify({ type: 'session', sessionId: session.id })}\n\n`)

    // 【方案 B - 消息预览面板】推送最终 messages 给前端可视化
    // 让用户看到"实际发给模型的内容"：system prompt / 历史摘要 / 多轮历史 / 当前问题
    // 配合 estimateTokens 让用户预估将消耗多少 token（请求前可见）
    const previewMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
      chars: m.content.length,
      tokens: estimateTokens(m.content),
    }))
    const totalTokens = previewMessages.reduce((sum, m) => sum + m.tokens, 0)
    res.write(
      `data: ${JSON.stringify({
        type: 'messages',
        messages: previewMessages,
        totalTokens,
        summary: session.summary || null,
        params: sampleParams,
      })}\n\n`
    )

    // 5. 调用 AI 流式接口，逐段推送
    let fullContent = ''
    let usage = null

    // 支持客户端中断（用户点击"停止"按钮 / 关闭页面）：
    // 前端断开 fetch 连接会触发 res 的 close 事件，此时 abort 上游模型请求，
    // 否则后端到通义千问的请求仍会跑完，token 照常计费。
    const controller = new AbortController()
    let finished = false
    // 注意：不能用 req.on('close')，它会在请求体读完后立即触发，导致提前中断。
    // 用 res.on('close') 并加 finished 守卫，仅响应客户端真实断开。
    res.on('close', () => {
      if (!finished) controller.abort()
    })

    try {
      const stream = streamChat(messages, controller.signal, sampleParams)
      for await (const chunk of stream) {
        if (chunk.type === 'content') {
          fullContent += chunk.content
          res.write(`data: ${JSON.stringify({ type: 'content', content: chunk.content })}\n\n`)
        } else if (chunk.type === 'usage') {
          usage = chunk.usage
        }
      }
    } catch (err) {
      // 连接断开或中断，正常结束，不记录错误
      if (
        err.name === 'AbortError' ||
        err.name === 'APIUserAbortError' ||
        err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        err.code === 'EPIPE'
      ) {
        finished = true
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`)
        }
      } else {
        throw err
      }
    }

    // 6. 把 AI 完整回复存入历史（中断时也保存已生成的部分内容）
    appendMessage(session.id, { role: 'assistant', content: fullContent, usage })

    // 7. 发送结束信号（客户端已断开则不再写，避免 EPIPE）
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'done', usage })}\n\n`)
      res.write('data: [DONE]\n\n')
      finished = true
      res.end()
    }
  } catch (error) {
    console.error('聊天接口错误:', error)
    // 如果已经开始了流式响应，用 SSE 格式返回错误
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`)
      res.end()
    } else {
      res.status(500).json({ error: error.message || 'AI 服务异常' })
    }
  }
})

/**
 * GET /api/chat/quick-questions
 * 获取快捷问题列表
 */
router.get('/quick-questions', (req, res) => {
  res.json({ questions: QUICK_QUESTIONS })
})

export default router
