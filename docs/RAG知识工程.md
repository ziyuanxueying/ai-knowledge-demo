# RAG 知识工程

知识库从「一条文档一个向量」改成父子切片。检索打在小块上，回答和引用使用父块全文。实现见 `server/src/rag/`。

## 存什么

手工条目和旧的 JSON 上传只把正文写进 PostgreSQL 的 `kb_entries.content`，不留原文件。`DATA_DIR` 仍然只放 `prompts.json`。

PDF、Word（`.docx`）、PPT（`.pptx`）、HTML、Markdown、TXT、CSV 走异步入库：接口先返回，后台再解析。原文存腾讯云 COS，对象键记在 `kb_entries.cosKey`。解析出的正文仍进 `content`，然后按下面的父子切片转向量。网页会抓取公网 HTML，正文入库，HTML 快照存 COS。公开 Git 仓库做浅克隆，最多 40 个可解析文件，每个文件一条文档。旧版 `.doc` 需要先另存为 `.docx`。

COS 用 `server/.env` 里的 `COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_BUCKET`、`COS_REGION`，可选 `COS_PREFIX`（默认 `kb/`）。没配齐时上传接口会直接说明缺哪几项。删除文档时会顺带删掉对应对象。

任务记在 `kb_jobs`，由当前 Node 进程排队执行。服务重启后，没跑完的任务会重新执行。文件要先传到 COS，重启后才能继续解析。网页抓取拒绝内网地址，仓库克隆限时 60 秒。

`kb_chunks` 同时放父块和子块：

- 父块：`parentId` 为空，没有向量。这是送给模型的上下文。
- 子块：`parentId` 指向父块，带 `embedding` 和 `embedding_model`。只有子块参与余弦检索。

删除文档时，块随 `kb_entries` 级联删除。

### 怎么在库里看

切块在 `kb_chunks`，整篇原文仍在 `kb_entries.content`。列名是驼峰，SQL 里要加双引号：`"entryId"`、`"parentId"`、`"chunkIndex"`、`"charStart"`、`"charEnd"`。

父块没有 `embedding`。子块有 `embedding` 和 `embedding_model`。查看是否已转向量时用 `embedding IS NOT NULL` 和 `vector_dims(embedding)`，不要把 `embedding` 整列选出来。

服务已启动时，用 `server/.env` 的 `DATABASE_URL` 连上后执行。下面按标题查出一篇文档的块，先父块后它的子块，正文只预览前 80 字：

```sql
SELECT
  CASE WHEN c."parentId" IS NULL THEN '父块' ELSE '子块' END AS kind,
  c."chunkIndex",
  c.heading,
  c."charStart",
  c."charEnd",
  length(c.content) AS chars,
  left(c.content, 80) AS preview,
  c.embedding IS NOT NULL AS has_embedding,
  c.embedding_model,
  CASE WHEN c.embedding IS NULL THEN NULL ELSE vector_dims(c.embedding) END AS dims
FROM kb_chunks c
JOIN kb_entries e ON e.id = c."entryId"
WHERE e.title = '文档标题'
ORDER BY COALESCE(c."parentId", c.id), (c."parentId" IS NOT NULL), c."chunkIndex";
```

要看全文，把 `left(c.content, 80)` 换成 `c.content`。

## 怎么切

切片不调用对话模型，也不改写原文。

父块按 Markdown 标题（`#` 到 `###`）分节，同一节里的自然段合并到大约 1000 字，不从段落中间切开。没有标题且全文较短时，整篇就是一个父块。

子块在父块内部按句号、问号、叹号拼到大约 250 字，相邻子块重叠大约 40 字。这 250 字是目标：切分只认这些标点，没有它们的长段（例如 PDF 抽出的目录）会整段落在同一个子块里，库里看到远大于 250 字的子块是符合实现的。父块短于大约 400 字时，只生成一个子块，正文与父块相同。子块记下在父块内的 `charStart` / `charEnd`，用来高亮。

短种子通常仍是 1 个父块加 1 个相同正文的子块。

## 向量

子块用环境变量里的 embedding 模型转向量，默认 `text-embedding-v3`，1024 维。送去转化的文本是「标题 / 小节 / 子块正文」。父块不转向量。问句用同一个模型。

余弦距离只和 `embedding_model` 等于当前配置的子块比较。同维度换模型时，启动会清空对不上的子块向量再重转；转完之前语义路为空，关键词路仍可用。换 `EMBEDDING_DIM` 时重建 `kb_chunks.embedding` 列和 HNSW 索引，不动会话表。

知识库面板显示当前模型，以及已转化子块 / 总子块。「补齐向量」只补空向量，「重新生成全部向量」按当前模型重转。模型与库内不一致时，按钮文案是「按当前模型重新转化」。

每条文档标题旁的「N 父块 / M 子块」表示该篇已切分。顶部「已转化子块 / 总子块」两边相等，且没有「待向量化」，表示子块都已转向量。语义检索能召回该篇，表示这些向量已参与检索。

## 检索

Agent 预检索和 `search_frontend_kb` 都走 `server/src/rag/retrieve.js`。

1. 有上一轮对话时，用当前 `QWEN_MODEL` 把追问改写成独立问句。首问或改写失败则用原句。不做 HyDE。
2. 关键词和向量各取子块 Top 20。关键词是子串匹配，不依赖中文分词扩展。
3. 用 RRF 融合：`1/(60+rank)` 相加。只出现在一路里的子块，另一路记 0。
4. 新鲜度不乘进融合分。相邻名次的分差大约只有 1%，半年打八折会把较新的次优文档排到更相关的旧文档前面。文档更新时间只在融合分相同时再比较。
5. 同一个父块有多个子块命中时只留分数最高的一条。
6. 配置了 `RERANK_MODEL`（例如 `gte-rerank`）时，把父块文本送给通义 rerank，取前 5。失败则保持 RRF 顺序。

可选查询参数 `category` 按条目分类过滤。没有多库和密级。

知识库页面的检索对比同时给出关键词、语义、混合三列，结果都是父块，并标出命中的子块。

## 引用

检索结果在答案开始前以 SSE 推送：

```json
{ "type": "citations", "citations": [{ "n": 1, "title": "闭包", "excerpt": "父块全文", "highlightStart": 0, "highlightEnd": 40 }] }
```

模型被要求用 `[1]` 这种编号作答。编号对不上或库里没有的，应写明知识库未收录。回答下方有来源卡片，点开父块原文，命中的子块会高亮。同一份 JSON 存在 `messages.citations`，从历史会话打开后还在。

Chat 模式不检索知识库，引用只出现在 Agent 回答上。

## 回归

`server/eval/golden.json` 放了一批问答，期望命中的是父文档标题。在 `server` 目录执行：

```bash
npm run eval:rag
```

脚本对每条问题跑混合检索，打印 Hit@3 和未命中列表。这不是 RAGAS，也没有接进 CI。
