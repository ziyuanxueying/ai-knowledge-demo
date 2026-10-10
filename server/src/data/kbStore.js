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

import { config } from '../config/index.js';
import { query as sql, withTransaction, toVectorSql } from './db.js';
import { embedTexts, hasEmbeddingConfig } from '../services/embedding.service.js';
import { buildChildEmbedText, chunkDocument } from '../rag/chunker.js';

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

const ENTRY_COLS = 'id, title, keywords, category, content, "sourceType", "sourceUrl", "cosKey", "ingestStatus", "ingestError", "createdAt", "updatedAt"';

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

async function getEntryWithCounts(id) {
  const res = await sql(
    `SELECT ${ENTRY_COLS},
            (SELECT COUNT(*)::int FROM kb_chunks p WHERE p."entryId" = kb_entries.id AND p."parentId" IS NULL) AS "parentCount",
            (SELECT COUNT(*)::int FROM kb_chunks c WHERE c."entryId" = kb_entries.id AND c."parentId" IS NOT NULL) AS "childCount"
     FROM kb_entries WHERE id = $1`,
    [id]
  );
  return rowToEntry(res.rows[0]);
}

async function embedPendingChildren(entryId) {
  const params = [config.dashscope.embeddingModel];
  let where = `c."parentId" IS NOT NULL AND (c.embedding IS NULL OR c.embedding_model IS DISTINCT FROM $1)`;
  if (entryId) {
    params.push(entryId);
    where += ` AND c."entryId" = $2`;
  }
  const missing = (
    await sql(
      `SELECT c.id, c.heading, c.content, e.title
       FROM kb_chunks c
       JOIN kb_entries e ON e.id = c."entryId"
       WHERE ${where}`,
      params
    )
  ).rows;
  if (missing.length === 0 || !hasEmbeddingConfig()) return;
  if (missing.some((row) => row)) {
    await sql(
      `UPDATE kb_chunks
       SET embedding = NULL, embedding_model = NULL
       WHERE "parentId" IS NOT NULL
         AND embedding_model IS NOT NULL
         AND embedding_model IS DISTINCT FROM $1
         ${entryId ? 'AND "entryId" = $2' : ''}`,
      params
    );
  }
  const pending = (
    await sql(
      `SELECT c.id, c.heading, c.content, e.title
       FROM kb_chunks c
       JOIN kb_entries e ON e.id = c."entryId"
       WHERE c."parentId" IS NOT NULL AND c.embedding IS NULL
         ${entryId ? 'AND c."entryId" = $1' : ''}`,
      entryId ? [entryId] : []
    )
  ).rows;
  await embedChildRows(pending);
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
    sourceType: row.sourceType || 'manual',
    sourceUrl: row.sourceUrl || '',
    cosKey: row.cosKey || '',
    ingestStatus: row.ingestStatus || 'ready',
    ingestError: row.ingestError || '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    parentCount: row.parentCount == null ? undefined : Number(row.parentCount),
    childCount: row.childCount == null ? undefined : Number(row.childCount),
  };
  if (!stripEmbedding && row.embedding) {
    entry.embedding = parseEmbedding(row.embedding);
  }
  return entry;
}

function genChunkId() {
  return `chk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 删掉文档旧块，按当前正文重新写入父子块。向量稍后单独转化。
 */
async function replaceEntryChunks(entry) {
  const parents = chunkDocument(entry.content);
  const now = new Date().toISOString();
  await withTransaction(async (client) => {
    await client.query('DELETE FROM kb_chunks WHERE "entryId" = $1 AND "parentId" IS NOT NULL', [entry.id]);
    await client.query('DELETE FROM kb_chunks WHERE "entryId" = $1', [entry.id]);
    for (let i = 0; i < parents.length; i++) {
      const parent = parents[i];
      const parentId = genChunkId();
      await client.query(
        `INSERT INTO kb_chunks
           (id, "entryId", "parentId", "chunkIndex", heading, content, "charStart", "charEnd", embedding, embedding_model, "createdAt")
         VALUES ($1, $2, NULL, $3, $4, $5, 0, $6, NULL, NULL, $7)`,
        [parentId, entry.id, i, parent.heading, parent.content, parent.content.length, now]
      );
      for (let j = 0; j < parent.children.length; j++) {
        const child = parent.children[j];
        await client.query(
          `INSERT INTO kb_chunks
             (id, "entryId", "parentId", "chunkIndex", heading, content, "charStart", "charEnd", embedding, embedding_model, "createdAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, NULL, $9)`,
          [
            genChunkId(),
            entry.id,
            parentId,
            j,
            parent.heading,
            child.content,
            child.charStart,
            child.charEnd,
            now,
          ]
        );
      }
    }
  });
}

async function embedInBatches(texts) {
  const out = new Array(texts.length).fill(null);
  for (let i = 0; i < texts.length; i += 10) {
    const slice = texts.slice(i, i + 10);
    try {
      const vectors = await embedTexts(slice);
      vectors.forEach((vector, j) => {
        out[i + j] = vector || null;
      });
    } catch {
      for (let j = 0; j < slice.length; j++) {
        try {
          const [vector] = await embedTexts([slice[j]]);
          out[i + j] = vector || null;
        } catch {
          out[i + j] = null;
        }
      }
    }
  }
  return out;
}

/**
 * 只给还没有向量、且模型对得上的子块做转化。
 */
