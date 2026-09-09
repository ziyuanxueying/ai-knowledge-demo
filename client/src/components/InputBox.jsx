import { useState, useRef, useEffect } from 'react';

/**
 * 输入框组件
 *
 * - 回车发送，Shift+回车换行
 * - 自动调整高度
 * - 流式输出时显示"停止"按钮
 */
export default function InputBox({ onSend, onStop, loading, disabled }) {
  const [text, setText] = useState('');
  const textareaRef = useRef(null);

  // 自动调整高度
  // biome-ignore lint/correctness/useExhaustiveDependencies: 需要在 text 变化时调整高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const handleSend = () => {
    const value = text.trim();
    if (!value || loading || disabled) return;
    onSend(value);
    setText('');
  };

  const handleKeyDown = (e) => {
    // 回车发送，Shift+回车换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="input-area">
      <div className="input-wrapper">
        <textarea
          ref={textareaRef}
          className="input-box"
          placeholder={disabled ? '请先配置 API Key...' : '输入你的问题，回车发送，Shift+回车换行'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
        />
        {loading ? (
          <button type="button" className="stop-btn" onClick={onStop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="send-btn"
            onClick={handleSend}
            disabled={!text.trim() || disabled}
          >
            发送
          </button>
        )}
      </div>
      <div className="input-hint">
        小码 · 前端开发知识库，由通义千问驱动，回答仅供参考
      </div>
    </div>
  );
}
