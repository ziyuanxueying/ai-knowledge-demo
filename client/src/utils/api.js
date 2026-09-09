/**
 * API 调用封装
 *
 * 【AI 学习要点 - 前端如何接收流式输出】：
 * 流式输出在后端用 SSE，前端不能用 EventSource（它只支持 GET），
 * 而要用 fetch + ReadableStream 来读取响应体。
 *
 * 核心思路：
 * 1. fetch 发起 POST 请求
 * 2. 拿到 response.body（ReadableStream）
 * 3. 用 TextDecoder 解码二进制为文本
 * 4. 按 "data: ...\n\n" 格式解析每个 SSE 事件
 * 5. 调用 onChunk 回调实时更新 UI
 */

const API_BASE = '/api'

/**
 * 发送聊天消息（流式）
 * @param {object} params - { message, sessionId, scenario }
 * @param {object} handlers - { onChunk, onDone, onError, signal }
 * @returns {Promise<void>}
 */
export async function sendChatMessage(
  { message, sessionId, scenario = 'frontend_dev', temperature, maxTokens },
  { onChunk, onSession, onUsage, onMessages, onDone, onError, signal }
) {
  let response
  try {
    response = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId, scenario, temperature, maxTokens }),
      signal,
    })
  } catch (err) {
    if (err.name !== 'AbortError') onError?.(err.message)
    return
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: '请求失败' }))
    onError?.(err.error || `HTTP ${response.status}`)
    return
  }

  // 读取流式响应
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // 按 SSE 格式拆分："data: {json}\n\n"
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // 保留最后不完整的一行

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue

        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          onDone?.()
          return
        }

        try {
          const parsed = JSON.parse(data)
          switch (parsed.type) {
            case 'session':
              onSession?.(parsed.sessionId)
              break
            case 'messages':
              onMessages?.(parsed)
              break
            case 'content':
              onChunk?.(parsed.content)
              break
            case 'usage':
              onUsage?.(parsed.usage)
              break
            case 'aborted':
              onDone?.()
              return
            case 'error':
              onError?.(parsed.message)
              return
            case 'done':
              onUsage?.(parsed.usage)
              onDone?.()
              return
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    }
    onDone?.()
  } catch (err) {
    if (err.name !== 'AbortError') onError?.(err.message)
  }
}

/**
 * A/B 对比（流式，方案 D + 方案 E 裁判评分）
 *
 * 同一问题用两套配置并行调用，单条 SSE 连接里事件按 variant（0/1）区分。
 * judge=true 时两路完成后后端再调裁判模型，推送 judge_start/judge_done。
 *
 * @param {object} params - { message, variants: [...], judge }
 * @param {object} handlers - { onVariantStart, onChunk(variant, content), onVariantDone, onJudgeStart, onJudgeDone, onJudgeError, onError, onDone, signal }
 */
export async function sendCompareMessage(
  { message, variants, judge = false },
  { onVariantStart, onChunk, onVariantDone, onJudgeStart, onJudgeDone, onJudgeError, onError, onDone, signal }
) {
  let response
  try {
    response = await fetch(`${API_BASE}/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, variants, judge }),
      signal,
    })
  } catch (err) {
    if (err.name !== 'AbortError') onError?.(err.message)
    return
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: '请求失败' }))
    onError?.(err.error || `HTTP ${response.status}`)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          onDone?.()
          return
        }
        try {
          const parsed = JSON.parse(data)
          switch (parsed.type) {
            case 'variant_start':
              onVariantStart?.(parsed.variant, parsed)
              break
            case 'content':
              onChunk?.(parsed.variant, parsed.content)
              break
            case 'variant_done':
              onVariantDone?.(parsed.variant, parsed)
              break
            case 'variant_aborted':
              onVariantDone?.(parsed.variant, { ...parsed, aborted: true })
              break
            case 'variant_error':
              onVariantDone?.(parsed.variant, { ...parsed, failed: true })
              break
            case 'judge_start':
              onJudgeStart?.()
              break
            case 'judge_done':
              onJudgeDone?.(parsed.verdict, parsed.labels)
              break
            case 'judge_error':
              onJudgeError?.(parsed.error)
              break
            case 'error':
              onError?.(parsed.error || '服务异常')
              return
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    }
    onDone?.()
  } catch (err) {
    if (err.name !== 'AbortError') onError?.(err.message)
  }
}

/** 获取快捷问题 */
export async function getQuickQuestions() {
  const res = await fetch(`${API_BASE}/chat/quick-questions`)
  return res.json()
}

/**
 * 提交任务给 Agent（流式）
 *
 * 【AI 学习要点 - Agent 事件流】：
 * Agent 比普通聊天多了 thinking / tool 事件，前端据此展示"思考过程"。
 * 其余 content / done / aborted 与普通聊天一致。
 *
 * @param {object} params - { task, sessionId }
 * @param {object} handlers - { onSession, onThinking, onTool, onChunk, onUsage, onDone, onError, signal }
 */
export async function sendAgentTask(
  { task, sessionId },
  { onSession, onThinking, onTool, onChunk, onUsage, onDone, onError, signal }
) {
  let response
  try {
    response = await fetch(`${API_BASE}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, sessionId }),
      signal,
    })
  } catch (err) {
    if (err.name !== 'AbortError') onError?.(err.message)
    return
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: '请求失败' }))
    onError?.(err.error || `HTTP ${response.status}`)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue

        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          onDone?.()
          return
        }

        try {
          const parsed = JSON.parse(data)
          switch (parsed.type) {
            case 'session':
              onSession?.(parsed.sessionId)
              break
            case 'thinking':
              onThinking?.(parsed)
              break
            case 'tool':
              onTool?.(parsed)
              break
            case 'content':
              onChunk?.(parsed.content)
              break
            case 'usage':
              onUsage?.(parsed.usage)
              break
            case 'aborted':
              onDone?.()
              return
            case 'error':
              onError?.(parsed.message)
              return
            case 'done':
              onUsage?.(parsed.usage)
              onDone?.()
              return
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    }
    onDone?.()
  } catch (err) {
    if (err.name !== 'AbortError') onError?.(err.message)
  }
}

