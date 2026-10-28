---
title: "AIDriveNote 产品优化方案 v2"
overview: "对标 Notion / Obsidian / Reflect / Mem 等笔记最佳实践的产品优化方案：修复检索写入链路（RAG v2 分块 + pgvector）、把 AI 从侧栏搬进写作现场（选区工具条 / 相关笔记 / 引用溯源）、MCP 双向平台化（应用内客户端 + 出站 scoped 服务）、补齐易用性地基（笔记 URL / 全局搜索 / 快速捕获）与本地知识库 2.0。"
status: draft
synced_at: "2026-10-27"
---

> **实施状态**：P0 全部完成、P1 全部完成、P2 全部任务落地（块引用按 spike 结论待实施），详见《[实施与差距](./AIDriveNote-产品优化方案-v2-实施与差距.md)》。

# AIDriveNote 产品优化方案 v2

> 本文基于 2026-10-27 代码核实（HEAD `31e31b3`），所有结论标注文件与行号，便于核对与落地。
> 与既有方案的关系见文末 [十三](#十三与既有方案的关系)：[《产品能力演进方案》](./AIDriveNote-产品能力演进方案.md) 回答"缺什么能力"，本文回答"**已有能力为什么不好用、AI 为什么不贴身、检索为什么不可信、MCP 为什么只出不进**"。

---

## 一、结论先行

1. **产品定位一句话**：以本地文件与个人知识库为底座、AI 可追溯地帮你**写作与检索**的中文笔记工作台——不是 Notion 数据库克隆，也不是 Obsidian 插件平台。
2. **最大杠杆不是加新功能**，而是修复两条"断掉的基础链路"：检索写入链路（新建/导入/恢复的笔记根本不入索引）和笔记 URL 化（整站没有一篇笔记有独立地址）。
3. **AI 要从"侧栏咨询师"变成"写作现场的副驾"**：选区即用、相关笔记常驻、AI 回答可点击溯源——这三件事决定了 AI 是"多开的网页"还是"产品的核心"。
4. **RAG 要从"整篇一个向量 + Python 暴力扫描"升级为分块 + pgvector + RRF 融合 + 引用契约**，否则"知识库问答"永远停留在演示水平。
5. **MCP 要双向**：目前只有"把手填 JSON 贴给 Claude Desktop"的出站通道，应用内没有客户端、没有工具授权、没有审计。

**成熟度自评**（满分 10，供快速对齐）：

| 维度 | 编辑 | 本地同步/KB | 检索 | AI 融合 | MCP | 易用性地基 |
|------|------|-------------|------|---------|-----|------------|
| 分数 | 8 | 7 | 3 | 5 | 3 | 5 |

---

## 二、现状盘点与五个结构性错位

### 2.1 已具备的能力（核实通过）

| 能力 | 位置 |
|------|------|
| 四种笔记类型（BlockNote 富文本 / Markdown / 思维导图 / 流程图） | `frontend/src/components/note/NoteEditorContainer.tsx` |
| 服务器端 `[[wiki 链接]]` 解析 + 反链查询 | `backend/app/services/note/link_parser.py:9`、`note_enhance_service.py:179-233` |
| 中文全文检索（zhparser → pg_trgm → ILIKE 三级降级） | `note_enhance_service.py:479` 起、`search_config.py` |
| RAG v1（FTS 0.4 + 向量 0.6 混合） | `backend/app/services/ai/rag_service.py:63-85` |
| AI 助手 / 技能 / SSE 流式 / 16 个笔记工具 + 写确认卡 | `backend/app/ai_tools/note_tools.py`、`frontend/src/components/ai/AISidebar.tsx` |
| 出站 MCP 服务（FastMCP，5 个工具，PAT 认证） | `mcp-server/src/aidrivenote_mcp/server.py:195-400` |
| 录音转写（Whisper/听悟 + 说话人分离 + 章节化） | `backend/app/services/note/recording/` |
| 离线 IndexedDB + 写队列 + PWA | `frontend/src/services/offline/` |
| 本地文件夹双向同步 + 知识库管理模式（本地为准、不删不覆盖） | `frontend/src/services/sync/syncEngine.ts:1-27`、`kbConfig.ts:12-58` |

### 2.2 五个结构性错位（本次优化要解决的根因）

| # | 错位 | 代码证据 | 后果 |
|---|------|----------|------|
| S1 | **检索写入链路不闭环** | `create_note` 不生成向量（`note_service.py:336-344`）；恢复修订不重建（`note_enhance_service.py:355-361`）；解密后索引不重建（`note_lock_service.py:119-124` 清空后无人补）；嵌入失败被 `except: pass` 吞掉（`note_service.py:404-409`）；语义检索无 ORDER BY 取前 200 条 + Python 算余弦（`embedding_service.py:60-87`） | 新笔记搜不到、老笔记搜不全、故障静默——**"知识库问答"的地基是漏的** |
| S2 | **摘要优先于正文被索引** | `note_preview_text` 有 `description` 就只返回 description（`note_enhance_service.py:631-638`），嵌入文本 = `title + preview` 上限 2000 字（`embedding_service.py:52-58`） | 写了摘要的长笔记，**正文永远不会被语义检索命中**；`build_search_text` 也完全不含流程图（`link_parser.py:33-50`） |
| S3 | **AI 不在写作现场** | `openAI({selectionText, presetMessage})` 管道已建成（`AppContext.tsx:43`、`useAIChat.ts:152`、`AISidebar.tsx:162-165`）但全应用只有两处无参调用（`AppLayout.tsx:58,79`）——选区 AI 实际不可达 | 用户要选中一段话去侧栏"手动复述需求"，AI 是另一个 App |
| S4 | **AI 输出不可追溯** | 引用只是提示词里的一行文本 `- [标题](note_id=uuid): 预览`（`rag_service.py:41-42`），前端把链接渲染成 `target="_blank"` 外链（`AIChatMarkdown.tsx:244-257`），且全站没有笔记详情路由（`App.tsx:92-95` 只有 `/`） | 点引用要么弹新标签 404、要么无处可点；用户无法验证 AI 说的对不对，**信任建立不起来** |
| S5 | **MCP 只出不进、KB 只在浏览器** | 应用内无 MCP 客户端/服务器注册/工具授权/审计；PAT 无 scope；KB 模式纯前端实现（File System Access API，仅 Chromium），`raw/` 的 PDF/图片不入库，配置存在 localStorage 不跨设备 | 生态能力用不进来；知识库资产（PDF、OCR）进不了检索；换浏览器配置全丢 |

---

## 三、定位与五条设计原则

| # | 原则 | 含义与约束 |
|---|------|-----------|
| P1 | **捕获 3 秒内完成** | 任何入口（快捷键 / 手机 FAB / 系统分享 / 邮件）到内容落库 ≤ 3s；先落 Inbox 再整理 |
| P2 | **每个 AI 回答可溯源** | 引用必须是可点击对象（笔记 + 块 + 原文引文），点击可跳转验证；无法给出引用时明确说"未在你的笔记中找到依据" |
| P3 | **AI 提议，人来批准** | 一切写操作（改标签、建链接、改正文、调工具）默认出候选 + 确认，沿用现有 `NoteChangeConfirmCard` 模式 |
| P4 | **本地文件不被静默改写** | KB 模式"本地为准、不删不覆盖、保护目录只读"是不变量（`syncEngine.ts:1-27`），AI 与索引只能读，不能触发写回 |
| P5 | **优雅降级而非报错** | 嵌入 / 重排 / 某个模型 / 某个 MCP 服务器不可用时，检索退到 FTS、AI 退到无工具模式，并在 UI 显式提示，绝不静默失败（现状 S1 的反面） |

---

## 四、对标差距矩阵

| 维度 | 标杆做法 | AIDriveNote 现状 | 目标态 | 优先级 |
|------|----------|------------------|--------|--------|
| 捕获入口 | Apple Notes / Bear：随处 3 秒记一条 | 无 Inbox、无快速捕获、无 share target | Inbox 路由 + FAB + PWA share target + 邮件转笔记 | P1 |
| 编辑器 | Notion 块编辑 / Obsidian Markdown | 四类型各自完整（优势，保留） | 不合并类型；补选区 AI、`[[` 补全、笔记内查找 | P0-P1 |
| 双向链接 | Obsidian/Roam：自动补全、可点反链、块引用 | 文档级、纯文本展示（`NoteEditorPanel.tsx:1423-1433`）、精确标题匹配 | 可点反链 + `[[` 补全 + 别名 + 改名级联；块引用做技术验证 | P1/P2 |
| 搜索 | Notion/Obsidian：全局 ⌘K、片段高亮、过滤器 | 列表内 ILIKE（`note_service.py:252-263`）；带高亮的 fulltext 端点存在但**无调用方**（`note.py:440-454`）；⌘K 仅编辑器命令 | 统一 ⌘K：笔记（真高亮片段）+ 命令 + 文件夹 + 标签 | P0 |
| AI 写作 | Notion AI 行内改写；Mem/Reflect 自动关联建议 | 仅侧栏 + 少量预设动作；`selectionText` 管道建成未接线（S3） | 选区工具条 + 相关笔记面板 + 建议链接 + 批准制自动标签 | P0-P1 |
| AI 问答 | Notion Q&A 带来源、可跳转验证 | Top-5 整篇预览注入提示词，引用不可点（S4） | 分块检索 + 引用对象（笔记/块/引文）+ 范围选择器 | P0-P1 |
| 知识库 | Obsidian vault 本地为主；Readwise 原子化沉淀 | 浏览器端 KB 模式（仅 Chromium），raw/ 资产不入库 | KB 2.0：服务端清单 + PDF 文本抽取 + 检索入库 | P1 |
| 扩展/MCP | Obsidian 插件生态；Claude/Cursor 等外部 Agent | 仅出站 5 工具 + 手填 PAT JSON | 应用内 MCP 客户端（发现/授权/审计）+ 出站 scoped PAT | P1-P2 |
| 分享发布 | Notion publish 只读链接 | 用户间 share + 邮件 | 公开只读链接（可过期、可撤销） | P2 |
| 版本历史 | Notion/Obsidian diff 对比 | 列表 + 恢复，无 diff（`NoteEditorPanel.tsx:1436-1454`） | 块级/行级 diff + 恢复前预览 | P1 |
| 移动端 | Bear/Apple Notes 单手即用 | 列表/编辑器二选一单栏 | 底部导航 + 滑动操作 + 捕获 FAB | P1 |
| 上手迁移 | Notion/Notion 导入器、Obsidian vault 导入 | 无引导、无导入器 | Markdown 文件夹 / Obsidian vault / Notion zip 导入 + 3 步引导 | P1-P2 |

---

## 五、主线 A：RAG v2 —— 先让检索"成立"，再谈智能

> 顺序原则：**先修写入路径（P0），再放大到分块（P1）**。写入路径现在是错的（不嵌入、静默失败），先放大只会让回填成本翻倍。

### A1 不变量

- 所有检索按 `created_by` 隔离（沿用 `embedding_service.py:70-77` 模式）；
- **加密笔记的明文永不入索引**：加锁时清块（对齐 `note_lock_service.py:119-124`），解锁期间保存才建块，worker 入队前二次校验；
- 游客配额：每游客 chunk 上限 50，防索引资源滥用；
- Ollama 不可用 → 检索自动降级 FTS + UI 横幅提示（P5 原则）。

### A2 数据模型（新增三张表 + 一个扩展）

```sql
CREATE EXTENSION IF NOT EXISTS vector;  -- pgvector, PostgreSQL 16

-- 文档级：内容指纹 + 版本，保证幂等
CREATE TABLE rag_documents (
  id UUID PK, note_id UUID FK, user_id UUID,
  content_hash CHAR(64),        -- SHA-256(title+content)，变了才重建
  chunk_count INT, status TEXT, -- pending|ok|failed|encrypted
  error TEXT, indexed_at TIMESTAMPTZ
);

-- 块级：检索与引用的最小单元
CREATE TABLE rag_chunks (
  id UUID PK, note_id UUID, user_id UUID, document_id UUID,
  chunk_index INT,
  heading_path TEXT,            -- "第一章 > 第一节"，装配时作前缀防断章取义
  content TEXT,                 -- 纯文本（剥离 base64/图片）
  content_hash CHAR(64),
  token_count INT,
  meta JSONB,                   -- note_type、时间戳（录音）、media_type 等
  embedding vector(768),        -- nomic-embed-text 维度，换模型需校验维度
  tsv tsvector                  -- 块级 FTS，GIN 索引
);
CREATE INDEX ON rag_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON rag_chunks USING gin (tsv);

-- 任务队列：APScheduler 进程内 worker 消费
CREATE TABLE rag_index_jobs (
  id UUID PK, note_id UUID, user_id UUID,
  reason TEXT,                  -- create|update|restore|decrypt|import|backfill
  priority INT, status TEXT, attempts INT, scheduled_at TIMESTAMPTZ, error TEXT
);
```

### A3 分块策略

| 笔记类型 | 切分方式 | 备注 |
|----------|----------|------|
| rich_text | 按标题分组块序列，400–800 token，重叠 15% | 保留 BlockNote 块 id → 引用可定位到块 |
| markdown | 按标题层级切，代码块/表格不切断 | heading_path 直接取标题栈 |
| mindmap | 按节点子树切（子树即语义单元） | 复用 `link_parser.py:53-62` 的文本展开 |
| flowchart | 节点 label + 连线 label 拼接为一个块 | 修复 S2 中"流程图不入检索"的缺口 |
| 录音转写 | 按章节/段切，meta 带起止时间 | 引用可点击跳转到音频对应时刻 |
| PDF（KB 2.0） | 按页 + 标题切 | pypdf 抽文本层，扫描件走 OCR（P2） |

通用规则：块内容带 `标题 + heading_path` 前缀；剥离 base64/图片数据；同 hash 幂等跳过。

### A4 索引生命周期（修复 S1）

1. **写路径只入队**：`create_note` / `update_note` / `restore_revision` / 解密 / KB 导入 / MCP `create_note`，全部只写 `rag_index_jobs`，**不再在请求内 await 嵌入**（消除保存被 Ollama 拖 30s 的隐患）；
2. **worker 防抖重建**：同笔记 15s 内合并任务；按 content_hash 幂等；指数退避重试，失败可见（管理端队列视图 + 笔记上"索引中/已索引/失败"角标）；
3. **嵌入文本改为正文拼接**：`title + description + 正文全文`（修复 S2），description 只作前缀不再顶替正文；
4. **一次性回填**：`python -m app.scripts.reindex --user <id> [--all]`，低优先级分批跑。

### A5 检索与融合

- 候选集：向量 Top-40（HNSW）∪ 块级 FTS Top-40 ∪ 链接邻居 Top-10（沿 `note_links` 一跳，复用现有反链表）；
- **RRF 融合**（k=60）替代当前硬编码 0.4/0.6 加权（`rag_service.py:72-77`），两路分数不同量纲不可线性加权；
- 可选重排：Top-20 → bge-reranker（本地 Ollama/独立进程）→ Top-8，失败则跳过；
- 过滤器：标签 / 文件夹子树 / 时间 / 笔记类型 / `include_shared`（共享笔记纳入检索需带权限校验，当前被完全排除）；
- 当前笔记置顶保留（`rag_service.py:55-61` 逻辑沿用）；同笔记多块命中去重取最高分块。

### A6 上下文装配与引用契约（修复 S4）

Token 预算：系统提示 ≤1.2k、RAG 上下文 ≤2.5k、历史 ≤2k、回答 ≤1.5k，超限按分数截断。

引用从"提示词文本"升级为**结构化对象**：

```json
{ "note_id": "...", "note_no": "N0042", "title": "会议纪要",
  "chunk_id": "...", "heading_path": "行动项",
  "quote": "由张三在周五前完成部署……" }
```

- SSE 新增 `citations` 事件随 `done` 下发；前端在回答下方渲染**引用芯片**（`AIChatMarkdown.tsx:244` 的外链渲染改为应用内路由）；
- 点击 → `/note/:id?chunk=<chunk_id>`，编辑器定位到对应块/标题并高亮 quote（hash 校验，笔记已改则提示"原文已变更"）；
- 提示词仍保留"请引用来源"，但校验以结构化 citations 为准。

### A7 迁移路径

`RAG_V2_READ` 开关：v2 就绪前读路径仍走 v1（JSONB 列保留双写）；离线评测（见 P0-7 评测集）达标后切读，观察一周再删旧列。

---

## 六、主线 B：AI 深度融合 —— 从侧栏到写作现场

| # | 场景 | 入口 / 交互 | 关键改动 | 失败模式与兜底 |
|---|------|-------------|----------|----------------|
| B1 | **选区 AI 工具条** | 编辑器选中文字浮出气泡：润色 / 续写 / 翻译 / 摘要 / 问 AI | 接通已建成的 `openAI({selectionText, presetMessage})`（`AppContext.tsx:43`、`useAIChat.ts:152`、`AISidebar.tsx:162-165`）；结果以"建议稿"呈现，确认后替换/插入 | BlockNote 跨块选区无法原位替换 → 退化为"整块替换"或"插入到下方"，UI 文案说明 |
| B2 | **相关笔记面板** | 编辑器右栏常驻：语义相关 + 共同标签 + 链接邻居；每条可"建立链接 / 忽略" | 新 `related_service`（复用 RAG v2 向量）；"建立链接"经用户确认后写 `[[标题]]`（走 `update_note`） | 有 dismiss 记忆，避免低质量建议骚扰 |
| B3 | **自动标签（批准制）** | 保存 30s 后出 3–5 个候选标签，编辑器内一键采纳 | worker 任务；**优先从既有标签库选**，防止标签体系膨胀；绝不静默写入 | 模型不可用则不出候选，无感知 |
| B4 | **录音 → 结构化纪要** | 转写完成页一键生成：摘要 / 决议 / 行动项（负责人·期限·出处章节时间戳）/ 待跟进 | 新 `recording_insight_service`，按章节分批控成本；结果可插入原笔记或另建笔记 | 长音频按章限流；失败保留原始转写 |
| B5 | **"问我的知识库"范围选择** | 聊天输入框上的范围芯片：全部 / 当前文件夹 / 标签 / 当前笔记 / 时间段；"仅依据我的笔记"与"允许联网"互斥 | `/ai/chat/stream` 增加 `scope` 参数透传到 A5 过滤器 | 范围内零命中 → 明确回答"未找到依据"，不编造 |
| B6 | **对话质量** | 重新生成、编辑消息、引用选区入对话、会话自动命名、逐条复制 | `useAIChat.ts` 与 `AISidebar.tsx` 增强 | — |
| B7 | **AI 溯源徽章** | AI 写入的内容带来源标记，修订历史可见"AI 生成 → 用户已改" | 修订 `change_summary` 记录工具来源（轻量实现） | — |

B1–B3 是"AI 贴身"的最低配置：**选中即用、打开即相关、保存即标签**。

---

## 七、主线 C：MCP 平台化 —— 双向打通

### C1 入站：应用内 MCP 客户端（P1）

- **数据模型**：`mcp_servers`（user、name、transport=http/sse/stdio、url/command、加密凭据）、`mcp_server_tools`（发现缓存：name、description、input_schema、enabled、approval_policy=always/once/deny）、`mcp_call_audit`（谁、何时、哪个工具、参数摘要、结果状态、耗时）；
- **传输**：先做 Streamable HTTP / SSE（纯服务端可完成）；stdio 依赖进程管理，放 P2 sidecar；
- **接入流程**：设置页添加服务器 → 自动发现工具列表 → 逐工具启用并设授权策略 → 绑定到助手；
- **运行时**：扩展 `RegisteredTool`（`backend/app/ai_tools/registry.py:17-24`）增加 `source`（builtin/mcp）、`approval`、`executor` 三个字段，工具调用循环按 source 分发——这是唯一需要先行的抽象，务必在 MCP 客户端动手前落地；
- **结果渲染**：MCP 结果以结构化卡片呈现（表格 / 链接 / 文件），不只是状态行。

### C2 出站：把 AIDriveNote 做成更好的 MCP 服务（P2）

- **scoped PAT**：`adn_` 令牌增加 scope（read / write / ask）+ 过期时间 + 用量统计，替代现在的全权限令牌；
- **补工具**：`get_note`、`update_note`（返回 diff 预览，需客户端确认语义）、`list_recent`、`ask_notes`（直接走 RAG 问答）、`get_backlinks`；
- **限流与审计**：按令牌限流，调用落审计表。

### C3 安全（缺一条就不上线）

1. 工具结果视为**不可信输入**：包裹 `<tool_result>` 标签、永不拼入 system 提示（防提示注入）；
2. SSRF：服务器 URL 走 allowlist + 禁内网地址；
3. 凭据复用 `secret_crypto` Fernet 加密落库（`enc::` 前缀，`secret_crypto.py` 既有模式）；
4. 写类工具强制 P3 确认 + 全量审计。

---

## 八、主线 D：易用性基础 —— 决定留存的地基

| # | 事项 | 现状证据 | 方案 |
|---|------|----------|------|
| D1 | **笔记 URL 化** | 全站唯一工作路由 `/`（`App.tsx:92-95`），笔记身份只存在 history state | 新增 `/note/:noteId`（及 `?chunk=` 锚点）：可收藏、可多标签页、可复制链接；是引用跳转（A6）、分享（P2）的前提。列表选中即 `navigate()`，刷新/直达走懒加载编辑器 |
| D2 | **统一 ⌘K 全局搜索 + 命令面板** | ⌘K 是编辑器命令面板，⌘P 是快速切换，列表搜索是另一套 ILIKE；带高亮的 fulltext 端点存在但无调用方（`note.py:440-454`） | 三合一：⌘K 面板 = 笔记（FTS + **真高亮片段**，替换现在的伪高亮 `note_preview_text(n,200)`，`note.py:453`）+ 命令 + 文件夹 + 标签 + 设置项；键盘上下选择直达 |
| D3 | **搜索体验** | 列表搜索 30/500 硬限、无片段、无零结果引导 | 结果摘要高亮、零结果给"问 AI"入口、最近搜索、范围芯片（类型/文件夹/标签） |
| D4 | **快捷键与弹窗** | Mod+K 双绑定（命令面板/插入链接）、Mod+Shift+S 双绑定（保存/删除线）；删除/模板命名用原生 `confirm()/prompt()` | 重排快捷键 + `?` 呼出速查表；原生弹窗统一为应用内 ConfirmDialog |
| D5 | **编辑器内** | 无笔记内查找（导图除外）、`[[` 无补全、反链纯文本不可点、修订无 diff | ⌘F 查找/替换；`[[` 触发标题候选（含别名）；反链可点击跳转；修订历史块级/行级 diff + 恢复前预览 |
| D6 | **快速捕获** | 无 | Inbox 路由 + 全局 FAB + PWA share target（Android）+ 邮件转笔记（复用现有 SMTP 出站通道做入站解析） |
| D7 | **移动端** | 列表/编辑器二选一，无底栏 | 底部导航（列表/搜索/AI/我的）+ 列表滑动操作（收藏/归档） |
| D8 | **导入与上手** | 无 onboarding、无导入器 | 首次 3 步引导（建笔记 → 连 AI → 同步本地）；Markdown 文件夹 / Obsidian vault / Notion zip 导入器（复用 KB 导入的 frontmatter 解析 `syncEngine.ts:591-613`） |

---

## 九、主线 E：本地知识库 KB 2.0

保持既有语义不变（本地为准、不删不覆盖、保护目录只读、路径即身份），补三个能力：

1. **服务端 KB 清单**：`kb_roots` / `kb_files`（path、hash、size、mtime、note_id、protected、ignored）。客户端推送清单增量，服务端据此建索引——配置不再困在 localStorage，换设备不丢；
2. **PDF / 文本资产入库**：`raw/` 下 PDF 抽取文本层建块（A3），可被检索和引用；图片 OCR 列 P2；导入的资产以"附件卡"挂到对应笔记；
3. **冲突与同步 UX**：同步报告页（新增/更新/被保护拦截清单）、冲突 diff 查看器、"本地为准"徽章语义可视化；
4. **补测试**：`syncEngine.ts` 目前零测试（当前最大回归风险），用内存 FS mock 做单测 + 清单版本号防重复导入。

可选（P2，显式 opt-in）：服务端文件 watch（NAS/挂载目录场景），默认仍为客户端手动/浏览器触发。

---

## 十、路线图

> 工作量：S ≤ 3 人日，M 4–10 人日，L > 10 人日。每个 Phase 独立可交付、可回滚。

### P0（2–3 周）：修地基——先让"搜得到、点得动、AI 够得着"

| # | 事项 | 用户可见结果 | 关键文件 | 量 | 依赖 | 风险 |
|---|------|--------------|----------|----|------|------|
| 1 | 笔记 URL 化与深链 | 每篇笔记有独立地址，可收藏/多开/复制链接 | `App.tsx:92-95`、`NotesPage.tsx:88-160`、`NoteListPanel.tsx` | M | 无 | 与离线草稿状态的同步语义需明确 |
| 2 | 统一 ⌘K 搜索 + 命令面板 | 一个入口搜笔记（带真高亮）/执行命令/跳转 | `NoteCommandPalette.tsx`、`NoteQuickSwitcher.tsx`、`note.py:440-454`、`note_enhance_service.py:480-637` | M | 无 | 中文高亮分词边界 |
| 3 | 选区 AI 工具条 | 选中即润色/翻译/摘要/续写/追问 | `AppContext.tsx:43`、`useAIChat.ts:152`、`AISidebar.tsx:162-165`、`NoteRichTextEditor.tsx` | M | 无 | BlockNote 跨块选区只能整块替换/下方插入 |
| 4 | AI 引用可点（v1 笔记级） | 回答下方引用芯片，点击直达笔记 | `rag_service.py:41-42`、`AIChatMarkdown.tsx:244-257` | S | P0-1 | v1 仅到笔记级，无块高亮 |
| 5 | RAG 写入链路修复 + 回填 | 新建/导入/恢复/解密的笔记都能被搜到；索引状态可见；嵌入失败不再静默 | `note_service.py:336-344,396-409`、`note_enhance_service.py:355-361`、`note_lock_service.py`、`embedding_service.py:52-58`、新 `scripts/reindex.py` | M | 无 | 索引异步后"保存即可搜"变为秒级延迟，需"索引中"角标 |
| 6 | 检索覆盖补全 | 流程图内容可搜；共享笔记可按权限纳入搜索 | `link_parser.py:33-50`、`note_service.py:252-263`、`note_enhance_service.py:438-478` | S | 无 | 共享笔记权限过滤必须严，防越权 |
| 7 | 快捷键/弹窗/保存态清理 | ⌘K、⌘S 符合直觉；无浏览器原生弹窗 | `NoteEditorPanel.tsx:1077`、`NotesPage.tsx:356`、`NoteRichTextEditor.tsx:932,961` | S | 无 | 老用户肌肉记忆 |
| 8 | CI 骨架 + RAG 评测集 | 每次提交跑后端 pytest + 前端 build；30–50 条真实问答标注集做 recall@5 基线 | 新 `.github/workflows/ci.yml`、新 `scripts/eval_rag.py` | S | 无 | 评测集需人工标注投入 |

**为什么 P0 不做分块**：分块是对同一套写入/生命周期路径的放大；路径错误时先放大，回填成本翻倍。

### P1（1–2 月）：检索质变 + AI 贴身 + MCP 入站

| # | 事项 | 用户可见结果 | 量 | 依赖 | 风险 |
|---|------|--------------|----|------|------|
| 1 | RAG v2：pgvector + 分块 + 索引 worker + RRF + 过滤器 + 引用 v2（块级高亮） | 语义检索显著变准；按标签/文件夹/时间限定问答；引用点开定位到段 | L | P0-5 | HNSW 迁移窗口；Ollama 单并发积压需自适应批大小 |
| 2 | 相关笔记面板 + 建议链接（批准制） | 打开笔记即见"相关的笔记/该链没链" | M | P1-1 | 建议质量差会骚扰，必须有 dismiss 记忆 |
| 3 | 自动标签（批准制） | 保存后出现候选标签，一键采纳 | M | P1-1 | 优先复用既有标签防膨胀 |
| 4 | MCP 客户端 v1（HTTP/SSE） | 设置页添加服务器、发现工具、逐工具授权、调用有审计 | L | P0（registry 扩展 `source` 字段） | 提示注入/SSRF 防线（C3）缺一不上线 |
| 5 | 修订 diff + 笔记内查找 + `[[` 补全 + 可点反链 | 历史可对比；⌘F 定位；输入 `[[` 出候选 | M | 无 | BlockNote 遍历长文档的性能 |
| 6 | 录音 → 结构化纪要 | 一键生成摘要/决议/行动项并写入笔记 | M | P0-5 | 长音频成本，按章限流 |
| 7 | KB 2.0：服务端清单 + PDF 入库 | raw/ 的 PDF 可被搜索和引用；配置跨设备 | M | P1-1 | 客户端推清单的增量协议需版本号 |
| 8 | 移动端底栏 + 快速捕获 + share target | 手机单手可用；3 秒记一条 | M | P0-1 | PWA share target 仅 Android/Chrome |

### P2（3 月+）：生态与纵深

| # | 事项 | 用户可见结果 | 量 | 依赖 |
|---|------|--------------|----|------|
| 1 | MCP stdio sidecar + 出站 scoped PAT/新工具/审计页 | 本地 MCP 服务器可用；外部 Agent 按授权读写 | L | P1-4 |
| 2 | 每日笔记 + AI 回顾 + 知识重现 | 打开即见昨日摘要与"该复习的旧笔记" | M | P1-1 |
| 3 | 块级引用 `((block))` 技术验证（2 周 spike，基于 BlockNote 自定义节点再决定） | Roam 式块引用 | L | P1-5 |
| 4 | Web Clipper 浏览器扩展 + 图片 OCR | 网页选区一键入库 | M | P1-8 |
| 5 | 本地 reranker + 离线评测常态化 | 检索持续可量化 | M | P1-1 |
| 6 | 公开只读分享链接（可过期/撤销） | 对外发布单篇笔记 | S | P0-1 |

---

## 十一、成功指标与采集

| 指标 | 定义 | 目标 | 采集方式（低成本） |
|------|------|------|--------------------|
| recall@5 | 评测集前 5 命中率 | 相对基线 +20pt | 离线脚本 `eval_rag.py`，零埋点 |
| 引用点击率 | 有引用回答中被点击比例 | ≥15% | 前端 `citation_click` 事件 |
| 引用可验证率 | 点击后 quote hash 校验通过占比 | ≥95% | 同上 + 笔记端校验结果 |
| 首字捕获时间 | ⌘N/捕获入口到可输入 | p95 < 300ms | `performance.mark` |
| AI 采纳率 | 写确认卡接受 / 提出 | ≥60% | 现有确认卡回调 |
| 相关笔记点击率 | 面板曝光 → 点击 | ≥10% | 面板曝光埋点 |
| 搜索零结果率 | 搜索请求 0 命中占比 | <8% | 服务端日志聚合 |
| 索引新鲜度 | 内容变更到可被检索的 p95 | <60s | job 表时间戳差 |
| MCP 工具成功率 / 拒权率 | 审计表聚合 | >95% / 拒权率用于发现过度授权 | `mcp_call_audit` |
| 周活跃笔记 | WAU 中有编辑行为的笔记数 | 环比增长 | 服务端 `updated_at` 聚合 |

埋点用一张 `product_events(user_id, event, props JSONB, created_at)` 表 + 批量异步写（参照 `guest_event_service` 既有模式），**不引入第三方分析**（隐私与国内部署约束）。

---

## 十二、风险与非目标

### 风险

| 风险 | 缓解 |
|------|------|
| **加密明文经 chunk 表泄漏**（S1 修复引入的新落点） | 入队前拦截 + worker 二次校验 + 上锁即删块 + 专项集成测试；解锁期临时索引在重上锁时清除 |
| 分块过碎导致上下文断裂 | 块带 `heading_path` 前缀；`RAG_V2_READ` 切换以评测集达标为闸门 |
| Ollama 单点 | 队列化后保存永不被阻塞；检索降级 FTS + 显式横幅（P5） |
| 索引成本（游客/批量导入） | 游客 chunk 上限 50；导入任务低优先级；批大小按队列长度自适应 |
| zhparser 缺失的部署 | RRF 仍可用（trgm/ILIKE 兜底），把 `search_config` 探测结果暴露到管理端 |
| MCP 提示注入 / SSRF | C3 三条防线（包裹不可信结果 / 不入 system / 写操作必确认）+ allowlist + 凭据加密 |
| BlockNote 能力天花板 | 行内 wiki 链接是文本级、跨块选区替换受限——P1 起在 UI 文案中明确边界，块引用先 spike 再承诺 |
| pgvector 迁移窗口 | 低峰执行 + 保留 v1 读路径 + 双写观察 |

### 非目标（明确不做）

- 实时协作 / CRDT（与现有 REST + 修订模型冲突，见《产品能力演进方案》P3-3，单独立项）；
- 知识图谱可视化页（相关笔记面板 + 可点反链已覆盖 80% 价值）；
- Notion 数据库 / 多维表克隆；
- 桌面端常驻文件 watch（需 Electron/Tauri 壳）；
- 插件市场（做 MCP 双向即可获得生态）。

---

## 十三、与既有方案的关系

| 文档 | 范围 | 与本文关系 |
|------|------|-----------|
| [《AIDriveNote-优化方向分析》](./AIDriveNote-优化方向分析.md) | 工程层（架构/性能/安全/CI） | 不重复；其 CI 门禁建议并入本文 P0-8 |
| [《AIDriveNote-产品能力演进方案》](./AIDriveNote-产品能力演进方案.md) | 能力补齐（块引用/图谱/画布/属性/CRDT） | 本文**调整其优先级**：图谱/画布/CRDT 让位于检索正确性与 AI 贴身；块引用降为 P2 spike；其 N1–N13 工程缺陷清单继续有效 |
| [《AI助手优化方案》](./AI助手优化方案.md) | 已完成：技能路由、RAG v1、编辑器 AI 入口 | 本文是其下一代：RAG v2 + 写作现场化 + 引用契约 |
| [《AIDriveNote-知识库管理模式方案》](./AIDriveNote-知识库管理模式方案.md) | P0 已实现：KB 管理模式 | 本文 KB 2.0 在其语义不变量（本地为准/不删不覆盖/保护目录）之上补服务端清单与资产入库 |
| [《笔记MCP集成方案》](../../.trae/documents/笔记MCP集成方案.md) | 已完成：出站 MCP + PAT | 本文主线 C 是其双向化续篇 |
