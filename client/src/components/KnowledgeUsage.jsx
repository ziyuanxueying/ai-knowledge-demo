import { useCallback, useEffect, useState } from 'react';
import { getKnowledgeUsage } from '../utils/api.js';

function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 知识库页的文档用量。数字来自已落库的来源卡片和「无用」反馈。
 */
export default function KnowledgeUsage() {
  const [cited, setCited] = useState([]);
  const [neverCited, setNeverCited] = useState([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const [showMissed, setShowMissed] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getKnowledgeUsage();
      setCited(Array.isArray(data.cited) ? data.cited : []);
      setNeverCited(Array.isArray(data.neverCited) ? data.neverCited : []);
      setError('');
    } catch (err) {
      setError(err.message || '读取文档用量失败');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="kb-rag-panel kb-eval-panel">
      <div className="kb-eval-bar">
        <div className="kb-eval-copy">
          <div className="kb-eval-heading">
            <div className="kb-rag-title">文档用量</div>
            {cited.length > 0 && <span className="kb-feedback-count">{cited.length}</span>}
          </div>
          <p className="kb-eval-desc">
            按已经落库的来源卡片统计。同一篇在一次回答里出现多次只算 1 次。无用次数来自点过「无用」的回答。
          </p>
        </div>
        <div className="kb-eval-actions">
          {(cited.length > 0 || neverCited.length > 0) && (
            <button
              type="button"
              className="kb-rag-btn"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? '收起列表' : '展开列表'}
            </button>
          )}
          <button type="button" className="kb-rag-btn" onClick={load}>
            刷新
          </button>
        </div>
      </div>
      {error && <div className="kb-eval-error">{error}</div>}
      {open && !error && cited.length === 0 && (
        <div className="kb-feedback-none">还没有带来源的回答。问一个知识库里的概念后，这里会按文档累计。</div>
      )}
      {open && cited.length > 0 && (
        <div className="kb-usage-table-wrap">
          <table className="kb-usage-table">
            <thead>
              <tr>
                <th>文档</th>
                <th>被引用</th>
                <th>无用回答</th>
                <th>最近引用</th>
              </tr>
            </thead>
            <tbody>
              {cited.map((row) => (
                <tr key={row.entryId}>
                  <td>
                    <div className="kb-usage-title" title={row.title}>{row.title}</div>
                    {row.category ? <div className="kb-usage-category">{row.category}</div> : null}
                  </td>
                  <td>{row.citedCount}</td>
                  <td>{row.uselessCount > 0 ? row.uselessCount : '—'}</td>
                  <td>{formatTime(row.lastCitedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && !error && (
        <div className="kb-usage-missed">
          <button
            type="button"
            className="kb-rag-btn"
            aria-expanded={showMissed}
            onClick={() => setShowMissed((value) => !value)}
          >
            {showMissed ? '收起从未引用' : `从未引用 ${neverCited.length}`}
          </button>
          {showMissed && neverCited.length === 0 && (
            <div className="kb-feedback-none">已入库的文档都出现过。</div>
          )}
          {showMissed && neverCited.length > 0 && (
            <ul className="kb-usage-missed-list">
              {neverCited.map((row) => (
                <li key={row.entryId}>
                  <span className="kb-usage-title" title={row.title}>{row.title}</span>
                  {row.category ? <span className="kb-usage-category">{row.category}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
