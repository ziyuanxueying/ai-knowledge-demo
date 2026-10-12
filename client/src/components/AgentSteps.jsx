import { useState } from 'react';

/**
 * Agent 步骤展示
 *
 * 知识库检索打在子块上，送给模型的是父块全文。
 * 步骤里默认只显示命中子块的一行摘要，点开才看父块，避免整段原文占满对话。
 */

const TOOL_LABELS = {
  search_frontend_kb: '搜索知识库',
  get_npm_package_info: '查询 npm',
  analyze_code: '分析代码',
};

function toolLabel(name) {
  return TOOL_LABELS[name] || name;
}

function Highlighted({ text, start, end }) {
  if (text == null) return null;
  const from = Number(start) || 0;
  const to = Number(end) || 0;
  if (to <= from || to > text.length) return text;
  return (
    <>
      {text.slice(0, from)}
      <mark className="cite-hit">{text.slice(from, to)}</mark>
      {text.slice(to)}
    </>
  );
}

function parentWindow(text, start, end) {
  const from = Math.max(0, start - 36);
  const to = Math.min(text.length, Math.max(end + 36, from + 220));
  const lead = from > 0 ? '…' : '';
  const tail = to < text.length ? '…' : '';
  const pad = lead.length;
  return {
    text: `${lead}${text.slice(from, to)}${tail}`,
    start: start - from + pad,
    end: end - from + pad,
  };
}

function KbHit({ hit }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const label = hit.heading ? `${hit.title} / ${hit.heading}` : hit.title;
  const excerpt = hit.excerpt || '';
  const previewBody = String(hit.preview || '').replace(/…$/, '');
  const expandable = excerpt.replace(/\s+/g, ' ').trim().length > previewBody.length;
  const start = Number(hit.highlightStart) || 0;
  const end = Number(hit.highlightEnd) || 0;
  const long = excerpt.length > 280;
  const view = open && long && !full ? parentWindow(excerpt, start, end) : null;

  const summary = (
    <>
      <span className="agent-kb-hit-title">
        [{hit.n}] {label}
      </span>
      {hit.preview && <span className="agent-kb-hit-preview">{hit.preview}</span>}
      {expandable && <span className="agent-kb-hit-action">{open ? '收起父块' : '父块'}</span>}
    </>
  );

  return (
    <div className="agent-kb-hit">
      {expandable ? (
        <button
          type="button"
          className="agent-kb-hit-btn"
          onClick={() => {
            setOpen((value) => !value);
            setFull(false);
          }}
          aria-expanded={open}
        >
          {summary}
        </button>
      ) : (
        <div className="agent-kb-hit-btn is-static">{summary}</div>
      )}
      {open && expandable && (
        <div className="agent-kb-parent">
          <Highlighted
            text={view ? view.text : excerpt}
            start={view ? view.start : start}
            end={view ? view.end : end}
          />
          {long && (
            <button type="button" className="kb-content-toggle" onClick={() => setFull((value) => !value)}>
              {full ? '收起' : '展开完整父块'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function KbHits({ hits }) {
  if (!hits?.length) return null;
  return (
    <div className="agent-kb-hits">
      <div className="agent-kb-note">命中 {hits.length} 条子块，点开查看对应父块</div>
      {hits.map((hit) => (
        <KbHit key={`${hit.n}-${hit.title}`} hit={hit} />
      ))}
    </div>
  );
}

function PlainResult({ text }) {
  const [open, setOpen] = useState(false);
  const value = String(text || '');
  if (!value) return null;
  const long = value.length > 160 || value.split('\n').length > 4;
  return (
    <div className="agent-tool-result">
      <pre className={`agent-tool-result-text${open || !long ? ' is-open' : ''}`}>{value}</pre>
      {long && (
        <button type="button" className="kb-content-toggle" onClick={() => setOpen((value) => !value)}>
          {open ? '收起' : '展开'}
        </button>
      )}
    </div>
  );
}

export default function AgentSteps({ steps }) {
  if (!steps || steps.length === 0) return null;

  return (
    <div className="agent-steps">
      <div className="agent-steps-title">Agent 执行步骤</div>
      {steps.map((s) => (
        <div key={s.step} className="agent-step">
          <div className="agent-step-header">
            <span className="agent-step-num">第 {s.step} 步</span>
            <span className="agent-step-plan">
              {s.plan && s.plan.length > 0
                ? s.plan.map((p) => toolLabel(p.toolName)).join('、')
                : '生成最终回答'}
            </span>
          </div>
          {(s.tools || []).map((t, idx) => {
            const kbHits = t.toolName === 'search_frontend_kb' ? t.hits : null;
            return (
              <div key={`${s.step}-${idx}`} className="agent-tool">
                <div className="agent-tool-head">
                  <span className="agent-tool-name">{toolLabel(t.toolName)}</span>
                  {t.args && Object.keys(t.args).length > 0 && (
                    <details className="agent-tool-args">
                      <summary>参数</summary>
                      <pre>{JSON.stringify(t.args, null, 2)}</pre>
                    </details>
                  )}
                </div>
                {kbHits?.length ? <KbHits hits={kbHits} /> : <PlainResult text={t.result} />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
