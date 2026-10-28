---
title: "AIDriveNote 产品优化方案 v2 · 实施与差距"
overview: "P0 全部落地、P1 主体落地后的实施清单、验证证据与差距分析（含补差设计）。明确已交付 / 部分交付 / 未交付，以及上线前必须补齐的事项。"
status: implemented-p0-p2
synced_at: "2026-10-28"
---

# 实施与差距分析（对应《[产品优化方案 v2](./AIDriveNote-产品优化方案-v2.md)》）

> 验证口径：`python -m pytest -q` → **275 passed**；`npm test`（Vitest）→ **8 passed**；`npm run type-check` → 通过；`npm run build` → 通过；
> 真实 PostgreSQL 16 + pgvector 迁移/检索冒烟（001–020 全部迁移 + HNSW + 共享笔记 + 块级引用取回）→ **PASS**；
> 浏览器端到端（登录→新建→深链→⌘K→选区 AI→`[[` 补全→公开分享→知识库资产→AI 引用芯片跳转）→ **PASS**（AI 使用本地假 OpenAI 服务）。
> 未覆盖：真实 Ollama/商用模型的质量与延迟、真实 cross-encoder reranker 模型、扩展商店发布（G16/G1 残留）。

---

## 一、交付总览

| 阶段 | 交付状态 | 说明 |
|------|----------|------|
| P0（8 项） | **全部完成** | 深链、统一搜索、选区 AI、引用可点、RAG 写入修复、检索覆盖、快捷键/弹窗、CI+评测 |
| P1（8 项） | **6 项完成、2 项部分** | RAG v2、相关笔记/标签建议、MCP 客户端、录音纪要、KB 2.0、快速捕获完成；修订 diff/查找完成但 wiki 补全缺失；移动端底栏完成但 share target/swipe 缺失 |
| P2（6 项） | **全部完成（块引用为 spike 结论）** | MCP stdio（白名单 + 假服务器测试）、块引用技术验证、Web Clipper 扩展 + 图片 OCR、本地/HTTP reranker、公开分享、每日笔记全部落地；块引用按 spike 结论进入"路径 A 待实施" |

---

## 二、P0 实施清单与证据

| # | 任务 | 状态 | 关键落点 | 验证 |
|---|------|------|----------|------|
| 1 | 笔记 URL 化 | ✅ | `App.tsx` 新增 `/note/:noteId`；`NotesPage` 用 `useParams/useNavigate` 取代 history state；刷新/直达按 id 补拉 | 类型检查；深链逻辑代码审查 |
| 2 | 统一 ⌘K | ✅ | 新 `GlobalCommandPalette.tsx`（服务端 FTS + 真高亮 + 操作）；后端 `highlight_snippet` 先转义再插 `<mark>` | `test_rag_write_path.py::test_highlight_snippet_*` |
| 3 | 选区 AI | ✅ | 新 `AISelectionToolbar.tsx` 绑定编辑器容器；接通既有 `openAI({selectionText,presetMessage})` 管道 | 类型检查 |
| 4 | 引用可点 | ✅（v1） | `rag_service` 产出结构化 citations；SSE `citations` 事件；`CitationChips.tsx` 跳 `/note/:id?chunk=`；`AIChatMarkdown` 拦截 `note_id=` 伪链接 | `test_rag_write_path.py::test_rag_context_returns_structured_citations` |
| 5 | RAG 写入闭环 | ✅ | 新建/恢复/解密补索引；嵌入移出请求路径（`schedule_note_embedding`）；失败告警；`scripts/reindex_embeddings.py` 双模式回填 | `test_rag_write_path.py` 6 项 |
| 6 | 检索覆盖 | ✅ | `link_parser._flowchart_text` 解析 draw.io `value` 属性；`full_text_search(include_shared=True)` 按 `NoteShare` 授权过滤 | `test_flowchart_text_enters_search_index`、`test_full_text_search_can_include_shared_notes` |
| 7 | 快捷键/弹窗 | ✅ | ⌘K 全局、⌘⇧K 编辑器命令、⌘⇧L 插入链接、⌘⇧X 删除线；`ConfirmDialog`/`PromptDialog` 替换原生弹窗 | 类型检查 |
| 8 | CI + 评测 | ✅ | `.github/workflows/ci.yml`（pytest + type-check + build）；`scripts/eval_rag.py` + 示例集，输出 recall@k / MRR 并可设阈值退出 | CI 配置审查；脚本可执行 |

