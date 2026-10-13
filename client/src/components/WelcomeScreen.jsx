import { useState, useEffect } from 'react';
import { getQuickQuestions } from '../utils/api.js';

/**
 * Agent 模式的示例任务（会触发工具调用，便于体验差异）
 */
const AGENT_TASKS = [
  { id: 'a1', text: '查 vite 和 webpack 的最新版本、依赖数和体积' },
  { id: 'a2', text: '闭包为什么会造成内存泄漏？' },
  { id: 'a3', text: '分析这段代码：function Box() { const [n, setN] = useState(0); return <button onClick={async () => { await fetch("/api"); setN(n + 1) }}>{n}</button> }' },
  { id: 'a4', text: 'Tree Shaking 是怎么消除未使用代码的？' },
];

/**
 * 欢迎页：根据模式展示不同的快捷问题
 */
export default function WelcomeScreen({ onSelectQuestion, mode = 'chat' }) {
  const [questions, setQuestions] = useState([]);

  const isAgent = mode === 'agent';

  useEffect(() => {
    if (isAgent) {
      // Agent 模式用本地示例任务（确保能触发工具）
      setQuestions(AGENT_TASKS);
    } else {
      // 对话模式用后端配置的快捷问题
      getQuickQuestions()
        .then((data) => setQuestions(data.questions || []))
        .catch(() => {});
    }
  }, [isAgent]);

  return (
    <div className="welcome">
      <div className="welcome-logo">{isAgent ? '🤖' : '码'}</div>
      <h1>{isAgent ? 'Agent 模式' : '你好，我是小码'}</h1>
      <p>
        {isAgent
          ? 'AI 会自主调用工具（查 npm 包、搜知识库、分析代码）完成任务，你能看到完整思考过程。'
          : '前端开发知识库助手，有什么技术问题可以帮你？'}
      </p>
      {questions.length > 0 && (
        <div className="quick-questions">
          {questions.map((q) => (
            <button
              type="button"
              key={q.id}
              className="quick-question"
              onClick={() => onSelectQuestion(q.text)}
            >
              {q.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
