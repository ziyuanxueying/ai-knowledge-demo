import { useState } from 'react';

const ROLE_LABELS = {
  system: '系统',
  user: '用户',
  assistant: '助手',
  tool: '工具',
};

function truncate(s, n = 300) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字）` : s;
}

/**
 * 消息预览面板（方案 B）
 *
 * 可视化"最终发给模型的 messages 数组"，让黑盒变白盒：
 * - 每条消息的角色（system / 摘要 / 历史用户 / 历史助手 / 当前问题）
 * - 每条消息的字数和估算 token
 * - 总 token 估算（请求前可知会不会超上下文上限）
 *
 * 样式修复要点：
 * - 默认折叠，避免挤占消息区空间
 * - 用 CSS 类（.is-open）控制显示/隐藏，而不是 conditional render，避免 DOM 抖动
 * - 横条加高对比度：深色背景 + 白字 + 大箭头，用户一眼能看到并点中
 * - 内容区独立滚动，不挤压缩放消息区
 */
export default function MessagePreview({ data }) {
  const [expanded, setExpanded] = useState(false);

  if (!data) return null;

  const { messages = [], totalTokens = 0, summary = null } = data;

  return (
    <div className={`msg-preview ${expanded ? 'is-open' : ''}`}>
      <button
        type="button"
        className="msg-preview-toggle"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls="msg-preview-body"
      >
        <span className="msg-preview-left">
          <span className="msg-preview-icon">
            {expanded ? '▼' : '▶'}
          </span>
          <span className="msg-preview-title">
            发给模型的消息预览
          </span>
        </span>
        <span className="msg-preview-right">
          <span className="msg-preview-stat">{messages.length} 条</span>
          <span className="msg-preview-stat">{totalTokens} tokens</span>
          <span className="msg-preview-action">
            {expanded ? '收起' : '展开'}
          </span>
        </span>
      </button>

      {/* 用 CSS 控制显示/隐藏，DOM 常驻，避免点击后元素消失的割裂感 */}
      <div
        id="msg-preview-body"
        className="msg-preview-body"
        role="region"
        aria-label="消息预览内容"
      >
        {summary && (
          <div className="msg-preview-summary">
            <span className="role-badge role-summary">摘要</span>
            <span className="msg-preview-summary-text">
              已注入早期对话摘要（{summary.length} 字），替代更早的原文历史
            </span>
          </div>
        )}

        <ul className="msg-preview-list">
          {messages.map((m, i) => (
            <li
              key={i}
              className={`msg-preview-item role-${m.role}`}
            >
              <div className="msg-preview-meta">
                <span className={`role-badge role-${m.role}`}>
                  {ROLE_LABELS[m.role] || m.role}
                </span>
                <span className="msg-preview-index">#{i + 1}</span>
                <span className="msg-preview-stats">
                  {m.chars} 字 · ~{m.tokens} tokens
                </span>
              </div>
              <pre className="msg-preview-content">{truncate(m.content)}</pre>
            </li>
          ))}
        </ul>

        <div className="msg-preview-total">
          <strong>总计</strong>
          <span>：{messages.length} 条消息 · 估算 {totalTokens} tokens</span>
          <span className="msg-preview-warn">
            （估算仅供参考，实际以模型 usage 为准）
          </span>
        </div>
      </div>
    </div>
  );
}
