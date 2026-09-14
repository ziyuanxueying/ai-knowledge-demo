/**
 * 侧边栏：新建对话 + 知识库入口 + 会话列表
 *
 * view: 'chat' | 'knowledge' | 'prompt' | 'compare'
 * 点击会话项会切回 chat 视图（由 App 的 onSwitch 负责）
 */
export default function Sidebar({
  sessions,
  currentSessionId,
  onNewChat,
  onSwitch,
  onDelete,
  view = 'chat',
  onOpenKnowledge,
  onOpenPrompt,
  onOpenCompare,
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button type="button" className="new-chat-btn" onClick={onNewChat}>
          + 新建对话
        </button>
        <button
          type="button"
          className={`nav-item ${view === 'knowledge' ? 'active' : ''}`}
          onClick={onOpenKnowledge}
        >
          <span className="nav-icon">📚</span>
          <span>知识库</span>
        </button>
        <button
          type="button"
          className={`nav-item ${view === 'prompt' ? 'active' : ''}`}
          onClick={onOpenPrompt}
        >
          <span className="nav-icon">🧪</span>
          <span>Prompt 实验室</span>
        </button>
        <button
          type="button"
          className={`nav-item ${view === 'compare' ? 'active' : ''}`}
          onClick={onOpenCompare}
        >
          <span className="nav-icon">⚡</span>
          <span>A/B 对比</span>
        </button>
      </div>

      <div className="session-list">
        {sessions.length === 0 ? (
          <div style={{ padding: '12px', color: 'rgba(236,236,241,0.4)', fontSize: '13px' }}>
            暂无历史会话
          </div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === currentSessionId && view === 'chat' ? 'active' : ''}`}
            >
              <button
                type="button"
                className="session-item-main"
                onClick={() => onSwitch(s.id)}
              >
                <span className="session-title">{s.title || '新对话'}</span>
              </button>
              <button
                type="button"
                className="session-delete"
                onClick={() => onDelete(s.id)}
                title="删除"
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        前端知识库 v1.0 · 基于通义千问
      </div>
    </aside>
  );
}
