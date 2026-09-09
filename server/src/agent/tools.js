/**
 * Agent 工具集
 *
 * 【AI 学习要点 - Function Calling / 工具调用】：
 * 普通 Chat 只能让 AI "说话"，无法"做事"。
 * Function Calling 让模型返回一个结构化的 tool_calls（工具名 + 参数），
 * 由后端执行真正的函数，再把结果作为 tool 角色消息回传给模型，
 * 模型基于结果继续推理，直到给出最终答案 —— 这就是 Agent 的核心循环。
 *
 * 工具定义（tools）用 JSON Schema 描述参数，模型据此生成可解析的参数。
 *
 * 【知识库接入 - RAG 升级】：
 * search_frontend_kb 工具现在调用"语义检索"（searchEntriesSemantic）：
 *   把查询向量化，与每条知识条目的向量算余弦相似度，取 Top-K。
 *   即使查询和条目字面不重叠（如"函数怎么记住外部变量" vs "闭包"）也能召回。
 * 当未配置 embedding API Key 或向量缺失时，自动回退关键词检索，保证可用。
 */

import { searchEntriesSemantic, formatSearchResultText } from '../data/kbStore.js'

/**
 * 工具 1：搜索前端知识库（语义检索 / RAG）
 */
async function searchFrontendKb(keyword) {
  if (!keyword) return '错误：keyword 不能为空'
  // 语义检索：取相似度最高的 Top 3，相似度下限 0.3 过滤无关结果
  const results = await searchEntriesSemantic(keyword, 3, 0.3)
  return formatSearchResultText(keyword, results)
}

/**
 * 工具 2：查询 npm 包信息（真实调用 npm registry）
 */
async function getNpmPackageInfo(packageName) {
  if (!packageName) return '错误：packageName 不能为空'
  const name = String(packageName).trim()
  // 防止 scoped 包名等异常
  if (!/^[@a-z0-9][\w-.@/]*$/i.test(name)) {
    return `错误：包名 "${name}" 不合法`
  }
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%2F', '/')}`
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (res.status === 404) return `npm registry 中未找到包 "${name}"。`
    if (!res.ok) return `查询失败：HTTP ${res.status}`
    const data = await res.json()
    const latest = data['dist-tags']?.latest
    const latestVer = data.versions?.[latest] || {}
    return JSON.stringify({
      name: data.name,
      latest,
      description: latestVer.description || data.description || '(无描述)',
      license: latestVer.license || '(未知)',
      dependenciesCount: Object.keys(latestVer.dependencies || {}).length,
      unpackedSize: latestVer.dist?.unpackedSize || null,
      homepage: latestVer.homepage || data.homepage || null,
    })
  } catch (err) {
    return `查询 npm 包信息失败：${err.message}`
  }
}

/**
 * 工具 3：分析代码（纯本地计算，演示工具不一定依赖网络）
 */
async function analyzeCode(code) {
  if (!code) return '错误：code 不能为空'
  const text = String(code)
  const lines = text.split('\n').length
  const chars = text.length
  const nonEmptyLines = text.split('\n').filter(l => l.trim()).length
  const hasJsx = /<[A-Za-z][\w.]*[\s/>]/.test(text)
  const hasAsync = /\basync\b|\bawait\b/.test(text)
  const hasHooks = /\buse[A-Z]\w*\b/.test(text)
  return JSON.stringify({
    lines,
    nonEmptyLines,
    chars,
    hasJsx,
    hasAsync,
    hasHooks,
    summary: `共 ${lines} 行（${nonEmptyLines} 行非空），${chars} 字符，${hasJsx ? '含 JSX' : '无 JSX'}，${
      hasAsync ? '含异步' : '无异步'
    }，${hasHooks ? '含 React Hooks' : '无 Hooks'}`,
  })
}

/**
 * 工具注册表：name → handler
 * handler 接收解析后的参数对象，返回字符串（会作为 tool 消息回传给模型）
 */
const TOOL_HANDLERS = {
  search_frontend_kb: ({ keyword }) => searchFrontendKb(keyword),
  get_npm_package_info: ({ packageName }) => getNpmPackageInfo(packageName),
  analyze_code: ({ code }) => analyzeCode(code),
}

/**
 * OpenAI 兼容的 tools 定义（JSON Schema 描述参数）
 * 模型据此生成结构化参数
 */
export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_frontend_kb',
      description:
        '在前端开发知识库中搜索概念解释。当需要解释虚拟DOM、闭包、事件循环、useEffect、SSR、Tree Shaking 等前端基础概念时调用。',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: '要搜索的关键词，例如 "虚拟DOM"、"闭包"、"useEffect"',
          },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_npm_package_info',
      description:
        '查询 npm registry 上某个包的最新版本、描述、依赖数、体积等真实信息。当需要对比包大小、查看版本、了解依赖时调用。',
      parameters: {
        type: 'object',
        properties: {
          packageName: {
            type: 'string',
            description: 'npm 包名，例如 "react"、"vue"、"vite"',
          },
        },
        required: ['packageName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_code',
      description:
        '分析一段前端代码的统计信息：行数、字符数、是否含 JSX/异步/Hooks。当用户给一段代码想了解其结构特征时调用。',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: '要分析的代码文本',
          },
        },
        required: ['code'],
      },
    },
  },
]

/**
 * 执行工具调用
 * @param {string} toolName - 工具名
 * @param {object} args - 解析后的参数对象
 * @returns {Promise<string>} 工具执行结果（字符串）
 */
export async function executeTool(toolName, args = {}) {
  const handler = TOOL_HANDLERS[toolName]
  if (!handler) {
    return `错误：未知工具 "${toolName}"`
  }
  try {
    return await handler(args)
  } catch (err) {
    return `工具执行出错：${err.message}`
  }
}
