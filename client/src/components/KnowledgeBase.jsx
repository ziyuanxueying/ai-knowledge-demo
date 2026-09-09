import { useState, useEffect, useCallback } from 'react';
import {
  getKnowledgeEntries,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
  getKbStats,
  searchKnowledge,
  regenerateKbEmbeddings,
} from '../utils/api.js';

/**
 * 知识库管理界面（RAG 升级版）
 *
 * 【功能】：
 * - 列出全部知识条目（带搜索）
 * - 新增 / 编辑 / 删除条目（保存时后端自动向量化）
 * - 向量化状态条：显示已向量化 X/Y 条 + 重新生成/补齐向量按钮
 * - 检索对比面板：同一查询并排展示"关键词检索" vs "语义检索"结果
 *   直观体现 RAG 的价值（语义相近但字面不重叠也能召回）
 *
 * 数据结构：{ id, title, keywords: [], category, content, createdAt, updatedAt }
 */
export default function KnowledgeBase({ onBack }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // 编辑中条目：null=未编辑，{}=新建，{...}=编辑已有
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // RAG 相关状态
  const [kbStats, setKbStats] = useState({ total: 0, embedded: 0, pending: 0 });
  const [ragQuery, setRagQuery] = useState('');
  const [ragResults, setRagResults] = useState(null); // { query, keyword: [], semantic: [] }
  const [ragLoading, setRagLoading] = useState(false);
  const [embeddingLoading, setEmbeddingLoading] = useState(false);

  const refreshStats = useCallback(async () => {
    try {
      const s = await getKbStats();
      setKbStats(s);
    } catch {
      // 忽略统计错误
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { entries } = await getKnowledgeEntries();
      setEntries(entries || []);
      await refreshStats();
    } catch (e) {
      setError(`加载失败：${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [refreshStats]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = search
    ? entries.filter((e) => {
        const q = search.toLowerCase();
        return (
          e.title.toLowerCase().includes(q) ||
          e.content.toLowerCase().includes(q) ||
          e.keywords.some((k) => k.toLowerCase().includes(q)) ||
          (e.category || '').toLowerCase().includes(q)
        );
      })
    : entries;

  const handleSave = async () => {
    if (!editing.title?.trim()) {
      setError('标题不能为空');
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      title: editing.title,
      keywords: (editing.keywordsText || '')
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      category: editing.category || '',
      content: editing.content || '',
    };
    try {
      if (editing.id) {
        await updateKnowledgeEntry(editing.id, payload);
      } else {
        await createKnowledgeEntry(payload);
      }
      setEditing(null);
      await load();
    } catch (e) {
      setError(`保存失败：${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('确定删除这条知识？删除后 Agent 将无法检索到。')) return;
    try {
      await deleteKnowledgeEntry(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      await refreshStats();
    } catch (e) {
      setError(`删除失败：${e.message}`);
    }
  };

  const startCreate = () => {
    setError(null);
    setEditing({ title: '', keywordsText: '', category: '', content: '' });
  };

  const startEdit = (entry) => {
    setError(null);
    setEditing({
      ...entry,
      keywordsText: (entry.keywords || []).join(', '),
    });
  };

  // RAG：检索对比
  const handleRagSearch = async () => {
    const q = ragQuery.trim();
    if (!q) {
      setError('请输入查询内容');
      return;
    }
    setRagLoading(true);
    setError(null);
    try {
      const result = await searchKnowledge(q, 'compare');
      setRagResults(result);
      // 对比会触发懒补齐，刷新统计
      await refreshStats();
    } catch (e) {
      setError(`检索失败：${e.message}`);
    } finally {
      setRagLoading(false);
    }
  };

  // 重新生成全部向量
  const handleRegenerate = async (action) => {
    setEmbeddingLoading(true);
    setError(null);
    try {
      await regenerateKbEmbeddings(action);
      await refreshStats();
    } catch (e) {
      setError(`向量化失败：${e.message}`);
    } finally {
      setEmbeddingLoading(false);
    }
  };

  const embedRatio = kbStats.total > 0 ? kbStats.embedded / kbStats.total : 0;
  const exampleQueries = ['函数怎么记住外部变量', '框架怎么高效更新 DOM', '打包时怎么去掉无用代码'];

  return (
    <div className="kb-view">
      <div className="kb-header">
        <button type="button" className="kb-back-btn" onClick={onBack}>
          ← 返回对话
        </button>
        <h2>📚 知识库管理</h2>
        <button type="button" className="kb-add-btn" onClick={startCreate}>
          + 新增条目
        </button>
      </div>

      {/* RAG：向量化状态条 */}
      <div className="kb-rag-bar">
        <div className="kb-rag-status">
          <span className="kb-rag-label">向量化</span>
          <div className="kb-rag-progress">
            <div className="kb-rag-progress-fill" style={{ width: `${embedRatio * 100}%` }} />
          </div>
          <span className="kb-rag-count">
            {kbStats.embedded}/{kbStats.total} 条
          </span>
          {kbStats.pending > 0 && (
            <span className="kb-rag-pending">待向量化 {kbStats.pending} 条</span>
          )}
        </div>
        <div className="kb-rag-actions">
          {kbStats.pending > 0 && (
            <button
              type="button"
              className="kb-rag-btn"
              onClick={() => handleRegenerate('ensure')}
              disabled={embeddingLoading}
            >
              {embeddingLoading ? '处理中...' : '补齐向量'}
            </button>
          )}
          <button
            type="button"
            className="kb-rag-btn"
            onClick={() => handleRegenerate('regenerate')}
            disabled={embeddingLoading || kbStats.total === 0}
          >
            {embeddingLoading ? '处理中...' : '重新生成全部向量'}
          </button>
        </div>
      </div>

      {/* RAG：检索对比面板 */}
      <div className="kb-rag-panel">
        <div className="kb-rag-title">🔍 检索对比（关键词 vs 语义）</div>
        <div className="kb-rag-input-row">
          <input
            type="text"
            className="kb-rag-input"
            placeholder="试一个字面不重叠的查询，如：函数怎么记住外部变量"
            value={ragQuery}
            onChange={(e) => setRagQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRagSearch();
            }}
          />
          <button
            type="button"
            className="kb-rag-search-btn"
            onClick={handleRagSearch}
            disabled={ragLoading}
          >
            {ragLoading ? '检索中...' : '搜索对比'}
          </button>
        </div>
        <div className="kb-rag-examples">
          示例：
          {exampleQueries.map((q) => (
            <button
              key={q}
              type="button"
              className="kb-rag-example"
              onClick={() => {
                setRagQuery(q);
              }}
            >
              {q}
            </button>
          ))}
        </div>

        {ragResults && (
          <div className="kb-rag-compare">
            <div className="kb-rag-col">
              <div className="kb-rag-col-title">关键词检索（{ragResults.keyword.length} 条）</div>
              <div className="kb-rag-col-body">
                {ragResults.keyword.length === 0 ? (
                  <div className="kb-rag-empty">无匹配（字面不重叠就召回不到）</div>
                ) : (
                  ragResults.keyword.map((e) => (
                    <div key={e.id} className="kb-rag-result">
                      <div className="kb-rag-result-title">{e.title}</div>
                      {e.category && <span className="kb-rag-result-cat">{e.category}</span>}
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="kb-rag-col">
              <div className="kb-rag-col-title">语义检索（{ragResults.semantic.length} 条）</div>
              <div className="kb-rag-col-body">
                {ragResults.semantic.length === 0 ? (
                  <div className="kb-rag-empty">无匹配</div>
                ) : (
                  ragResults.semantic.map((e) => (
                    <div key={e.id} className="kb-rag-result">
                      <div className="kb-rag-result-title">{e.title}</div>
                      {e.category && <span className="kb-rag-result-cat">{e.category}</span>}
                      {typeof e.score === 'number' && e.score > 0 && (
                        <div className="kb-rag-score">
                          <div className="kb-rag-score-bar">
                            <div
                              className="kb-rag-score-fill"
                              style={{ width: `${Math.min(e.score * 100, 100)}%` }}
                            />
                          </div>
                          <span className="kb-rag-score-num">{e.score}</span>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="kb-toolbar">
        <input
          type="text"
          className="kb-search"
          placeholder="搜索标题 / 关键词 / 内容 / 分类..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="kb-count">共 {filtered.length} 条</span>
      </div>

      {error && <div className="kb-error">⚠️ {error}</div>}

      <div className="kb-list">
        {loading ? (
          <div className="kb-empty">加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="kb-empty">
            {search ? '没有匹配的条目' : '知识库为空，点击「新增条目」添加第一条'}
          </div>
        ) : (
          filtered.map((e) => (
            <div key={e.id} className="kb-item">
              <div className="kb-item-head">
                <span className="kb-item-title">{e.title}</span>
                {e.category && <span className="kb-item-cat">{e.category}</span>}
              </div>
              {e.keywords?.length > 0 && (
                <div className="kb-item-keywords">
                  {e.keywords.map((k) => (
                    <span key={k} className="kb-tag">{k}</span>
                  ))}
                </div>
              )}
              <div className="kb-item-content">{e.content}</div>
              <div className="kb-item-foot">
                <span className="kb-item-time">
                  更新于 {new Date(e.updatedAt).toLocaleString('zh-CN')}
                </span>
                <div className="kb-item-actions">
                  <button type="button" className="kb-action-btn" onClick={() => startEdit(e)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="kb-action-btn danger"
                    onClick={() => handleDelete(e.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 编辑/新增 弹层：backdrop 用 button（无障碍），modal 用 role=dialog */}
      {editing && (
        <div className="kb-modal-mask">
          <button
            type="button"
            className="kb-modal-backdrop"
            aria-label="关闭"
            onClick={() => setEditing(null)}
          />
          <div className="kb-modal">
            <div className="kb-modal-title">
              {editing.id ? '编辑条目' : '新增条目'}
            </div>
            <div className="kb-form">
              <label className="kb-field">
                <span>标题 *</span>
                <input
                  type="text"
                  value={editing.title}
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  placeholder="如：虚拟 DOM"
                />
              </label>
              <label className="kb-field">
                <span>分类</span>
                <input
                  type="text"
                  value={editing.category}
                  onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                  placeholder="如：原理 / React / 工程化"
                />
              </label>
              <label className="kb-field">
                <span>关键词（逗号分隔）</span>
                <input
                  type="text"
                  value={editing.keywordsText}
                  onChange={(e) => setEditing({ ...editing, keywordsText: e.target.value })}
                  placeholder="如：virtual dom, 虚拟dom"
                />
              </label>
              <label className="kb-field">
                <span>内容</span>
                <textarea
                  rows={6}
                  value={editing.content}
                  onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                  placeholder="详细解释，会作为 Agent 检索结果返回给模型"
                />
              </label>
            </div>
            <div className="kb-modal-actions">
              <button
                type="button"
                className="kb-modal-btn"
                onClick={() => setEditing(null)}
                disabled={saving}
              >
                取消
              </button>
              <button
                type="button"
                className="kb-modal-btn primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