async function embedChildRows(rows) {
  if (!hasEmbeddingConfig() || rows.length === 0) return;
  const texts = rows.map((row) =>
    buildChildEmbedText(
      { title: row.title },
      { heading: row.heading, content: row.content }
    )
  );
  const vectors = await embedInBatches(texts);
  const model = config.dashscope.embeddingModel;
  await withTransaction(async (client) => {
    for (let i = 0; i < rows.length; i++) {
      const vector = vectors[i];
      if (!vector) continue;
      await client.query(
        'UPDATE kb_chunks SET embedding = $1::vector, embedding_model = $2 WHERE id = $3',
        [toVectorSql(vector), model, rows[i].id]
      );
    }
  });
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
  const res = await sql(
    `SELECT ${ENTRY_COLS},
            (SELECT COUNT(*)::int FROM kb_chunks p WHERE p."entryId" = kb_entries.id AND p."parentId" IS NULL) AS "parentCount",
            (SELECT COUNT(*)::int FROM kb_chunks c WHERE c."entryId" = kb_entries.id AND c."parentId" IS NOT NULL) AS "childCount"
     FROM kb_entries
     ORDER BY "updatedAt" DESC`
  );
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
  await replaceEntryChunks(entry);
  await embedPendingChildren(entry.id);
  return getEntryWithCounts(id);
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
  await replaceEntryChunks(entry);
  await embedPendingChildren(id);
  return getEntryWithCounts(id);
}

/**
 * 删除条目
 */
export async function deleteEntry(id) {
  const res = await sql('DELETE FROM kb_entries WHERE id = $1', [id]);
  return res.rowCount > 0;
}

/**
 * 先占一条「解析中」的文档，正文等异步任务写回后再切块。
 */
export async function createPendingEntry({ title, sourceType, sourceUrl = '', category = '' }) {
  const now = new Date().toISOString();
  const id = genId();
  await sql(
    `INSERT INTO kb_entries
       (id, title, keywords, category, content, embedding, "sourceType", "sourceUrl", "cosKey", "ingestStatus", "ingestError", "createdAt", "updatedAt")
     VALUES ($1, $2, '[]', $3, '', NULL, $4, $5, '', 'pending', '', $6, $6)`,
    [id, String(title || '').trim() || '未命名文档', String(category || '').trim(), sourceType, sourceUrl, now]
  );
  return getEntryWithCounts(id);
}

/** 解析完成后写入正文、切块并转向量 */
export async function completeIngest(id, { content, cosKey = '', title }) {
  const existing = await getEntry(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const nextTitle = title ? String(title).trim() : existing.title;
  await sql(
    `UPDATE kb_entries
     SET title = $1, content = $2, "cosKey" = $3, "ingestStatus" = 'ready', "ingestError" = '', "updatedAt" = $4
     WHERE id = $5`,
    [nextTitle, String(content || ''), cosKey || existing.cosKey || '', now, id]
  );
  const entry = { ...existing, title: nextTitle, content: String(content || '') };
  await replaceEntryChunks(entry);
  await embedPendingChildren(id);
  return getEntryWithCounts(id);
}

export async function failIngest(id, message) {
  if (!id) return;
  await sql(
    `UPDATE kb_entries SET "ingestStatus" = 'failed', "ingestError" = $1, "updatedAt" = $2 WHERE id = $3`,
    [String(message || '解析失败').slice(0, 500), new Date().toISOString(), id]
  );
}

/**
 * 给还没有块的文档补父子块，清掉模型对不上的子块向量，再补齐缺失向量。
 */
export async function syncChunks() {
  const missing = await sql(
    `SELECT ${ENTRY_COLS} FROM kb_entries e
     WHERE e."ingestStatus" = 'ready'
       AND NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c."entryId" = e.id)`
  );
  for (const row of missing.rows) {
    await replaceEntryChunks(rowToEntry(row));
  }
  await sql(
    `UPDATE kb_chunks
     SET embedding = NULL, embedding_model = NULL
     WHERE "parentId" IS NOT NULL
       AND embedding_model IS NOT NULL
       AND embedding_model IS DISTINCT FROM $1`,
    [config.dashscope.embeddingModel]
  );
  await embedPendingChildren();
}

/**
 * 补齐缺失的子块向量
 */
export async function ensureEmbeddings() {
  await embedPendingChildren();
  return stats();
}

/**
 * 按当前 embedding 模型重转全部子块
 */
export async function regenerateAllEmbeddings() {
  await sql(
    `UPDATE kb_chunks SET embedding = NULL, embedding_model = NULL WHERE "parentId" IS NOT NULL`
  );
  await embedPendingChildren();
  return stats();
}

/**
 * 统计子块向量化进度，以及当前 embedding 模型是否和库内一致
 */
export async function stats() {
  const res = await sql(
    `SELECT
       COUNT(*) FILTER (WHERE "parentId" IS NULL)::int AS parents,
       COUNT(*) FILTER (WHERE "parentId" IS NOT NULL)::int AS children,
       COUNT(*) FILTER (WHERE "parentId" IS NOT NULL AND embedding IS NOT NULL)::int AS embedded,
       COUNT(*) FILTER (
         WHERE "parentId" IS NOT NULL
           AND embedding IS NOT NULL
           AND embedding_model IS DISTINCT FROM $1
       )::int AS stale
     FROM kb_chunks`,
    [config.dashscope.embeddingModel]
  );
  const row = res.rows[0] || {};
  const children = row.children || 0;
  const embedded = row.embedded || 0;
  return {
    total: children,
    embedded,
    pending: children - embedded,
    parents: row.parents || 0,
    children,
    embeddingModel: config.dashscope.embeddingModel,
    modelStale: (row.stale || 0) > 0,
  };
}
