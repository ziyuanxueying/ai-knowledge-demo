/**
 * PostgreSQL 数据库连接与初始化（pgvector）
 *
 * 【为什么用 PostgreSQL + pgvector】：
 * 1. SQLite 没有向量索引，语义检索要把所有向量读进内存、用 JS 算余弦相似度，
 *    知识库一大就会慢；pgvector 提供原生 vector 类型 + <=> 余弦距离算子，
 *    检索在数据库内完成，规模上来后用 HNSW 索引加速。
 * 2. SQLite 是单文件 + 单写入者，多实例并发写会锁等待；Postgres 是独立服务，
 *    多实例可连同一个库，适配 Sealos 多副本部署。
 *
 * 【部署要求】：
 * - 数据库需启用 pgvector（initDB 会执行 CREATE EXTENSION IF NOT EXISTS vector）。
 * - 通过 DATABASE_URL（或 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD）配置连接。
 *
 * 【数据迁移】：
 * - 旧的 history.json 仍是会话的首次启动迁移源，表为空且文件存在时自动导入（幂等）。
 * - 会话/消息/知识库/向量统一存 Postgres；prompts.json 仍为文件存储（见 promptStore.js）。
 */

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 连接参数来自 server/.env 的 DATABASE_URL 或 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD
export const pool = new Pool(config.postgres);

pool.on('error', (err) => {
  console.error('[DB] 连接池空闲客户端异常:', err.message);
});

const HISTORY_JSON = path.join(__dirname, '..', 'history.json');

const VECTOR_DIM = Number(config.embeddingDim);

if (!Number.isInteger(VECTOR_DIM) || VECTOR_DIM <= 0 || VECTOR_DIM > 16000) {
  throw new Error(`EMBEDDING_DIM 非法：${config.embeddingDim}（需为 1–16000 的整数）`);
}

/**
 * 把 number[] 转成 pgvector 的字符串形式 '[1,2,3]'
 * 写入时配合 $n::vector 强制转型，避免依赖客户端序列化器
 */
export function toVectorSql(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return `[${arr.map((n) => Number(n)).join(',')}]`;
}

export function query(text, params) {
  return pool.query(text, params);
}

/** 事务封装：fn(client) 内的多条 SQL 要么全成功要么全回滚 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 连接已断时 ROLLBACK 可能再失败，忽略
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function pingDB() {
  await pool.query('SELECT 1');
}

export async function closeDB() {
  await pool.end();
}

/**
 * 初始化：建扩展、建表、建索引，并从旧 JSON 迁移数据
 * 幂等，重复调用安全（CREATE ... IF NOT EXISTS）
 */
