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
 * - 旧的 knowledge.json / history.json 仍是"首次启动"的迁移源，表为空且文件存在时自动导入（幂等）。
 * - 会话/消息/知识库/向量统一存 Postgres；prompts.json 仍为文件存储（见 promptStore.js）。
 */

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new Pool(config.postgres);

pool.on('error', (err) => {
  console.error('[DB] 连接池空闲客户端异常:', err.message);
});

const HISTORY_JSON = path.join(__dirname, '..', 'history.json');
const KB_JSON = path.join(__dirname, 'knowledge.json');

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
      "createdAt"   TEXT NOT NULL,
      "updatedAt"   TEXT NOT NULL
    )
  `);

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

  await migrateFromJSON();
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

  const kbCount = (await query('SELECT COUNT(*)::int AS c FROM kb_entries')).rows[0].c;
  if (kbCount === 0 && fs.existsSync(KB_JSON)) {
    try {
      const { entries } = JSON.parse(fs.readFileSync(KB_JSON, 'utf-8'));
      if (entries && entries.length > 0) {
        await withTransaction(async (client) => {
          for (const e of entries) {
            await client.query(
              `INSERT INTO kb_entries (id, title, keywords, category, content, embedding, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)`,
              [
                e.id,
                e.title || '',
                JSON.stringify(e.keywords || []),
                e.category || '',
                e.content || '',
                e.embedding ? toVectorSql(e.embedding) : null,
                e.createdAt || new Date().toISOString(),
                e.updatedAt || new Date().toISOString(),
              ]
            );
          }
        });
        console.log(`[DB] 已从 knowledge.json 迁移 ${entries.length} 条知识库条目`);
      }
    } catch (err) {
      console.error('[DB] 迁移知识库失败:', err.message);
    }
  }
}
