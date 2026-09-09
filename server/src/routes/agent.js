import { Router } from 'express';
import { runAgent } from '../agent/agent.service.js';
import { createSession, getSession, appendMessage } from '../data/store.js';

const router = Router();

/**
 * Agent 路由
 *
 * 【AI 学习要点 - Agent 与普通 Chat 的区别】：
 * 普通 Chat（/api/chat）：用户问 → AI 答，单轮。
 * Agent（/api/agent）：用户给任务 → AI 自主调用工具 → 多轮推理 → 最终答案。
 *
 * SSE 事件类型（前端据此渲染 Agent 的"思考过程"）：
 *   { type: 'session', sessionId }
 *   { type: 'thinking', step, plan: [{toolName, args}] }   // Agent 计划调用哪些工具
 *   { type: 'tool', step, toolName, args, result }          // 单个工具执行结果
 *   { type: 'content', content }                            // 最终答案文本片段
 *   { type: 'usage', usage }                                // token 用量
 *   { type: 'aborted' }                                     // 被中断
 *   { type: 'done' }                                        // 结束
 *   { type: 'error', message }
 */

/**
 * POST /api/agent
 * 提交任务给 Agent，流式返回思考过程 + 最终答案
 *
 * 请求体：
 * {
 *   "sessionId": "xxx",   // 可选，不传则新建会话
 *   "task": "对比 react 和 vue 的包大小并给建议"
 * }
 */
router.post('/', async (req, res) => {
  try {
    const { task, sessionId } = req.body;

    if (!task || typeof task !== 'string') {
      return res.status(400).json({ error: 'task 不能为空' });
    }

    // 获取或创建会话（复用聊天会话存储）
    let session = sessionId ? getSession(sessionId) : null;
    if (!session) {
      session = createSession('Agent 任务');
    }

    // 把用户任务存入历史
    appendMessage(session.id, { role: 'user', content: task });

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 先发送 sessionId
    res.write(`data: ${JSON.stringify({ type: 'session', sessionId: session.id })}\n\n`);

    // 构造历史消息（用于多轮上下文）
    const history = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-10); // 只保留最近 10 条，控制 token

    const controller = new AbortController();
    let finished = false;
    // 注意：不能用 req.on('close')，它会在请求体读完后立即触发，导致提前中断。
    // 用 res.on('close') 并加 finished 守卫，仅响应客户端真实断开（如点"停止"）。
    res.on('close', () => {
      if (!finished) controller.abort();
    });

    let fullContent = '';
    let usage = null;
    const steps = []; // 记录工具调用步骤，存入历史

    try {
      const stream = runAgent({ task, history, signal: controller.signal });
      for await (const event of stream) {
        switch (event.type) {
          case 'thinking':
            steps.push({ step: event.step, plan: event.plan, tools: [] });
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            break;
          case 'tool': {
            const stepRecord = steps.find((s) => s.step === event.step);
            if (stepRecord) {
              stepRecord.tools.push({
                toolName: event.toolName,
                args: event.args,
                result: event.result,
              });
            }
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            break;
          }
          case 'content':
            fullContent += event.content;
            res.write(`data: ${JSON.stringify({ type: 'content', content: event.content })}\n\n`);
            break;
          case 'usage':
            usage = event.usage;
            break;
          case 'aborted':
            res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }
      }
    } catch (err) {
      if (
        err.name === 'AbortError' ||
        err.name === 'APIUserAbortError' ||
        err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        err.code === 'EPIPE'
      ) {
        res.write(`data: ${JSON.stringify({ type: 'aborted' })}\n\n`);
      } else {
        throw err;
      }
    }

    // 把 Agent 的最终回复存入历史（含工具步骤记录，便于回看）
    appendMessage(session.id, {
      role: 'assistant',
      content: fullContent,
      usage,
      agentSteps: steps.length > 0 ? steps : undefined,
    });

    res.write(`data: ${JSON.stringify({ type: 'done', usage })}\n\n`);
    res.write('data: [DONE]\n\n');
    finished = true;
    res.end();
  } catch (error) {
    console.error('Agent 接口错误:', error);
    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
      finished = true;
      res.end();
    } else {
      res.status(500).json({ error: error.message || 'Agent 服务异常' });
    }
  }
});

export default router;
