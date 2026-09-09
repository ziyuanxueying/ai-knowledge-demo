import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  embedTexts,
  embedQuery,
  cosineSimilarity,
  hasEmbeddingConfig,
} from '../services/embedding.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_FILE = path.join(__dirname, 'knowledge.json');

/**
 * 知识库存储层（RAG 升级版）
 *
 * 【AI 学习要点 - RAG 检索增强生成】：
 * RAG = Retrieval-Augmented Generation（检索增强生成）
 * 流程：用户提问 → 检索相关知识 → 把知识塞进 prompt → 模型据此回答
 *
 * 本存储层在原 CRUD 基础上增加"向量化"能力：
 * - 每条条目存一份 embedding 向量（1024 维）
 * - 检索时用余弦相似度找语义最相近的 Top-K
 * - create/update 时自动（重新）生成向量
 * - 老条目无向量时，ensureEmbeddings() 懒补齐
 *
 * 与向量数据库的区别：这里直接在 JSON 里存向量、用 JS 算余弦相似度。
 * 条目量小（几十~几百）时性能完全够用，且零依赖、便于学习理解原理。
 * 生产环境数据量大时才需引入向量数据库（如 Milvus / pgvector）。
 */

// 种子数据：首次启动时写入，让 Agent 有内容可搜
const SEED_ENTRIES = [
  {
    title: '虚拟 DOM',
    keywords: ['virtual dom', '虚拟dom', '虚拟 dom'],
    category: '原理',
    content:
      '虚拟 DOM 是用 JS 对象描述真实 DOM 的树结构。框架先比对新旧虚拟 DOM（diff），再最小化地更新真实 DOM，避免全量重绘。React 和 Vue 都基于虚拟 DOM 实现高效渲染。',
  },
  {
    title: '闭包',
    keywords: ['闭包', 'closure'],
    category: '原理',
    content:
      '闭包是函数与其词法环境的组合。内部函数引用了外部函数的变量，导致该变量不会被回收。常用于数据私有化、柯里化、回调中保存状态。注意避免不当闭包造成内存泄漏。',
  },
  {
    title: '事件循环',
    keywords: ['事件循环', 'event loop', '宏任务', '微任务'],
    category: '原理',
    content:
      '事件循环是 JS 并发的核心机制：调用栈清空后，先执行所有微任务（Promise.then、queueMicrotask），再取一个宏任务（setTimeout、I/O）。微任务在每轮宏任务之间清空。',
  },
  {
    title: 'useEffect 与 useLayoutEffect',
    keywords: ['useeffect', 'uselayouteffect'],
    category: 'React',
    content:
      'useEffect 在浏览器绘制后异步执行，适合订阅、请求等副作用；useLayoutEffect 在 DOM 变更后、绘制前同步执行，适合读取布局并同步修改 DOM，避免闪烁。',
  },
  {
    title: 'SSR 服务端渲染',
    keywords: ['ssr', '服务端渲染', '服务器渲染'],
    category: '架构',
    content:
      'SSR 在服务器生成 HTML 字符串返回给浏览器，首屏更快、利于 SEO。框架如 Next.js（React）、Nuxt.js（Vue）提供开箱即用的 SSR 支持。需注意 hydration（注水）过程。',
  },
  {
    title: 'Tree Shaking',
    keywords: ['tree shaking', '摇树'],
    category: '工程化',
    content:
      'Tree Shaking 是打包器消除未使用代码的优化。基于 ES Module 静态分析，标记 export 中未被 import 的部分为副作用后删除。前提是使用 ESM 且 package.json 正确声明 sideEffects。',
  },
];

