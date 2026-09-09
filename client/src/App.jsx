import { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import InputBox from './components/InputBox.jsx';
import KnowledgeBase from './components/KnowledgeBase.jsx';
import PromptLab from './components/PromptLab.jsx';
import CompareLab from './components/CompareLab.jsx';
import MessagePreview from './components/MessagePreview.jsx';
import ParamPanel from './components/ParamPanel.jsx';
import { useChat } from './hooks/useChat.js';
import { useAgent } from './hooks/useAgent.js';
import { getPrompts } from './utils/api.js';

/**
 * 应用主组件
 *
 * 两种视图：
 * - chat：对话（含「对话 / Agent」两种模式）
 * - knowledge：知识库管理
 */
export default function App() {
  const [view, setView] = useState('chat'); // 'chat' | 'knowledge' | 'prompt'
  const [mode, setMode] = useState('chat'); // 'chat' | 'agent'
  const chat = useChat();
  const agent = useAgent();

  // 当前模式对应的接口
  const isAgent = mode === 'agent';
  const messages = isAgent ? agent.messages : chat.messages;
  const sessions = chat.sessions; // 会话列表共用聊天模式的存储
  const currentSessionId = isAgent ? agent.currentSessionId : chat.currentSessionId;
  const loading = isAgent ? agent.loading : chat.loading;
  const error = isAgent ? agent.error : chat.error;

  const [apiReady, setApiReady] = useState(true);
  // 可选角色列表（与 Prompt 实验室的 prompts.json 联动：编辑器加新场景这里自动出现）
  const [scenarioList, setScenarioList] = useState([]);
  // 当前角色显示名（切换后 header 文字也跟着变）
  const currentScenarioName =
    scenarioList.find((s) => s.id === chat.scenario)?.name || '助手';

  // 启动时加载会话列表
  useEffect(() => {
    chat.loadSessions();
  }, [chat.loadSessions]);

  // 启动时加载角色列表
  useEffect(() => {
    getPrompts()
      .then((data) => setScenarioList(data.scenarios || []))
      .catch((e) => console.error('加载角色列表失败', e));
  }, []);

  // 检查后端是否配置了 API Key
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(() => setApiReady(true))
      .catch(() => setApiReady(false));
  }, []);

  const handleSend = (text) => {
    if (isAgent) {
      agent.sendTask(text);
    } else {
      chat.sendMessage(text);
    }
  };

  const handleStop = () => {
    if (isAgent) {
      agent.stopGenerate();
    } else {
      chat.stopGenerate();
    }
  };

  // 新建对话：切回 chat 视图（在知识库视图点新建对话应回到聊天）
  const handleNewChat = () => {
    setView('chat');
    if (isAgent) {
      agent.newChat();
    } else {
      chat.newChat();
    }
  };

  // 切换会话：同时切回 chat 视图
  const handleSwitchSession = (id) => {
    setView('chat');
    chat.switchSession(id);
  };

  // 切换模式时清空当前模式的消息状态
  const handleSwitchMode = (nextMode) => {
    if (nextMode === mode) return;
    if (nextMode === 'agent') {
      agent.newChat();
    } else {
      chat.newChat();
    }
    setMode(nextMode);
  };

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        onNewChat={handleNewChat}
        onSwitch={handleSwitchSession}
        onDelete={chat.removeSession}
        view={view}
        onOpenKnowledge={() => setView('knowledge')}
        onOpenPrompt={() => setView('prompt')}
        onOpenCompare={() => setView('compare')}
      />

      <main className="main">
        {view === 'knowledge' ? (
          <KnowledgeBase onBack={() => setView('chat')} />
        ) : view === 'prompt' ? (
          <PromptLab onBack={() => setView('chat')} />
        ) : view === 'compare' ? (
          <CompareLab onBack={() => setView('chat')} />
        ) : (
          <>
            <div className="chat-header">
              <span className="dot" />
              <span>{isAgent ? 'Agent 模式 · 在线' : `${currentScenarioName} 在线`}</span>
              <div className="mode-switch">
                <button
                  type="button"
                  className={`mode-btn ${mode === 'chat' ? 'active' : ''}`}
                  onClick={() => handleSwitchMode('chat')}
                >
                  对话
                </button>
                <button
                  type="button"
                  className={`mode-btn ${mode === 'agent' ? 'active' : ''}`}
                  onClick={() => handleSwitchMode('agent')}
                >
                  Agent
                </button>
              </div>
              {!isAgent && scenarioList.length > 0 && (
                <label className="scenario-picker">
                  <span className="scenario-picker-label">角色</span>
                  <select
                    className="scenario-select"
                    value={chat.scenario}
                    onChange={(e) => {
                      chat.setScenario(e.target.value);
                      // 切换角色时清空当前对话，避免新旧角色上下文混乱
                      chat.newChat();
                    }}
                  >
                    {scenarioList.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {!isAgent && (
              <ParamPanel
                params={chat.modelParams}
                onChange={chat.setModelParams}
                onReset={chat.resetModelParams}
              />
            )}

            {!isAgent && chat.previewMessages && (
              <MessagePreview data={chat.previewMessages} />
            )}

            <ChatWindow
              messages={messages}
              error={error}
              onSelectQuestion={handleSend}
              mode={mode}
            />

            <InputBox
              onSend={handleSend}
              onStop={handleStop}
              loading={loading}
              disabled={!apiReady}
            />
          </>
        )}
      </main>
    </div>
  );
}
