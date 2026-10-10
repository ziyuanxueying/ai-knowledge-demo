/**
 * 父子块混合检索
 *
 * 向量路和关键词路都打在子块上，RRF 融合后按父块去重。
 * 送给模型和引用卡片的正文是父块；子块起止位置用来高亮命中片段。
 */

import OpenAI from 'openai';
import { config } from '../config/index.js';
import { query as sql, toVectorSql } from '../data/db.js';
import { embedQuery, hasEmbeddingConfig } from '../services/embedding.service.js';

const RRF_K = 60;
const RECALL_K = 20;
const FRESHNESS_TAU_DAYS = 806;

const chatClient = new OpenAI({
  apiKey: config.dashscope.apiKey,
  baseURL: config.dashscope.baseURL,
});

const HIT_COLS = `
  c.id AS "childId",
  c."parentId",
  c."entryId",
  c.heading,
  c.content AS "childContent",
  c."charStart",
  c."charEnd",
  p.content AS "parentContent",
  p.heading AS "parentHeading",
  e.title,
  e.category,
  e."updatedAt"
`;

/**
 * Agent 使用的混合检索。首问用原句；有历史时尝试把追问改写成独立问句。
 */
export async function retrieveHybrid(queryText, options = {}) {
  const query = String(queryText || '').trim();
  if (!query) return { query: '', rewrittenQuery: '', hits: [], text: formatSearchResultText('', []) };

  const topK = options.topK || 5;
  const threshold = options.threshold ?? 0.3;
  const category = String(options.category || '').trim();
  let rewrittenQuery = query;
  if (options.rewrite !== false) {
    rewrittenQuery = await rewriteFollowUp(query, options.history);
  }

  const [keyword, semantic] = await Promise.all([
    keywordRecall(rewrittenQuery, category),
    vectorRecall(rewrittenQuery, category, threshold),
  ]);
  let hits = fuseParents(keyword, semantic);
  hits = await maybeRerank(rewrittenQuery, hits, options.rerank !== false);
  hits = hits.slice(0, topK).map((hit, index) => ({ ...hit, n: index + 1 }));

  return {
    query,
    rewrittenQuery,
    hits,
    text: formatSearchResultText(rewrittenQuery, hits),
    citations: hits.map(toCitation),
  };
}

/**
 * 知识库对比面板：同一问句的关键词、纯向量、混合三路，都不做追问改写。
 */
export async function searchCompare(queryText, topK = 5, category = '') {
  const query = String(queryText || '').trim();
  if (!query) return { query: '', keyword: [], semantic: [], hybrid: [] };
  const cat = String(category || '').trim();
  const [keyword, semantic, hybrid] = await Promise.all([
    keywordParents(query, topK, cat),
    vectorParents(query, topK, 0, cat),
    retrieveHybrid(query, { topK, threshold: 0, category: cat, rewrite: false, rerank: true }).then((r) => r.hits),
  ]);
  return { query, keyword, semantic, hybrid };
}

export function formatSearchResultText(queryText, hits) {
  if (!hits || hits.length === 0) {
    return `知识库中未找到与 "${queryText}" 相关的内容。`;
  }
  const parts = hits.map((hit) => {
    const where = hit.heading ? `${hit.title} / ${hit.heading}` : hit.title;
    const scoreText = typeof hit.score === 'number' && hit.score > 0 ? `（相关度 ${hit.score}）` : '';
    return `[${hit.n}] ${where}${scoreText}\n${hit.excerpt}`;
  });
  return `在知识库中找到 ${hits.length} 条相关内容。回答时用对应的 [编号] 标注来源。下面没有的内容不要写成来自知识库。\n\n${parts.join('\n\n')}`;
}

async function keywordParents(query, topK, category = '') {
  const rows = await keywordRecall(query, category);
  return dedupeParents(rows.map((row, index) => rowToHit(row, row.kwScore || RECALL_K - index))).slice(0, topK);
}

async function vectorParents(query, topK, threshold, category = '') {
  const rows = await vectorRecall(query, category, threshold);
  return dedupeParents(rows.map((row) => rowToHit(row, Number(row.score) || 0))).slice(0, topK);
}

async function keywordRecall(queryText, category) {
  const q = String(queryText || '').toLowerCase();
  if (!q) return [];
  const res = await sql(
    `SELECT ${HIT_COLS},
            (
              (CASE WHEN strpos(lower(e.title), $1) > 0 THEN 4 ELSE 0 END) +
              (CASE WHEN strpos(lower(c.content), $1) > 0 THEN 3 ELSE 0 END) +
              (CASE WHEN strpos(lower(c.heading), $1) > 0 THEN 2 ELSE 0 END) +
              (CASE WHEN strpos(lower(e.keywords), $1) > 0 THEN 2 ELSE 0 END) +
              (CASE WHEN strpos(lower(e.category), $1) > 0 THEN 1 ELSE 0 END)
            ) AS "kwScore"
     FROM kb_chunks c
     JOIN kb_chunks p ON p.id = c."parentId"
     JOIN kb_entries e ON e.id = c."entryId"
     WHERE c."parentId" IS NOT NULL
       AND ($2 = '' OR e.category = $2)
       AND (
         strpos(lower(c.content), $1) > 0
         OR strpos(lower(c.heading), $1) > 0
         OR strpos(lower(p.heading), $1) > 0
         OR strpos(lower(e.title), $1) > 0
         OR strpos(lower(e.category), $1) > 0
         OR strpos(lower(e.keywords), $1) > 0
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(e.keywords::jsonb) AS kw
           WHERE strpos($1, lower(kw)) > 0 AND length(kw) > 0
         )
       )
     ORDER BY "kwScore" DESC, e."updatedAt" DESC
     LIMIT $3`,
    [q, category, RECALL_K]
  );
  return res.rows;
}

