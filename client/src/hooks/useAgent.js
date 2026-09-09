import { useState, useCallback, useRef } from 'react'
import { sendAgentTask } from '../utils/api.js'

/**
 * Agent 模式 Hook
 *
 * 【AI 学习要点 - Agent 前端状态管理】：
 * 普通聊天：消息 = 用户问 + AI 答
 * Agent：消息 = 用户任务 + AI 答（其中 AI 答 = 思考步骤 + 工具调用 + 最终答案）
 *
 * 关键区别：AI 消息多了 steps 字段，记录工具调用过程。
 */
export function useAgent() {
  const [messages, setMessages] = useState([])
  const [currentSessionId, setCurrentSessionId] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)

  /** 新建任务 */
  const sendTask = useCallback(
    async text => {
      if (!text.trim() || loading) return

      setError(null)
      setLoading(true)

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
          onTool: ({ step, toolName, args, result }) => {
            setMessages(prev => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last && last.role === 'assistant') {
                const steps = (last.steps || []).map(s =>
                  s.step === step ? { ...s, tools: [...s.tools, { toolName, args, result }] } : s
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
          onDone: () => {
            setMessages(prev => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, streaming: false }
              }
              return next
            })
            setLoading(false)
            abortRef.current = null
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
          },
        }
      )
    },
    [loading, currentSessionId]
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
  }, [])

  /** 新建对话 */
  const newChat = useCallback(() => {
    setCurrentSessionId(null)
    setMessages([])
    setError(null)
  }, [])

  return {
    messages,
    currentSessionId,
    loading,
    error,
    sendTask,
    stopGenerate,
    newChat,
  }
}
