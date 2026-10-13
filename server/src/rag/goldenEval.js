/**
 * 固定考卷上的混合检索打分。供命令行和知识库页面共用。
 * 不建库、不补种子、不调用对话模型。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { retrieveHybrid } from './retrieve.js';

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval', 'golden.json');

export const GOLDEN_TOP_K = 3;

export function loadGoldenCases() {
  const cases = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));
  validateCases(cases);
  return cases;
}

/**
 * 按黄金集规则打分。titles 是检索返回的父文档标题，按相关度从高到低。
 */
export function gradeCase(titles, item) {
  const list = titles || [];
  const failures = [];
  if (item.expectTitle && !list.includes(item.expectTitle)) {
    failures.push(`期望「${item.expectTitle}」`);
  }
  if (item.forbidTitle && list.includes(item.forbidTitle)) {
    failures.push(`不应出现「${item.forbidTitle}」`);
  }
  if (item.expectEmpty && list.length > 0) {
    failures.push('应为空');
  }
  return { ok: failures.length === 0, failures };
}

function expectText(item) {
  const parts = [];
  if (item.expectTitle) parts.push(`期望「${item.expectTitle}」`);
  if (item.forbidTitle) parts.push(`不应出现「${item.forbidTitle}」`);
  if (item.expectEmpty) parts.push('应为空');
  return parts.join('，');
}

function validateCases(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('golden.json 至少要有一条用例');
  }
  items.forEach((item, index) => {
    const n = index + 1;
    if (!item || typeof item.q !== 'string' || !item.q.trim()) {
      throw new Error(`第 ${n} 条缺少 q`);
    }
    const hasExpect = typeof item.expectTitle === 'string' && item.expectTitle.trim();
    const hasForbid = typeof item.forbidTitle === 'string' && item.forbidTitle.trim();
    const hasEmpty = item.expectEmpty === true;
    if (!hasExpect && !hasForbid && !hasEmpty) {
      throw new Error(`第 ${n} 条缺少 expectTitle、forbidTitle 或 expectEmpty`);
    }
    if (hasExpect && hasForbid && item.expectTitle === item.forbidTitle) {
      throw new Error(`第 ${n} 条期望标题和禁止标题相同`);
    }
    if (item.category != null && typeof item.category !== 'string') {
      throw new Error(`第 ${n} 条 category 必须是字符串`);
    }
  });
}

/** 对黄金集逐题跑混合检索。与 Agent 相同：threshold 0.3、Top 3，追问改写关闭。 */
export async function runGoldenEval() {
  const cases = loadGoldenCases();
  const results = [];
  for (const item of cases) {
    const found = await retrieveHybrid(item.q, {
      topK: GOLDEN_TOP_K,
      threshold: 0.3,
      category: item.category || '',
      rewrite: false,
    });
    const titles = found.hits.map((hit) => hit.title);
    const graded = gradeCase(titles, item);
    results.push({
      q: item.q,
      category: item.category || '',
      expect: expectText(item),
      ok: graded.ok,
      failures: graded.failures,
      titles,
    });
  }
  const hits = results.filter((item) => item.ok).length;
  return {
    total: results.length,
    hits,
    topK: GOLDEN_TOP_K,
    rate: results.length === 0 ? 0 : hits / results.length,
    rerank: config.dashscope.rerankModel || '',
    cases: results,
  };
}
