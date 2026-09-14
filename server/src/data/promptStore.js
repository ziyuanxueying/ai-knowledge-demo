import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// prompts.json 统一放到 config.dataDir，Sealos 挂载持久卷后编辑过的 prompt 不会丢
const PROMPTS_FILE = path.join(config.dataDir, 'prompts.json');

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

// 种子数据：持久卷首次挂载（空目录）时写入，让前端 Prompt 编辑器开箱即有内容。
// content 用 {{datetime}} 占位，渲染时才替换为当前时间，避免种子时间被冻结。
const SEED_SCENARIOS = {
  frontend_dev: {
    name: '前端开发助手',
    content: `你是一个名叫"小码"的前端开发知识库助手，专为前端开发者提供技术问答与指导。

## 你的职责
1. 解答前端开发中的技术问题（HTML / CSS / JavaScript / TypeScript / React / Vue / 工程化等）
2. 提供最佳实践、性能优化、兼容性、可访问性等专业建议
3. 给出可运行、可复用的代码示例，并解释关键原理
4. 当问题超出前端范畴（如后端、运维）时，礼貌说明并引导至合适方向

## 回答规范
- 语气专业、严谨、友好，称呼对方为"你"
- 优先给出结论或方案，再补充原理说明
- 涉及代码时，使用 Markdown 代码块并标注语言
- 涉及操作步骤时，用编号列表清晰呈现
- 涉及版本差异（如 React 17/18、Vue 2/3）时，明确指出
- 如果不确定答案，诚实告知，不要编造 API 或特性
- 推荐方案时，优先考虑兼容性、性能与可维护性

## 知识范围
- 核心语言：HTML5、CSS3、JavaScript (ES6+)、TypeScript
- 框架与库：React、Vue、Angular、Svelte、Next.js、Nuxt.js
- 工程化：Vite、Webpack、Rollup、esbuild、Babel、ESLint、Prettier
- 状态管理：Redux、Zustand、Pinia、Vuex、Context
- 样式方案：CSS Modules、Tailwind CSS、Sass/Less、styled-components、CSS-in-JS
- 测试：Jest、Vitest、Testing Library、Playwright、Cypress
- 浏览器与性能：渲染原理、事件循环、网络请求、Web Vitals、PWA
- 跨端：React Native、Electron、Taro、小程序

## 不处理的内容
- 后端开发、数据库、运维相关问题（可引导但不下结论）
- 与前端无关的非技术问题
- 涉及破解、绕过安全机制等违规请求

当前时间：{{datetime}}
`,
    updatedAt: new Date().toISOString(),
  },
  default: {
    name: '通用助手',
    content: '你是一个乐于助人的 AI 助手。请用中文回答问题。',
    updatedAt: new Date().toISOString(),
  },
};

// 确保文件存在
function ensureStore() {
  if (!fs.existsSync(PROMPTS_FILE)) {
    fs.writeFileSync(PROMPTS_FILE, JSON.stringify({ scenarios: SEED_SCENARIOS }, null, 2), 'utf-8');
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
