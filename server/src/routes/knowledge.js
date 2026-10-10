import { Router } from 'express';
import multer from 'multer';
import {
  listEntries,
  getEntry,
  createEntry,
  createPendingEntry,
  updateEntry,
  deleteEntry,
  ensureEmbeddings,
  regenerateAllEmbeddings,
  stats,
} from '../data/kbStore.js';
import { searchCompare } from '../rag/retrieve.js';
import { enqueueJob, listJobs } from '../rag/ingest.js';
import { assertCosConfig, buildObjectKey, deleteObject, missingCosEnv, putObject } from '../storage/cos.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const router = Router();

/**
 * 知识库管理路由
 *
 * 提供知识库条目的 CRUD 接口，供前端管理界面调用。
 * 另提供 RAG 相关接口：检索对比、向量化统计、重新生成向量。
 * Agent 的搜索直接调用 rag/retrieve.js，不走这些路由。
 *
 * 注意：具名路由（/search、/stats、/embeddings/regenerate）必须在
 *       /:id 之前定义，否则会被 :id 参数路由捕获。
 */

/**
 * GET /api/knowledge/stats
 * 向量化状态统计（总数 / 已向量化 / 待向量化）
 */
router.get('/stats', async (req, res) => {
  res.json(await stats());
});

/**
 * GET /api/knowledge/search?q=关键词&mode=keyword|semantic|compare&topK=5&category=
 * 检索打在子块上，结果展开为父块：
 *   mode=keyword   —— 关键词
 *   mode=semantic  —— 向量
 *   mode=compare   —— 关键词、向量、混合三路（默认）
 */
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const mode = String(req.query.mode || 'compare');
  const topK = Number.parseInt(req.query.topK || '5', 10) || 5;
  const category = String(req.query.category || '').trim();
  if (!q) return res.json({ query: '', keyword: [], semantic: [], hybrid: [] });
  try {
    const result = await searchCompare(q, topK, category);
    if (mode === 'keyword') return res.json({ query: q, keyword: result.keyword, semantic: [], hybrid: [] });
    if (mode === 'semantic') return res.json({ query: q, keyword: [], semantic: result.semantic, hybrid: [] });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: `检索失败：${err.message}` });
  }
});

/**
 * POST /api/knowledge/upload
 * 读取 .md / .txt 的正文写入知识库。不保留原始文件。
 * body: { title?, filename?, content }
 */
router.get('/ingest/config', (req, res) => {
  const missing = missingCosEnv();
  res.json({ cosConfigured: missing.length === 0, missing });
});

router.get('/jobs', async (req, res) => {
  res.json({ jobs: await listJobs() });
});

/**
 * POST /api/knowledge/ingest/file
 * multipart 字段 file。原文上传到 COS，解析在后台进行。
 */
router.post('/ingest/file', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? '文件超过 20MB' : err.message;
    res.status(400).json({ error: message });
  });
}, async (req, res) => {
  try {
    assertCosConfig();
    const file = req.file;
    if (!file) return res.status(400).json({ error: '请选择文件' });
    const filename = decodeFilename(file.originalname || 'file');
    const title = filename.replace(/\.[^.]+$/, '') || filename;
    const entry = await createPendingEntry({
      title,
      sourceType: 'file',
      sourceUrl: filename,
      category: req.body?.category || '',
    });
    const cosKey = buildObjectKey(entry.id, filename);
    try {
      await putObject(cosKey, file.buffer, file.mimetype || 'application/octet-stream');
    } catch (err) {
      await deleteEntry(entry.id);
      throw err;
    }
    const jobId = await enqueueJob({
      type: 'file',
      entryId: entry.id,
      payload: { cosKey, filename },
    });
    res.status(202).json({ entry: { ...entry, cosKey, ingestStatus: 'pending' }, jobId });
  } catch (err) {
    res.status(400).json({ error: err.message || '上传失败' });
  }
});

/**
 * POST /api/knowledge/ingest/url
 * body: { url }
 */
router.post('/ingest/url', async (req, res) => {
  try {
    assertCosConfig();
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url 不能为空' });
    const entry = await createPendingEntry({
      title: url,
      sourceType: 'web',
      sourceUrl: url,
      category: '网页',
    });
    const jobId = await enqueueJob({ type: 'web', entryId: entry.id, payload: { url } });
    res.status(202).json({ entry, jobId });
  } catch (err) {
    res.status(400).json({ error: err.message || '提交失败' });
  }
});

/**
 * POST /api/knowledge/ingest/repo
 * body: { url, branch? } 公开的 https Git 地址，浅克隆后按文件入库。
 */
router.post('/ingest/repo', async (req, res) => {
  try {
    assertCosConfig();
    const url = String(req.body?.url || '').trim();
    const branch = String(req.body?.branch || '').trim();
    if (!url) return res.status(400).json({ error: 'url 不能为空' });
    if (branch && !/^[\w.\-/]+$/.test(branch)) {
      return res.status(400).json({ error: '分支名不合法' });
    }
    const jobId = await enqueueJob({ type: 'repo', payload: { url, branch } });
    res.status(202).json({ jobId });
  } catch (err) {
    res.status(400).json({ error: err.message || '提交失败' });
  }
});

router.post('/upload', async (req, res) => {
  const content = String(req.body?.content || '');
  const rawName = String(req.body?.title || req.body?.filename || '').trim();
  const title = rawName.replace(/\.(md|txt)$/i, '').trim();
  if (!title) return res.status(400).json({ error: 'title 不能为空' });
  if (!content.trim()) return res.status(400).json({ error: 'content 不能为空' });
  const entry = await createEntry({ title, content, keywords: [], category: req.body?.category || '' });
  res.status(201).json({ entry });
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
router.get('/', async (req, res) => {
  const entries = await listEntries();
  res.json({ entries });
});

/**
 * GET /api/knowledge/:id
 * 获取单个条目
 */
router.get('/:id', async (req, res) => {
  const entry = await getEntry(req.params.id);
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
router.delete('/:id', async (req, res) => {
  const existing = await getEntry(req.params.id);
  const ok = await deleteEntry(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: '条目不存在' });
  }
  if (existing?.cosKey) {
    deleteObject(existing.cosKey).catch((err) => {
      console.warn('[COS] 删除对象失败：', err.message);
    });
  }
  res.json({ ok: true });
});

function decodeFilename(name) {
  if (/[^\u0000-\u00ff]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

export default router;
