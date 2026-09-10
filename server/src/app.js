import express from 'express'
import cors from 'cors'
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

// 当前文件所在目录（server/src/），用于定位前端构建产物
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 前端构建产物目录：server/src → 上两级到项目根 → client/dist
const CLIENT_DIST = path.join(__dirname, '..', '..', 'client', 'dist')
// 仅当前端已构建（client/dist 存在）时才托管，避免本地开发模式下误拦截
const HAS_FRONTEND_BUILD = fs.existsSync(path.join(CLIENT_DIST, 'index.html'))

const app = express()

// 中间件
app.use(cors()) // 允许前端跨域访问
app.use(express.json({ limit: '1mb' })) // 解析 JSON 请求体

// 简单的请求日志
app.use((req, res, next) => {
  console.log(`${new Date().toLocaleTimeString()} ${req.method} ${req.url}`)
  next()
})

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    model: config.dashscope.model,
    time: new Date().toISOString(),
  })
})

// 路由
app.use('/api/chat', chatRouter)
app.use('/api/agent', agentRouter)
app.use('/api/knowledge', knowledgeRouter)
app.use('/api/history', historyRouter)
app.use('/api/prompts', promptsRouter)
app.use('/api/compare', compareRouter)

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

// 启动服务
app.listen(config.port, () => {
  console.log('========================================')
  console.log('  前端开发知识库后端服务已启动')
  console.log('========================================')
  console.log(`  地址: http://localhost:${config.port}`)
  console.log(`  模型: ${config.dashscope.model}`)
  console.log(`  温度: ${config.dashscope.temperature}`)
  console.log('========================================')
})