/** 获取会话列表 */
export async function getSessions() {
  const res = await fetch(`${API_BASE}/history`)
  return res.json()
}

/** 获取会话详情（含消息） */
export async function getSessionDetail(sessionId) {
  const res = await fetch(`${API_BASE}/history/${sessionId}`)
  return res.json()
}

/** 创建新会话 */
export async function createSession(title) {
  const res = await fetch(`${API_BASE}/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  return res.json()
}

/** 删除会话 */
export async function deleteSession(sessionId) {
  const res = await fetch(`${API_BASE}/history/${sessionId}`, {
    method: 'DELETE',
  })
  return res.json()
}

/* ========== 知识库管理 API ========== */

/** 获取知识库全部条目 */
export async function getKnowledgeEntries() {
  const res = await fetch(`${API_BASE}/knowledge`)
  return res.json()
}

/** 创建知识库条目 */
export async function createKnowledgeEntry({ title, keywords, category, content }) {
  const res = await fetch(`${API_BASE}/knowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, keywords, category, content }),
  })
  return res.json()
}

/** 更新知识库条目 */
export async function updateKnowledgeEntry(id, { title, keywords, category, content }) {
  const res = await fetch(`${API_BASE}/knowledge/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, keywords, category, content }),
  })
  return res.json()
}

/** 删除知识库条目 */
export async function deleteKnowledgeEntry(id) {
  const res = await fetch(`${API_BASE}/knowledge/${id}`, {
    method: 'DELETE',
  })
  return res.json()
}

/* ----- RAG：向量化与语义检索 ----- */

/**
 * 获取知识库向量化状态统计
 * 返回 { total, embedded, pending }
 */
export async function getKbStats() {
  const res = await fetch(`${API_BASE}/knowledge/stats`)
  return res.json()
}

/**
 * 检索对比：同时返回关键词检索与语义检索结果
 * @param {string} q - 查询
 * @param {string} mode - keyword | semantic | compare（默认 compare）
 * @returns {Promise<{query, keyword: [], semantic: []}>}
 */
export async function searchKnowledge(q, mode = 'compare') {
  const url = `${API_BASE}/knowledge/search?q=${encodeURIComponent(q)}&mode=${mode}`
  const res = await fetch(url)
  return res.json()
}

/**
 * 重新生成全部向量，或补齐缺失向量
 * @param {'regenerate'|'ensure'} action
 */
export async function regenerateKbEmbeddings(action = 'regenerate') {
  const res = await fetch(`${API_BASE}/knowledge/embeddings/${action}`, {
    method: 'POST',
  })
  return res.json()
}

/* ========== Prompt 实验室 API ========== */

/**
 * 列出所有 prompt scenario + 可用变量
 * @returns {Promise<{ scenarios: Array<{id,name,contentLength,updatedAt}>, vars: string[] }>}
 *
 * 【AI 学习要点 - Prompt 在线编辑】：
 * 把 Prompt 从代码里抽出来存 JSON，通过 REST 暴露读写。
 * 前端编辑器保存后，下次对话即用新 prompt，无需重启后端。
 */
export async function getPrompts() {
  const res = await fetch(`${API_BASE}/prompts`)
  return res.json()
}

/** 取单个 prompt（含 raw + 渲染后 + 变量列表） */
export async function getPrompt(scenario) {
  const res = await fetch(`${API_BASE}/prompts/${scenario}`)
  return res.json()
}

/** 更新 prompt，立即生效 */
export async function updatePromptApi(scenario, { name, content }) {
  const res = await fetch(`${API_BASE}/prompts/${scenario}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  })
  return res.json()
}
