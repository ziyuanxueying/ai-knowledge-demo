import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_FILE = path.join(__dirname, 'prompts.json');

/**
 * Prompt 存储层
 *
 * 【AI 学习要点 - Prompt 工程可视化】：
 * 把 System Prompt 从代码里抽出来存到 JSON 文件，实现"运行时可改"。
 * 之前改 Prompt 要改 system.js + 重启后端；现在用编辑器保存即可生效。
 *
 * 设计要点：
 * - 文件存储简单直观（学习项目够用，生产可换数据库）
 * - 内置变量 {{datetime}} 等，运行时插值，让 prompt 能感知当前时间
 * - 渲染与原始分离：编辑器显示原始（含 {{}}），模型调用用渲染后
 */

// 确保文件存在
function ensureStore() {
  if (!fs.existsSync(PROMPTS_FILE)) {
    fs.writeFileSync(PROMPTS_FILE, JSON.stringify({ scenarios: {} }, null, 2), 'utf-8');
  }
}

function readAll() {
  ensureStore();
  return JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf-8'));
}

function writeAll(data) {
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// 内置变量：在 prompt 中用 {{xxx}} 引用，运行时替换
// 【AI 学习要点 - 模板插值】：让 prompt 不再是死字符串，能动态拼装
const BUILTIN_VARS = {
  datetime: () => new Date().toLocaleString('zh-CN'),
  date: () => new Date().toLocaleDateString('zh-CN'),
  time: () => new Date().toLocaleTimeString('zh-CN'),
  weekday: () => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date().getDay()],
};

/**
 * 应用变量插值：把 {{var}} 替换为运行时值
 * 未知变量保留原样（不报错，方便用户自定义占位符）
 */
export function applyVars(content, extraVars = {}) {
  if (!content) return '';
  return content.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    const fn = BUILTIN_VARS[name];
    if (fn) return fn();
    if (extraVars[name] !== undefined) return String(extraVars[name]);
    return match;
  });
}

/** 列出所有 scenario（不含 content 全文，避免列表过大） */
export function listScenarios() {
  const { scenarios } = readAll();
  return Object.entries(scenarios).map(([id, s]) => ({
    id,
    name: s.name,
    contentLength: s.content?.length || 0,
    updatedAt: s.updatedAt,
  }));
}

/** 取原始 prompt（编辑器显示用，含未渲染的 {{}}） */
export function getRawPrompt(scenario) {
  const { scenarios } = readAll();
  return scenarios[scenario] ? { ...scenarios[scenario] } : null;
}

/** 取渲染后的 prompt（发给模型用，{{}} 已被替换） */
export function getRenderedPrompt(scenario, extraVars = {}) {
  const raw = getRawPrompt(scenario);
  if (!raw) return null;
  return applyVars(raw.content, extraVars);
}

/** 更新 prompt */
export function updatePrompt(scenario, { name, content }) {
  const data = readAll();
  if (!data.scenarios[scenario]) {
    data.scenarios[scenario] = { name: name || scenario, content: '' };
  }
  if (name !== undefined) data.scenarios[scenario].name = name;
  if (content !== undefined) data.scenarios[scenario].content = content;
  data.scenarios[scenario].updatedAt = new Date().toISOString();
  writeAll(data);
  return data.scenarios[scenario];
}

/** 列出可用变量名（前端编辑器展示用） */
export function getAvailableVars() {
  return Object.keys(BUILTIN_VARS);
}
