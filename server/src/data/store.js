/**
 * 对话历史存储层（PostgreSQL 版）
 *
 * 【相对旧 JSON / SQLite 版】：
 * - pg 是异步 API，所有函数均为 async，路由层需 await
 * - 消息用自增 seq 列保证插入顺序
 *
 * 【保持不变】：
 * - 导出函数的返回值结构与旧版一致，仅从同步变异步
 */

import { query, withTransaction } from './db.js';

function mapMessage(m) {
  return {
    ...m,
    usage: m.usage ? JSON.parse(m.usage) : undefined,
    toolSteps: m.toolSteps ? JSON.parse(m.toolSteps) : undefined,
  };
}

async function getMessages(sessionId) {
  const res = await query('SELECT * FROM messages WHERE "sessionId" = $1 ORDER BY seq ASC', [sessionId]);
  return res.rows.map(mapMessage);
}

/**
 * 会话列表（不含消息正文，带 messageCount）
 */
export async function listSessionSummaries() {
  const res = await query(`
    SELECT
      s.id,
      s.title,
      s."createdAt",
      s."updatedAt",
      COUNT(m.id)::int AS "messageCount"
    FROM sessions s
    LEFT JOIN messages m ON m."sessionId" = s.id
    GROUP BY s.id
    ORDER BY s."updatedAt" DESC
  `);
  return { sessions: res.rows };
}

/**
 * 读取所有会话（带消息，保持与旧版返回结构一致）
 * @returns {Promise<{ sessions: object[] }>}
 */
export async function readAllSessions() {
  const sessionsRes = await query('SELECT * FROM sessions ORDER BY "updatedAt" DESC');
  const messagesRes = await query('SELECT * FROM messages ORDER BY seq ASC');
  const bySession = new Map();
  for (const m of messagesRes.rows) {
    const list = bySession.get(m.sessionId) || [];
    list.push(mapMessage(m));
    bySession.set(m.sessionId, list);
  }
  return {
    sessions: sessionsRes.rows.map((s) => ({
      ...s,
      messages: bySession.get(s.id) || [],
    })),
  };
}

/**
 * 创建新会话
 * @param {string} title - 会话标题
 * @returns {Promise<object>} 新会话对象（含空 messages 数组）
 */
export async function createSession(title = '新对话') {
  const now = new Date().toISOString();
  const session = {
    id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    messages: [],
    summary: '',
    summaryUpTo: 0,
    createdAt: now,
    updatedAt: now,
  };
  await query(
    `INSERT INTO sessions (id, title, summary, "summaryUpTo", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [session.id, session.title, session.summary, session.summaryUpTo, session.createdAt, session.updatedAt]
  );
  return session;
}

/**
 * 获取单个会话（含完整消息）
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
export async function getSession(sessionId) {
  const res = await query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  const row = res.rows[0];
  if (!row) return null;
  return { ...row, messages: await getMessages(sessionId) };
}

/**
 * 追加消息到会话
 * @param {string} sessionId
 * @param {object} message - {role, content, usage?, toolSteps?}
 * @returns {Promise<object|null>} 更新后的 session
 */
export async function appendMessage(sessionId, message) {
  const now = new Date().toISOString();
  const inserted = await withTransaction(async (client) => {
    const sessionRes = await client.query('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    const session = sessionRes.rows[0];
    if (!session) return null;

    await client.query(
      `INSERT INTO messages (id, "sessionId", role, content, usage, "toolSteps", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        message.role,
        message.content || '',
        message.usage ? JSON.stringify(message.usage) : null,
        message.toolSteps ? JSON.stringify(message.toolSteps) : null,
        now,
      ]
    );

    if (message.role === 'user' && session.title === '新对话') {
      await client.query('UPDATE sessions SET title = $1, "updatedAt" = $2 WHERE id = $3', [
        message.content.slice(0, 20),
        now,
        sessionId,
      ]);
    } else {
      await client.query('UPDATE sessions SET "updatedAt" = $1 WHERE id = $2', [now, sessionId]);
    }
    return true;
  });

  if (!inserted) return null;
  return getSession(sessionId);
}

/**
 * 删除会话（级联删除消息）
 * @param {string} sessionId
 * @returns {Promise<boolean>} 是否删除成功
 */
export async function deleteSession(sessionId) {
  const res = await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  return res.rowCount > 0;
}

/**
 * 更新会话标题
 * @returns {Promise<object|null>}
 */
export async function updateSessionTitle(sessionId, title) {
  const now = new Date().toISOString();
  const res = await query('UPDATE sessions SET title = $1, "updatedAt" = $2 WHERE id = $3', [
    title,
    now,
    sessionId,
  ]);
  if (res.rowCount === 0) return null;
  return getSession(sessionId);
}

/**
 * 更新会话的对话摘要
 * @param {string} sessionId
 * @param {string} summary - 新摘要文本
 * @param {number} summaryUpTo - 摘要覆盖到的历史消息数
 * @returns {Promise<object|null>}
 */
export async function updateSessionSummary(sessionId, summary, summaryUpTo) {
  const now = new Date().toISOString();
  const res = await query(
    'UPDATE sessions SET summary = $1, "summaryUpTo" = $2, "updatedAt" = $3 WHERE id = $4',
    [summary, summaryUpTo, now, sessionId]
  );
  if (res.rowCount === 0) return null;
  return getSession(sessionId);
}
