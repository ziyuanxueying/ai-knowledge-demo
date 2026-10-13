/**
 * 混合检索回归。不调用对话模型。
 * 在 server 目录执行：npm run eval:rag
 *
 * 与 Agent 预检索同一条 retrieveHybrid：threshold 0.3、Top 3。
 * 追问改写关闭。Rerank 是否启用只看 RERANK_MODEL，和线上一致。
 */
import { config } from '../config/index.js';
import { initDB, closeDB } from '../data/db.js';
import { ensureSeedEntries, syncChunks } from '../data/kbStore.js';
import { openDbTunnel } from '../sshTunnel.js';
import { GOLDEN_TOP_K, loadGoldenCases, runGoldenEval } from './goldenEval.js';

const cases = loadGoldenCases();
const rerank = config.dashscope.rerankModel || '未配置';
console.log(`用例 ${cases.length} 条；Top ${GOLDEN_TOP_K}；threshold 0.3；追问改写关闭；Rerank ${rerank}`);

const tunnel = await openDbTunnel();
let exitCode = 1;
try {
  await initDB();
  await ensureSeedEntries();
  await syncChunks();

  const report = await runGoldenEval();
  for (const item of report.cases) {
    const scope = item.category ? ` [${item.category}]` : '';
    const actual = item.titles.join(' | ') || '(空)';
    console.log(`${item.ok ? 'HIT' : 'MISS'} ${item.q}${scope}  =>  ${actual}`);
  }

  console.log(`\nHit@${report.topK} ${report.hits}/${report.total} (${(report.rate * 100).toFixed(1)}%)`);
  const misses = report.cases.filter((item) => !item.ok);
  if (misses.length > 0) {
    console.log('未通过：');
    for (const miss of misses) {
      const scope = miss.category ? ` [${miss.category}]` : '';
      const actual = miss.titles.join('、') || '无';
      console.log(`- ${miss.q}${scope}（${miss.failures.join('，')}，实际 ${actual}）`);
    }
  }
  exitCode = misses.length > 0 ? 1 : 0;
} finally {
  await closeDB();
  tunnel?.close();
}
process.exit(exitCode);
