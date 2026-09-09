import express from 'express';
import cors from 'cors';
import chatRouter from './routes/chat.js';
import agentRouter from './routes/agent.js';
import knowledgeRouter from './routes/knowledge.js';
import historyRouter from './routes/history.js';
import promptsRouter from './routes/prompts.js';
import compareRouter from './routes/compare.js';
import { config } from './config/index.js';

const app = express();

// 中间件
app.use(cors()); // 允许前端跨域访问
app.use(express.json({ limit: '1mb' })); // 解析 JSON 请求体

// 简单的请求日志
app.use((req, res, next) => {
  console.log(`${new Date().toLocaleTimeString()} ${req.method} ${req.url}`);
  next();
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    model: config.dashscope.model,
    time: new Date().toISOString(),
  });
});

// 路由
app.use('/api/chat', chatRouter);
app.use('/api/agent', agentRouter);
app.use('/api/knowledge', knowledgeRouter);
app.use('/api/history', historyRouter);
app.use('/api/prompts', promptsRouter);
app.use('/api/compare', compareRouter);

// 根路由
app.get('/', (req, res) => {
  res.json({
    name: '前端开发知识库 API',
    version: '1.0.0',
    endpoints: {
      chat: 'POST /api/chat',
      agent: 'POST /api/agent',
      knowledge: 'GET/POST/PUT/DELETE /api/knowledge',
      quickQuestions: 'GET /api/chat/quick-questions',
      history: 'GET /api/history',
      prompts: 'GET/PUT /api/prompts',
      health: 'GET /api/health',
    },
  });
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('未捕获错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 启动服务
app.listen(config.port, () => {
  console.log('========================================');
  console.log('  前端开发知识库后端服务已启动');
  console.log('========================================');
  console.log(`  地址: http://localhost:${config.port}`);
  console.log(`  模型: ${config.dashscope.model}`);
  console.log(`  温度: ${config.dashscope.temperature}`);
  console.log('========================================');
});