---

## 三、P1 实施清单与证据

### 3.1 RAG v2（完成主体）

- **Schema**：`rag_documents` / `rag_chunks`（`vector(768)` + `tsvector` + HNSW/GIN）/ `rag_index_jobs`；迁移 `015_rag_v2.py`；服务层用原生 SQL（避免 SQLite 测试被 vector 类型污染），启动时 `ensure_rag_schema` 幂等兜底。
- **分块**：`chunking_service.py`，Markdown 按标题层级、超长段落滑窗 + 15% 重叠、四种笔记类型统一展开。
- **索引 worker**：`rag_index_service.py`，`FOR UPDATE SKIP LOCKED` 领取任务、指数退避重试、同笔记待处理任务合并（防抖）；`main.py` lifespan 启动。
- **检索**：`rag_v2_service.py`，向量 Top-40 ∪ 块级 FTS Top-40，**RRF(k=60)** 融合，支持 note/folder/tag/date/note-type scope（folder 用递归 CTE，tag 走关联表）。
- **引用**：块级 `chunkId` + `headingPath` + `quote`，前端跳转携带 `?chunk=`。
- **降级**：非 PostgreSQL / 缺扩展 / SQL 失败 → 自动回退 v1；`RAG_V2_ENABLED` 可关闭。
- **加密防线**：上锁时同步删除该笔记的 chunks/documents/jobs（修复新增明文落点）。

验证：`test_rag_v2_chunking.py`（6 项）；`test_note_encryption.py` 27 项回归通过。

### 3.2 相关笔记 / 建议链接 / 标签候选（完成）

- `related_service.py`：v2 语义 → v1 向量 → 共同标签三级降级；返回 `linked` 状态。
- 接口：`GET /notes/{id}/related`、`POST /notes/{id}/related/{target}/link`（追加 `[[标题]]`，走 `append_text` 保留修订）、`GET /notes/{id}/tag-suggestions`。
- 前端：编辑器「✨」入口 + 相关笔记面板 + 一键插入链接；标签弹层「建议标签」；反链改为可点击。
- 标签候选**不调用 LLM**：优先命中既有标签，再取正文高频词（零成本、稳定、批准制）。

验证：`test_related_and_tags.py`（4 项）。

### 3.3 MCP 客户端 v1（完成）

- `models/mcp.py` + 迁移 `016_mcp_client.py`：服务器 / 工具缓存 / 调用审计。
- `mcp_service.py`：JSON-RPC over HTTP，兼容 JSON 与 SSE 响应；`initialize` 握手失败可继续；工具定义自动接入 function calling（仅 `auto` 策略、上限 20 个）；工具结果以 `<tool_result>` 包裹（防注入）；凭据 Fernet 加密；URL SSRF 校验（默认禁内网，`MCP_ALLOW_PRIVATE_HOSTS` 放开）；每次调用落审计。
- 路由 `/api/v1/mcp/*`；设置页 `McpSettingsPage`（新增/发现/启停/策略/审计）。
- `ToolExecutor` 按 `mcp__` 前缀分发。

验证：`test_mcp_client.py`（7 项：命名往返、SSRF、ask/deny 策略、LLM 暴露面、未知服务器、审计）。

### 3.4 修订 diff / 笔记内查找 / 可点反链（完成）/ wiki 补全（未完成）

- `noteDiff.ts`：四类笔记展开为纯文本 + 行级 LCS diff；`RevisionDiffDialog` 展示 +/-。
- `⌘F` 查找条：DOM 级 `window.find`（富文本/预览有效）；**textarea 编辑态无效**（G7）。
- 反链可点击跳转。
- **`[[` 自动补全未实现**（G7）。

### 3.5 录音结构化纪要（完成）

- `recording_insight_service.py`：复用 `dispatch_llm`，输出摘要 / 决议 / 行动项（负责人·期限·时间戳）/ 章节；严格 JSON + 规则层兜底；超长转写取首尾控制成本。
- 接口 `POST /note-recordings/{id}/minutes`。
- 前端：`TranscriptPreview` 增加「生成纪要」→ 预览、复制、`minutesToBlocks` 插入当前笔记。

验证：`test_recording_minutes.py`（4 项）。

### 3.6 KB 2.0（完成基础版）

