import OpenAI from 'openai';
import { config } from '../config/index.js';

/**
 * Embedding（向量化）服务
 *
 * 【AI 学习要点 - Embedding / 向量表示】：
 * Embedding 把文本映射成一组高维浮点数向量（如 1024 维），
 * 语义相近的文本，向量在空间中也相近。
 *
 * 这样就能做"语义检索"：
 * - 把知识库每条条目向量化存起来
 * - 用户提问也向量化
 * - 算两个向量的余弦相似度，越接近 1 越相关
 * - 取相似度最高的 Top-K 喂给模型 —— 这就是 RAG 的核心
 *
 * 关键区别于关键词匹配：
 *   关键词："函数怎么记住外部变量" 搜不到 "闭包"（字面不重叠）
 *   语义检索：能召回（语义相近，余弦相似度高）
 *
 * 这里复用通义千问的 OpenAI 兼容端点 /embeddings，
 * 与 chat 调用同一个 client，只是把端点从 /chat/completions 换成 /embeddings。
 */

const client = new OpenAI({
  apiKey: config.dashscope.apiKey,
  baseURL: config.dashscope.baseURL,
});

/**
 * 判断是否配置了可用的 API Key
 */
export function hasEmbeddingConfig() {
  return !!(config.dashscope.apiKey && !config.dashscope.apiKey.startsWith('sk-your-'));
}

/**
 * 批量向量化文本
 * @param {string[]} texts - 多条文本
 * @returns {Promise<number[][]>} 向量数组（每条对应一个向量）
 */
export async function embedTexts(texts) {
  if (!hasEmbeddingConfig()) {
    throw new Error('未配置 DASHSCOPE_API_KEY，无法生成向量');
  }
  const cleaned = texts.map((t) => String(t || ''));
  // OpenAI 兼容：input 可传字符串数组，一次返回多个向量
  const res = await client.embeddings.create({
    model: config.dashscope.embeddingModel,
    input: cleaned,
  });
  // 按 index 排序，确保顺序与输入一致
  return res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/**
 * 向量化单条查询
 * @param {string} text - 用户查询
 * @returns {Promise<number[]>} 向量
 */
export async function embedQuery(text) {
  const vectors = await embedTexts([String(text || '')]);
  return vectors[0];
}

/**
 * 余弦相似度
 * 两个向量的夹角余弦，范围 [-1, 1]，越接近 1 越相似。
 *
 *   cos(a, b) = (a · b) / (|a| × |b|)
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} 相似度
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
