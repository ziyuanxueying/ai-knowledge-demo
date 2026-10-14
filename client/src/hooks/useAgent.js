import { useState, useCallback, useRef } from 'react'
import { getSessionDetail, saveAnswerFeedback, sendAgentTask } from '../utils/api.js'

/**
 * Agent 模式 Hook
 *
 * 【AI 学习要点 - Agent 前端状态管理】：
 * 普通聊天：消息 = 用户问 + AI 答
 * Agent：消息 = 用户任务 + AI 答（其中 AI 答 = 思考步骤 + 工具调用 + 最终答案）
 *
 * 关键区别：AI 消息多了 steps 字段，记录工具调用过程。
 */
export function useAgent(onTurnEnd) {
  const [messages, setMessages] = useState([])
  const [currentSessionId, setCurrentSessionId] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // 后端在调用模型前推送的 messages（人设、计划、早期摘要、最近原文、当前任务）
  const [previewMessages, setPreviewMessages] = useState(null)
  const abortRef = useRef(null)

  /** 新建任务 */
  const sendTask = useCallback(
    async text => {
      if (!text.trim() || loading) return

      setError(null)
      setLoading(true)
      setPreviewMessages(null)

      // 用户消息
      const userMsg = {
        id: `u_${Date.now()}`,
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      }

      // AI 占位消息（含步骤数组 + 流式内容）
      const assistantMsg = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        content: '',
        steps: [],
        streaming: true,
        createdAt: new Date().toISOString(),
      }

      setMessages(prev => [...prev, userMsg, assistantMsg])

      const controller = new AbortController()
      abortRef.current = controller

      await sendAgentTask(
        { task: text, sessionId: currentSessionId },
        {
          signal: controller.signal,
          onSession: sessionId => {
            setCurrentSessionId(sessionId)
          },
          onMessages: data => {
            setPreviewMessages(data)
          },
          onThinking: ({ step, plan }) => {
            // 追加一个新步骤
            setMessages(prev => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last && last.role === 'assistant') {
                const steps = [...(last.steps || []), { step, plan, tools: [] }]
                next[next.length - 1] = { ...last, steps }
              }
              return next
            })
          },
          onCitations: citations => {
            setMessages(prev => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, citations }
              }
              return next
            })
          },
          onTool: ({ step, toolName, args, result, hits }) => {
            setMessages(prev => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last && last.role === 'assistant') {
                const steps = (last.steps || []).map(s =>
                  s.step === step
                    ? { ...s, tools: [...s.tools, { toolName, args, result, hits }] }
                    : s
                )
                next[next.length - 1] = { ...last, steps }
              }
              return next
            })
          },
          onChunk: content => {
            setMessages(prev => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: last.content + content }
              }
              return next
            })
          },
          onUsage: usage => {
            setMessages(prev => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, usage }
              }
              return next
            })
          },
          onDone: payload => {
            setMessages(prev => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last && last.role === 'assistant') {
                next[next.length - 1] = {
                  ...last,
                  streaming: false,
                  id: payload?.messageId || last.id,
                  retrieval: payload?.retrieval || last.retrieval,
                }
              }
              return next
            })
            setLoading(false)
            abortRef.current = null
            onTurnEnd?.()
          },
          onError: msg => {
            setError(msg || 'Agent 执行失败')
            setMessages(prev => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last && last.role === 'assistant' && !last.content && (last.steps || []).length === 0) {
                next.pop()
              } else if (last) {
                next[next.length - 1] = { ...last, streaming: false }
              }
              return next
            })
            setLoading(false)
            abortRef.current = null
            onTurnEnd?.()
          },
        }
      )
    },
    [loading, currentSessionId, onTurnEnd]
  )

  /** 停止生成 */
  const stopGenerate = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setLoading(false)
    setMessages(prev => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last && last.role === 'assistant') {
        next[next.length - 1] = { ...last, streaming: false }
      }
      return next
    })
    onTurnEnd?.()
  }, [onTurnEnd])

  /** 打开已有 Agent 会话 */
  const loadSession = useCallback(async sessionId => {
    if (sessionId === currentSessionId) return
    setError(null)
    setPreviewMessages(null)
    try {
      const { session } = await getSessionDetail(sessionId)
      if (!session) throw new Error('会话不存在')
      setCurrentSessionId(sessionId)
      setMessages(session.messages || [])
    } catch {
      setError('加载会话失败')
    }
  }, [currentSessionId])

  /** 有用 / 无用。回答必须已经落库，刷新后仍在。 */
  const submitFeedback = useCallback(async (messageId, { verdict, reason }) => {
    const feedback = await saveAnswerFeedback({ messageId, verdict, reason })
    setMessages(prev => prev.map(item => (item.id === messageId ? { ...item, feedback } : item)))
    return feedback
  }, [])

  /** 新建对话 */
  const newChat = useCallback(() => {
    setCurrentSessionId(null)
    setMessages([])
    setPreviewMessages(null)
    setError(null)
  }, [])

  return {
    messages,
    previewMessages,
    currentSessionId,
    loading,
    error,
    sendTask,
    submitFeedback,
    stopGenerate,
    loadSession,
    newChat,
  }
}
