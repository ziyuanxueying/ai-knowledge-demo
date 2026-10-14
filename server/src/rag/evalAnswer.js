/**
 * 回答回归。会调用对话模型。
 * 在 server 目录执行：npm run eval:answer
 *
 * 与 Agent 预检索同一条 retrieveHybrid：threshold 0.3、Top 5。
 * 追问改写关闭。有未通过的用例时进程退出码为 1。
 */
import { listAnswerCases, runAnswerEval } from './answerEval.js';
import { config } from '../config/index.js';
import { initDB, closeDB } from '../data/db.js';
import { ensureSeedEntries, syncChunks } from '../data/kbStore.js';
import { openDbTunnel } from '../sshTunnel.js';

const cases = listAnswerCases();
const extra = cases.filter((item) => item.source === 'feedback').length;
console.log(
  `回答用例 ${cases.length} 条（种子 ${cases.length - extra}，补充 ${extra}）；Top 5；threshold 0.3；追问改写关闭；模型 ${config.dashscope.model}`
);
console.log('每题会生成回答并调用裁判，和检索回归分开。');

const tunnel = await openDbTunnel();
let exitCode = 1;
try {
  await initDB();
  await ensureSeedEntries();
  await syncChunks();

  const report = await runAnswerEval();
  for (const item of report.cases) {
    const from = item.source === 'feedback' ? '补充 ' : '';
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${from}${item.q}`);
    if (!item.ok) {
      for (const reason of item.failures) console.log(`  - ${reason}`);
      if (item.answer) console.log(`  回答：${item.answer.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }

  console.log(`\n回答回归 ${report.hits}/${report.total} (${(report.rate * 100).toFixed(1)}%)`);
  exitCode = report.hits === report.total ? 0 : 1;
} finally {
  await closeDB();
  tunnel?.close();
}
process.exit(exitCode);
