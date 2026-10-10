/**
 * 入库任务在进程内排队执行：请求先返回，解析和向量化在后台做。
 * 进程重启后，未完成的任务会重新跑。
 */
import { query as sql } from '../data/db.js';
import { completeIngest, createPendingEntry, failIngest } from '../data/kbStore.js';
import { extractText, htmlToText } from './extract.js';
import { cloneRepoFiles, fetchPublicPage } from './fetchSource.js';
import { buildObjectKey, getObjectBuffer, putObject } from '../storage/cos.js';

let draining = false;
let resumeRunning = true;

export async function enqueueJob({ type, entryId = null, payload }) {
  const now = new Date().toISOString();
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await sql(
    `INSERT INTO kb_jobs (id, type, status, payload, "entryId", error, "createdAt", "updatedAt")
     VALUES ($1, $2, 'pending', $3, $4, '', $5, $5)`,
    [id, type, JSON.stringify(payload), entryId, now]
  );
  kickIngest();
  return id;
}

export function kickIngest() {
  if (draining) return;
  draining = true;
  setImmediate(async () => {
    try {
      if (resumeRunning) {
        resumeRunning = false;
        await sql(`UPDATE kb_jobs SET status = 'pending' WHERE status = 'running'`);
      }
      for (;;) {
        const next = await sql(
          `SELECT * FROM kb_jobs WHERE status = 'pending' ORDER BY "createdAt" ASC LIMIT 1`
        );
        const job = next.rows[0];
        if (!job) break;
        await sql(`UPDATE kb_jobs SET status = 'running', "updatedAt" = $1 WHERE id = $2`, [
          new Date().toISOString(),
          job.id,
        ]);
        try {
          if (job.entryId) {
            await sql(
              `UPDATE kb_entries SET "ingestStatus" = 'parsing', "updatedAt" = $1
               WHERE id = $2 AND "ingestStatus" = 'pending'`,
              [new Date().toISOString(), job.entryId]
            );
          }
          await runJob(job);
          await sql(`UPDATE kb_jobs SET status = 'done', error = '', "updatedAt" = $1 WHERE id = $2`, [
            new Date().toISOString(),
            job.id,
          ]);
        } catch (err) {
          const message = err.message || '解析失败';
          await sql(`UPDATE kb_jobs SET status = 'failed', error = $1, "updatedAt" = $2 WHERE id = $3`, [
            message.slice(0, 500),
            new Date().toISOString(),
            job.id,
          ]);
          if (job.entryId) await failIngest(job.entryId, message);
          console.error('[Ingest]', job.type, message);
        }
      }
    } finally {
      draining = false;
    }
    const left = await sql(`SELECT id FROM kb_jobs WHERE status = 'pending' LIMIT 1`);
    if (left.rows[0]) kickIngest();
  });
}

export async function listJobs(limit = 20) {
  const res = await sql(
    `SELECT id, type, status, "entryId", error, "createdAt", "updatedAt"
     FROM kb_jobs ORDER BY "createdAt" DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function runJob(job) {
  const payload = JSON.parse(job.payload);
  if (job.type === 'file') return ingestFile(job, payload);
  if (job.type === 'web') return ingestWeb(job, payload);
  if (job.type === 'repo') return ingestRepo(payload);
  throw new Error(`未知入库任务：${job.type}`);
}

async function ingestFile(job, payload) {
  const buffer = await getObjectBuffer(payload.cosKey);
  const text = await extractText(payload.filename, buffer);
  if (!text) throw new Error('没有从文件中解析出文字');
  await completeIngest(job.entryId, { content: text, cosKey: payload.cosKey });
}

async function ingestWeb(job, payload) {
  const page = await fetchPublicPage(payload.url);
  const { title, text } = htmlToText(page.buffer.toString('utf8'));
  if (!text) throw new Error('网页里没有可入库的正文');
  const key = buildObjectKey(job.entryId, 'page.html');
  await putObject(key, page.buffer, 'text/html; charset=utf-8');
  await completeIngest(job.entryId, {
    content: text,
    cosKey: key,
    title: title || undefined,
  });
}

async function ingestRepo(payload) {
  const files = await cloneRepoFiles(payload.url, payload.branch || '');
  const failures = [];
  for (const file of files) {
    const entry = await createPendingEntry({
      title: file.relative,
      sourceType: 'repo',
      sourceUrl: payload.url,
      category: '仓库',
    });
    try {
      const text = await extractText(file.filename, file.buffer);
      if (!text) throw new Error('没有解析出文字');
      const key = buildObjectKey(entry.id, file.filename);
      await putObject(key, file.buffer);
      await completeIngest(entry.id, { content: text, cosKey: key, title: file.relative });
    } catch (err) {
      await failIngest(entry.id, err.message);
      failures.push(`${file.relative}: ${err.message}`);
    }
  }
  if (failures.length === files.length) {
    throw new Error(failures.slice(0, 3).join('；'));
  }
}
