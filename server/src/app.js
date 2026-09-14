import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import chatRouter from './routes/chat.js'
import agentRouter from './routes/agent.js'
import knowledgeRouter from './routes/knowledge.js'
import historyRouter from './routes/history.js'
import promptsRouter from './routes/prompts.js'
import compareRouter from './routes/compare.js'
import { config } from './config/index.js'
import { initDB, pingDB, closeDB } from './data/db.js'
import { seedIfEmpty } from './data/kbStore.js'

// 当前文件所在目录（server/src/），用于定位前端构建产物
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 前端构建产物目录：server/src → 上两级到项目根 → client/dist
const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist')
// 仅当前端已构建（client/dist 存在）时才托管，避免本地开发模式下误拦截
const HAS_FRONTEND_BUILD = fs.existsSync(path.join(CLIENT_DIST, 'index.html'))

const app = express()

// 信任反向代理（Sealos / Render / Nginx 等平台部署时，客户端 IP 在 X-Forwarded-For 中）。
// 不设置会导致 express-rate-limit 抛出 ERR_ERL_UNEXPECTED_X_FORWARDED_FOR。
// 数字 1 表示信任最外层一跳代理。
app.set('trust proxy', 1)

// 中间件
app.use(cors()) // 允许前端跨域访问
app.use(express.json({ limit: '1mb' })) // 解析 JSON 请求体

// ===== 接口限流 =====
// AI 对话类接口会真实消耗模型 token，严格限制（默认每分钟 20 次，可用环境变量调整）
const AI_RATE_MAX = Number(process.env.AI_RATE_LIMIT) || 20
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: AI_RATE_MAX,
  standardHeaders: true, // 返回 RateLimit-* 标准头
  legacyHeaders: false,
  message: { error: `请求过于频繁，请稍后再试（AI 接口每分钟最多 ${AI_RATE_MAX} 次）` },
})

// 普通 API 接口（历史/知识库/Prompt 等，不消耗 token），宽松限制
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
})

// 简单的请求日志
app.use((req, res, next) => {
  console.log(`${new Date().toLocaleTimeString()} ${req.method} ${req.url}`)
  next()
})

// 健康检查（不限流，供平台探活/冷启动检测）
app.get('/api/health', async (req, res) => {
  try {
    await pingDB()
    res.json({
      status: 'ok',
      db: 'ok',
      model: config.dashscope.model,
      time: new Date().toISOString(),
    })
  } catch {
    res.status(503).json({
      status: 'degraded',
      db: 'error',
      model: config.dashscope.model,
      time: new Date().toISOString(),
    })
  }
})

// 路由：AI 对话类接口用严格限流
app.use('/api/chat', aiLimiter, chatRouter)
app.use('/api/agent', aiLimiter, agentRouter)
app.use('/api/compare', aiLimiter, compareRouter)
// 普通接口用宽松限流
app.use('/api/knowledge', apiLimiter, knowledgeRouter)
app.use('/api/history', apiLimiter, historyRouter)
app.use('/api/prompts', apiLimiter, promptsRouter)

// ===== 前端静态文件托管（生产环境：client 构建产物由 Express 直接提供）=====
if (HAS_FRONTEND_BUILD) {
  // express.static 提供 /assets/* 等静态资源
  app.use(express.static(CLIENT_DIST))

  // SPA 路由回退：所有非 /api 的 GET 请求都返回 index.html，
  // 让前端（React）接管路由，避免刷新页面 404
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.sendFile(path.join(CLIENT_DIST, 'index.html'))
  })
} else {
  // 本地开发模式：前端由 Vite dev server 提供，根路由返回 API 信息
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
    })
  })
}

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('未捕获错误:', err)
  res.status(500).json({ error: '服务器内部错误' })
})

// 启动服务：先初始化数据库（建表/迁移/种子），再监听端口
async function bootstrap() {
  try {
    await initDB()
    await seedIfEmpty()
  } catch (err) {
    console.error('❌ 数据库初始化失败，请检查 PostgreSQL 连接与 pgvector 扩展：', err.message)
    process.exit(1)
  }

  app.listen(config.port, () => {
    console.log('========================================')
    console.log('  前端开发知识库后端服务已启动')
    console.log('========================================')
    console.log(`  地址: http://localhost:${config.port}`)
    console.log(`  模型: ${config.dashscope.model}`)
    console.log(`  温度: ${config.dashscope.temperature}`)
    console.log('  存储: PostgreSQL + pgvector')
    console.log('========================================')
  })
}

async function shutdown() {
  try {
    await closeDB()
  } catch {
    // ignore
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

bootstrap()
