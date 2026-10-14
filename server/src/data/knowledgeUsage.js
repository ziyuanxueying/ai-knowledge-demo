/**
 * 知识库用量：哪篇被引用过，哪篇出现在无用回答里，哪篇从未被引用。
 * 数字只来自已落库的来源卡片，不另做埋点。
 */
import { query } from './db.js';

function parseCitations(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 一次回答里同一篇父文档只计一次。 */
function entryIds(citations) {
  const ids = new Set();
  for (const cite of citations) {
    const id = String(cite?.entryId || '').trim();
    if (id) ids.add(id);
  }
  return ids;
}

function byTitle(a, b) {
  return String(a.title || '').localeCompare(String(b.title || ''), 'zh');
}

/**
 * @param {Array<{id: string, title: string, category?: string, ingestStatus?: string}>} entries
 * @param {Array<{citations: string|object[], createdAt?: string}>} messages
 * @param {Array<{citations: string|object[], verdict?: string}>} feedbackRows
 */
export function summarizeUsage(entries, messages, feedbackRows) {
  const byId = new Map();
  for (const entry of entries || []) {
    if (!entry?.id) continue;
    byId.set(entry.id, {
      entryId: entry.id,
      title: entry.title || '未命名',
      category: entry.category || '',
      ingestStatus: entry.ingestStatus || 'ready',
      citedCount: 0,
      uselessCount: 0,
      lastCitedAt: '',
    });
  }

  for (const message of messages || []) {
    const at = String(message?.createdAt || '');
    for (const id of entryIds(parseCitations(message?.citations))) {
      const row = byId.get(id);
      if (!row) continue;
      row.citedCount += 1;
      if (at && (!row.lastCitedAt || at > row.lastCitedAt)) row.lastCitedAt = at;
    }
  }

  for (const feedback of feedbackRows || []) {
    if (feedback?.verdict && feedback.verdict !== 'useless') continue;
    for (const id of entryIds(parseCitations(feedback?.citations))) {
      const row = byId.get(id);
      if (!row) continue;
      row.uselessCount += 1;
    }
  }

  const cited = [...byId.values()]
    .filter((row) => row.citedCount > 0 || row.uselessCount > 0)
    .sort((a, b) => b.citedCount - a.citedCount || b.uselessCount - a.uselessCount || b.lastCitedAt.localeCompare(a.lastCitedAt) || byTitle(a, b))
    .map(({ entryId, title, category, citedCount, uselessCount, lastCitedAt }) => ({
      entryId,
      title,
      category,
      citedCount,
      uselessCount,
      lastCitedAt,
    }));

  const neverCited = [...byId.values()]
    .filter((row) => row.citedCount === 0 && row.uselessCount === 0 && row.ingestStatus === 'ready')
    .sort(byTitle)
    .map(({ entryId, title, category }) => ({ entryId, title, category }));

  return { cited, neverCited };
}

export async function loadKnowledgeUsage() {
  const [entries, messages, feedback] = await Promise.all([
    query('SELECT id, title, category, "ingestStatus" FROM kb_entries'),
    query(
      `SELECT citations, "createdAt"
       FROM messages
       WHERE role = 'assistant' AND citations IS NOT NULL AND citations <> '' AND citations <> '[]'`
    ),
    query(
      `SELECT citations FROM answer_feedback WHERE verdict = 'useless'`
    ),
  ]);
  return summarizeUsage(entries.rows, messages.rows, feedback.rows);
}
