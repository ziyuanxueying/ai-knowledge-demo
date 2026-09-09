import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { getPrompts, sendCompareMessage } from '../utils/api.js';

/**
 * A/B 对比实验室（方案 D + 方案 E 裁判评分）
 *
 * 【方案 D - A/B 对比】：同一个问题用两套参数并行请求，后端在同一条 SSE
 * 连接里交错推送两路流，前端左右两栏同时逐字渲染，直观对比 temperature /
 * max_tokens 对回答风格、速度、长度的影响。对比不带历史/摘要/RAG，是干净单轮。
 *
 * 【方案 E - LLM 裁判】：勾选裁判后，两路回答完成，后端再调用一个裁判模型
 * （低温 0.1 保证稳定），按准确性/完整性/清晰度/实用性 4 个维度打分，
 * 返回结构化 JSON，前端渲染成胜者 banner + 分数条 + 简评。
 */

const EMPTY_RESULT = { status: 'idle', content: '', usage: null, elapsedMs: null, chars: 0 };

export default function CompareLab({ onBack }) {
  const [scenarios, setScenarios] = useState([]);
  const [scenario, setScenario] = useState('frontend_dev');
  const [question, setQuestion] = useState('');
  const [variants, setVariants] = useState([
    { id: 'a', label: '方案 A · 低温（稳定精确）', temperature: 0.2, maxTokens: 1024 },
    { id: 'b', label: '方案 B · 高温（发散创意）', temperature: 1.5, maxTokens: 1024 },
  ]);
  const [results, setResults] = useState([
    { ...EMPTY_RESULT, id: 'a' },
    { ...EMPTY_RESULT, id: 'b' },
  ]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // 方案 E：LLM 裁判评分状态
  const [judgeEnabled, setJudgeEnabled] = useState(true);
  const [judge, setJudge] = useState({ status: 'idle', verdict: null, labels: null, error: null });
  const abortRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await getPrompts();
        setScenarios(data.scenarios || []);
      } catch {
        // 角色列表加载失败时静默，下拉框回退为只有默认场景
      }
    })();
  }, []);

  const updateVariant = (idx, patch) => {
    setVariants((prev) => prev.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  };

  const patchResult = (idx, patch) => {
    setResults((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const runCompare = async () => {
    if (!question.trim() || loading) return;
    setError(null);
    setLoading(true);
    setResults([
      { ...EMPTY_RESULT, id: 'a', status: 'streaming' },
      { ...EMPTY_RESULT, id: 'b', status: 'streaming' },
    ]);
    setJudge({ status: judgeEnabled ? 'waiting' : 'idle', verdict: null, labels: null, error: null });

    const controller = new AbortController();
    abortRef.current = controller;

    await sendCompareMessage(
      {
        message: question.trim(),
        variants: variants.map((v) => ({ ...v, scenario })),
        judge: judgeEnabled,
      },
      {
        signal: controller.signal,
        onVariantStart: (idx, data) => {
          patchResult(idx, {
            status: 'streaming',
            params: data.params,
            label: data.label,
          });
        },
        onChunk: (idx, content) => {
          setResults((prev) =>
            prev.map((r, i) =>
              i === idx ? { ...r, content: r.content + content, chars: r.chars + content.length } : r
            )
          );
        },
        onVariantDone: (idx, data) => {
          patchResult(idx, {
            status: data.failed ? 'error' : data.aborted ? 'aborted' : 'done',
            usage: data.usage || null,
            elapsedMs: data.elapsedMs ?? null,
            errorText: data.error || null,
          });
        },
        onJudgeStart: () => {
          setJudge((prev) => ({ ...prev, status: 'judging' }));
        },
        onJudgeDone: (verdict, labels) => {
          setJudge({ status: 'done', verdict, labels, error: null });
        },
        onJudgeError: (msg) => {
          setJudge((prev) => ({ ...prev, status: 'error', error: msg }));
        },
        onError: (msg) => {
          setError(msg);
          setLoading(false);
        },
        onDone: () => {
          setLoading(false);
          abortRef.current = null;
        },
      }
    );
  };

  const stopCompare = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setResults((prev) =>
      prev.map((r) => (r.status === 'streaming' ? { ...r, status: 'aborted' } : r))
    );
    // 中断后裁判不会再返回，复位裁判区避免卡在"评分中"
    setJudge((prev) =>
      prev.status === 'waiting' || prev.status === 'judging' ? { ...prev, status: 'idle' } : prev
    );
  };

  return (
    <div className="compare-lab">
      <header className="compare-lab-header">
        <button type="button" className="back-btn" onClick={onBack}>
          ← 返回聊天
        </button>
        <h2>⚡ A/B 对比实验室</h2>
        <p className="compare-lab-subtitle">
          同一个问题用两套参数并行请求，左右两栏同时流式输出；可开启 AI 裁判按 4 个维度自动打分。
        </p>
      </header>

      <div className="compare-lab-body">
        {/* 配置区 */}
        <section className="compare-config">
          <div className="compare-config-row">
            <label className="compare-field">
              <span className="compare-field-label">角色场景（两边共用）</span>
              <select
                className="compare-select"
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
                disabled={loading}
              >
                {scenarios.length === 0 && <option value="frontend_dev">前端开发助手</option>}
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="compare-variants">
            {variants.map((v, idx) => (
              <div key={v.id} className={`compare-variant-card variant-${idx}`}>
                <input
                  className="compare-variant-label"
                  value={v.label}
                  onChange={(e) => updateVariant(idx, { label: e.target.value })}
                  disabled={loading}
                  aria-label={`方案 ${String.fromCharCode(65 + idx)} 名称`}
                />
                <div className="compare-slider-row">
                  <label htmlFor={`cmp-temp-${idx}`}>
                    temperature <strong>{v.temperature.toFixed(1)}</strong>
                  </label>
                  <input
                    id={`cmp-temp-${idx}`}
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={v.temperature}
                    onChange={(e) => updateVariant(idx, { temperature: Number.parseFloat(e.target.value) })}
                    disabled={loading}
                    className="param-slider param-slider-temp"
                  />
                </div>
                <div className="compare-slider-row">
                  <label htmlFor={`cmp-max-${idx}`}>
                    max_tokens <strong>{v.maxTokens}</strong>
                  </label>
                  <input
                    id={`cmp-max-${idx}`}
                    type="range"
                    min="256"
                    max="4096"
                    step="128"
                    value={v.maxTokens}
                    onChange={(e) => updateVariant(idx, { maxTokens: Number.parseInt(e.target.value, 10) })}
                    disabled={loading}
                    className="param-slider param-slider-max"
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="compare-question-row">
            <textarea
              className="compare-question-input"
              placeholder="输入要对比的问题，例如：用一句话解释什么是闭包"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              disabled={loading}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  runCompare();
                }
              }}
            />
            {loading ? (
              <button type="button" className="compare-stop-btn" onClick={stopCompare}>
                停止对比
              </button>
            ) : (
              <button
                type="button"
                className="compare-run-btn"
                onClick={runCompare}
                disabled={!question.trim()}
              >
                开始对比
              </button>
            )}
          </div>

          <label className="compare-judge-toggle">
            <input
              type="checkbox"
              checked={judgeEnabled}
              onChange={(e) => setJudgeEnabled(e.target.checked)}
              disabled={loading}
            />
            <span>
              <strong>⚖ 启用 AI 裁判评分</strong>
              <em>两路回答完成后，裁判模型按 4 个维度（准确性/完整性/清晰度/实用性）自动打分并裁定胜者</em>
            </span>
          </label>
          {error && <div className="compare-error">⚠ {error}</div>}
        </section>

        {/* 结果区：左右两栏 */}
        <section className="compare-results">
          {results.map((r, idx) => (
            <div key={r.id} className={`compare-result-card variant-${idx}`}>
              <div className="compare-result-head">
                <span className="compare-result-badge">
                  {String.fromCharCode(65 + idx)}
                </span>
                <span className="compare-result-label">{variants[idx].label}</span>
                <span className="compare-result-params">
                  temp {variants[idx].temperature.toFixed(1)} · max {variants[idx].maxTokens}
                </span>
              </div>

              <div className="compare-result-body">
                {r.status === 'idle' && (
                  <div className="compare-result-empty">
                    点击「开始对比」后，这里会显示方案 {String.fromCharCode(65 + idx)} 的流式回答
                  </div>
                )}
                {r.status === 'error' && (
                  <div className="compare-result-error">调用失败：{r.errorText || '未知错误'}</div>
                )}
                {r.status === 'aborted' && (
                  <div className="compare-result-aborted">已停止{r.content ? '（以下为已生成部分）' : ''}</div>
                )}
                {r.content && (
                  <div className="compare-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                      {r.content}
                    </ReactMarkdown>
                    {r.status === 'streaming' && <span className="cursor" />}
                  </div>
                )}
                {r.status === 'streaming' && !r.content && (
                  <span className="compare-thinking">思考中...</span>
                )}
              </div>

              {r.status !== 'idle' && (
                <div className="compare-result-meta">
                  {r.status === 'done' && r.usage && (
                    <>
                      <span>✅ 完成</span>
                      <span>耗时 {(r.elapsedMs / 1000).toFixed(1)}s</span>
                      <span>输出 {r.usage.completion_tokens} tokens</span>
                      <span>{r.chars} 字</span>
                    </>
                  )}
                  {r.status === 'streaming' && <span className="compare-live">● 生成中... {r.chars} 字</span>}
                  {r.status === 'aborted' && <span>⏹ 已中断</span>}
                  {r.status === 'error' && <span>❌ 失败</span>}
                </div>
              )}
            </div>
          ))}
        </section>

        {/* 方案 E：AI 裁判评分报告 */}
        {judgeEnabled && judge.status !== 'idle' && (
          <section className="judge-report">
            <h3 className="judge-report-title">⚖ AI 裁判评分</h3>

            {(judge.status === 'waiting' || judge.status === 'judging') && (
              <div className="judge-loading">
                <span className="judge-spinner" />
                {judge.status === 'waiting' ? '等待两路回答完成…' : '裁判正在阅读两路回答并打分…'}
              </div>
            )}

            {judge.status === 'error' && (
              <div className="judge-error">⚠ 裁判评分失败：{judge.error}（两路回答仍可正常对比）</div>
            )}

            {judge.status === 'done' && judge.verdict && (
              <JudgeVerdict verdict={judge.verdict} labels={judge.labels} />
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** 裁判评分结果：胜者 banner + 维度分数条 + 双方简评 + 总评语 */
function JudgeVerdict({ verdict, labels }) {
  const { A, B, winner, summary, dimensions } = verdict;
  const winnerText =
    winner === 'tie'
      ? '🤝 势均力敌（平局）'
      : `🏆 ${winner === 'A' ? labels?.A || '方案 A' : labels?.B || '方案 B'} 胜出`;

  return (
    <>
      <div className={`judge-winner ${winner === 'tie' ? 'is-tie' : winner === 'A' ? 'win-a' : 'win-b'}`}>
        <span className="judge-winner-text">{winnerText}</span>
        <span className="judge-winner-score">
          总分 <b className="score-a">{A.total}</b> vs <b className="score-b">{B.total}</b>（满分 40）
        </span>
      </div>

      <div className="judge-dims">
        {dimensions.map((dim) => (
          <div key={dim.key} className="judge-dim-row">
            <div className="judge-dim-name" title={dim.desc}>
              {dim.label}
            </div>
            <div className="judge-bars">
              <div className="judge-bar-line">
                <span className="judge-bar-tag">A</span>
                <div className="judge-bar-track">
                  <div
                    className={`judge-bar-fill bar-a ${A.scores[dim.key] >= B.scores[dim.key] ? 'is-lead' : ''}`}
                    style={{ width: `${A.scores[dim.key] * 10}%` }}
                  >
                    {A.scores[dim.key]}
                  </div>
                </div>
              </div>
              <div className="judge-bar-line">
                <span className="judge-bar-tag">B</span>
                <div className="judge-bar-track">
                  <div
                    className={`judge-bar-fill bar-b ${B.scores[dim.key] > A.scores[dim.key] ? 'is-lead' : ''}`}
                    style={{ width: `${B.scores[dim.key] * 10}%` }}
                  >
                    {B.scores[dim.key]}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="judge-comments">
        <div className="judge-comment variant-0">
          <span className="judge-comment-badge">A</span>
          <p>{A.comment}</p>
        </div>
        <div className="judge-comment variant-1">
          <span className="judge-comment-badge">B</span>
          <p>{B.comment}</p>
        </div>
      </div>

      {summary && (
        <div className="judge-summary">
          <span className="judge-summary-label">裁判总结</span>
          <p>{summary}</p>
        </div>
      )}
    </>
  );
}