async function vectorRecall(queryText, category, threshold) {
  if (!hasEmbeddingConfig()) return [];
  let qVec;
  try {
    qVec = await embedQuery(queryText);
  } catch {
    return [];
  }
  const distanceLimit = 1 - threshold;
  const res = await sql(
    `SELECT ${HIT_COLS},
            1 - (c.embedding <=> q.v) AS score
     FROM kb_chunks c
     JOIN kb_chunks p ON p.id = c."parentId"
     JOIN kb_entries e ON e.id = c."entryId",
          (SELECT $1::vector AS v) AS q
     WHERE c."parentId" IS NOT NULL
       AND c.embedding IS NOT NULL
       AND c.embedding_model = $2
       AND ($3 = '' OR e.category = $3)
       AND (c.embedding <=> q.v) <= $4
     ORDER BY c.embedding <=> q.v
     LIMIT $5`,
    [toVectorSql(qVec), config.dashscope.embeddingModel, category, distanceLimit, RECALL_K]
  );
  return res.rows;
}

function fuseParents(keywordRows, vectorRows) {
  const rankKw = new Map();
  keywordRows.forEach((row, index) => {
    if (!rankKw.has(row.childId)) rankKw.set(row.childId, index + 1);
  });
  const rankVec = new Map();
  vectorRows.forEach((row, index) => {
    if (!rankVec.has(row.childId)) rankVec.set(row.childId, index + 1);
  });

  const byId = new Map();
  for (const row of [...vectorRows, ...keywordRows]) {
    if (!byId.has(row.childId)) byId.set(row.childId, row);
  }

  const fused = [];
  for (const [childId, row] of byId) {
    const kw = rankKw.get(childId);
    const vec = rankVec.get(childId);
    const rrf = (kw ? 1 / (RRF_K + kw) : 0) + (vec ? 1 / (RRF_K + vec) : 0);
    // 相邻名次的 RRF 分差大约 1%。若直接乘「半年八折」，一条较新的次优文档会排到更相关的旧文档前面。
    // 主排序用召回名次，新鲜度只在分数相同的时候再比较。
    const score = Number(rrf.toFixed(6));
    const hit = rowToHit(row, score);
    hit.freshness = freshness(row.updatedAt);
    fused.push(hit);
  }
  fused.sort((a, b) => b.score - a.score || b.freshness - a.freshness);
  return dedupeParents(fused);
}

function dedupeParents(hits) {
  const best = new Map();
  for (const hit of hits) {
    const prev = best.get(hit.parentId);
    if (!prev || hit.score > prev.score) best.set(hit.parentId, hit);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || (b.freshness || 0) - (a.freshness || 0))
    .map((hit, index) => ({ ...hit, n: index + 1 }));
}

function rowToHit(row, score) {
  const heading = row.parentHeading || row.heading || '';
  return {
    n: 0,
    parentId: row.parentId,
    childId: row.childId,
    entryId: row.entryId,
    title: row.title,
    heading,
    category: row.category || '',
    excerpt: row.parentContent || '',
    childExcerpt: row.childContent || '',
    highlightStart: Number(row.charStart) || 0,
    highlightEnd: Number(row.charEnd) || 0,
    updatedAt: row.updatedAt,
    score: Number(Number(score).toFixed(4)),
  };
}

function toCitation(hit) {
  return {
    n: hit.n,
    parentId: hit.parentId,
    childId: hit.childId,
    entryId: hit.entryId,
    title: hit.title,
    heading: hit.heading,
    excerpt: hit.excerpt,
    highlightStart: hit.highlightStart,
    highlightEnd: hit.highlightEnd,
  };
}

function freshness(updatedAt) {
  const time = new Date(updatedAt).getTime();
  if (!Number.isFinite(time)) return 1;
  const ageDays = Math.max(0, (Date.now() - time) / 86400000);
  return Math.exp(-ageDays / FRESHNESS_TAU_DAYS);
}

async function maybeRerank(queryText, hits, enabled) {
  const model = config.dashscope.rerankModel;
  if (!enabled || !model || hits.length <= 1 || !hasEmbeddingConfig()) return hits;
  try {
    const documents = hits.map((hit) => `${hit.title}\n${hit.excerpt}`.slice(0, 2000));
    const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.dashscope.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: { query: queryText, documents },
        parameters: { top_n: Math.min(hits.length, 5), return_documents: false },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return hits;
    const data = await res.json();
    const ranked = data?.output?.results;
    if (!Array.isArray(ranked) || ranked.length === 0) return hits;
    return ranked
      .map((item) => {
        const hit = hits[item.index];
        if (!hit) return null;
        const relevance = Number(item.relevance_score);
        return {
          ...hit,
          score: Number.isFinite(relevance) ? Number(relevance.toFixed(4)) : hit.score,
        };
      })
      .filter(Boolean);
  } catch {
    return hits;
  }
}

async function rewriteFollowUp(query, history) {
  const turns = (history || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-4);
  if (turns.length === 0 || !hasEmbeddingConfig()) return query;
  try {
    const res = await chatClient.chat.completions.create(
      {
        model: config.dashscope.model,
        temperature: 0.1,
        max_tokens: 80,
        messages: [
          {
            role: 'system',
            content: '把用户的最新问题改写成可以独立检索知识库的一句问话。只输出问句本身。如果它已经完整，原样输出。',
          },
          ...turns.map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 500) })),
          { role: 'user', content: query },
        ],
      },
      { timeout: 8000 }
    );
    const text = res.choices?.[0]?.message?.content?.trim();
    return text ? text.replace(/^["「]|["」]$/g, '') : query;
  } catch {
    return query;
  }
}
