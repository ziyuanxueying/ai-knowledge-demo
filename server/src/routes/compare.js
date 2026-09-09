import { Router } from 'express'
import { streamChat, estimateTokens } from '../services/ai.service.js'
import { judgeAnswers } from '../services/judge.service.js'
import { getSystemPrompt } from '../data/knowledge.js'
import { config } from '../config/index.js'

/**
 * A/B 对比路由（方案 D）
 *
 * 【AI 学习要点 - A/B 对比】：
 * 同一个问题，用两套配置（不同 temperature / max_tokens / 人设场景）**并行**
 * 调用模型，把两路流式输出通过同一个 SSE 连接交错推给前端，前端左右两栏
 * 同时逐字渲染——像"赛跑"一样直观看出参数对回答风格、速度、长度的影响。
 *
 * 与 /api/chat 的区别：
 * - 不读写会话历史（对比是一次性干净实验，不带上下文干扰）
 * - 不触发摘要、不注入 RAG（聚焦对比变量本身）
 * - 单连接内并发两个流，事件用 variant 字段（0/1）区分
 *
 * 中断处理遵循项目约定：res.on('close') + finished 守卫，
 * 客户端断开时 abort 两个进行中的流，finished 后不再写响应。
 */

const router = Router()

/** 归一化单个变体配置，非法值回退默认（与 chat.js 同样的校验范围） */
function normalizeVariant(v, idx) {
  let temperature = config.dashscope.temperature
  if (typeof v?.temperature === 'number' && v.temperature >= 0 && v.temperature <= 2) {
    temperature = Math.round(v.temperature * 10) / 10
  }
  let maxTokens = config.dashscope.maxTokens
  if (typeof v?.maxTokens === 'number' && v.maxTokens >= 100 && v.maxTokens <= 8192) {
    maxTokens = Math.round(v.maxTokens)
  }
  const scenario = typeof v?.scenario === 'string' && v.scenario ? v.scenario : 'frontend_dev'
  const label = typeof v?.label === 'string' && v.label.trim()
    ? v.label.trim()
    : `方案 ${String.fromCharCode(65 + idx)}`
  return { temperature, maxTokens, scenario, label }
}

router.post('/', async (req, res) => {
  const { message, variants, judge = false } = req.body || {}

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message 不能为空' })
  }
  if (!Array.isArray(variants) || variants.length !== 2) {
    return res.status(400).json({ error: 'variants 必须是包含 2 个配置的数组' })
  }

  const cfgs = variants.map(normalizeVariant)

  // SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  // 中断守卫：客户端断开 → abort 两路流；正常结束后置位，不再写
  let finished = false
  const controller = new AbortController()
  res.on('close', () => {
    if (!finished) controller.abort()
  })

  const send = (obj) => {
    if (!finished) res.write(`data: ${JSON.stringify(obj)}\n\n`)
  }

  /** 跑单个变体：独立 messages、独立流，事件带 variant 索引；返回结果供裁判使用 */
  const runVariant = async (idx) => {
    const cfg = cfgs[idx]
    const systemPrompt = getSystemPrompt(cfg.scenario)
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ]

    send({
      type: 'variant_start',
      variant: idx,
      label: cfg.label,
      scenario: cfg.scenario,
      params: { temperature: cfg.temperature, maxTokens: cfg.maxTokens },
      estimatedPromptTokens: estimateTokens(systemPrompt) + estimateTokens(message),
    })

    let usage = null
    let full = ''
    const startedAt = Date.now()

    try {
      const stream = streamChat(messages, controller.signal, {
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'content') {
          full += chunk.content
          send({ type: 'content', variant: idx, content: chunk.content })
        } else if (chunk.type === 'usage') {
          usage = chunk.usage
        }
      }
      send({
        type: 'variant_done',
        variant: idx,
        label: cfg.label,
        usage,
        elapsedMs: Date.now() - startedAt,
        chars: full.length,
      })
      return { ok: true, content: full, usage, elapsedMs: Date.now() - startedAt }
    } catch (err) {
      if (
        err.name === 'AbortError' ||
        err.name === 'APIUserAbortError' ||
        err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        err.code === 'EPIPE'
      ) {
        send({ type: 'variant_aborted', variant: idx, label: cfg.label })
        return { ok: false, aborted: true, content: full }
      }
      send({
        type: 'variant_error',
        variant: idx,
        label: cfg.label,
        error: err.message || '调用失败',
      })
      return { ok: false, error: err.message, content: full }
    }
  }

  try {
    // 并行跑两路流，SSE 事件在同一连接上自然交错
    const [resultA, resultB] = await Promise.all([runVariant(0), runVariant(1)])

    // 方案 E：两路都成功且请求了裁判 → 调用 LLM-as-a-judge 打分
    // 裁判是非流式内部调用，失败不阻塞主流程（前端仍能看到两路回答）
    if (judge && !finished && resultA?.ok && resultB?.ok && resultA.content && resultB.content) {
      send({ type: 'judge_start' })
      try {
        const { verdict, usage: judgeUsage } = await judgeAnswers({
          question: message,
          answerA: resultA.content,
          answerB: resultB.content,
          labelA: cfgs[0].label,
          labelB: cfgs[1].label,
        })
        if (!finished) {
          send({ type: 'judge_done', verdict, labels: { A: cfgs[0].label, B: cfgs[1].label }, usage: judgeUsage })
        }
      } catch (judgeErr) {
        if (!finished) {
          send({ type: 'judge_error', error: judgeErr.message || '裁判评分失败' })
        }
      }
    }

    // 注意顺序：必须先 send（send 内部用 !finished 守卫），再置 finished
    if (!finished) {
      send({ type: 'done' })
      finished = true
      res.write('data: [DONE]\n\n')
      res.end()
    }
  } catch (err) {
    if (!finished) {
      send({ type: 'error', error: err.message || '服务异常' })
      finished = true
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
})

export default router
