import { FRONTEND_DEV_PROMPT, DEFAULT_PROMPT } from '../prompts/system.js';
import { getRenderedPrompt } from './promptStore.js';

/**
 * 前端开发知识库
 *
 * 【AI 学习要点】：
 * 知识库的作用是给 AI 提供业务专属信息，让它能回答通用模型不知道的问题。
 * 实现方式有几种：
 *   1. 简单方式：把知识写进 System Prompt（本项目采用）
 *   2. RAG 检索增强：用向量数据库检索相关知识，动态拼接到 Prompt
 *   3. 微调：用业务数据训练模型（成本高，效果最好）
 *
 * 本项目同时支持 1 和 2：System Prompt 可在线编辑，知识库可 RAG 检索。
 */

/**
 * 获取系统提示词
 *
 * 【AI 学习要点 - Prompt 在线编辑】：
 * 优先从 promptStore（prompts.json）读取渲染后的 prompt，
 * 让前端编辑器保存的 prompt 立即生效，无需重启。
 * 兜底用硬编码（prompts.json 不存在或被删时仍可用）。
 *
 * @param {string} scenario - 场景：frontend_dev / default
 */
export function getSystemPrompt(scenario = 'frontend_dev') {
  const rendered = getRenderedPrompt(scenario);
  if (rendered) return rendered;
  switch (scenario) {
    case 'frontend_dev':
      return FRONTEND_DEV_PROMPT;
    default:
      return DEFAULT_PROMPT;
  }
}

/**
 * 快捷问题列表（展示在前端，用户可点击快速提问）
 */
export const QUICK_QUESTIONS = [
  { id: 'q1', text: 'React 中 useEffect 和 useLayoutEffect 有什么区别？' },
  { id: 'q2', text: '如何用 CSS 实现一个垂直水平居中的布局？' },
  { id: 'q3', text: 'Vue 3 的 Composition API 相比 Options API 有什么优势？' },
  { id: 'q4', text: '前端如何优化首屏加载性能？' },
];