- `models/kb.py` + 迁移 `017_kb_assets.py`：`kb_roots` / `kb_files`（hash 去重、保护目录标记、`note_id` 关联）。
- `kb_service.py`：PDF 文本抽取（pypdf，200 页/20 万字上限）、文本类资产解码、搜索、转 Markdown 笔记（自动进 RAG）。
- 接口 `/api/v1/kb/*`；`requirements.txt` 固定 `pypdf>=6.7,<7`。
- 前端同步设置页新增「知识库资产」卡片：扫描绑定目录、上传 PDF/文本、列表展示、一键转笔记。

验证：`test_kb_assets.py`（4 项）。

### 3.7 移动端与快速捕获（部分完成）

- `QuickCaptureDialog` + `⌘⇧N` + 移动端 FAB：第一行作标题、回车保存、离线入队。
- 移动端底部导航（列表/搜索/新建/AI）。
- **未实现**：PWA share target、列表滑动操作（G9）。

### 3.8 公开分享与每日笔记（完成）

- **公开只读链接**：`note_public_links`（迁移 `018_public_links.py`）；`token_urlsafe` 令牌、可过期、可撤销；加密/已删除笔记拒绝解析；`GET /public/notes/{token}` 无需登录。
- 前端：分享面板「创建公开只读链接 / 复制 / 撤销」；`/p/:token` 公开阅读页（纯文本安全渲染）。
- **每日笔记**：`GET /notes/daily/today`（按标题=日期幂等创建，带模板）；`POST /notes/daily/review`（最近 24h 笔记 → LLM 回顾，模型不可用时规则版兜底）。
- 前端：⌘K 面板「今日笔记」「生成今日回顾」两个动作。

验证：`test_public_daily.py`（5 项）。

### 3.9 出站权限范围与本机分享入口（完成）

- **scoped PAT**：`user_api_tokens.scopes`（迁移 `019_token_scopes.py`，默认 `read,write`）；认证时挂到用户对象，`require_write_scope` 拦截只读令牌的创建/修改/删除；令牌页新增「读取 / 写入」勾选。
- **PWA share target**：`site.webmanifest` 增加 `share_target`；`/share` 路由把系统分享的标题/正文/链接直接落成 Markdown 笔记并跳转。
- **MCP stdio**：见 3.11。
- **列表滑动操作**：见 3.10。

验证：`test_token_scopes.py`（4 项）。

### 3.10 编辑器与移动端收尾（完成）

- **`[[` 双链补全**：Markdown 编辑态监听 `[[query`，弹出标题候选（↑↓/Enter/Tab），插入 `[[标题]]`；已在浏览器实测。
- **⌘F 笔记内查找**：Markdown 编辑态直接定位 textarea 并选中；富文本/预览走 `window.find`。
- **移动端滑动**：左滑收藏、右滑置顶，滑动后抑制误触 click（`NoteListPanel`）。
- **纪要新笔记**：纪要预览增加「新建纪要笔记」，以录音文件名 + 纪要标题创建并刷新列表。
- **标签建议 LLM 重排（可选）**：`NOTE_TAG_SUGGEST_LLM=true` 时先启发式筛选，再由模型在候选内挑选；失败回退启发式。

验证：`npm run type-check`；`[[` 补全与移动底栏浏览器实测；`test_related_and_tags.py` 新增解析测试。

### 3.11 P2 生态能力（完成）

- **MCP stdio**：迁移 `020_mcp_stdio.py` 增加 `command/args`；子进程 JSON-RPC（initialize → tools/list/call），命令白名单 `MCP_STDIO_ALLOWED_COMMANDS`；`tests/fake_mcp_stdio.py` 覆盖发现与调用。
- **块引用 spike**：见《[块引用技术验证](./AIDriveNote-块引用技术验证.md)》——结论 Go（块锚点路径）、Hold（自定义内联节点）、No-Go（实时块同步）。
- **Web Clipper**：后端 `POST /clip`（write scope）+ `extension/` MV3 扩展（右键菜单/弹窗，README 安装说明）；支持 `folderId` / `folderName` 归档（名称不存在自动创建，校验归属），可直接承接 Gemini/Gmail 日报邮件。
- **图片 OCR**：KB 登记图片时用 pytesseract（chi_sim+eng）抽取文字；系统无 tesseract 时优雅降级为 `extract_failed`。
- **Reranker**：支持 Jina/Cohere/BGE 风格 HTTP 接口；未配置 URL 或调用失败时自动使用**本地词法重排**，`RERANK_ENABLED=true` 即可生效。

