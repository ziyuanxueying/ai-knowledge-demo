/**
 * 知识库存储层（PostgreSQL + pgvector 版）
 *
 * 【从 SQLite 迁移到 PostgreSQL 的改变】：
 * - embedding 从「JSON 字符串存 TEXT」改为 pgvector 的 vector 类型
 * - 语义检索从「全量读内存 + JS 算余弦相似度」改为数据库内 <=> 余弦距离算子
 * - better-sqlite3 同步 API → pg 异步 API，所有函数改为 async
 *
 * 【保持不变】：
 * - 所有导出函数的返回值结构不变，仅同步变异步
 * - 关键词检索、相似度阈值、Top-K 等逻辑不变
 */

import { query as sql, withTransaction, toVectorSql } from './db.js';
import {
  embedTexts,
  embedQuery,
  hasEmbeddingConfig,
} from '../services/embedding.service.js';

// 种子数据：表为空且没有 knowledge.json 时写入，让 Agent 有内容可搜
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

const ENTRY_COLS = 'id, title, keywords, category, content, "createdAt", "updatedAt"';

function genId() {
  return `kb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseEmbedding(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 构造用于生成向量的文本：把标题/分类/关键词/内容拼成一段
 */
function buildEmbedText(entry) {
  const kw = (entry.keywords || []).join('、');
  return `标题：${entry.title || ''}\n分类：${entry.category || ''}\n关键词：${kw}\n内容：${entry.content || ''}`;
}

/**
 * 把数据库行转换为 API 返回格式（剥离 embedding，解析 keywords）
 */
function rowToEntry(row, { stripEmbedding = true } = {}) {
  if (!row) return null;
  const entry = {
    id: row.id,
    title: row.title,
    keywords: JSON.parse(row.keywords || '[]'),
    category: row.category,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (!stripEmbedding && row.embedding) {
    entry.embedding = parseEmbedding(row.embedding);
  }
  return entry;
}

/**
 * 为单条条目生成并保存向量
 */
async function embedEntry(id, entry) {
  if (!hasEmbeddingConfig()) {
    return null;
  }
  try {
    const [vector] = await embedTexts([buildEmbedText(entry)]);
    await sql('UPDATE kb_entries SET embedding = $1::vector WHERE id = $2', [toVectorSql(vector), id]);
    return vector;
  } catch {
    await sql('UPDATE kb_entries SET embedding = NULL WHERE id = $1', [id]);
    return null;
  }
}

/**
 * 首次启动：表为空时写入种子条目（由 app.js 在 initDB 之后调用）
 */
export async function seedIfEmpty() {
  const count = (await sql('SELECT COUNT(*)::int AS c FROM kb_entries')).rows[0].c;
  if (count > 0) return;

  const now = new Date().toISOString();
  await withTransaction(async (client) => {
    for (let i = 0; i < SEED_ENTRIES.length; i++) {
      const e = SEED_ENTRIES[i];
      await client.query(
        `INSERT INTO kb_entries (id, title, keywords, category, content, embedding, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
        [`kb_seed_${i + 1}`, e.title, JSON.stringify(e.keywords || []), e.category || '', e.content || '', now, now]
      );
    }
  });
  console.log(`[DB] 已写入 ${SEED_ENTRIES.length} 条种子知识库数据`);
}

/**
 * 列出全部条目（按更新时间倒序，剥离向量）
 */
export async function listEntries() {
  const res = await sql(`SELECT ${ENTRY_COLS} FROM kb_entries ORDER BY "updatedAt" DESC`);
  return res.rows.map((r) => rowToEntry(r));
}

/**
 * 获取单个条目（剥离向量）
 */
export async function getEntry(id) {
  const res = await sql(`SELECT ${ENTRY_COLS} FROM kb_entries WHERE id = $1`, [id]);
  return rowToEntry(res.rows[0]);
}

/**
 * 创建条目（自动向量化）
 */
