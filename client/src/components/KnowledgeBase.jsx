import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import {
  getKnowledgeEntries,
  getKnowledgeEntry,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  deleteKnowledgeEntry,
  getKbStats,
  searchKnowledge,
  runKnowledgeEval,
  runAnswerEval,
  regenerateKbEmbeddings,
  uploadKnowledgeBinary,
  ingestWebUrl,
  ingestRepo,
  getIngestConfig,
  getIngestJobs,
} from '../utils/api.js';
import AnswerFeedbackQueue from './AnswerFeedbackQueue.jsx';
import MenuButton from './MenuButton.jsx';

function assertIngestResult(data) {
  if (data?.duplicate) {
    const error = new Error(data.error || '内容已在知识库中');
    error.duplicate = true;
    throw error;
  }
  if (data?.error) throw new Error(data.error);
}

function formatChars(count) {
  const n = Number(count) || 0;
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万字`;
  return `${n} 字`;
}

/** 列表只放预览。短文可在卡片里展开；长文打开阅读层，收起按钮固定在顶部。 */
function EntryContent({ preview, truncated, onOpen }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const text = preview || '';

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open || truncated) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, open, truncated]);

  if (!text && !truncated) return null;

  return (
    <>
      <div
        ref={ref}
        className={`kb-item-content${open && !truncated ? ' is-open' : ''}${(truncated || (overflows && !open)) ? ' is-clamped' : ''}`}
      >
        {text}
      </div>
      {truncated ? (
        <button type="button" className="kb-content-toggle" onClick={onOpen}>
          查看全文
        </button>
      ) : overflows ? (
        <button type="button" className="kb-content-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? '收起' : '展开'}
        </button>
      ) : null}
    </>
  );
}

function Reader({ title, content, loading, onClose }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="kb-modal-mask">
      <button type="button" className="kb-modal-backdrop" aria-label="收起全文" onClick={onClose} />
      <div className="kb-reader" role="dialog" aria-modal="true" aria-label={title || '全文'}>
        <div className="kb-reader-bar">
          <span className="kb-reader-title">{title}</span>
          <button type="button" className="kb-modal-btn" onClick={onClose}>
            收起
          </button>
        </div>
        <div className="kb-reader-body">
          {loading ? '加载全文…' : content}
        </div>
      </div>
    </div>
  );
}

function RagHits({ hits, empty = '无匹配' }) {
  if (!hits.length) return <div className="kb-rag-empty">{empty}</div>;
  return hits.map((hit) => (
    <div key={hit.parentId || hit.id} className="kb-rag-result">
      <div className="kb-rag-result-title">
        {hit.title}
        {hit.heading ? ` / ${hit.heading}` : ''}
      </div>
      {hit.category && <span className="kb-rag-result-cat">{hit.category}</span>}
      {hit.childExcerpt && hit.childExcerpt !== hit.excerpt && (
        <div className="kb-rag-hit">命中：{hit.childExcerpt.slice(0, 80)}</div>
      )}
      {typeof hit.score === 'number' && hit.score > 0 && (
        <div className="kb-rag-score">
          <div className="kb-rag-score-bar">
            <div className="kb-rag-score-fill" style={{ width: `${Math.min(hit.score * 100, 100)}%` }} />
          </div>
          <span className="kb-rag-score-num">{hit.score}</span>
        </div>
      )}
    </div>
  ));
}

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
export default function KnowledgeBase({ onBack, onOpenMenu }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // 编辑中条目：null=未编辑，{}=新建，{...}=编辑已有
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // RAG 相关状态
  const [kbStats, setKbStats] = useState({ total: 0, embedded: 0, pending: 0, embeddingModel: '', modelStale: false });
  const [ragQuery, setRagQuery] = useState('');
  const [ragResults, setRagResults] = useState(null); // { query, keyword: [], semantic: [] }
  const [ragLoading, setRagLoading] = useState(false);
  const [evalReport, setEvalReport] = useState(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState('');
  const [evalOpen, setEvalOpen] = useState(false);
  const [answerReport, setAnswerReport] = useState(null);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState('');
  const [answerOpen, setAnswerOpen] = useState(false);
  const [embeddingLoading, setEmbeddingLoading] = useState(false);
  const [webUrl, setWebUrl] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [ingestConfig, setIngestConfig] = useState({ cosConfigured: true, missing: [] });
  const [jobs, setJobs] = useState([]);
  const [reader, setReader] = useState(null);
  const searchRef = useRef('');
  searchRef.current = search;

  const refreshStats = useCallback(async () => {
    try {
      const s = await getKbStats();
      setKbStats(s);
    } catch {
      // 忽略统计错误
    }
  }, []);

  const reloadEntries = useCallback(async (q = searchRef.current) => {
    const { entries: next } = await getKnowledgeEntries(String(q || '').trim());
    setEntries(next || []);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ entries: next }, config, jobData] = await Promise.all([
        getKnowledgeEntries(searchRef.current.trim()),
        getIngestConfig(),
        getIngestJobs(),
      ]);
      setEntries(next || []);
      setIngestConfig(config || { cosConfigured: false, missing: [] });
      setJobs(jobData?.jobs || []);
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

  const prevQuery = useRef('');
  useEffect(() => {
    const q = search.trim();
    if (!q && !prevQuery.current) return undefined;
    prevQuery.current = q;
    let cancelled = false;
    const timer = setTimeout(() => {
      reloadEntries(q).catch((e) => {
        if (!cancelled) setError(`搜索失败：${e.message}`);
      });
    }, q ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, reloadEntries]);

  const busy = entries.some((entry) => entry.ingestStatus === 'pending' || entry.ingestStatus === 'parsing')
    || jobs.some((job) => job.status === 'pending' || job.status === 'running');

  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => {
      Promise.all([getKnowledgeEntries(searchRef.current.trim()), getIngestJobs()])
        .then(([entryData, jobData]) => {
          setEntries(entryData.entries || []);
          setJobs(jobData.jobs || []);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [busy]);

  const filtered = entries;

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

  const startEdit = async (entry) => {
    setError(null);
    try {
      const needsFull = !entry.content || (entry.contentLength && entry.content.length < entry.contentLength);
      const full = needsFull ? (await getKnowledgeEntry(entry.id)).entry : entry;
      setEditing({
        ...entry,
        ...full,
        keywordsText: (full.keywords || []).join(', '),
      });
    } catch (e) {
      setError(`打开编辑失败：${e.message}`);
    }
  };

  const openReader = async (entry) => {
    setReader({ id: entry.id, title: entry.title, content: '', loading: true });
    try {
      const { entry: full } = await getKnowledgeEntry(entry.id);
      setReader({ id: full.id, title: full.title, content: full.content || '', loading: false });
    } catch (e) {
      setReader(null);
      setError(`打开全文失败：${e.message}`);
    }
  };

  const closeReader = useCallback(() => setReader(null), []);

  const handleEval = async () => {
    setEvalLoading(true);
    setEvalError('');
    try {
      setEvalReport(await runKnowledgeEval());
      setEvalOpen(true);
    } catch (e) {
      setEvalError(e.message || '检索回归失败');
    } finally {
      setEvalLoading(false);
    }
  };

  const handleAnswerEval = async () => {
    setAnswerLoading(true);
    setAnswerError('');
    try {
      setAnswerReport(await runAnswerEval());
      setAnswerOpen(true);
    } catch (e) {
      setAnswerError(e.message || '回答回归失败');
    } finally {
      setAnswerLoading(false);
    }
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
        <MenuButton onClick={onOpenMenu} />
        <button type="button" className="kb-back-btn" onClick={onBack}>
          ← 返回对话
        </button>
        <h2>📚 知识库管理</h2>
        <label className="kb-add-btn kb-upload-btn">
          上传文件
          <input
            type="file"
            accept=".pdf,.docx,.pptx,.md,.txt,.html,.htm,.csv,application/pdf"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setError(null);
              try {
                const data = await uploadKnowledgeBinary(file);
                assertIngestResult(data);
                await load();
              } catch (e) {
                setError(e.duplicate ? e.message : `上传失败：${e.message}`);
              }
            }}
          />
        </label>
        <button type="button" className="kb-add-btn" onClick={startCreate}>
          + 新增条目
        </button>
      </div>

      {!ingestConfig.cosConfigured && (
        <div className="kb-error">
          原文要存到腾讯云 COS。请在 server/.env 填写 {ingestConfig.missing?.join('、') || 'COS 配置'} 后重启服务。
        </div>
      )}

      <div className="kb-ingest">
        <form
          className="kb-ingest-row"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              const data = await ingestWebUrl(webUrl.trim());
              assertIngestResult(data);
              setWebUrl('');
              await load();
            } catch (e) {
              setError(e.duplicate ? e.message : `网页入库失败：${e.message}`);
            }
          }}
        >
          <input
            type="url"
            className="kb-rag-input"
            placeholder="网页地址，例如 https://example.com/docs"
            value={webUrl}
            onChange={(e) => setWebUrl(e.target.value)}
          />
          <button type="submit" className="kb-rag-search-btn">抓取网页</button>
        </form>
        <form
          className="kb-ingest-row"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              const data = await ingestRepo(repoUrl.trim(), repoBranch.trim());
              if (data.error) throw new Error(data.error);
              setRepoUrl('');
              await load();
            } catch (e) {
              setError(`仓库入库失败：${e.message}`);
            }
          }}
        >
          <input
            type="url"
            className="kb-rag-input"
            placeholder="公开 Git 仓库 https 地址"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
          />
          <input
            type="text"
            className="kb-ingest-branch"
            placeholder="分支，可空"
            value={repoBranch}
            onChange={(e) => setRepoBranch(e.target.value)}
          />
          <button type="submit" className="kb-rag-search-btn">导入仓库</button>
        </form>
        {jobs[0] && (jobs[0].status === 'pending' || jobs[0].status === 'running' || jobs[0].status === 'failed') && (
          <div className="kb-ingest-job">
            最近任务 {jobs[0].type}：{jobs[0].status === 'failed' ? jobs[0].error || '失败' : '解析中'}
          </div>
        )}
      </div>

      {/* RAG：向量化状态条 */}
      <div className="kb-rag-bar">
        <div className="kb-rag-status">
          <span className="kb-rag-label">向量化</span>
          <div className="kb-rag-progress">
            <div className="kb-rag-progress-fill" style={{ width: `${embedRatio * 100}%` }} />
          </div>
          <span className="kb-rag-count">
            子块 {kbStats.embedded}/{kbStats.total}
            {kbStats.embeddingModel ? ` · ${kbStats.embeddingModel}` : ''}
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
            {embeddingLoading
              ? '处理中...'
              : kbStats.modelStale
                ? '按当前模型重新转化'
                : '重新生成全部向量'}
          </button>
        </div>
      </div>

      <AnswerFeedbackQueue />

      <div className="kb-rag-panel kb-eval-panel">
        <div className="kb-eval-bar">
          <div className="kb-eval-copy">
            <div className="kb-eval-heading">
              <div className="kb-rag-title">检索回归</div>
              {evalReport && (
                <span className={`kb-eval-score${evalReport.hits === evalReport.total ? ' is-pass' : ' is-fail'}`}>
                  前 3 条命中 {evalReport.hits}/{evalReport.total}（{(evalReport.rate * 100).toFixed(1)}%）
                </span>
              )}
            </div>
            <p className="kb-eval-desc">
              种子题，加上已确认收进检索集的无用反馈。检查期望文档有没有出现在前 3 条结果里。
            </p>
          </div>
          <div className="kb-eval-actions">
            {evalReport && (
              <button
                type="button"
                className="kb-rag-btn"
                onClick={() => setEvalOpen((open) => !open)}
                aria-expanded={evalOpen}
              >
                {evalOpen ? '收起明细' : '展开明细'}
              </button>
            )}
            <button
              type="button"
              className="kb-rag-search-btn"
              onClick={handleEval}
              disabled={evalLoading}
            >
              {evalLoading ? '正在评测…' : '运行检索评测'}
            </button>
          </div>
        </div>
        {evalError && <div className="kb-eval-error">{evalError}</div>}
        {evalReport && evalOpen && (
          <div className="kb-eval-list">
            {[...evalReport.cases].sort((a, b) => Number(a.ok) - Number(b.ok)).map((item) => (
              <div key={`${item.source || 'seed'}-${item.q}-${item.category}-${item.expect}`} className={`kb-eval-row${item.ok ? '' : ' is-miss'}`}>
                <span className="kb-eval-mark">{item.ok ? '通过' : '未过'}</span>
                <div className="kb-eval-body">
                  <div className="kb-eval-q">
                    {item.q}
                    {item.source === 'feedback' ? <span className="kb-rag-result-cat">补充</span> : null}
                    {item.category ? <span className="kb-rag-result-cat">{item.category}</span> : null}
                  </div>
                  <div className="kb-eval-detail">
                    {item.expect}
                    {' · 实际 '}
                    {item.titles.length ? item.titles.join('、') : '空'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="kb-rag-panel kb-eval-panel">
        <div className="kb-eval-bar">
          <div className="kb-eval-copy">
            <div className="kb-eval-heading">
              <div className="kb-rag-title">回答回归</div>
              {answerReport && (
                <span className={`kb-eval-score${answerReport.hits === answerReport.total ? ' is-pass' : ' is-fail'}`}>
                  通过 {answerReport.hits}/{answerReport.total}（{(answerReport.rate * 100).toFixed(1)}%）
                </span>
              )}
            </div>
            <p className="kb-eval-desc">
              种子题，加上已确认收进回答集的无用反馈。检查结论是否贴着父块，以及 [n] 是否对得上。会调用对话模型。
            </p>
          </div>
          <div className="kb-eval-actions">
            {answerReport && (
              <button
                type="button"
                className="kb-rag-btn"
                onClick={() => setAnswerOpen((open) => !open)}
                aria-expanded={answerOpen}
              >
                {answerOpen ? '收起明细' : '展开明细'}
              </button>
            )}
            <button
              type="button"
              className="kb-rag-search-btn"
              onClick={handleAnswerEval}
              disabled={answerLoading}
            >
              {answerLoading ? '正在评测…' : '运行回答评测'}
            </button>
          </div>
        </div>
        {answerError && <div className="kb-eval-error">{answerError}</div>}
        {answerReport && answerOpen && (
          <div className="kb-eval-list">
            {[...answerReport.cases].sort((a, b) => Number(a.ok) - Number(b.ok)).map((item) => (
              <div key={`${item.source || 'seed'}-${item.q}`} className={`kb-eval-row${item.ok ? '' : ' is-miss'}`}>
                <span className="kb-eval-mark">{item.ok ? '通过' : '未过'}</span>
                <div className="kb-eval-body">
                  <div className="kb-eval-q">
                    {item.q}
                    {item.source === 'feedback' ? <span className="kb-rag-result-cat">补充</span> : null}
                  </div>
                  <div className="kb-eval-detail">
                    {item.expect}
                    {item.failures?.length ? ` · ${item.failures.join('；')}` : ' · 忠实，引用编号正确'}
                  </div>
                  {item.answer ? <div className="kb-eval-answer">{item.answer}</div> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* RAG：检索对比面板 */}
      <div className="kb-rag-panel">
        <div className="kb-rag-title">检索对比（关键词 / 语义 / 混合）</div>
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
              <div className="kb-rag-col-title">关键词检索（{(ragResults.keyword || []).length} 条）</div>
              <div className="kb-rag-col-body">
                <RagHits hits={ragResults.keyword || []} empty="无匹配（字面不重叠就召回不到）" />
              </div>
            </div>
            <div className="kb-rag-col">
              <div className="kb-rag-col-title">语义检索（{(ragResults.semantic || []).length} 条）</div>
              <div className="kb-rag-col-body">
                <RagHits hits={ragResults.semantic || []} />
              </div>
            </div>
            <div className="kb-rag-col">
              <div className="kb-rag-col-title">混合检索（{(ragResults.hybrid || []).length} 条）</div>
              <div className="kb-rag-col-body">
                <RagHits hits={ragResults.hybrid || []} />
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
                {e.ingestStatus && e.ingestStatus !== 'ready' && (
                  <span className={`kb-ingest-status ${e.ingestStatus}`}>
                    {e.ingestStatus === 'failed' ? `解析失败 ${e.ingestError || ''}` : '解析中'}
                  </span>
                )}
                {(e.parentCount > 0 || e.childCount > 0) && (
                  <span className="kb-item-chunks">
                    {e.parentCount || 0} 父块 / {e.childCount || 0} 子块
                  </span>
                )}
                {e.contentLength > 0 && (
                  <span className="kb-item-chunks">{formatChars(e.contentLength)}</span>
                )}
              </div>
              {e.keywords?.length > 0 && (
                <div className="kb-item-keywords">
                  {e.keywords.map((k) => (
                    <span key={k} className="kb-tag">{k}</span>
                  ))}
                </div>
              )}
              <EntryContent
                preview={e.preview || ''}
                truncated={(e.contentLength || 0) > (e.preview || '').length}
                onOpen={() => openReader(e)}
              />
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

      {reader && (
        <Reader
          title={reader.title}
          content={reader.content}
          loading={reader.loading}
          onClose={closeReader}
        />
      )}

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