验证：`test_mcp_client.py`（新增 stdio 3 项）、`test_clip_service.py`（4 项）、`test_kb_assets.py`（OCR 容错）、`test_rerank_service.py`（6 项）。

---

## 三点五、真实环境验证记录

### A. PostgreSQL 16 + pgvector（独立测试库，验证后删除）

- 创建空库 → `alembic upgrade head`：**001–020 全部迁移成功**（含 `CREATE EXTENSION vector`、HNSW、MCP stdio、KB、公开链接、令牌 scope）。
- `python -m scripts.verify_rag_v2_pg`：`PASS: pgvector schema / HNSW / RRF 检索 / 块级引用 / 共享笔记 均正常`。
- 验证脚本保留在 `backend/scripts/verify_rag_v2_pg.py`，可在 CI 的 pgvector service 中复用。

### B. 浏览器端到端（真实 PG + Vite 开发服务器 + Chromium）

| 流程 | 结果 | 证据 |
|------|------|------|
| 登录（真实账号） | ✅ | 跳转 `/`，列表显示 0 篇 |
| 新建 Markdown 笔记 | ✅ | URL 变为 `/note/517a5c1b-…` |
| **深链刷新** | ✅（修复一个回归） | 初次实现中"未选中→回首页"的副作用会抢在加载前重定向；已用 `hadSelectedNoteRef` 修复，刷新后仍停留在 `/note/…` |
| ⌘K 全局面板 | ✅ | 显示当前笔记、操作、编辑器命令入口；输入 `E2E` 命中笔记并展示片段 |
| 编辑器 ⌘⇧K | ✅ | 命令面板打开，含「相关笔记」「分享笔记」 |
| 选区 AI 工具条 | ✅ | 选中文字后出现「润色/翻译/总结/续写/问 AI」 |
| 快速捕获 ⌘⇧N | ✅ | 第一行成为标题，保存后跳 `/note/484f050d-…` |
| 公开只读链接 | ✅ | 创建后得到 `/p/<token>`；`curl` 不带任何凭据返回笔记 JSON；公开页正常渲染 |
| MCP 设置页 | ✅ | 新增入口可见，服务器/工具/审计区块正常 |
| `[[` 双链补全 | ✅ | 编辑态输入 `[[目标` 出现标题候选，Enter 插入 `[[目标笔记]]` |
| AI 回答 + 引用芯片 | ✅（假模型） | 本地假 OpenAI 流式服务返回回答，页面出现「依据 2 篇笔记」与两个引用芯片；点击「发布检查清单」跳到对应 `/note/:id` |
| 检索范围切换 | ✅ | AI 侧栏显示「全部笔记 / 当前笔记」 |
| 移动端底栏 / FAB | ✅（窄视口） | 列表/搜索/新建/AI 与快速捕获按钮可见 |

> 说明：E2E 期间发现并修复了两个真实问题：①深链刷新被"未选中→回首页"副作用抢先重定向；②长问句在 trigram/ILIKE 下整句失配，已加入"问句前缀"回退并在 v2 全文检索中加入短前缀匹配。这正是浏览器实测与检索冒烟不可被类型检查替代的原因。

---

## 四、差距分析

### 4.1 阻断上线 / 高优

