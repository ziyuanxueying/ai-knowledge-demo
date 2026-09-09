import { Router } from 'express';
import {
  listEntries,
  getEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  searchEntries,
  searchEntriesSemantic,
  searchCompare,
  ensureEmbeddings,
  regenerateAllEmbeddings,
  stats,
} from '../data/kbStore.js';

const router = Router();

/**
 * 知识库管理路由
 *
 * 提供知识库条目的 CRUD 接口，供前端管理界面调用。
 * 另提供 RAG 相关接口：检索对比、向量化统计、重新生成向量。
 * Agent 的搜索能力直接调用 kbStore.searchEntriesSemantic，不走这些路由。
 *
 * 注意：具名路由（/search、/stats、/embeddings/regenerate）必须在
 *       /:id 之前定义，否则会被 :id 参数路由捕获。
 */

/**
 * GET /api/knowledge/stats
 * 向量化状态统计（总数 / 已向量化 / 待向量化）
 */
router.get('/stats', (req, res) => {
  res.json(stats());
});

/**
 * GET /api/knowledge/search?q=关键词&mode=keyword|semantic|compare&topK=3
 * 检索接口：
 *   mode=keyword   —— 关键词匹配
 *   mode=semantic  —— 语义检索（向量化 + 余弦相似度）
 *   mode=compare   —— 同时返回两种结果，供对比面板展示（默认）
 */
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const mode = String(req.query.mode || 'compare');
  const topK = Number.parseInt(req.query.topK || '3', 10) || 3;
  if (!q) return res.json({ query: '', keyword: [], semantic: [] });
  try {
    if (mode === 'keyword') {
      return res.json({ query: q, keyword: searchEntries(q), semantic: [] });
    }
    if (mode === 'semantic') {
      const semantic = await searchEntriesSemantic(q, topK, 0);
      return res.json({ query: q, keyword: [], semantic });
    }
    // compare
    const result = await searchCompare(q, topK);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: `检索失败：${err.message}` });
  }
});

/**
 * POST /api/knowledge/embeddings/regenerate
 * 重新生成全部条目的向量（换 embedding 模型 / 向量损坏时用）
 * 也可用 POST /api/knowledge/embeddings/ensure 仅补齐缺失的
 */
router.post('/embeddings/:action', async (req, res) => {
  const action = req.params.action;
  try {
    let result;
    if (action === 'regenerate') {
      result = await regenerateAllEmbeddings();
    } else if (action === 'ensure') {
      result = await ensureEmbeddings();
    } else {
      return res.status(400).json({ error: `未知操作：${action}（支持 ensure / regenerate）` });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: `向量化失败：${err.message}` });
  }
});

/**
 * GET /api/knowledge
 * 列出全部条目（按更新时间倒序）
 */
router.get('/', (req, res) => {
  const entries = listEntries();
  res.json({ entries });
});

/**
 * GET /api/knowledge/:id
 * 获取单个条目
 */
router.get('/:id', (req, res) => {
  const entry = getEntry(req.params.id);
  if (!entry) {
    return res.status(404).json({ error: '条目不存在' });
  }
  res.json({ entry });
});

/**
 * POST /api/knowledge
 * 创建条目（自动向量化）
 * body: { title, keywords: [], category, content }
 */
router.post('/', async (req, res) => {
  const { title, keywords, category, content } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title 不能为空' });
  }
  const entry = await createEntry({ title, keywords, category, content });
  res.status(201).json({ entry });
});

/**
 * PUT /api/knowledge/:id
 * 更新条目（内容变化后自动重新向量化）
 */
router.put('/:id', async (req, res) => {
  const { title, keywords, category, content } = req.body;
  const entry = await updateEntry(req.params.id, { title, keywords, category, content });
  if (!entry) {
    return res.status(404).json({ error: '条目不存在' });
  }
  res.json({ entry });
});

/**
 * DELETE /api/knowledge/:id
 * 删除条目
 */
router.delete('/:id', (req, res) => {
  const ok = deleteEntry(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: '条目不存在' });
  }
  res.json({ ok: true });
});

export default router;
