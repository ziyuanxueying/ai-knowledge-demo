/**
 * 混合检索 Hit@3。
 * 用法：在 server 目录执行 npm run eval:rag
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDB, closeDB } from '../data/db.js';
import { syncChunks } from '../data/kbStore.js';
import { retrieveHybrid } from './retrieve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goldenPath = path.join(__dirname, '..', '..', 'eval', 'golden.json');

const cases = JSON.parse(fs.readFileSync(goldenPath, 'utf-8'));

await initDB();
await syncChunks();

let hits = 0;
const misses = [];

for (const item of cases) {
  const found = await retrieveHybrid(item.q, { topK: 3, threshold: 0, rewrite: false, rerank: false });
  const titles = found.hits.map((hit) => hit.title);
  const ok = titles.includes(item.expectTitle);
  if (ok) hits += 1;
  else misses.push({ q: item.q, expectTitle: item.expectTitle, titles });
  console.log(`${ok ? 'HIT' : 'MISS'}  ${item.q}  =>  ${titles.join(' | ') || '(空)'}`);
}

const rate = cases.length === 0 ? 0 : hits / cases.length;
console.log(`\nHit@3 ${hits}/${cases.length} (${(rate * 100).toFixed(1)}%)`);
if (misses.length > 0) {
  console.log('未命中：');
  for (const miss of misses) {
    console.log(`- ${miss.q}（期望「${miss.expectTitle}」，实际 ${miss.titles.join('、') || '无'}）`);
  }
}

await closeDB();
process.exit(misses.length > 0 ? 1 : 0);