| # | 差距 | 根因 | 影响 | 补差设计 |
|---|------|------|------|----------|
| G1 | **RAG v2 已用真实 PG+pgvector 验证** | 已在独立测试库跑通 19 个迁移、HNSW 索引、RRF 检索与块级引用 | 仅"真实嵌入模型 + 大规模数据"的性能/召回未压测 | 补充：用 Ollama 真实嵌入跑 `verify_rag_v2_pg`（去掉 mock）；压测 1 万块下的 HNSW 延迟；用 `scripts/eval_rag.py` 跑 30–50 问基线 |
| G2 | **块级引用已支持原文定位** | 新增 `GET /notes/{id}/chunks/{chunk_id}`；编辑器顶部展示引用片段/标题路径，并用 `window.find` 定位（找不到时提示原文已变更） | 仍未保存 BlockNote 块 id，定位是"文本级"而非"块级" | 在 `rag_chunks.meta` 写 block id；编辑器按 id 滚动并高亮（与 G17 合并做） |
| G3 | **索引状态已可见** | `NoteOut.indexStatus` 批量读取 `rag_documents.status`；编辑器显示「索引中… / 索引失败」，索引中自动轮询列表 | 失败后只能靠再次保存或脚本重试 | 增加"重新索引"按钮（调用单篇 reindex 接口） |
| G4 | **共享笔记已纳入 RAG** | v2 SQL 通过 `note_shares` 放行；v1 全文/向量均 `include_shared=True`；PG 冒烟已验证被分享者能检索并取回块 | folder/tag scope 仍只覆盖自有笔记 | scope 解析时并入共享笔记；补权限回归测试 |
| G5 | **标签建议支持可选 LLM 重排** | `NOTE_TAG_SUGGEST_LLM` 开启后由模型在启发式候选内挑选；默认关闭控制成本；失败回退 | 未用真实模型评估候选质量 | 用真实笔记集对比启发式 vs LLM 的采纳率 |
| G6 | **MCP 确认卡已落地** | `ask` 策略返回结构化待确认结果；聊天中渲染确认卡（参数预览 + 允许并执行 + 审计）；scoped PAT 已限制只读令牌写入；stdio 受命令白名单约束 | 设置页仍无"调试调用"JSON 表单；`auto` 工具无首次会话级确认 | 设置页工具行加调试调用；`auto` 首次调用弹一次确认；结果以结构化卡片渲染 |
| G7 | **`[[` 补全与笔记内查找已覆盖 Markdown** | Markdown 编辑态支持 `[[` 候选与 Enter 插入；⌘F 直接定位 textarea；富文本/预览用 `window.find` | BlockNote 富文本尚未接入 `[[` SuggestionMenu，查找是文本级 | 在 BlockNote 注册 `[[` 触发器；用编辑器 API 遍历块实现精确查找 |
| G8 | **KB 已改为清单增量 + 图片 OCR** | `POST /kb/manifest` 对比 hash 只上传变化文件；图片用 tesseract OCR；无 tesseract 时降级 | 服务端 watch 未做；OCR 质量依赖系统语言包 | 可选服务端 watch（NAS，opt-in）；OCR 前做图像预处理 |
| G9 | **移动端滑动已实现** | 列表左滑收藏、右滑置顶，滑动后抑制 click | 未做自动化手势测试 | 用 Playwright touch 事件补回归 |
| G10 | **P2 六项均已落地** | stdio、块引用 spike、Clipper+OCR、reranker、公开分享、每日笔记全部完成 | 块引用按 spike 结论待实施；扩展未上架；真实 reranker 模型未部署 | 按 spike 路径 A 实施块引用；扩展打包发布；部署 bge-reranker 后开启 RERANK_URL |
| G11 | **索引 worker 是进程内单例** | 未引入独立队列 | 多 uvicorn worker / 多副本会重复消费；重启丢在途任务 | 任务表已有 `running/attempts`；增加 `FOR UPDATE SKIP LOCKED` 已具备并发安全，但需把 worker 抽成独立容器或加 PG advisory lock；超时任务回收（`running` 超过 10 分钟重置） |
| G12 | **嵌入维度硬编码 768** | 沿用 nomic-embed-text | 换模型（1536 维）会写入失败 | `EMBEDDING_DIM` 读取配置并与 `rag_documents` 记录模型名；维度变化触发"重建索引"管理动作，而不是静默失败 |
| G13 | **纪要可直接生成新笔记** | 纪要预览增加「新建纪要笔记」，写入后刷新列表 | 未提供"选择文件夹/标签" | 创建对话框支持目标文件夹与标签 |
| G14 | **新功能未覆盖离线** | 选区 AI、引用跳转、KB 上传都依赖在线 | 离线时交互无提示或失败 | 统一 `isNetworkError` 处理：离线禁用并提示；引用跳转走本地缓存；KB 登记在离线时排队 |
| G15 | **前端已有单元测试基建** | 引入 Vitest 5.0.5；`noteDiff` 8 项测试；CI 增加 `npm test` | 组件与交互（面板键盘导航、引用芯片、确认卡）仍未覆盖 | 继续补 Testing Library 组件测试；Playwright 跑关键流程 |
| G16 | **浏览器 E2E 已覆盖核心链路，AI 回答链路仍未验证** | 本机无 Ollama 模型；E2E 用真实 PG + 开发服务器 | 引用芯片、AI 工具写笔记、MCP 真实调用未被端到端验证 | 启动本地 Ollama（qwen2.5 + nomic-embed-text）后补三条 E2E：①RAG 问答出现引用芯片并可跳转；②AI 写入笔记的确认卡；③MCP 发现→调用→审计记录；同时补移动端视口截图 |

