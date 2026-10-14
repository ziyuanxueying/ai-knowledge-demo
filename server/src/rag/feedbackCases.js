/**
 * 人工确认后的补充评测题。种子集 golden.json / answer.json 不在这里改。
 * 文件不存在或是空数组时，两套回归只跑种子题。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const feedbackPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval', 'feedback.json');

export function feedbackFilePath() {
  return feedbackPath;
}

function readRaw() {
  if (!fs.existsSync(feedbackPath)) return [];
  const parsed = JSON.parse(fs.readFileSync(feedbackPath, 'utf-8'));
  if (!Array.isArray(parsed)) throw new Error('feedback.json 必须是数组');
  return parsed;
}

function validateItem(item, index) {
  const n = index + 1;
  if (!item || typeof item !== 'object') throw new Error(`feedback.json 第 ${n} 条不是对象`);
  if (item.kind !== 'retrieval' && item.kind !== 'answer') {
    throw new Error(`feedback.json 第 ${n} 条 kind 只能是 retrieval 或 answer`);
  }
  if (typeof item.q !== 'string' || !item.q.trim()) throw new Error(`feedback.json 第 ${n} 条缺少 q`);
  if (typeof item.feedbackId !== 'string' || !item.feedbackId.trim()) {
    throw new Error(`feedback.json 第 ${n} 条缺少 feedbackId`);
  }
  const hasTitle = typeof item.expectTitle === 'string' && item.expectTitle.trim();
  const hasEmpty = item.expectEmpty === true;
  if (item.kind === 'answer') {
    if (hasTitle === hasEmpty) throw new Error(`feedback.json 第 ${n} 条回答题只能在 expectTitle 和 expectEmpty 里选一个`);
    return;
  }
  if (!hasTitle && !hasEmpty) throw new Error(`feedback.json 第 ${n} 条检索题缺少 expectTitle 或 expectEmpty`);
  if (hasTitle && hasEmpty) throw new Error(`feedback.json 第 ${n} 条检索题不能同时写期望标题和应为空`);
}

/** @param {'retrieval'|'answer'} kind */
export function loadFeedbackCases(kind) {
  const items = readRaw();
  items.forEach(validateItem);
  return items
    .filter((item) => item.kind === kind)
    .map((item) => ({
      q: item.q.trim(),
      expectTitle: typeof item.expectTitle === 'string' ? item.expectTitle.trim() : '',
      expectEmpty: item.expectEmpty === true,
      feedbackId: item.feedbackId,
      source: 'feedback',
    }));
}

/**
 * 同一条反馈的同一种题只保留一条。已存在则不改文件。
 * @returns {{ added: boolean }}
 */
export function appendFeedbackCase(entry) {
  const items = readRaw();
  items.forEach(validateItem);
  const exists = items.some((item) => item.feedbackId === entry.feedbackId && item.kind === entry.kind);
  if (exists) return { added: false };
  const next = [...items, entry];
  next.forEach(validateItem);
  const tmp = `${feedbackPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, feedbackPath);
  return { added: true };
}