function ensureKbFile() {
  if (!fs.existsSync(KB_FILE)) {
    const seed = SEED_ENTRIES.map((e, i) => ({
      id: `kb_seed_${i + 1}`,
      ...e,
      embedding: null, // 种子数据初始无向量，首次检索时懒补齐
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    fs.writeFileSync(KB_FILE, JSON.stringify({ entries: seed }, null, 2), 'utf-8');
  }
}

function readAll() {
  ensureKbFile();
  return JSON.parse(fs.readFileSync(KB_FILE, 'utf-8'));
}

function writeAll(data) {
  fs.writeFileSync(KB_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function genId() {
  return `kb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 构造用于生成向量的文本：把标题/分类/关键词/内容拼成一段
 * 让 embedding 模型"看到"全部语义信息，向量更具区分度。
 */
function buildEmbedText(entry) {
  const kw = (entry.keywords || []).join('、');
  return `标题：${entry.title || ''}\n分类：${entry.category || ''}\n关键词：${kw}\n内容：${entry.content || ''}`;
}

/**
 * 为单条条目生成并保存向量（内部使用）
 * @param {object} entry - 条目（会被写入文件）
 * @param {object} data - 全量数据（用于落盘）
 * @returns {Promise<void>}
 */
async function embedEntry(entry, data) {
  if (!hasEmbeddingConfig()) {
    entry.embedding = null;
    return;
  }
  try {
    const [vector] = await embedTexts([buildEmbedText(entry)]);
    entry.embedding = vector;
  } catch {
    // 向量化失败不阻断写入，置空后续可补齐
    entry.embedding = null;
  }
  writeAll(data);
}

/**
 * 列出全部条目（按更新时间倒序）。
 * 向量字段体积大且对前端无意义，这里剥离掉不返回给 UI。
 */
export function listEntries() {
  const { entries } = readAll();
  return [...entries]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map(({ embedding, ...rest }) => rest);
}

/**
 * 获取单个条目（剥离向量）
 */
export function getEntry(id) {
  const { entries } = readAll();
  const e = entries.find((x) => x.id === id);
  if (!e) return null;
  const { embedding, ...rest } = e;
  return rest;
}

/**
 * 创建条目（自动向量化）
 */
export async function createEntry({ title, keywords = [], category = '', content = '' }) {
  const data = readAll();
  const now = new Date().toISOString();
  const entry = {
    id: genId(),
    title: String(title || '').trim(),
    keywords: Array.isArray(keywords) ? keywords.map((k) => String(k).trim()).filter(Boolean) : [],
    category: String(category || '').trim(),
    content: String(content || ''),
    embedding: null,
    createdAt: now,
    updatedAt: now,
  };
  data.entries.push(entry);
  await embedEntry(entry, data);
  const { embedding, ...rest } = entry;
  return rest;
}

/**
 * 更新条目（内容变化后自动重新向量化）
 */
export async function updateEntry(id, patch) {
  const data = readAll();
  const entry = data.entries.find((e) => e.id === id);
  if (!entry) return null;
  if (patch.title !== undefined) entry.title = String(patch.title).trim();
  if (patch.keywords !== undefined) {
    entry.keywords = Array.isArray(patch.keywords)
      ? patch.keywords.map((k) => String(k).trim()).filter(Boolean)
      : [];
  }
  if (patch.category !== undefined) entry.category = String(patch.category).trim();
  if (patch.content !== undefined) entry.content = String(patch.content);
  entry.updatedAt = new Date().toISOString();
  // 内容变了，向量失效，重新生成
  await embedEntry(entry, data);
  const { embedding, ...rest } = entry;
  return rest;
}

/**
 * 删除条目
 */
export function deleteEntry(id) {
  const data = readAll();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => e.id !== id);
  writeAll(data);
  return data.entries.length < before;
}

/**
 * 搜索条目 - 关键词匹配（title + keywords + content + category）
 * @param {string} query - 搜索词
 * @returns {Array} 匹配的条目数组（剥离向量）
 */
export function searchEntries(query) {
  if (!query) return [];
  const q = String(query).toLowerCase();
  const { entries } = readAll();
  return entries
    .filter((e) => {
      const inTitle = e.title.toLowerCase().includes(q);
      const inKeywords = e.keywords.some((k) => k.toLowerCase().includes(q) || q.includes(k.toLowerCase()));
      const inContent = e.content.toLowerCase().includes(q);
      const inCategory = e.category?.toLowerCase().includes(q);
      return inTitle || inKeywords || inContent || inCategory;
    })
    .map(({ embedding, ...rest }) => rest);
}

/**
 * 搜索条目 - 语义检索（RAG 核心）
 * 1. 先确保所有条目都有向量（懒补齐）
 * 2. 把查询向量化
 * 3. 与每条条目算余弦相似度
 * 4. 取相似度 >= threshold 的 Top-K
 *
 * @param {string} query - 用户查询
 * @param {number} topK - 返回最多多少条（默认 3）
 * @param {number} threshold - 相似度下限（默认 0.3，过滤无关结果）
 * @returns {Promise<Array>} [{ ...entry, score }] 按相似度降序
 */
export async function searchEntriesSemantic(query, topK = 3, threshold = 0.3) {
  if (!query) return [];
  await ensureEmbeddings();
  const { entries } = readAll();
  const withVector = entries.filter((e) => Array.isArray(e.embedding) && e.embedding.length);
  if (withVector.length === 0) {
    // 没有任何向量（如未配置 API Key），回退关键词检索
    return searchEntries(query).map((e) => ({ ...e, score: 0 }));
  }
  let qVec;
  try {
    qVec = await embedQuery(query);
  } catch {
    // 查询向量化失败，回退关键词检索
    return searchEntries(query).map((e) => ({ ...e, score: 0 }));
  }
  return withVector
    .map((e) => ({ entry: e, score: cosineSimilarity(qVec, e.embedding) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ entry, score }) => {
      const { embedding, ...rest } = entry;
      return { ...rest, score: Number(score.toFixed(4)) };
    });
}

/**
 * 检索对比：同时返回关键词检索与语义检索的结果
 * 供前端"检索对比面板"直观展示两种方式的召回差异。
 *
 * @param {string} query
 * @param {number} topK
 * @returns {Promise<{ query, keyword: Array, semantic: Array }>}
 */
export async function searchCompare(query, topK = 3) {
  if (!query) return { query: '', keyword: [], semantic: [] };
  const keyword = searchEntries(query);
  let semantic = [];
  try {
    semantic = await searchEntriesSemantic(query, topK, 0);
  } catch {
    semantic = [];
  }
  return { query, keyword, semantic };
}

/**
 * 补齐所有缺失向量的条目（懒补齐）
 * 首次语义检索、或手动点"生成向量"时调用。
 * @returns {Promise<{ total: number, embedded: number, before: number }>}
 */
export async function ensureEmbeddings() {
  const data = readAll();
  const missing = data.entries.filter(
    (e) => !Array.isArray(e.embedding) || e.embedding.length === 0
  );
  if (missing.length === 0) {
    return stats();
  }
  if (!hasEmbeddingConfig()) {
    return stats();
  }
  // 批量向量化，减少 API 调用次数
  const texts = missing.map(buildEmbedText);
  try {
    const vectors = await embedTexts(texts);
    missing.forEach((e, i) => {
      e.embedding = vectors[i] || null;
    });
  } catch {
    // 整批失败，逐条尝试（某条文本异常时不影响其他）
    for (const e of missing) {
      try {
        const [v] = await embedTexts([buildEmbedText(e)]);
        e.embedding = v;
      } catch {
        e.embedding = null;
      }
    }
  }
  writeAll(data);
  return stats();
}

/**
 * 重新生成全部条目的向量
 * 内容未变但换了 embedding 模型、或向量损坏时使用。
 * @returns {Promise<{ total: number, embedded: number, before: number }>}
 */
export async function regenerateAllEmbeddings() {
  const data = readAll();
  if (data.entries.length === 0 || !hasEmbeddingConfig()) {
    return stats();
  }
  const texts = data.entries.map(buildEmbedText);
  try {
    const vectors = await embedTexts(texts);
    data.entries.forEach((e, i) => {
      e.embedding = vectors[i] || null;
    });
  } catch {
    // 批量失败，逐条尝试
    for (const e of data.entries) {
      try {
        const [v] = await embedTexts([buildEmbedText(e)]);
        e.embedding = v;
      } catch {
        e.embedding = null;
      }
    }
  }
  writeAll(data);
  return stats();
}

/**
 * 统计：总数 / 已向量化 / 待向量化
 */
export function stats() {
  const { entries } = readAll();
  const total = entries.length;
  const embedded = entries.filter(
    (e) => Array.isArray(e.embedding) && e.embedding.length > 0
  ).length;
  return { total, embedded, pending: total - embedded };
}

/**
 * 把搜索结果格式化为给模型用的文本
 * （Agent 工具调用时使用，语义检索结果带相似度分）
 */
export function formatSearchResultText(query, results) {
  if (!results || results.length === 0) {
    return `知识库中未找到与 "${query}" 相关的内容。`;
  }
  const parts = results.map((e, i) => {
    const scoreText = typeof e.score === 'number' && e.score > 0 ? `（相似度 ${e.score}）` : '';
    return `【${i + 1}. ${e.title}】（分类：${e.category || '未分类'}）${scoreText}\n${e.content}`;
  });
  return `在知识库中找到 ${results.length} 条相关内容：\n\n${parts.join('\n\n')}`;
}