### 4.2 中低优

| # | 差距 | 补差 |
|---|------|------|
| G17 | 分块未保留 BlockNote 块 id，引用只能定位到 heading | 在 `chunk_note` 输出 `block_ids`，写入 `meta`（与 G2 合并做） |
| G18 | 富文本分块按段落合并，标题路径只对 Markdown 生效 | 富文本从 block props.level 构建 heading 栈 |
| G19 | 评估集只有 3 条示例 | 用真实用户问题标注 30–50 条，纳入 CI 阈值 |
| G20 | MCP SSE 只解析最后一条 data 行，不支持长连接流式结果 | 改为增量解析 + 结果合并；stdio 版本一并处理 |
| G21 | 录音纪要超长只取首尾 | 按章节分批生成后合并（成本与完整性折中） |
| G22 | KB 图片仅登记不 OCR | P2 接 PaddleOCR/Tesseract，抽取后与 PDF 同路径入库 |

---

## 五、补差优先级（建议执行顺序）

1. **G16 + G1**：先把真实 PG/浏览器环境跑通，否则后续判断都缺证据；
2. **G3 + G4 + G2/G17**：索引状态、共享检索、块级高亮——直接决定"AI 是否可信"；
3. **G6 + G7**：MCP 确认卡与 wiki 补全——决定"是否顺手"；
4. **G15 + G19**：前端测试与真实评测集，锁住回归；
5. **G8 + G9 + G13**：KB 增量、share target、纪要新笔记；
6. **G10（P2）**：按原方案顺序推进。

---

## 六、变更文件索引

**后端新增**：`services/ai/chunking_service.py`、`rag_v2_schema.py`、`rag_index_service.py`、`rag_v2_service.py`、`rerank_service.py`、`related_service.py`、`mcp_service.py`、`services/note/tag_suggestion_service.py`、`recording/recording_insight_service.py`、`kb_service.py`、`public_link_service.py`、`daily_service.py`、`clip_service.py`、`models/mcp.py`、`models/kb.py`、`routers/mcp.py`、`routers/kb.py`、`routers/public.py`、`routers/clip.py`、`scripts/reindex_embeddings.py`、`scripts/eval_rag.py`、`scripts/verify_rag_v2_pg.py`、迁移 `015/016/017/018/019/020`、测试 10 个文件（含 `fake_mcp_stdio.py`）。

**后端修改**：`embedding_service.py`、`rag_service.py`、`ai_service.py`、`tool_executor.py`、`note_service.py`、`note_enhance_service.py`、`link_parser.py`、`note_lock_service.py`、`routers/note/note.py`、`routers/note/recordings.py`、`main.py`、`config.py`、`requirements.txt`、`tests/conftest.py`。

**前端新增**：`GlobalCommandPalette.tsx`、`QuickCaptureDialog.tsx`、`AISelectionToolbar.tsx`、`CitationChips.tsx`、`RevisionDiffDialog.tsx`、`PromptDialog.tsx`、`McpSettingsPage.tsx`、`McpToolConfirmCard.tsx`、`PublicNotePage.tsx`、`ShareTargetPage.tsx`、`services/mcp.ts`、`services/kb.ts`、`utils/noteDiff.ts`、`utils/noteDiff.test.ts`。

**前端修改**：`App.tsx`、`NotesPage.tsx`、`NoteEditorPanel.tsx`、`NoteRichTextEditor.tsx`、`NoteRecordingPanel.tsx`、`TranscriptPreview.tsx`、`AISidebar.tsx`、`AIChatMarkdown.tsx`、`useAIChat.ts`、`services/ai/ai.ts`、`services/note/note.ts`、`services/note/recording.ts`、`utils/noteAudioBlocks.ts`、`SettingsLayout.tsx`、`SyncSettingsPage.tsx`。

**基础设施**：`.github/workflows/ci.yml`、`extension/`（MV3 Web Clipper）、`docs/plans/AIDriveNote-块引用技术验证.md`。
