import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 加载 .env 环境变量
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 文件存储目录（目前主要是 prompts.json）
 * 会话 / 消息 / 知识库 / 向量已迁到 PostgreSQL，不再写 DATA_DIR。
 * Sealos 部署：把持久卷挂到 /app/data，并设 DATA_DIR=/app/data。
 */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// 确保数据目录存在（持久卷首次挂载时可能是空目录）
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 应用配置
 * 所有配置项都从环境变量读取，便于不同环境部署
 */
export const config = {
  // 服务端口
  port: process.env.PORT || 3001,

  // 通义千问 API 配置
  // 注意：使用 OpenAI 兼容接口调用通义千问
  dashscope: {
    apiKey: process.env.DASHSCOPE_API_KEY || '',
    // OpenAI 兼容接口的基础地址（通义千问）
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    // 默认模型
    model: process.env.QWEN_MODEL || 'qwen-turbo',
    // 温度：控制回答的随机性
    temperature: Number.parseFloat(process.env.TEMPERATURE || '0.7'),
    // 最大输出 Token 数
    maxTokens: Number.parseInt(process.env.MAX_TOKENS || '2048', 10),
    // Embedding 向量化模型（RAG 用）：通义千问 text-embedding-v3 输出 1024 维向量
    // 通过同一个 OpenAI 兼容端点 /embeddings 调用
    embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-v3',
  },

  // 文件存储目录（prompts.json）
  dataDir: DATA_DIR,

  // PostgreSQL 连接配置（会话/消息/知识库/向量统一存 Postgres + pgvector）
  postgres: buildPostgresConfig(),

  // Embedding 向量维度（需与 embeddingModel 输出一致）
  // text-embedding-v3 默认 1024 维
  embeddingDim: Number.parseInt(process.env.EMBEDDING_DIM || '1024', 10),
};

/**
 * 托管 Postgres（Sealos / RDS）常用 sslmode=require；本地 docker-compose 不需要 SSL。
 * PGSSL=true / PGSSLMODE=require 开启；PGSSLMODE=no-verify 跳过证书校验。
 */
function buildSsl() {
  const mode = (process.env.PGSSLMODE || '').toLowerCase();
  const flag = (process.env.PGSSL || '').toLowerCase();
  if (flag === 'false' || mode === 'disable') return false;
  if (flag === 'true' || mode === 'require' || mode === 'no-verify') {
    return {
      rejectUnauthorized: mode !== 'no-verify' && process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false',
    };
  }
  return undefined;
}

function buildPostgresConfig() {
  const ssl = buildSsl();
  const max = Number.parseInt(process.env.PGPOOL_MAX || '10', 10);
  const base = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PGHOST || 'localhost',
        port: Number.parseInt(process.env.PGPORT || '5432', 10),
        database: process.env.PGDATABASE || 'ai_knowledge',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
      };
  return {
    ...base,
    max: Number.isFinite(max) && max > 0 ? max : 10,
    ...(ssl === undefined ? {} : { ssl }),
  };
}

// 启动时校验 API Key
if (!config.dashscope.apiKey || config.dashscope.apiKey.startsWith('sk-your-')) {
  console.warn('⚠️  警告：未配置有效的 DASHSCOPE_API_KEY');
  console.warn('   请复制 server/.env.example 为 server/.env 并填入真实 API Key');
  console.warn('   获取地址：https://bailian.console.aliyun.com/');
}