export async function initDB() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

  // Postgres 会把未加引号的标识符折叠成小写，camelCase 列加双引号保持字段名
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL DEFAULT '新对话',
      summary       TEXT NOT NULL DEFAULT '',
      "summaryUpTo" INTEGER NOT NULL DEFAULT 0,
      mode          TEXT NOT NULL DEFAULT 'chat',
      "createdAt"   TEXT NOT NULL,
      "updatedAt"   TEXT NOT NULL
    )
  `);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'chat'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      seq         BIGSERIAL,
      "sessionId" TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      usage       TEXT,
      "toolSteps" TEXT,
      "createdAt" TEXT NOT NULL
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages("sessionId", seq)'
  );
  await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS citations TEXT');
  await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS retrieval TEXT');

  // Agent 回答的有用/无用。点踩不自动进评测集，确认后再写入 eval/feedback.json。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS answer_feedback (
      id                    TEXT PRIMARY KEY,
      "sessionId"           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      "messageId"           TEXT NOT NULL,
      question              TEXT NOT NULL,
      "rewrittenQuery"      TEXT NOT NULL DEFAULT '',
      citations             TEXT NOT NULL DEFAULT '[]',
      answer                TEXT NOT NULL DEFAULT '',
      "embeddingModel"      TEXT NOT NULL DEFAULT '',
      verdict               TEXT NOT NULL,
      reason                TEXT NOT NULL DEFAULT '',
      "retrievalPromotedAt" TEXT NOT NULL DEFAULT '',
      "answerPromotedAt"    TEXT NOT NULL DEFAULT '',
      "createdAt"           TEXT NOT NULL,
      "updatedAt"           TEXT NOT NULL
    )
  `);
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_answer_feedback_message ON answer_feedback ("messageId")'
  );

  // Memory RAG：回合原文（kind=turn，随会话删除）和跨会话事实（kind=fact，sessionId 为空）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id                   TEXT PRIMARY KEY,
      "sessionId"          TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      "sourceSessionId"    TEXT,
      kind                 TEXT NOT NULL,
      content              TEXT NOT NULL,
      embedding            vector(${VECTOR_DIM}),
      embedding_model      TEXT,
      "userMessageId"      TEXT,
      "assistantMessageId" TEXT,
      "createdAt"          TEXT NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_memories_session ON memories("sessionId")');
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_turn_user
     ON memories ("userMessageId")
     WHERE kind = 'turn' AND "userMessageId" IS NOT NULL`
  );
  await ensureEmbeddingColumn('memories', 'idx_memories_embedding');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_entries (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      keywords    TEXT NOT NULL DEFAULT '[]',
      category    TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      embedding   vector(${VECTOR_DIM}),
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    )
  `);

  // 余弦距离 <=> 与检索 SQL 一致；HNSW 在数据量上来后才明显快于顺序扫描
  try {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_kb_entries_embedding
      ON kb_entries USING hnsw (embedding vector_cosine_ops)
    `);
  } catch (err) {
    console.warn('[DB] HNSW 向量索引创建失败，语义检索将走顺序扫描：', err.message);
  }
  await pool.query('CREATE INDEX IF NOT EXISTS idx_kb_entries_updated ON kb_entries("updatedAt" DESC)');
  await pool.query(`ALTER TABLE kb_entries ADD COLUMN IF NOT EXISTS "sourceType" TEXT NOT NULL DEFAULT 'manual'`);
  await pool.query(`ALTER TABLE kb_entries ADD COLUMN IF NOT EXISTS "sourceUrl" TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE kb_entries ADD COLUMN IF NOT EXISTS "cosKey" TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE kb_entries ADD COLUMN IF NOT EXISTS "ingestStatus" TEXT NOT NULL DEFAULT 'ready'`);
  await pool.query(`ALTER TABLE kb_entries ADD COLUMN IF NOT EXISTS "ingestError" TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE kb_entries ADD COLUMN IF NOT EXISTS "contentHash" TEXT NOT NULL DEFAULT ''`);
  // 空指纹（手工条目）和解析失败的记录不占唯一约束，失败后可以重新上传同一文件。
  // 库里若已有重复网页地址，唯一索引建不上，查重仍由写入前的查询完成。
  await createUniqueIndex(
    'idx_kb_entries_content_hash',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_entries_content_hash
     ON kb_entries ("contentHash")
     WHERE "contentHash" <> '' AND "ingestStatus" <> 'failed'`
  );
  await createUniqueIndex(
    'idx_kb_entries_web_url',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_entries_web_url
     ON kb_entries ("sourceUrl")
     WHERE "sourceType" = 'web' AND "sourceUrl" <> '' AND "ingestStatus" <> 'failed'`
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_jobs (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      status      TEXT NOT NULL,
      payload     TEXT NOT NULL,
      "entryId"   TEXT,
      error       TEXT NOT NULL DEFAULT '',
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_kb_jobs_status ON kb_jobs(status, "createdAt")');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id              TEXT PRIMARY KEY,
      "entryId"       TEXT NOT NULL REFERENCES kb_entries(id) ON DELETE CASCADE,
      "parentId"      TEXT,
      "chunkIndex"    INTEGER NOT NULL,
      heading         TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL DEFAULT '',
      "charStart"     INTEGER NOT NULL DEFAULT 0,
      "charEnd"       INTEGER NOT NULL DEFAULT 0,
      embedding       vector(${VECTOR_DIM}),
      embedding_model TEXT,
      "createdAt"     TEXT NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_kb_chunks_entry ON kb_chunks("entryId")');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_kb_chunks_parent ON kb_chunks("parentId")');
  await ensureEmbeddingColumn('kb_chunks', 'idx_kb_chunks_embedding');

  await migrateFromJSON();
  await backfillAgentSessionTitles();
}

/**
 * pgvector 的 vector(N) 不能原地改维度。和 EMBEDDING_DIM 不一致时丢掉该列再重建。
 * table / indexName 只来自本文件的常量，不接受外部输入。
 */
async function ensureEmbeddingColumn(table, indexName) {
  const res = await pool.query(
    `
    SELECT format_type(a.atttypid, a.atttypmod) AS label
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = $1
      AND a.attname = 'embedding'
      AND NOT a.attisdropped
  `,
    [table]
  );
  const label = res.rows[0]?.label || '';
  const match = /vector\((\d+)\)/.exec(label);
  const dim = match ? Number(match[1]) : null;
  if (dim == null || dim === VECTOR_DIM) {
    await createHnsw(table, indexName);
    return;
  }
  console.warn(`[DB] ${table}.embedding 当前是 ${label || '未知'}，将重建为 vector(${VECTOR_DIM})`);
  await pool.query(`DROP INDEX IF EXISTS ${indexName}`);
  await pool.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS embedding`);
  await pool.query(`ALTER TABLE ${table} ADD COLUMN embedding vector(${VECTOR_DIM})`);
  await createHnsw(table, indexName);
}