export async function createEntry({ title, keywords = [], category = '', content = '' }) {
  const now = new Date().toISOString();
  const id = genId();
  const entry = {
    id,
    title: String(title || '').trim(),
    keywords: Array.isArray(keywords) ? keywords.map((k) => String(k).trim()).filter(Boolean) : [],
    category: String(category || '').trim(),
    content: String(content || ''),
  };
  await sql(
    `INSERT INTO kb_entries (id, title, keywords, category, content, embedding, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
    [entry.id, entry.title, JSON.stringify(entry.keywords), entry.category, entry.content, now, now]
  );
  await embedEntry(id, entry);
  const res = await sql(`SELECT ${ENTRY_COLS} FROM kb_entries WHERE id = $1`, [id]);
  return rowToEntry(res.rows[0]);
}

/**
 * 更新条目（内容变化后自动重新向量化）
 */
export async function updateEntry(id, patch) {
  const rowRes = await sql(`SELECT ${ENTRY_COLS} FROM kb_entries WHERE id = $1`, [id]);
  const row = rowRes.rows[0];
  if (!row) return null;
  const entry = rowToEntry(row);
  if (patch.title !== undefined) entry.title = String(patch.title).trim();
  if (patch.keywords !== undefined) {
    entry.keywords = Array.isArray(patch.keywords)
      ? patch.keywords.map((k) => String(k).trim()).filter(Boolean)
      : [];
  }
  if (patch.category !== undefined) entry.category = String(patch.category).trim();
  if (patch.content !== undefined) entry.content = String(patch.content);
  const now = new Date().toISOString();
  await sql(
    `UPDATE kb_entries
     SET title = $1, keywords = $2, category = $3, content = $4, embedding = NULL, "updatedAt" = $5
     WHERE id = $6`,
    [entry.title, JSON.stringify(entry.keywords), entry.category, entry.content, now, id]
  );
  await embedEntry(id, entry);
  const res = await sql(`SELECT ${ENTRY_COLS} FROM kb_entries WHERE id = $1`, [id]);
  return rowToEntry(res.rows[0]);
}

/**
 * 删除条目
 */
export async function deleteEntry(id) {
  const res = await sql('DELETE FROM kb_entries WHERE id = $1', [id]);
  return res.rowCount > 0;
}

/**
 * 搜索条目 - 关键词匹配（title + keywords + content + category）
 */
export async function searchEntries(queryText) {
  if (!queryText) return [];
  const q = String(queryText).toLowerCase();
  const res = await sql(
    `SELECT ${ENTRY_COLS} FROM kb_entries
     WHERE strpos(lower(title), $1) > 0
        OR strpos(lower(category), $1) > 0
        OR strpos(lower(content), $1) > 0
        OR strpos(lower(keywords), $1) > 0
        OR EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(keywords::jsonb) AS kw
             WHERE strpos($1, lower(kw)) > 0
           )
     ORDER BY "updatedAt" DESC`,
    [q]
  );
  return res.rows.map((row) => rowToEntry(row));
}

/**
 * 搜索条目 - 语义检索（RAG 核心，pgvector 余弦距离）
 */
export async function searchEntriesSemantic(queryText, topK = 3, threshold = 0.3) {
  if (!queryText) return [];
  await ensureEmbeddings();

  if (!hasEmbeddingConfig()) {
    return (await searchEntries(queryText)).map((e) => ({ ...e, score: 0 }));
  }

  let qVec;
  try {
    qVec = await embedQuery(queryText);
  } catch {
    return (await searchEntries(queryText)).map((e) => ({ ...e, score: 0 }));
  }

  // <=> 是余弦距离（越小越相似），相似度 score = 1 - distance
  // (distance <= 1 - threshold) 等价于 (score >= threshold)
  const res = await sql(
    `SELECT ${ENTRY_COLS.split(', ').map((c) => `k.${c}`).join(', ')},
            1 - (k.embedding <=> q.v) AS score
     FROM kb_entries k, (SELECT $1::vector AS v) AS q
     WHERE k.embedding IS NOT NULL AND (k.embedding <=> q.v) <= $2
     ORDER BY k.embedding <=> q.v
     LIMIT $3`,
    [toVectorSql(qVec), 1 - threshold, topK]
  );

  return res.rows.map((row) => ({
    ...rowToEntry(row),
    score: Number(Number(row.score).toFixed(4)),
  }));
}

/**
 * 检索对比：同时返回关键词检索与语义检索的结果
 */
export async function searchCompare(queryText, topK = 3) {
  if (!queryText) return { query: '', keyword: [], semantic: [] };
  const keyword = await searchEntries(queryText);
  let semantic = [];
  try {
    semantic = await searchEntriesSemantic(queryText, topK, 0);
  } catch {
    semantic = [];
  }
  return { query: queryText, keyword, semantic };
}

/**
 * 补齐所有缺失向量的条目（懒补齐）
 */
export async function ensureEmbeddings() {
  const missing = (await sql(`SELECT ${ENTRY_COLS} FROM kb_entries WHERE embedding IS NULL`)).rows;
  if (missing.length === 0) return stats();
  if (!hasEmbeddingConfig()) return stats();

  const texts = missing.map((row) => buildEmbedText(rowToEntry(row)));
  try {
    const vectors = await embedTexts(texts);
    await withTransaction(async (client) => {
      for (let i = 0; i < missing.length; i++) {
        if (vectors[i]) {
          await client.query('UPDATE kb_entries SET embedding = $1::vector WHERE id = $2', [
            toVectorSql(vectors[i]),
            missing[i].id,
          ]);
        }
      }
    });
  } catch {
    for (const row of missing) {
      try {
        const [v] = await embedTexts([buildEmbedText(rowToEntry(row))]);
        await sql('UPDATE kb_entries SET embedding = $1::vector WHERE id = $2', [toVectorSql(v), row.id]);
      } catch {
        // 置空，后续可重试
      }
    }
  }
  return stats();
}

/**
 * 重新生成全部条目的向量
 */
export async function regenerateAllEmbeddings() {
  const allRows = (await sql(`SELECT ${ENTRY_COLS} FROM kb_entries`)).rows;
  if (allRows.length === 0 || !hasEmbeddingConfig()) return stats();

  const texts = allRows.map((row) => buildEmbedText(rowToEntry(row)));
  try {
    const vectors = await embedTexts(texts);
    await withTransaction(async (client) => {
      for (let i = 0; i < allRows.length; i++) {
        await client.query('UPDATE kb_entries SET embedding = $1::vector WHERE id = $2', [
          vectors[i] ? toVectorSql(vectors[i]) : null,
          allRows[i].id,
        ]);
      }
    });
  } catch {
    for (const row of allRows) {
      try {
        const [v] = await embedTexts([buildEmbedText(rowToEntry(row))]);
        await sql('UPDATE kb_entries SET embedding = $1::vector WHERE id = $2', [toVectorSql(v), row.id]);
      } catch {
        // 置空
      }
    }
  }
  return stats();
}

/**
 * 统计：总数 / 已向量化 / 待向量化
 */
export async function stats() {
  const total = (await sql('SELECT COUNT(*)::int AS c FROM kb_entries')).rows[0].c;
  const embedded = (await sql('SELECT COUNT(*)::int AS c FROM kb_entries WHERE embedding IS NOT NULL')).rows[0].c;
  return { total, embedded, pending: total - embedded };
}

/**
 * 把搜索结果格式化为给模型用的文本
 */
export function formatSearchResultText(queryText, results) {
  if (!results || results.length === 0) {
    return `知识库中未找到与 "${queryText}" 相关的内容。`;
  }
  const parts = results.map((e, i) => {
    const scoreText =
      typeof e.score === 'number' && e.score > 0 ? `（相似度 ${e.score}）` : '';
    return `【${i + 1}. ${e.title}】（分类：${e.category || '未分类'}）${scoreText}\n${e.content}`;
  });
  return `在知识库中找到 ${results.length} 条相关内容：\n\n${parts.join('\n\n')}`;
}
