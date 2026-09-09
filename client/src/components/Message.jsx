import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import AgentSteps from './AgentSteps.jsx';

/**
 * 消息组件
 *
 * 【AI 学习要点 - Markdown 渲染】：
 * AI 回复的内容通常是 Markdown 格式（代码块、列表、表格等）。
 * 用 react-markdown 把 Markdown 渲染成 HTML：
 * - remark-gfm：支持 GitHub 风格 Markdown（表格、删除线等）
 * - rehype-highlight：代码块语法高亮
 */
export default function Message({ message, mode = 'chat' }) {
  const isUser = message.role === 'user';
  const hasSteps = !isUser && message.steps && message.steps.length > 0;
  // Agent 模式下，即使没调用工具也显示一个标记，让用户清楚这是 Agent 的"直答"
  const showAgentDirectBadge = mode === 'agent' && !isUser && !hasSteps;

  return (
    <div className="message">
      <div className={`avatar ${message.role}`}>
        {isUser ? '我' : '码'}
      </div>
      <div className="message-body">
        <div className="message-role">{isUser ? '你' : '小码 · 前端助手'}</div>
        <div className="message-content">
          {isUser ? (
            // 用户消息直接显示文本
            <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
          ) : (
            <>
              {/* Agent 模式：先展示工具调用步骤，再展示最终答案 */}
              {hasSteps && <AgentSteps steps={message.steps} />}
              {showAgentDirectBadge && (
                <div className="agent-direct-badge">
                  🤖 Agent 判断无需调用工具，直接回答
                </div>
              )}
              {message.content ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {message.content}
                </ReactMarkdown>
              ) : !hasSteps ? (
                <span style={{ color: 'rgba(0,0,0,0.4)' }}>思考中...</span>
              ) : null}
              {/* 流式输出时显示光标 */}
              {message.streaming && <span className="cursor" />}
            </>
          )}
        </div>
        {/* 显示 Token 用量（仅 AI 消息且非流式时） */}
        {!isUser && !message.streaming && message.usage && (
          <div className="message-usage">
            输入 {message.usage.prompt_tokens} tokens · 输出 {message.usage.completion_tokens} tokens · 共 {message.usage.total_tokens} tokens
          </div>
        )}
      </div>
    </div>
  );
}
