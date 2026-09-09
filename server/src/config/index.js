import dotenv from 'dotenv';

// 加载 .env 环境变量
dotenv.config();

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

  // 数据存储路径
  data: {
    historyFile: new URL('../data/history.json', import.meta.url).pathname,
  },
};

// 启动时校验 API Key
if (!config.dashscope.apiKey || config.dashscope.apiKey.startsWith('sk-your-')) {
  console.warn('⚠️  警告：未配置有效的 DASHSCOPE_API_KEY');
  console.warn('   请复制 server/.env.example 为 server/.env 并填入真实 API Key');
  console.warn('   获取地址：https://bailian.console.aliyun.com/');
}
