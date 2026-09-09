import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

/**
 * 简单的 JSON 文件存储
 *
 * 【说明】：
 * 学习项目用 JSON 文件存储对话历史，简单直观。
 * 生产环境应使用数据库（如 SQLite、MongoDB、PostgreSQL）。
 */

// 确保数据目录和文件存在
function ensureStore() {
  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ sessions: [] }, null, 2), 'utf-8');
  }
}

/**
 * 读取所有会话
 */
export function readAllSessions() {
  ensureStore();
  const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
  return JSON.parse(data);
}

/**
 * 保存所有会话
 */
function writeAllSessions(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 创建新会话
 * @param {string} title - 会话标题
 * @returns {object} 新会话对象
 */
export function createSession(title = '新对话') {
  const store = readAllSessions();
  const session = {
    id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    messages: [],
    // 【AI 学习要点 - 长对话摘要压缩】：
    // summary 存早期对话的压缩摘要，summaryUpTo 标记摘要覆盖到第几条 user/assistant 消息。
    // 构造 messages 时用"summary + 最近 N 条原文"，避免历史线性增长爆 token。
    // 触发与构造逻辑见 server/src/routes/chat.js。
    summary: '',
    summaryUpTo: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.sessions.unshift(session);
  writeAllSessions(store);
  return session;
}

/**
 * 获取单个会话
 */
export function getSession(sessionId) {
  const store = readAllSessions();
  return store.sessions.find((s) => s.id === sessionId) || null;
}

/**
 * 追加消息到会话
 * @param {string} sessionId - 会话 ID
 * @param {object} message - {role, content, usage?}
 */
export function appendMessage(sessionId, message) {
  const store = readAllSessions();
  const session = store.sessions.find((s) => s.id === sessionId);
  if (!session) return null;

  session.messages.push({
    id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...message,
    createdAt: new Date().toISOString(),
  });
  session.updatedAt = new Date().toISOString();

  // 第一条用户消息自动作为会话标题
  if (message.role === 'user' && session.title === '新对话') {
    session.title = message.content.slice(0, 20);
  }

  writeAllSessions(store);
  return session;
}

/**
 * 删除会话
 */
export function deleteSession(sessionId) {
  const store = readAllSessions();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((s) => s.id !== sessionId);
  writeAllSessions(store);
  return store.sessions.length < before;
}

/**
 * 更新会话标题
 */
export function updateSessionTitle(sessionId, title) {
  const store = readAllSessions();
  const session = store.sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  session.title = title;
  session.updatedAt = new Date().toISOString();
  writeAllSessions(store);
  return session;
}

/**
 * 更新会话的对话摘要
 * @param {string} sessionId - 会话 ID
 * @param {string} summary - 新摘要文本
 * @param {number} summaryUpTo - 摘要覆盖到的历史消息数（user/assistant 计数）
 * @returns {object|null} 更新后的 session
 *
 * 【AI 学习要点 - 长对话摘要压缩】：
 * 把早期对话压缩成一段摘要文本存起来，构造 messages 时用它替代早期原文。
 * summaryUpTo 标记摘要覆盖到第几条 user/assistant 消息，避免重复摘要同一段历史。
 */
export function updateSessionSummary(sessionId, summary, summaryUpTo) {
  const store = readAllSessions();
  const session = store.sessions.find((s) => s.id === sessionId);
  if (!session) return null;
  session.summary = summary;
  session.summaryUpTo = summaryUpTo;
  session.updatedAt = new Date().toISOString();
  writeAllSessions(store);
  return session;
}
