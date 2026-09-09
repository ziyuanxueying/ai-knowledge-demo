import { useState, useCallback, useRef } from 'react';
import {
  sendChatMessage,
  getSessions,
  getSessionDetail,
  deleteSession as apiDeleteSession,
} from '../utils/api.js';

/**
 * 方案 C：模型采样参数（temperature / maxTokens）
 * 存 localStorage，刷新页面后保留用户调参偏好
 */
const DEFAULT_PARAMS = { temperature: 0.7, maxTokens: 2048 };
const PARAMS_STORAGE_KEY = 'model_sample_params';

function loadParams() {
  try {
    const raw = localStorage.getItem(PARAMS_STORAGE_KEY);
    if (!raw) return DEFAULT_PARAMS;
    const parsed = JSON.parse(raw);
    return {
      temperature: typeof parsed.temperature === 'number' ? parsed.temperature : DEFAULT_PARAMS.temperature,
      maxTokens: typeof parsed.maxTokens === 'number' ? parsed.maxTokens : DEFAULT_PARAMS.maxTokens,
    };
  } catch {
    return DEFAULT_PARAMS;
  }
}

/**
 * 聊天逻辑 Hook
 *
 * 集中管理：消息列表、流式接收、会话切换、错误处理
 */
export function useChat() {
  const [messages, setMessages] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // 当前对话使用的 prompt 场景（角色）：决定 AI 用哪个人设回答
  const [scenario, setScenario] = useState('frontend_dev');
  // 消息预览：后端构造的最终 messages 数组（system/摘要/RAG/历史/user）
  // 由 /api/chat 在调用模型前推送，用于让用户看到"实际发给模型的内容"
  const [previewMessages, setPreviewMessages] = useState(null);
  // 方案 C：模型采样参数，持久化到 localStorage
  const [modelParams, setModelParamsState] = useState(loadParams);
  const abortRef = useRef(null);

  /** 更新采样参数并持久化 */
  const setModelParams = useCallback((next) => {
    setModelParamsState((prev) => {
      const merged = { ...prev, ...next };
      try {
        localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(merged));
      } catch {
        // localStorage 不可用时静默
      }
      return merged;
    });
  }, []);

  /** 恢复默认参数 */
  const resetModelParams = useCallback(() => {
    setModelParamsState(DEFAULT_PARAMS);
    try {
      localStorage.removeItem(PARAMS_STORAGE_KEY);
    } catch {
      // 静默
    }
  }, []);

  /** 加载会话列表 */
  const loadSessions = useCallback(async () => {
    try {
      const { sessions } = await getSessions();
      setSessions(sessions);
    } catch (e) {
      console.error('加载会话列表失败', e);
    }
  }, []);

  /** 切换会话 */
  const switchSession = useCallback(async (sessionId) => {
    if (sessionId === currentSessionId) return;
    setError(null);
    try {
      const { session } = await getSessionDetail(sessionId);
      setCurrentSessionId(sessionId);
      setMessages(session.messages);
    } catch {
      setError('加载会话失败');
    }
  }, [currentSessionId]);

  /** 新建会话 */
  const newChat = useCallback(() => {
    setCurrentSessionId(null);
    setMessages([]);
    setError(null);
  }, []);

  /** 删除会话 */
  const removeSession = useCallback(async (sessionId) => {
    await apiDeleteSession(sessionId);
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (sessionId === currentSessionId) {
      newChat();
    }
  }, [currentSessionId, newChat]);

  /** 发送消息 */
  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || loading) return;

    setError(null);
    setLoading(true);
    // 清空上一次的预览，新一轮请求会推送新的
    setPreviewMessages(null);

    // 1. 立即把用户消息加到列表
    const userMsg = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };

    // 2. 创建一个占位的 AI 消息，用于流式更新
    const assistantMsg = {
      id: `a_${Date.now()}`,
      role: 'assistant',
      content: '',
      streaming: true,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    // 中断控制器
    const controller = new AbortController();
    abortRef.current = controller;

    await sendChatMessage(
      {
        message: text,
        sessionId: currentSessionId,
        scenario,
        temperature: modelParams.temperature,
        maxTokens: modelParams.maxTokens,
      },
      {
        signal: controller.signal,
        onSession: (sessionId) => {
          setCurrentSessionId(sessionId);
        },
        onMessages: (data) => {
          // 后端在调用模型前推送的最终 messages 数组（含 token 估算）
          setPreviewMessages(data);
        },
        onChunk: (content) => {
          // 流式更新最后一条 AI 消息
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, content: last.content + content };
            }
            return next;
          });
        },
        onUsage: (usage) => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, usage };
            }
            return next;
          });
        },
        onDone: () => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, streaming: false };
            }
            return next;
          });
          setLoading(false);
          abortRef.current = null;
          // 刷新会话列表（标题可能更新了）
          loadSessions();
        },
        onError: (msg) => {
          setError(msg || '发送失败');
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant' && !last.content) {
              next.pop(); // 移除空的占位消息
            } else if (last) {
              next[next.length - 1] = { ...last, streaming: false };
            }
            return next;
          });
          setLoading(false);
          abortRef.current = null;
        },
      }
    );
  }, [loading, currentSessionId, loadSessions, scenario, modelParams.temperature, modelParams.maxTokens]);

  /** 停止生成 */
  const stopGenerate = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === 'assistant') {
        next[next.length - 1] = { ...last, streaming: false };
      }
      return next;
    });
  }, []);

  return {
    messages,
    sessions,
    currentSessionId,
    loading,
    error,
    scenario,
    setScenario,
    previewMessages,
    modelParams,
    setModelParams,
    resetModelParams,
    sendMessage,
    stopGenerate,
    newChat,
    loadSessions,
    switchSession,
    removeSession,
  };
}