async function createUniqueIndex(name, sqlText) {
  try {
    await pool.query(sqlText);
  } catch (err) {
    console.warn(`[DB] 唯一索引 ${name} 未建立：`, err.message);
  }
}

async function createHnsw(table, indexName) {
  try {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${indexName}
      ON ${table} USING hnsw (embedding vector_cosine_ops)
    `);
  } catch (err) {
    console.warn(`[DB] ${table} HNSW 索引创建失败，语义检索将走顺序扫描：`, err.message);
  }
}

/**
 * 旧版 Agent 会话标题固定为「Agent 任务」。
 * 改成首条用户任务的前 20 字，并用 mode 区分对话和 Agent。
 */
async function backfillAgentSessionTitles() {
  await pool.query(`
    UPDATE sessions AS s
    SET
      mode = 'agent',
      title = COALESCE(
        NULLIF((
          SELECT left(m.content, 20)
          FROM messages AS m
          WHERE m."sessionId" = s.id AND m.role = 'user'
          ORDER BY m.seq ASC
          LIMIT 1
        ), ''),
        '新对话'
      )
    WHERE s.title = 'Agent 任务'
  `);
}

/** 从旧的 JSON 文件迁移数据到 Postgres（幂等） */
async function migrateFromJSON() {
  const sessionCount = (await query('SELECT COUNT(*)::int AS c FROM sessions')).rows[0].c;
  if (sessionCount === 0 && fs.existsSync(HISTORY_JSON)) {
    try {
      const { sessions } = JSON.parse(fs.readFileSync(HISTORY_JSON, 'utf-8'));
      if (sessions && sessions.length > 0) {
        await withTransaction(async (client) => {
          for (const s of sessions) {
            await client.query(
              `INSERT INTO sessions (id, title, summary, "summaryUpTo", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                s.id,
                s.title || '新对话',
                s.summary || '',
                s.summaryUpTo || 0,
                s.createdAt || new Date().toISOString(),
                s.updatedAt || new Date().toISOString(),
              ]
            );
            for (const m of s.messages || []) {
              await client.query(
                `INSERT INTO messages (id, "sessionId", role, content, usage, "toolSteps", "createdAt")
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                  m.id || `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  s.id,
                  m.role,
                  m.content || '',
                  m.usage ? JSON.stringify(m.usage) : null,
                  m.toolSteps ? JSON.stringify(m.toolSteps) : null,
                  m.createdAt || new Date().toISOString(),
                ]
              );
            }
          }
        });
        console.log(`[DB] 已从 history.json 迁移 ${sessions.length} 个会话`);
      }
    } catch (err) {
      console.error('[DB] 迁移会话历史失败:', err.message);
    }
  }
}
