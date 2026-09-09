import { Router } from 'express';
import {
  listScenarios,
  getRawPrompt,
  getRenderedPrompt,
  updatePrompt,
  getAvailableVars,
} from '../data/promptStore.js';

const router = Router();

/**
 * Prompt 管理 API
 *
 * 【AI 学习要点 - Prompt 工程可视化】：
 * 通过 REST API 暴露 Prompt 的读写，前端就能做编辑器，无需改代码 + 重启。
 *
 * 接口：
 * - GET    /api/prompts              列出所有 scenario + 可用变量
 * - GET    /api/prompts/:scenario    取单个（含 raw + 渲染后）
 * - PUT    /api/prompts/:scenario    更新 name / content，立即生效
 */

// 列出所有 scenario
router.get('/', (req, res) => {
  res.json({
    scenarios: listScenarios(),
    vars: getAvailableVars(),
  });
});

// 取单个 prompt
router.get('/:scenario', (req, res) => {
  const { scenario } = req.params;
  const raw = getRawPrompt(scenario);
  if (!raw) {
    return res.status(404).json({ error: `场景 "${scenario}" 不存在` });
  }
  res.json({
    scenario,
    name: raw.name,
    content: raw.content, // 原始（含 {{}}），编辑器显示用
    rendered: getRenderedPrompt(scenario), // 渲染后，调试预览用
    vars: getAvailableVars(),
    updatedAt: raw.updatedAt,
  });
});

// 更新 prompt
router.put('/:scenario', (req, res) => {
  const { scenario } = req.params;
  const { name, content } = req.body;
  if (content === undefined && name === undefined) {
    return res.status(400).json({ error: '至少提供 name 或 content' });
  }
  const updated = updatePrompt(scenario, { name, content });
  res.json({ ok: true, scenario, prompt: updated });
});

export default router;
