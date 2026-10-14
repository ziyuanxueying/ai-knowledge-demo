import { Router } from 'express';
import { listAnswerFeedback, promoteAnswerFeedback, saveAnswerFeedback } from '../data/feedbackStore.js';

const router = Router();

/**
 * POST /api/feedback
 * 给一条已落库的 Agent 回答记有用或无用。body: { messageId, verdict, reason? }
 */
router.post('/', async (req, res) => {
  try {
    const messageId = String(req.body?.messageId || '').trim();
    const verdict = req.body?.verdict;
    if (!messageId) return res.status(400).json({ error: 'messageId 不能为空' });
    if (verdict !== 'useful' && verdict !== 'useless') {
      return res.status(400).json({ error: 'verdict 只能是 useful 或 useless' });
    }
    const feedback = await saveAnswerFeedback({
      messageId,
      verdict,
      reason: req.body?.reason,
    });
    res.json({ feedback });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '保存反馈失败' });
  }
});

/**
 * GET /api/feedback?verdict=useless
 * 知识库页列出无用反馈。不带 verdict 时返回全部。
 */
router.get('/', async (req, res) => {
  try {
    const verdict = String(req.query.verdict || '').trim();
    if (verdict && verdict !== 'useful' && verdict !== 'useless') {
      return res.status(400).json({ error: 'verdict 只能是 useful 或 useless' });
    }
    const feedback = await listAnswerFeedback(verdict);
    res.json({ feedback });
  } catch (err) {
    res.status(500).json({ error: err.message || '读取反馈失败' });
  }
});

/**
 * POST /api/feedback/:id/promote
 * 人工确认后追加到 eval/feedback.json。body: { kind, expectTitle?, expectEmpty? }
 */
router.post('/:id/promote', async (req, res) => {
  try {
    const result = await promoteAnswerFeedback(req.params.id, {
      kind: req.body?.kind,
      expectTitle: req.body?.expectTitle,
      expectEmpty: req.body?.expectEmpty,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || '收进评测集失败' });
  }
});

export default router;
