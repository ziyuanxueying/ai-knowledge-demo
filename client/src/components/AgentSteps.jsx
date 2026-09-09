/**
 * Agent 步骤展示组件
 *
 * 【AI 学习要点 - Agent 的"思考过程"可视化】：
 * Agent 与普通聊天的最大体验差异：能看到 AI 在回答前做了什么。
 * 每一步 (step) 包含：
 *   - plan: AI 计划调用的工具列表
 *   - tools: 实际执行的工具及其参数和结果
 */
export default function AgentSteps({ steps }) {
  if (!steps || steps.length === 0) return null;

  return (
    <div className="agent-steps">
      <div className="agent-steps-title">🤖 Agent 执行步骤</div>
      {steps.map((s) => (
        <div key={s.step} className="agent-step">
          <div className="agent-step-header">
            <span className="agent-step-num">第 {s.step} 步</span>
            <span className="agent-step-plan">
              {s.plan && s.plan.length > 0
                ? `调用工具：${s.plan.map((p) => p.toolName).join(', ')}`
                : '生成最终回答'}
            </span>
          </div>
          {(s.tools || []).map((t, idx) => (
            <div key={`${s.step}-${idx}`} className="agent-tool">
              <div className="agent-tool-head">
                <span className="agent-tool-name">🔧 {t.toolName}</span>
                <details className="agent-tool-args">
                  <summary>参数</summary>
                  <pre>{JSON.stringify(t.args, null, 2)}</pre>
                </details>
              </div>
              <div className="agent-tool-result">
                <span className="agent-tool-result-label">结果：</span>
                <pre className="agent-tool-result-text">{t.result}</pre>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
