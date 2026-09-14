import { Router } from 'express';
import {
  listSessionSummaries,
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
router.get('/', async (req, res) => {
  const store = await listSessionSummaries();
  res.json({ sessions: store.sessions });
});

// 获取单个会话的完整消息
router.get('/:sessionId', async (req, res) => {
  const session = await getSession(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: '会话不存在' });
  }
  res.json({ session });
});

// 创建新会话
router.post('/', async (req, res) => {
  const { title } = req.body || {};
  const session = await createSession(title || '新对话');
  res.status(201).json({ session });
});

// 更新会话标题
router.patch('/:sessionId', async (req, res) => {
  const { title } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title 不能为空' });
  const session = await updateSessionTitle(req.params.sessionId, title);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  res.json({ session });
});

// 删除会话
router.delete('/:sessionId', async (req, res) => {
  const ok = await deleteSession(req.params.sessionId);
  if (!ok) return res.status(404).json({ error: '会话不存在' });
  res.json({ success: true });
});

export default router;
