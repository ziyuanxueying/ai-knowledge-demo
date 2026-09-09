import { useEffect, useState } from 'react';
import { getPrompts, getPrompt, updatePromptApi } from '../utils/api.js';

/**
 * Prompt 实验室
 *
 * 【AI 学习要点 - Prompt 在线编辑器】：
 * 在 UI 里直接编辑 System Prompt，保存到后端 prompts.json，立即生效。
 * 之前改 prompt 要：改 system.js → 重启 → 测试 → 反复。
 * 现在改 prompt 只要：UI 编辑 → 保存 → 发消息测试 → 立刻看效果。
 *
 * 核心功能：
 * - 左侧切换 scenario（前端助手 / 通用助手）
 * - 右侧编辑名称 + 内容
 * - 变量提示（点击 {{datetime}} 插入到末尾）
 * - 保存后展示渲染后效果（{{}} 已被替换为真实值）
 * - 「返回」回到聊天视图
 */
export default function PromptLab({ onBack }) {
  const [scenarios, setScenarios] = useState([]);
  const [vars, setVars] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [rendered, setRendered] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null); // { type: 'success'|'error', text }

  // 初始加载 scenario 列表
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const data = await getPrompts();
        setScenarios(data.scenarios || []);
        setVars(data.vars || []);
        if (data.scenarios?.length > 0) {
          setCurrentId(data.scenarios[0].id);
        }
      } catch (err) {
        setMessage({ type: 'error', text: err.message || '加载失败' });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // 切换 scenario 时加载详情
  useEffect(() => {
    if (!currentId) return;
    (async () => {
      try {
        const data = await getPrompt(currentId);
        setName(data.name);
        setContent(data.content);
        setRendered(data.rendered);
        setMessage(null);
      } catch (err) {
        setMessage({ type: 'error', text: err.message || '加载失败' });
      }
    })();
  }, [currentId]);

  const handleSave = async () => {
    if (!currentId) return;
    setSaving(true);
    setMessage(null);
    try {
      await updatePromptApi(currentId, { name, content });
      // 重新加载渲染效果 + 刷新列表（名称可能改了）
      const [detail, list] = await Promise.all([getPrompt(currentId), getPrompts()]);
      setRendered(detail.rendered);
      setScenarios(list.scenarios || []);
      setVars(list.vars || []);
      setMessage({ type: 'success', text: '已保存并立即生效，下次对话即应用' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message || '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const handleInsertVar = (varName) => {
    setContent((c) => `${c}{{${varName}}}`);
  };

  return (
    <div className="prompt-lab">
      <header className="prompt-lab-header">
        <button type="button" className="back-btn" onClick={onBack}>
          ← 返回聊天
        </button>
        <h2>🧪 Prompt 实验室</h2>
        <p className="prompt-lab-subtitle">
          在线编辑 System Prompt，保存后立即生效，无需重启后端
        </p>
      </header>

      <div className="prompt-lab-body">
        <aside className="prompt-scenarios">
          <h3>场景</h3>
          {loading && <div className="muted">加载中...</div>}
          {!loading && scenarios.length === 0 && (
            <div className="muted">暂无场景</div>
          )}
          {scenarios.map((s) => (
            <button
              type="button"
              key={s.id}
              className={`scenario-item ${s.id === currentId ? 'active' : ''}`}
              onClick={() => setCurrentId(s.id)}
            >
              <span className="scenario-id">{s.id}</span>
              <span className="scenario-name">{s.name}</span>
            </button>
          ))}
        </aside>

        <section className="prompt-editor">
          <div className="prompt-field">
            <label htmlFor="prompt-name">名称</label>
            <input
              id="prompt-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="给这个场景起个名字"
            />
          </div>

          <div className="prompt-field">
            <label htmlFor="prompt-content">Prompt 内容</label>
            <textarea
              id="prompt-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={22}
              spellCheck={false}
              placeholder="支持 Markdown 和 {{变量}} 插值"
            />
            <div className="prompt-stats">字数：{content.length}</div>
          </div>

          {vars.length > 0 && (
            <div className="vars-tip">
              <strong>可用变量（点击插入）：</strong>
              {vars.map((v) => (
                <button
                  type="button"
                  key={v}
                  className="var-chip"
                  onClick={() => handleInsertVar(v)}
                  title={`插入 {{${v}}}`}
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>
          )}

          <div className="prompt-actions">
            <button
              type="button"
              className="save-btn"
              onClick={handleSave}
              disabled={saving || !currentId}
            >
              {saving ? '保存中...' : '保存并立即生效'}
            </button>
            {message && (
              <span className={`prompt-message ${message.type}`}>
                {message.text}
              </span>
            )}
          </div>

          {rendered && (
            <details className="rendered-preview">
              <summary>查看渲染后效果（{'{{}}'} 已替换，发给模型前的样子）</summary>
              <pre>{rendered}</pre>
            </details>
          )}
        </section>
      </div>
    </div>
  );
}
