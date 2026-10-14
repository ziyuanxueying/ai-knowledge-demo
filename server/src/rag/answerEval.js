/**
 * 回答回归：同一条混合检索生成答案，再核对是否贴着父块、引用编号是否正确。
 * 会调用对话模型。检索 Hit@3 仍走 goldenEval.js，不在这里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { chat } from '../services/ai.service.js';
import { judgeGrounding } from '../services/judge.service.js';
import { loadFeedbackCases } from './feedbackCases.js';
import { retrieveHybrid } from './retrieve.js';

const answerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval', 'answer.json');

const ANSWER_SYSTEM = `你是前端开发知识库助手。只根据给出的检索结果回答。
- 若有命中，用结果里的 [编号] 标注。编号必须和检索结果一致，一句结论只标支撑它的那个编号
- 检索结果里没有的内容不要写成来自知识库
- 若结果写明未找到，或命中的父块答非所问，必须写明「知识库未收录」，不要编造编号，也不要说「据知识库」
用简体中文，控制在 200 字以内。`;

/** 种子题在前，已确认的补充回答题在后。 */
export function listAnswerCases() {
  const seed = loadAnswerCases().map((item) => ({ ...item, source: 'seed' }));
  return [...seed, ...loadFeedbackCases('answer')];
}

export function loadAnswerCases() {
  const cases = JSON.parse(fs.readFileSync(answerPath, 'utf-8'));
  validateCases(cases);
  return cases;
}

function validateCases(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('answer.json 至少要有一条用例');
  }
  items.forEach((item, index) => {
    const n = index + 1;
    if (!item || typeof item.q !== 'string' || !item.q.trim()) {
      throw new Error(`第 ${n} 条缺少 q`);
    }
    const hasTitle = typeof item.expectTitle === 'string' && item.expectTitle.trim();
    const hasEmpty = item.expectEmpty === true;
    if (hasTitle === hasEmpty) {
      throw new Error(`第 ${n} 条只能在 expectTitle 和 expectEmpty 里选一个`);
    }
  });
}

function expectText(item) {
  if (item.expectEmpty) return '应说明未收录';
  return `应贴着「${item.expectTitle}」`;
}

function citedNumbers(answer) {
  return [...new Set([...String(answer || '').matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])))];
}

function saysMissing(answer) {
  return /未收录|未找到|没有找到/.test(answer);
}

/**
 * 不调用模型就能判定的引用和未收录规则。
 * 父块是否支撑那句话仍交给裁判。
 */
export function deterministicFailures(answer, citations, item) {
  const failures = [];
  const text = String(answer || '');
  const cited = citedNumbers(text);
  const known = new Set((citations || []).map((cite) => cite.n));

  for (const n of cited) {
    if (!known.has(n)) failures.push(`编号 [${n}] 不在本次检索结果里`);
  }

  if (item.expectEmpty) {
    if (!saysMissing(text)) failures.push('应写明知识库未收录');
    if (cited.length > 0) failures.push('未收录的问题不应标注来源编号');
    if (/据知识库/.test(text) && !saysMissing(text)) failures.push('不能把未收录的内容写成据知识库');
  }

  if (item.expectTitle) {
    const expected = (citations || []).filter((cite) => cite.title === item.expectTitle).map((cite) => cite.n);
    if (expected.length > 0 && !cited.some((n) => expected.includes(n))) {
      failures.push(`应引用「${item.expectTitle}」的编号 [${expected.join('、')}]`);
    }
  }

  return failures;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

async function draftAnswer(question, context) {
  const { content } = await chat(
    [
      { role: 'system', content: ANSWER_SYSTEM },
      { role: 'user', content: `问题：${question}\n\n${context}` },
    ],
    { temperature: 0.1, maxTokens: 500 }
  );
  return String(content || '').trim();
}

/**
 * 逐题检索、作答、核对。与 Agent 预检索相同的 threshold 0.3、Top 5，追问改写关闭。
 * 期望文档没进本次检索时不再调用对话模型。
 */
export async function runAnswerEval() {
  const cases = listAnswerCases();
  const results = [];

  for (const item of cases) {
    const found = await retrieveHybrid(item.q, {
      topK: 5,
      threshold: 0.3,
      rewrite: false,
    });
    const titles = found.hits.map((hit) => hit.title);
    const base = {
      q: item.q,
      source: item.source || 'seed',
      expect: expectText(item),
      titles,
      answer: '',
      faithful: null,
      citationsOk: null,
    };

    if (item.expectTitle && !titles.includes(item.expectTitle)) {
      results.push({
        ...base,
        ok: false,
        failures: [`期望「${item.expectTitle}」未进入本次检索`],
      });
      continue;
    }

    const answer = await draftAnswer(item.q, found.text);
    const failures = deterministicFailures(answer, found.citations, item);
    let faithful = null;
    let citationsOk = null;

    if (!answer) {
      failures.push('模型没有作答');
    } else {
      try {
        const judged = await judgeGrounding({
          question: item.q,
          answer,
          citations: found.citations,
        });
        faithful = judged.faithful;
        citationsOk = judged.citationsOk;
        if (!faithful) failures.push(judged.faithfulReason || '结论没有贴着检索到的父块');
        if (!citationsOk) failures.push(judged.citationsReason || '引用编号和父块对不上');
      } catch (err) {
        failures.push(err.message || '裁判失败');
      }
    }

    const reasons = unique(failures);
    results.push({
      ...base,
      answer,
      faithful,
      citationsOk,
      failures: reasons,
      ok: reasons.length === 0,
    });
  }

  const hits = results.filter((item) => item.ok).length;
  return {
    total: results.length,
    hits,
    rate: results.length === 0 ? 0 : hits / results.length,
    model: config.dashscope.model,
    cases: results,
  };
}
