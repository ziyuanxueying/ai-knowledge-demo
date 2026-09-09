import { useEffect, useRef } from 'react'
import Message from './Message.jsx'
import WelcomeScreen from './WelcomeScreen.jsx'

/**
 * 聊天主窗口
 */
export default function ChatWindow({ messages, error, onSelectQuestion, mode = 'chat' }) {
  const bottomRef = useRef(null)

  // 新消息时自动滚动到底部
  // biome-ignore lint/correctness/useExhaustiveDependencies: 需要在 messages 变化时触发滚动
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="messages">
      {messages.length === 0 ? (
        <WelcomeScreen onSelectQuestion={onSelectQuestion} mode={mode} />
      ) : (
        <div className="message-list">
          {messages.map(msg => (
            <Message key={msg.id} message={msg} mode={mode} />
          ))}
          {error && (
            <div
              style={{
                color: '#c7254e',
                padding: '12px',
                background: '#fff5f5',
                borderRadius: '8px',
                margin: '8px 0',
                fontSize: '14px',
              }}
            >
              ⚠️ {error}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
