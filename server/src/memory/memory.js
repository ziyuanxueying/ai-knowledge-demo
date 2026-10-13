/**
 * Memory RAG
 *
 * 摘要会把早期细节压扁，最近 6 条原文又盖不住更早的原话。
 * 这里把已经结束的回合向量化，下次按当前问题召回相关原文，再写进 messages。
 * 用户说出姓名、偏好、技术栈或约定时，另抽一条不绑会话的事实，换对话也能召回。
 *
 * 召回失败或写入失败都不挡住回答。最近几条已经在 prompt 里的原文会被排除，避免重复。
 */

import { config } from '../config/index.js';
import { query, toVectorSql } from '../data/db.js';
import { embedTexts, hasEmbeddingConfig } from '../services/embedding.service.js';
import { chat } from '../services/ai.service.js';

const TURN_TOP_K = 4;
const FACT_TOP_K = 3;
// 中文 embedding 的无关文本也常有 0.4 上下的分。阈值再低会把「你好」召回来。
const TURN_THRESHOLD = 0.61;
const FACT_THRESHOLD = 0.55;
const SCORE_GAP = 0.12;
const FACT_DEDUPE = 0.9;
const CATCH_UP_LIMIT = 6;
const MAX_FACTS = 80;
const USER_CLIP = 400;
const ASSISTANT_CLIP = 500;

const FACT_HINT =
  /我叫|我的名字|请叫我|叫我|我喜欢|我偏好|我习惯|我用|我在做|我正在|我是|请记住|记住我|以后都|记得我|remember|my name|i prefer|i use|i like|call me/i;

export const MEMORY_HEADING = '## 按当前问题召回的记忆（Memory RAG）';

function clip(text, max) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}…`;
}

function worthIndexing(userText) {
  const text = String(userText || '').trim();
  if (!text) return false;
  if (FACT_HINT.test(text)) return true;
  return text.length >= 8;
}

export function buildTurnText(userContent, assistantContent) {
  return `用户：${clip(userContent, USER_CLIP)}\n助手：${clip(assistantContent, ASSISTANT_CLIP)}`;
}

export function latestTurn(messages) {
  const dialogue = (messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
  const assistant = dialogue[dialogue.length - 1];
  const user = dialogue[dialogue.length - 2];
  if (!assistant || assistant.role !== 'assistant' || !user || user.role !== 'user') return null;
  if (!String(user.content || '').trim()) return null;
  return { user, assistant };
}

function pairTurns(rows) {
  const bySession = new Map();
  for (const row of rows) {
    const list = bySession.get(row.sessionId) || [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }
  const pairs = [];
  const skipped = [];
  for (const [sessionId, list] of bySession) {
    list.sort((a, b) => Number(a.seq) - Number(b.seq));
    let pending = null;
    for (const msg of list) {
      if (msg.role === 'user') {
        pending = msg;
      } else if (msg.role === 'assistant' && pending) {
        const item = { sessionId, user: pending, assistant: msg };
        if (String(pending.content || '').trim() && String(msg.content || '').trim()) {
          pairs.push(item);
        } else {
          skipped.push(item);
        }
        pending = null;
      }
    }
  }
  return { pairs, skipped };
}

function parseFacts(text) {
  if (!text) return [];
  const attempts = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) attempts.push(text.slice(start, end + 1));
  for (const item of attempts) {
    try {
      const parsed = JSON.parse(item);
      const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
      return facts
        .map((fact) => clip(fact, 80))
        .filter((fact) => fact.startsWith('用户') && fact.length >= 6)
        .slice(0, 3);
    } catch {
      // 换下一种切法
    }
  }
  return [];
}

async function searchByVector({ vector, kind, threshold, limit, excludeMessageIds }) {
  const exclude = excludeMessageIds.length > 0 ? excludeMessageIds : [];
  const res = await query(
    `SELECT mem.id,
            mem."sessionId",
            mem.kind,
            mem.content,
            s.title AS "sessionTitle",
            1 - (mem.embedding <=> q.v) AS score
     FROM memories mem
     LEFT JOIN sessions s ON s.id = mem."sessionId",
          (SELECT $1::vector AS v) AS q
     WHERE mem.kind = $2
       AND mem.embedding IS NOT NULL
       AND mem.embedding_model = $3
       AND (mem.embedding <=> q.v) <= $4
       AND (
         cardinality($5::text[]) = 0
         OR NOT (
           COALESCE(mem."userMessageId", '') = ANY($5::text[])
           OR COALESCE(mem."assistantMessageId", '') = ANY($5::text[])
         )
       )
     ORDER BY mem.embedding <=> q.v
     LIMIT $6`,
    [
      toVectorSql(vector),
      kind,
      config.dashscope.embeddingModel,
      1 - threshold,
      exclude,
      limit,
    ]
  );
  return res.rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle || '',
    kind: row.kind,
    content: row.content,
    score: Number(Number(row.score).toFixed(3)),
  }));
}

function labelOf(item, sessionId) {
  if (item.kind === 'fact') return '长期记忆';
  if (item.sessionId && item.sessionId === sessionId) return '本会话更早';
  return item.sessionTitle ? `其他会话 · ${item.sessionTitle}` : '其他会话';
}

function keepNearTop(items, threshold) {
  const passed = items.filter((item) => item.score >= threshold);
  if (!passed.length) return [];
  const floor = Math.max(threshold, passed[0].score - SCORE_GAP);
  return passed.filter((item) => item.score >= floor);
}

export function formatMemoryContext(items) {
  if (!items.length) return '';
  const lines = items.map(
    (item, index) => `${index + 1}. [${item.label} · 相关度 ${item.score.toFixed(2)}] ${item.content}`
  );
  return `${MEMORY_HEADING}
