import { useCallback, useEffect, useState } from 'react';
import { listUselessFeedback, promoteAnswerFeedback } from '../utils/api.js';

function titlesOf(item) {
  return [...new Set((item.citations || []).map((cite) => cite.title).filter(Boolean))];
}

function statusLabels(item) {
  const labels = [];
  if (item.retrievalPromotedAt) labels.push('已收入检索集');
  if (item.answerPromotedAt) labels.push('已收入回答集');
  return labels;
}

function PromoteFields({ item, title, setTitle, empty, setEmpty, pending, onPromote, listId }) {
  const titles = titlesOf(item);
  return (
    <>
      <label className="kb-feedback-empty">
        <input type="checkbox" checked={empty} onChange={(event) => setEmpty(event.target.checked)} />
        知识库不该命中
      </label>
      {!empty && (
        <input
          className="kb-feedback-title"
          list={titles.length ? listId : undefined}
          value={title}
          placeholder="期望的父文档标题"
          onChange={(event) => setTitle(event.target.value)}
        />
      )}
      {titles.length > 0 && !empty && (
        <datalist id={listId}>
          {titles.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      <div className="kb-feedback-actions">
        <button
          type="button"
          className="kb-rag-btn"
          disabled={pending !== '' || Boolean(item.retrievalPromotedAt)}
          onClick={() => onPromote('retrieval')}
        >
          {item.retrievalPromotedAt ? '已收入检索集' : pending === 'retrieval' ? '写入中…' : '收进检索集'}
        </button>
        <button
          type="button"
          className="kb-rag-btn"
          disabled={pending !== '' || Boolean(item.answerPromotedAt)}
          onClick={() => onPromote('answer')}
        >
          {item.answerPromotedAt ? '已收入回答集' : pending === 'answer' ? '写入中…' : '收进回答集'}
        </button>
      </div>
    </>
  );
}

function FeedbackReader({ item, title, setTitle, empty, setEmpty, pending, error, onPromote, onClose }) {
  const rewritten = item.rewrittenQuery && item.rewrittenQuery !== item.question ? item.rewrittenQuery : '';
  const citations = Array.isArray(item.citations) ? item.citations : [];

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="kb-modal-mask">
      <button type="button" className="kb-modal-backdrop" aria-label="关闭全文" onClick={onClose} />
      <div className="kb-reader kb-feedback-reader" role="dialog" aria-modal="true" aria-label={item.question || '无用回答'}>
        <div className="kb-reader-bar">
          <span className="kb-reader-title">{item.question || '无用回答'}</span>
          <button type="button" className="kb-modal-btn" onClick={onClose}>
            收起
          </button>
        </div>
        <div className="kb-feedback-reader-body">
          <section className="kb-feedback-section">
            <div className="kb-feedback-label">原问</div>
            <div className="kb-feedback-block">{item.question}</div>
          </section>
          {rewritten && (
            <section className="kb-feedback-section">
              <div className="kb-feedback-label">评测问句</div>
              <div className="kb-feedback-block">{rewritten}</div>
            </section>
          )}
          {item.reason && (
            <section className="kb-feedback-section">
              <div className="kb-feedback-label">原因</div>
              <div className="kb-feedback-block">{item.reason}</div>
            </section>
          )}
          <section className="kb-feedback-section">
            <div className="kb-feedback-label">回答</div>
            <div className="kb-feedback-block is-pre">{item.answer || '（空）'}</div>
          </section>
          <section className="kb-feedback-section">
            <div className="kb-feedback-label">
              命中父块{item.embeddingModel ? ` · ${item.embeddingModel}` : ''}
            </div>
            {citations.length === 0 ? (
              <div className="kb-feedback-block">没有父块</div>
            ) : (
              citations.map((cite) => (
                <div key={`${cite.n}-${cite.parentId || cite.title}`} className="kb-feedback-cite">
                  <div className="kb-feedback-cite-title">
                    [{cite.n}] {cite.heading ? `${cite.title} / ${cite.heading}` : cite.title}
                  </div>
                  {cite.excerpt && <div className="kb-feedback-block is-pre">{cite.excerpt}</div>}
                </div>
              ))
            )}
          </section>
          <section className="kb-feedback-section">
            <div className="kb-feedback-label">收进评测集</div>
            <PromoteFields
              item={item}
              title={title}
              setTitle={setTitle}
              empty={empty}
              setEmpty={setEmpty}
              pending={pending}
              onPromote={onPromote}
              listId={`feedback-titles-reader-${item.id}`}
            />
            {error && <div className="kb-eval-error">{error}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}

function FeedbackCard({ item, onChange }) {
  const titles = titlesOf(item);
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [title, setTitle] = useState(titles[0] || '');
  const [empty, setEmpty] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const rewritten = item.rewrittenQuery && item.rewrittenQuery !== item.question ? item.rewrittenQuery : '';
  const preview = String(item.answer || '').replace(/\s+/g, ' ').trim();
  const labels = statusLabels(item);

  async function promote(kind) {
    setPending(kind);
    setError('');
    try {
      const result = await promoteAnswerFeedback(item.id, {
        kind,
        expectTitle: empty ? '' : title.trim(),
        expectEmpty: empty,
      });
      onChange(result.feedback);
    } catch (err) {
      setError(err.message || '收进评测集失败');
    } finally {
      setPending('');
    }
  }

  return (
    <article className={`kb-feedback-card${open ? ' is-open' : ''}`}>
      <div className="kb-feedback-head">
        <button
          type="button"
          className="kb-feedback-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="kb-feedback-q">{item.question}</span>
          {preview && <span className="kb-feedback-preview">{preview}</span>}
        </button>
        <div className="kb-feedback-head-actions">
          {labels.map((label) => (
            <span key={label} className="kb-feedback-chip">
              {label}
            </span>
          ))}
          <button type="button" className="kb-content-toggle" onClick={() => setReading(true)}>
            查看全部
          </button>
          <button type="button" className="kb-content-toggle" onClick={() => setOpen((value) => !value)}>
            {open ? '收起' : '展开'}
          </button>
        </div>
      </div>
      {open && (
        <div className="kb-feedback-body">
          {rewritten && <div className="kb-feedback-meta">评测将用改写后的问句：{rewritten}</div>}
          {item.reason && <div className="kb-feedback-meta">原因：{item.reason}</div>}
          <div className="kb-feedback-meta">
            命中：{titles.length ? titles.join('、') : '没有父块'}
            {item.embeddingModel ? ` · ${item.embeddingModel}` : ''}
          </div>
          {preview && <div className="kb-feedback-answer">{preview}</div>}
          <button type="button" className="kb-content-toggle" onClick={() => setReading(true)}>
            查看全部内容
          </button>
          <PromoteFields
            item={item}
            title={title}
            setTitle={setTitle}
            empty={empty}
            setEmpty={setEmpty}
            pending={pending}
            onPromote={promote}
            listId={`feedback-titles-card-${item.id}`}
          />
          {error && <div className="kb-eval-error">{error}</div>}
        </div>
      )}
      {reading && (
        <FeedbackReader
          item={item}
          title={title}
          setTitle={setTitle}
          empty={empty}
          setEmpty={setEmpty}
          pending={pending}
          error={error}
          onPromote={promote}
          onClose={() => setReading(false)}
        />
      )}
    </article>
  );
}

export default function AnswerFeedbackQueue() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    try {
      const next = await listUselessFeedback();
      setItems(next);
      setError('');
    } catch (err) {
      setError(err.message || '读取反馈失败');
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
            <div className="kb-rag-title">无用回答</div>
            {items.length > 0 && <span className="kb-feedback-count">{items.length}</span>}
          </div>
          <p className="kb-eval-desc">
            Agent 回答点「无用」后出现在这里。确认期望标题后才写入补充评测集，不会改种子题。
          </p>
        </div>
        <div className="kb-eval-actions">
          {items.length > 0 && (
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
      {open && items.length === 0 && !error && <div className="kb-feedback-none">还没有无用反馈。</div>}
      {open && items.length > 0 && (
        <div className="kb-feedback-list">
          {items.map((item) => (
            <FeedbackCard
              key={item.id}
              item={item}
              onChange={(next) => setItems((prev) => prev.map((row) => (row.id === next.id ? next : row)))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
