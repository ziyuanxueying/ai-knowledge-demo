/**
 * Agent 回答的有用 / 无用。
 * 写入时快照原问、改写问句、命中父块和回答。确认后才追加 eval/feedback.json。
 */
import { config } from '../config/index.js';
import { query } from './db.js';
import { getSession } from './store.js';
import { appendFeedbackCase } from '../rag/feedbackCases.js';

function mapRow(row) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    messageId: row.messageId,
    question: row.question,
    rewrittenQuery: row.rewrittenQuery || '',
    citations: row.citations ? JSON.parse(row.citations) : [],
    answer: row.answer || '',
    embeddingModel: row.embeddingModel || '',
    verdict: row.verdict,
    reason: row.reason || '',
    retrievalPromotedAt: row.retrievalPromotedAt || '',
    answerPromotedAt: row.answerPromotedAt || '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function newId() {
  return `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 给一条已落库的 Agent 回答记有用或无用。同一条回答再次提交会改判定，不另起一行。
 */
export async function saveAnswerFeedback({ messageId, verdict, reason }) {
  const session = await findSessionByMessage(messageId);
  if (!session) {
    const error = new Error('找不到这条回答');
    error.status = 404;
    throw error;
  }
  const index = session.messages.findIndex((item) => item.id === messageId);
  const message = session.messages[index];
  if (!message || message.role !== 'assistant') {
    const error = new Error('只能给助手回答反馈');
    error.status = 400;
    throw error;
  }
  const questionMessage = [...session.messages.slice(0, index)].reverse().find((item) => item.role === 'user');
  if (!questionMessage?.content?.trim()) {
    const error = new Error('这条回答没有对应的问题');
    error.status = 400;
    throw error;
  }

  const now = new Date().toISOString();
  const retrieval = message.retrieval || {};
  const rewrittenQuery = String(retrieval.rewrittenQuery || '').trim();
  const embeddingModel = String(retrieval.embeddingModel || config.dashscope.embeddingModel || '');
  const citations = Array.isArray(message.citations) ? message.citations : [];
  const storedReason = verdict === 'useless' ? String(reason || '').trim().slice(0, 200) : '';

  const res = await query(
    `INSERT INTO answer_feedback (
       id, "sessionId", "messageId", question, "rewrittenQuery", citations, answer,
       "embeddingModel", verdict, reason, "createdAt", "updatedAt"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT ("messageId") DO UPDATE SET
       question = EXCLUDED.question,
       "rewrittenQuery" = EXCLUDED."rewrittenQuery",
       citations = EXCLUDED.citations,
       answer = EXCLUDED.answer,
       "embeddingModel" = EXCLUDED."embeddingModel",
       verdict = EXCLUDED.verdict,
       reason = EXCLUDED.reason,
       "updatedAt" = EXCLUDED."updatedAt"
     RETURNING *`,
    [
      newId(),
      session.id,
      message.id,
      questionMessage.content.trim(),
      rewrittenQuery,
      JSON.stringify(citations),
      message.content || '',
      embeddingModel,
      verdict,
      storedReason,
      now,
      now,
    ]
  );
  return mapRow(res.rows[0]);
}

export async function listAnswerFeedback(verdict = '') {
  const params = [];
  let where = '';
  if (verdict) {
    params.push(verdict);
    where = 'WHERE verdict = $1';
  }
  const res = await query(
    `SELECT * FROM answer_feedback ${where} ORDER BY "createdAt" DESC`,
    params
  );
  return res.rows.map(mapRow);
}

/**
 * 把一条无用反馈收进补充评测集。不改 golden.json 和 answer.json。
 * 评测问句用改写后的独立问句；没有改写时用原问。回归脚本会关掉追问改写。
 */
export async function promoteAnswerFeedback(id, { kind, expectTitle, expectEmpty }) {
  const res = await query('SELECT * FROM answer_feedback WHERE id = $1', [id]);
  const row = res.rows[0] ? mapRow(res.rows[0]) : null;
  if (!row) {
    const error = new Error('找不到这条反馈');
    error.status = 404;
    throw error;
  }
  if (row.verdict !== 'useless') {
    const error = new Error('只有无用反馈可以收进评测集');
    error.status = 400;
    throw error;
  }
  if (kind !== 'retrieval' && kind !== 'answer') {
    const error = new Error('kind 只能是 retrieval 或 answer');
    error.status = 400;
    throw error;
  }

  const title = String(expectTitle || '').trim();
  const empty = expectEmpty === true;
  if (empty && title) {
    const error = new Error('应为空时不要再填期望标题');
    error.status = 400;
    throw error;
  }
  if (!empty && !title) {
    const error = new Error('请选择期望的父文档标题，或标成应为空');
    error.status = 400;
    throw error;
  }

  const entry = {
    feedbackId: row.id,
    kind,
    q: row.rewrittenQuery || row.question,
  };
  if (empty) entry.expectEmpty = true;
  else entry.expectTitle = title;

  const { added } = appendFeedbackCase(entry);
  const column = kind === 'retrieval' ? 'retrievalPromotedAt' : 'answerPromotedAt';
  const already = kind === 'retrieval' ? row.retrievalPromotedAt : row.answerPromotedAt;
  const promotedAt = already || new Date().toISOString();
  if (!already) {
    await query(`UPDATE answer_feedback SET "${column}" = $1, "updatedAt" = $1 WHERE id = $2`, [
      promotedAt,
      row.id,
    ]);
  }
  const fresh = await query('SELECT * FROM answer_feedback WHERE id = $1', [id]);
  return { feedback: mapRow(fresh.rows[0]), added };
}

async function findSessionByMessage(messageId) {
  const found = await query('SELECT "sessionId" FROM messages WHERE id = $1', [messageId]);
  const sessionId = found.rows[0]?.sessionId;
  if (!sessionId) return null;
  return getSession(sessionId);
}
