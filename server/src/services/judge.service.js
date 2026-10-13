import { chat } from './ai.service.js'

/**
 * LLM-as-a-Judge：用一个"裁判模型"给 A/B 两路回答打分（方案 E）
 *
 * 【AI 学习要点 - LLM 自动评分】：
 * 人工对比两个回答费时费力。让另一个 LLM 充当裁判，按明确的评分标准（rubric）
 * 对每个维度打分并给理由，就是 LLM-as-a-judge。关键工程点：
 *
 * 1. 评分维度要具体、可操作（不能只说"回答好不好"）
 * 2. 裁判用低温（temperature 0.1）保证评分稳定可复现
 * 3. 强制结构化 JSON 输出，并用 XML 标签分段 prompt 降低格式漂移
 * 4. JSON 解析必须兜底——模型可能用 ```json 包裹或夹带说明文字
 * 5. 已知偏差：位置偏好（模型倾向选先出现的 A），工业界会交换 A/B 顺序跑两次
 *    取平均（镜像消偏），学习项目在 prompt 中声明"不受顺序影响"即可
 */

export const JUDGE_DIMENSIONS = [
  { key: 'accuracy', label: '准确性', desc: '技术内容是否正确，有无事实性错误或误导' },
  { key: 'completeness', label: '完整性', desc: '是否完整回应了问题，有无关键遗漏' },
  { key: 'clarity', label: '清晰度', desc: '表达是否条理清晰、结构分明、易于理解' },
  { key: 'usefulness', label: '实用性', desc: '对前端开发者是否有实际帮助（代码示例、可操作建议）' },
]

function buildJudgePrompt(question, answerA, answerB, labelA, labelB) {
  const dimsText = JUDGE_DIMENSIONS
    .map((d, i) => `${i + 1}. ${d.label}（${d.key}）：${d.desc}`)
    .join('\n')

  return `<role>
你是一位严格的前端技术评审专家，负责评判两个 AI 回答的质量。
</role>

<task>
针对同一个用户问题，有两个候选回答（方案 ${labelA} 和方案 ${labelB}）。
请按下面 4 个维度分别给两个回答打分（1-10 分整数），并给出简短理由。
评分必须客观，不受回答出现顺序影响，不要因为措辞长短而偏袒。
</task>

<dimensions>
${dimsText}
</dimensions>

<input>
<question>
${question}
</question>

<answer_a label="${labelA}">
${answerA}
</answer_a>

<answer_b label="${labelB}">
${answerB}
</answer_b>
</input>

<output_format>
只输出一个 JSON 对象，不要输出任何其他文字、不要用 markdown 代码块包裹。格式：
{
  "A": {
    "scores": {"accuracy": 0, "completeness": 0, "clarity": 0, "usefulness": 0},
    "comment": "一句话总体评价，指出最突出的优点或问题"
  },
  "B": {
    "scores": {"accuracy": 0, "completeness": 0, "clarity": 0, "usefulness": 0},
    "comment": "一句话总体评价"
  },
  "winner": "A 或 B 或 tie",
  "summary": "两三句话总结：两者的核心差异是什么，什么场景该选哪个"
}
</output_format>`
}

/**
 * 从模型输出中提取 JSON（兜底处理 markdown 包裹和多余文字）
 */
function extractJson(text) {
  if (!text) return null
  // 1. 直接解析
  try {
    return JSON.parse(text)
  } catch {
    // 继续
  }
  // 2. 去掉 ```json ... ``` 代码块
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    try {
      return JSON.parse(fenced[1])
    } catch {
      // 继续
    }
  }
  // 3. 提取第一个 { 到最后一个 } 之间的内容
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      // 继续
    }
  }
  return null
}

/** 归一化裁判结果，补齐缺失字段，分数钳制到 1-10 */
function normalizeVerdict(parsed) {
  const clamp = (n) => {
    const v = Number.parseInt(n, 10)
    if (Number.isNaN(v)) return 0
    return Math.min(10, Math.max(0, v))
  }
  const normalizeSide = (side) => {
    const s = side?.scores || {}
    const scores = {
      accuracy: clamp(s.accuracy),
      completeness: clamp(s.completeness),
      clarity: clamp(s.clarity),
      usefulness: clamp(s.usefulness),
    }
    return {
      scores,
      total: scores.accuracy + scores.completeness + scores.clarity + scores.usefulness,
      comment: typeof side?.comment === 'string' ? side.comment : '',
    }
  }

  const A = normalizeSide(parsed?.A)
  const B = normalizeSide(parsed?.B)

  let winner = parsed?.winner
  if (winner !== 'A' && winner !== 'B' && winner !== 'tie') {
    // 模型没给合法 winner，按总分裁定
    winner = A.total === B.total ? 'tie' : A.total > B.total ? 'A' : 'B'
  }

  return {
    A,
    B,
    winner,
    summary: typeof parsed?.summary === 'string' ? parsed.summary : '',
    dimensions: JUDGE_DIMENSIONS,
  }
}

