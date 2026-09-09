import { Router } from 'express';
import {
  readAllSessions,
  getSession,
  createSession,
  deleteSession,
  updateSessionTitle,
} from '../data/store.js';

const router = Router();

/**
 * 历史记录路由
 *
 * 提供会话的增删改查接口。
 */

// 获取所有会话列表（不含消息内容，避免数据过大）
router.get('/', (req, res) => {
  const store = readAllSessions();
  // 只返回摘要信息
  const list = store.sessions.map((s) => ({
    id: s.id,
    title: s.title,
    messageCount: s.messages.length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
  res.json({ sessions: list });
});

// 获取单个会话的完整消息
router.get('/:sessionId', (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: '会话不存在' });
  }
  res.json({ session });
});

// 创建新会话
router.post('/', (req, res) => {
  const { title } = req.body || {};
  const session = createSession(title || '新对话');
  res.status(201).json({ session });
});

// 更新会话标题
router.patch('/:sessionId', (req, res) => {
  const { title } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title 不能为空' });
  const session = updateSessionTitle(req.params.sessionId, title);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  res.json({ session });
});

// 删除会话
router.delete('/:sessionId', (req, res) => {
  const ok = deleteSession(req.params.sessionId);
  if (!ok) return res.status(404).json({ error: '会话不存在' });
  res.json({ success: true });
});

export default router;
