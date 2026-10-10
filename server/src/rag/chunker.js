/**
 * 父子切片（不调用模型）
 *
 * 父块是送给模型的上下文：按 Markdown 标题分节，再把自然段合并到约 1000 字。
 * 子块是检索单位：在父块内部按句子拼成约 250 字，相邻块重叠约 40 字。
 * 短父块不再切开，子块正文与父块相同。
 */

const PARENT_TARGET = 1000;
const CHILD_TARGET = 250;
const CHILD_OVERLAP = 40;
const CHILD_AS_PARENT_BELOW = 400;

/**
 * @param {string} content
 * @returns {Array<{ heading: string, content: string, children: Array<{ content: string, charStart: number, charEnd: number }> }>}
 */
export function chunkDocument(content) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  if (!text.trim()) {
    return [
      {
        heading: '',
        content: '',
        children: [{ content: '', charStart: 0, charEnd: 0 }],
      },
    ];
  }

  const sections = splitSections(text);
  const parents = [];
  for (const section of sections) {
    const groups = mergeParagraphs(section.body, PARENT_TARGET);
    for (const body of groups) {
      parents.push({ heading: section.heading, content: body });
    }
  }
  if (parents.length === 0) {
    parents.push({ heading: '', content: text.trim() });
  }

  return parents.map((parent) => ({
    heading: parent.heading,
    content: parent.content,
    children: splitChildren(parent.content),
  }));
}

function splitSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let heading = '';
  let buf = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) sections.push({ heading, body });
    buf = [];
  };

  for (const line of lines) {
    const match = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (match) {
      flush();
      heading = match[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

function mergeParagraphs(body, target) {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const groups = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }
    if (current.length >= target) {
      groups.push(current);
      current = paragraph;
    } else {
      current = `${current}\n\n${paragraph}`;
    }
  }
  if (current) groups.push(current);
  return groups;
}

function splitChildren(parentContent) {
  if (parentContent.length < CHILD_AS_PARENT_BELOW) {
    return [{ content: parentContent, charStart: 0, charEnd: parentContent.length }];
  }

  const sentences = splitSentences(parentContent);
  if (sentences.length === 0) {
    return [{ content: parentContent, charStart: 0, charEnd: parentContent.length }];
  }

  const children = [];
  let index = 0;
  while (index < sentences.length) {
    let end = index;
    let length = 0;
    while (end < sentences.length && length < CHILD_TARGET) {
      length += sentences[end].end - sentences[end].start;
      end += 1;
    }
    if (end === index) end = index + 1;

    const startAt = sentences[index].start;
    const endAt = sentences[end - 1].end;
    children.push({
      content: parentContent.slice(startAt, endAt),
      charStart: startAt,
      charEnd: endAt,
    });

    if (end >= sentences.length) break;

    let overlap = 0;
    let next = end;
    while (next > index + 1 && overlap < CHILD_OVERLAP) {
      next -= 1;
      overlap += sentences[next].end - sentences[next].start;
    }
    index = next > index ? next : end;
  }

  return children.length > 0
    ? children
    : [{ content: parentContent, charStart: 0, charEnd: parentContent.length }];
}

function splitSentences(text) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?') {
      pushSentence(parts, text, start, i + 1);
      start = i + 1;
    }
  }
  if (start < text.length) pushSentence(parts, text, start, text.length);
  return parts;
}

function pushSentence(parts, text, start, end) {
  if (text.slice(start, end).trim()) parts.push({ start, end });
}

/** 子块送去向量化的文本：带上文档标题和小节，避免短句在向量空间里漂走 */
export function buildChildEmbedText(entry, child) {
  return `标题：${entry.title || ''}\n小节：${child.heading || ''}\n${child.content || ''}`;
}