这些是按当前问题向量检索到的历史，不是最近几轮原文。最近原文仍会照常附在后面。若与早期摘要冲突，以这里的原文为准。长期记忆是跨会话的用户事实。
${lines.join('\n')}`;
}

async function loadMissingPairs() {
  const res = await query(
    `SELECT id, "sessionId", role, content, seq
     FROM messages
     WHERE role IN ('user', 'assistant')
       AND NOT EXISTS (
         SELECT 1 FROM memories mem
         WHERE mem."userMessageId" = messages.id
            OR mem."assistantMessageId" = messages.id
       )
     ORDER BY seq ASC
     LIMIT 48`
  );
  return pairTurns(res.rows);
}

async function loadUnembedded(limit) {
  const res = await query(
    `SELECT id, content
     FROM memories
     WHERE embedding IS NULL AND content <> ''
     ORDER BY "createdAt" ASC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

function newMemoryId() {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function insertTurn({ sessionId, userMessageId, assistantMessageId, content, vector }) {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO memories
       (id, "sessionId", "sourceSessionId", kind, content, embedding, embedding_model, "userMessageId", "assistantMessageId", "createdAt")
     VALUES ($1, $2, $2, 'turn', $3, $4::vector, $5, $6, $7, $8)
     ON CONFLICT ("userMessageId") WHERE kind = 'turn' AND "userMessageId" IS NOT NULL
     DO NOTHING`,
    [
      newMemoryId(),
      sessionId,
      content,
      vector ? toVectorSql(vector) : null,
      vector ? config.dashscope.embeddingModel : null,
      userMessageId,
      assistantMessageId,
      now,
    ]
  );
}

let modelAligned = false;

async function alignEmbeddingModel() {
  if (modelAligned) return;
  await query(
    `UPDATE memories
     SET embedding = NULL, embedding_model = NULL
     WHERE embedding_model IS NOT NULL
       AND embedding_model IS DISTINCT FROM $1`,
    [config.dashscope.embeddingModel]
  );
  modelAligned = true;
}

async function upsertFact({ content, vector, sourceSessionId }) {
  const nearest = await searchByVector({
    vector,
    kind: 'fact',
    threshold: FACT_DEDUPE,
    limit: 1,
    excludeMessageIds: [],
  });
  const hit = nearest[0];
  if (hit && hit.score >= FACT_DEDUPE) {
    if (hit.content === content) return;
    await query(
      `UPDATE memories
       SET content = $1, embedding = $2::vector, embedding_model = $3, "sourceSessionId" = $4
       WHERE id = $5`,
      [content, toVectorSql(vector), config.dashscope.embeddingModel, sourceSessionId || null, hit.id]
    );
    return;
  }
  const now = new Date().toISOString();
  await query(
    `INSERT INTO memories
       (id, "sessionId", "sourceSessionId", kind, content, embedding, embedding_model, "createdAt")
     VALUES ($1, NULL, $2, 'fact', $3, $4::vector, $5, $6)`,
    [
      newMemoryId(),
      sourceSessionId || null,
      content,
      toVectorSql(vector),
      config.dashscope.embeddingModel,
      now,
    ]
  );
  await query(
    `DELETE FROM memories
     WHERE id IN (
       SELECT id FROM memories
       WHERE kind = 'fact'
       ORDER BY "createdAt" DESC
       OFFSET $1
     )`,
    [MAX_FACTS]
  );
}

async function catchUp(excludeMessageIds) {
  await alignEmbeddingModel();
  const excluded = new Set(excludeMessageIds);
  const missing = await loadMissingPairs();
  if (missing.skipped.length > 0) {
    for (const pair of missing.skipped) {
      await insertTurn({
        sessionId: pair.sessionId,
        userMessageId: pair.user.id,
        assistantMessageId: pair.assistant.id,
        content: '',
        vector: null,
      });
    }
  }
  const pendingVectors = await loadUnembedded(CATCH_UP_LIMIT);
  const room = Math.max(0, CATCH_UP_LIMIT - pendingVectors.length);
  const eligible = missing.pairs.filter(
    (pair) =>
      !excluded.has(pair.user.id) &&
      !excluded.has(pair.assistant.id) &&
      worthIndexing(pair.user.content)
  );
  const tooShort = missing.pairs.filter(
    (pair) => !excluded.has(pair.user.id) && !worthIndexing(pair.user.content)
  );
  for (const pair of tooShort) {
    await insertTurn({
      sessionId: pair.sessionId,
      userMessageId: pair.user.id,
      assistantMessageId: pair.assistant.id,
      content: '',
      vector: null,
    });
  }
  const pairs = room ? eligible.slice(0, room) : [];
  if (pendingVectors.length === 0 && pairs.length === 0) return;

  const texts = [
    ...pendingVectors.map((row) => row.content),
    ...pairs.map((pair) => buildTurnText(pair.user.content, pair.assistant.content)),
  ];
  const vectors = await embedTexts(texts);
  for (let i = 0; i < pendingVectors.length; i++) {
    await query(
      `UPDATE memories SET embedding = $1::vector, embedding_model = $2 WHERE id = $3`,
      [toVectorSql(vectors[i]), config.dashscope.embeddingModel, pendingVectors[i].id]
    );
  }
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const vector = vectors[pendingVectors.length + i];
    await insertTurn({
      sessionId: pair.sessionId,
      userMessageId: pair.user.id,
      assistantMessageId: pair.assistant.id,
      content: texts[pendingVectors.length + i],
      vector,
    });
  }
  if (pairs.length > 0) {
    console.log(`[Memory RAG] 补写 ${pairs.length} 条回合记忆`);
  }
}

/**
 * 请求开始前：补上还没向量化的旧回合，再按当前问题召回。
 * @returns {Promise<{ text: string, items: object[] }>}
 */
export async function prepareMemoryContext({ query: queryText, sessionId, excludeMessageIds = [] }) {
  if (!hasEmbeddingConfig() || !String(queryText || '').trim()) {
    return { text: '', items: [] };
  }
  try {
    try {
      await catchUp(excludeMessageIds);
    } catch (err) {
      console.error('Memory RAG 补写失败:', err.message);
    }
    const [vector] = await embedTexts([String(queryText)]);
    const [turns, facts] = await Promise.all([
      searchByVector({
        vector,
        kind: 'turn',
        threshold: TURN_THRESHOLD,
        limit: TURN_TOP_K,
        excludeMessageIds,
      }),
      searchByVector({
        vector,
        kind: 'fact',
        threshold: FACT_THRESHOLD,
        limit: FACT_TOP_K,
        excludeMessageIds: [],
      }),
    ]);
    const items = [...keepNearTop(facts, FACT_THRESHOLD), ...keepNearTop(turns, TURN_THRESHOLD)].map((item) => ({
      ...item,
      label: labelOf(item, sessionId),
    }));
    if (items.length > 0) {
      console.log(`[Memory RAG] 召回 ${items.length} 条`);
    }
    return { text: formatMemoryContext(items), items };
  } catch (err) {
    console.error('Memory RAG 召回失败:', err.message);
    return { text: '', items: [] };
  }
}

async function extractFacts(userContent, assistantContent) {
  const { content } = await chat(
    [
      {
        role: 'system',
        content: '你只抽取可长期复用的用户事实。没有就输出 {"facts":[]}。只输出 JSON。',
      },
      {
        role: 'user',
        content: `从这一轮对话抽取用户的稳定事实：姓名、称呼、技术偏好、正在做的项目、明确约定。
不要记一次性问题、助手的发挥、知识库里的概念。
每条必须是以「用户」开头的完整句子，写清主语和内容。例如「用户名叫小安」「用户喜欢用 React，不喜欢用 Vue」。
不要只写名字或技术名词。最多 3 条，每条不超过 40 字。
只输出 {"facts":["..."]}

用户：${clip(userContent, 500)}
助手：${clip(assistantContent, 500)}`,
      },
    ],
    { temperature: 0, maxTokens: 200 }
  );
  return parseFacts(content);
}

/**
 * 回答落库后写入这一轮。偏好类说法会再抽长期事实。
 */
export async function rememberTurn({
  sessionId,
  userMessageId,
  assistantMessageId,
  userContent,
  assistantContent,
}) {
  if (!hasEmbeddingConfig()) return;
  const userText = String(userContent || '').trim();
  const assistantText = String(assistantContent || '').trim();
  if (!sessionId || !userMessageId || !userText) return;
  if (!worthIndexing(userText)) {
    try {
      await insertTurn({
        sessionId,
        userMessageId,
        assistantMessageId,
        content: '',
        vector: null,
      });
    } catch (err) {
      console.error('写入记忆失败:', err.message);
    }
    return;
  }
  if (!assistantText) {
    try {
      await insertTurn({
        sessionId,
        userMessageId,
        assistantMessageId,
        content: '',
        vector: null,
      });
    } catch (err) {
      console.error('写入记忆失败:', err.message);
    }
    return;
  }

  try {
    await alignEmbeddingModel();
    const existed = await query(
      `SELECT 1 FROM memories WHERE kind = 'turn' AND "userMessageId" = $1 LIMIT 1`,
      [userMessageId]
    );
    const turnText = buildTurnText(userText, assistantText);
    const wantFacts = FACT_HINT.test(userText);
    const factTask = (
      wantFacts ? extractFacts(userText, assistantText) : Promise.resolve([])
    ).catch((err) => {
      console.error('抽取长期记忆失败:', err.message);
      return [];
    });

    if (existed.rowCount === 0) {
      const [vector] = await embedTexts([turnText]);
      await insertTurn({
        sessionId,
        userMessageId,
        assistantMessageId,
        content: turnText,
        vector,
      });
    }

    const facts = await factTask;
    if (facts.length === 0) return;
    const factVectors = await embedTexts(facts);
    for (let i = 0; i < facts.length; i++) {
      await upsertFact({
        content: facts[i],
        vector: factVectors[i],
        sourceSessionId: sessionId,
      });
    }
    console.log(`[Memory RAG] 写入长期记忆 ${facts.length} 条`);
  } catch (err) {
    console.error('写入记忆失败:', err.message);
  }
}