/**
 * 给 A/B 两个回答评分
 * @param {object} params
 * @param {string} params.question - 用户问题
 * @param {string} params.answerA - 方案 A 回答全文
 * @param {string} params.answerB - 方案 B 回答全文
 * @param {string} [params.labelA='方案 A']
 * @param {string} [params.labelB='方案 B']
 * @returns {Promise<{verdict: object, raw: string, usage: object}>}
 */
export async function judgeAnswers({ question, answerA, answerB, labelA = '方案 A', labelB = '方案 B' }) {
  const prompt = buildJudgePrompt(question, answerA, answerB, labelA, labelB)

  // 裁判用低温（0.1）+ 限制长度，保证评分稳定、输出收敛
  const { content, usage } = await chat(
    [
      { role: 'system', content: '你是专业的前端技术评审，只输出 JSON。' },
      { role: 'user', content: prompt },
    ],
    { temperature: 0.1, maxTokens: 1500 }
  )

  const parsed = extractJson(content)
  if (!parsed) {
    throw new Error('裁判返回的内容无法解析为 JSON')
  }

  return {
    verdict: normalizeVerdict(parsed),
    raw: content,
    usage,
  }
}

function sourceBlock(citations) {
  if (!citations?.length) return '（本次检索没有命中父块）'
  return citations
    .map((item) => {
      const where = item.heading ? `${item.title} / ${item.heading}` : item.title
      const excerpt = String(item.excerpt || '').slice(0, 800)
      return `[${item.n}] ${where}\n${excerpt}`
    })
    .join('\n\n')
}

function buildGroundingPrompt(question, answer, citations) {
  return `<role>
你是检索增强回答的核对员。只根据给出的父块判断回答，不要用你自己的知识补全。
</role>

<task>
检查两件事：
1. 忠实：回答里的结论能否在父块中找到。没有命中父块时，回答必须写明知识库未收录，不能把常识或编造内容说成来自知识库。
2. 引用：回答中每个 [n] 必须出现在来源列表里，且标了这个编号的那句话要能被该编号的父块支撑。有命中却把知识库结论写成没有编号，引用也不算对。没有命中时，回答里不该出现来源编号。
</task>

<input>
<question>
${question}
</question>

<sources>
${sourceBlock(citations)}
</sources>

<answer>
${answer}
</answer>
</input>

<output_format>
只输出一个 JSON 对象，不要输出其他文字，不要用 markdown 代码块包裹。格式：
{
  "faithful": true,
  "citationsOk": true,
  "faithfulReason": "一句话，说明结论是否贴着父块",
  "citationsReason": "一句话，说明编号是否对得上对应父块"
}
faithful 和 citationsOk 只能是布尔值。不通过时在对应 reason 里指出具体句子。
</output_format>`
}

function normalizeGrounding(parsed) {
  const reasons = Array.isArray(parsed?.reasons) ? parsed.reasons.filter((item) => typeof item === 'string') : []
  const faithful = parsed?.faithful === true
  const citationsOk = parsed?.citationsOk === true
  const faithfulReason = typeof parsed?.faithfulReason === 'string' ? parsed.faithfulReason.trim() : ''
  const citationsReason = typeof parsed?.citationsReason === 'string' ? parsed.citationsReason.trim() : ''
  return {
    faithful,
    citationsOk,
    faithfulReason: faithfulReason || (!faithful ? reasons[0] || '' : ''),
    citationsReason: citationsReason || (!citationsOk ? reasons[1] || reasons[0] || '' : ''),
  }
}

/**
 * 核对一次回答是否贴着本次检索到的父块，以及 [n] 是否对应该父块。
 * 裁判用低温，并强制 JSON。不引入 RAGAS。
 */
export async function judgeGrounding({ question, answer, citations = [] }) {
  const { content, usage } = await chat(
    [
      { role: 'system', content: '你是检索结果核对员，只输出 JSON。' },
      { role: 'user', content: buildGroundingPrompt(question, answer, citations) },
    ],
    { temperature: 0.1, maxTokens: 500 }
  )

  const parsed = extractJson(content)
  if (!parsed) {
    throw new Error('裁判返回的内容无法解析为 JSON')
  }

  return {
    ...normalizeGrounding(parsed),
    raw: content,
    usage,
  }
}
