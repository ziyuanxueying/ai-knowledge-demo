import { useState } from 'react';

/**
 * 模型采样参数调节面板（方案 C）
 *
 * 实时调节 temperature / max_tokens，参数随请求发给后端覆盖默认值，
 * 下一条消息立即生效。偏好存 localStorage（见 useChat.js）。
 *
 * 交互与 MessagePreview 保持一致：
 * - 默认折叠，横条只占一行，不挤占消息区
 * - .is-open 类 + CSS 控制展开/折叠（DOM 常驻，避免高度塌陷）
 * - 横条用青绿渐变，与消息预览的蓝紫渐变视觉区分
 */

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;

function temperatureLabel(t) {
  if (t <= 0.3) return '稳定精确 · 适合事实/代码类问题';
  if (t <= 0.9) return '平衡 · 适合日常技术问答';
  if (t <= 1.3) return '较发散 · 适合头脑风暴';
  return '高度随机 · 适合创意写作（可能不稳定）';
}

export default function ParamPanel({ params, onChange, onReset }) {
  const [expanded, setExpanded] = useState(false);

  if (!params) return null;

  const { temperature, maxTokens } = params;
  const isDefault = temperature === DEFAULT_TEMPERATURE && maxTokens === DEFAULT_MAX_TOKENS;

  return (
    <div className={`param-panel ${expanded ? 'is-open' : ''}`}>
      <button
        type="button"
        className="param-panel-toggle"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls="param-panel-body"
      >
        <span className="param-panel-left">
          <span className="param-panel-icon">{expanded ? '▼' : '▶'}</span>
          <span className="param-panel-title">模型参数</span>
        </span>
        <span className="param-panel-right">
          <span className="param-panel-stat">temperature {temperature.toFixed(1)}</span>
          <span className="param-panel-stat">max_tokens {maxTokens}</span>
          <span className="param-panel-action">{expanded ? '收起' : '调节'}</span>
        </span>
      </button>

      <div
        id="param-panel-body"
        className="param-panel-body"
        role="region"
        aria-label="模型参数调节"
      >
        <div className="param-row">
          <div className="param-row-head">
            <label htmlFor="param-temperature" className="param-name">
              temperature（温度）
            </label>
            <span className="param-value">{temperature.toFixed(1)}</span>
          </div>
          <input
            id="param-temperature"
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => onChange({ temperature: Number.parseFloat(e.target.value) })}
            className="param-slider param-slider-temp"
          />
          <div className="param-scale">
            <span>0 精确</span>
            <span>0.7 默认</span>
            <span>2 发散</span>
          </div>
          <p className="param-desc">{temperatureLabel(temperature)}</p>
        </div>

        <div className="param-row">
          <div className="param-row-head">
            <label htmlFor="param-maxtokens" className="param-name">
              max_tokens（最大回复长度）
            </label>
            <span className="param-value">{maxTokens}</span>
          </div>
          <input
            id="param-maxtokens"
            type="range"
            min="256"
            max="4096"
            step="128"
            value={maxTokens}
            onChange={(e) => onChange({ maxTokens: Number.parseInt(e.target.value, 10) })}
            className="param-slider param-slider-max"
          />
          <div className="param-scale">
            <span>256 简短</span>
            <span>2048 默认</span>
            <span>4096 长文</span>
          </div>
          <p className="param-desc">限制 AI 单次回复的最大 token 数，防止回复过长。</p>
        </div>

        <div className="param-row-actions">
          <button
            type="button"
            className="param-reset-btn"
            onClick={onReset}
            disabled={isDefault}
          >
            恢复默认（temperature 0.7 / max_tokens 2048）
          </button>
          <span className="param-tip">参数即时生效，作用于下一条消息</span>
        </div>
      </div>
    </div>
  );
}
