import { Router } from 'express';
import { runAgent } from '../agent/agent.service.js';
import { summarizeHistory } from '../services/ai.service.js';
import { createSession, getSession, appendMessage, updateSessionSummary } from '../data/store.js';

// 与对话模式相同：最近 6 条留原文，更早的每多 2 条才摘要一次。
// 摘要失败时退回原来的最近 10 条，不挡住这一轮回答。
const MAX_RECENT_MESSAGES = 6;
const FALLBACK_HISTORY_MESSAGES = 10;

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
 *   { type: 'messages', messages, totalTokens, summary }  // 实际发给模型的 messages
 *   { type: 'thinking', step, plan: [{toolName, args}] }   // Agent 计划调用哪些工具
 *   { type: 'tool', step, toolName, args, result }          // 单个工具执行结果
 *   { type: 'citations', citations }                        // 检索到来源（父块 + 子块高亮位置）
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
  // 声明在 try 外，出错分支才能标记已结束。写在 try 里时 catch 访问不到，会把进程打崩。
  let finished = false;
  try {
    const { task, sessionId } = req.body;

    if (!task || typeof task !== 'string') {
      return res.status(400).json({ error: 'task 不能为空' });
    }

    // 获取或创建会话（复用聊天会话存储）
    let session = sessionId ? await getSession(sessionId) : null;
    if (!session) {
      session = await createSession('Agent 任务');
    }

    // 当前任务还没写入，摘要只覆盖更早的 user/assistant 正文。
    // 工具结果存在 toolSteps 里，不进这段历史，也就不会被压进摘要。
    const allHistory = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content || '' }));
    const earlier = allHistory.slice(0, -MAX_RECENT_MESSAGES);
    const recentHistory = allHistory.slice(-MAX_RECENT_MESSAGES);
    let summary = session.summary || '';
    let history = recentHistory;
    let summaryFailed = false;
    if (earlier.length - (session.summaryUpTo || 0) >= 2) {
      try {
        const newSummary = await summarizeHistory(earlier, summary);
        const updated = await updateSessionSummary(session.id, newSummary, earlier.length);
        summary = updated?.summary || newSummary;
        console.log(`[Agent 摘要] 触发: 压缩前 ${earlier.length} 条历史 -> ${summary.length} 字摘要`);
      } catch (err) {
        summaryFailed = true;
        console.error('生成 Agent 对话摘要失败:', err.message);
      }
    }
    if (summaryFailed) {
      history = allHistory.slice(-FALLBACK_HISTORY_MESSAGES);
      summary = '';
    }

    // 把用户任务存入历史
    await appendMessage(session.id, { role: 'user', content: task });

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 先发送 sessionId
    res.write(`data: ${JSON.stringify({ type: 'session', sessionId: session.id })}\n\n`);

    const controller = new AbortController();
    // 注意：不能用 req.on('close')，它会在请求体读完后立即触发，导致提前中断。
    // 用 res.on('close') 并加 finished 守卫，仅响应客户端真实断开（如点"停止"）。
    res.on('close', () => {
      if (!finished) controller.abort();
    });

    let fullContent = '';
    let usage = null;
    let citations = null;
    const steps = []; // 记录工具调用步骤，存入历史

    try {
      const stream = runAgent({ task, history, summary, signal: controller.signal });
      for await (const event of stream) {
        switch (event.type) {
          case 'messages':
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            break;
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
                hits: event.hits,
              });
            }
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            break;
          }
          case 'citations':
            citations = event.citations;
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            break;
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
    await appendMessage(session.id, {
      role: 'assistant',
      content: fullContent,
      usage,
      toolSteps: steps.length > 0 ? steps : undefined,
      citations: citations || undefined,
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
