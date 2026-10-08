---
title: "AIDriveNote 产品能力演进方案"
overview: "在工程优化（见《AIDriveNote-优化方向分析》）之上，面向 Obsidian / Notion / Heptabase 等笔记最佳实践的产品能力方案：块级双链与嵌入、知识图谱、无限画布、结构化属性与多维视图、资源解耦、CRDT 协同、Graph-RAG 与主动式 Copilot。"
status: draft
synced_at: "2026-10-06"
---

# 产品能力演进方案

> 本文是**产品/架构层**的演进方案，与 [《AIDriveNote 优化方向分析》](./AIDriveNote-优化方向分析.md)（工程层：性能、安全、CI）互补而不重叠。
> 所有结论均来自实际代码审查，文中标注了具体文件与行号，便于核对与落地。
> 事实核对日期：2026-10-06（HEAD `880b610`）。

---

## 一、现状核实（基于代码）

### 1.1 已具备的能力（本次逐项核对通过）

| 能力 | 代码位置 | 核实结论 |
|------|----------|----------|
| 四种笔记类型 | `backend/app/models/note/note.py:60` `note_type` | 独立字段存储，`content` 为 JSONB，结构按类型区分 |
| 双向链接 | `note_enhance_service.py:179-233` `NoteLinkService` | 有 `note_links` 表（`source_id`/`target_id`/`link_text`），支持反链查询 |
| 版本历史 | `note_enhance_service.py:236-296` | 变更前快照 + 恢复前再存一条，可回退 |
| 全文检索 | `note_enhance_service.py:373-446` | `TSVECTOR` + GIN 索引（`001_initial.py:71`），异常降级 `ILIKE` |
| 标签 / 收藏 | `note_enhance_service.py:24-177` | 独立关联表 + 唯一约束 |
| 混合 RAG | `rag_service.py:44-97` | 全文 0.4 + 向量 0.6，取 Top-5，当前笔记置顶 |
| AI 工具 | `ai_tools/note_tools.py`（826 行） | 16 个工具，写入类有前端确认卡片 |
| MCP 服务 | `mcp-server/src/aidrivenote_mcp/server.py` | 5 个工具：`list_folders`/`list_tags`/`search_notes`/`create_note`/`append_to_note` |
| 离线 | `frontend/src/services/offline/` | IndexedDB 缓存 + 写队列（`offlineDb.ts` 489 行、`offlineQueue.ts` 382 行） |
| 本机同步 | `services/sync/syncEngine.ts`（1163 行） | File System Access API + 三方比对 + 冲突副本 |
| 前端列表性能 | `NoteListPanel.tsx:971` | **已用 `@tanstack/react-virtual` 虚拟化**（工程分析 B1 已过时） |
| 路由分包 | `App.tsx:32-57` | `lazyComposed` 并行拉取布局+页面，避免串行 |

### 1.2 本次审查新发现的问题（工程分析未覆盖）

| # | 问题 | 证据 | 影响 |
|---|------|------|------|
| **N1** | **README「保留最近 50 条」与实现不符** | `list_revisions(..., limit=50)` 只是**查询上限**（`note_enhance_service.py:257`）；全库无任何删除旧修订的代码 | 修订表**无上限增长**，长寿命笔记会持续膨胀 |
| **N2** | 富文本图片 Base64 内嵌 | `frontend/src/utils/blocknoteImageUpload.ts:5-24`（5MB/张）；后端无资源上传接口，`uploads/` 下只有 `ai/` | 单条笔记 JSONB 可达数十 MB；列表接口与全文检索被拖垮 |
| **N3** | 中文全文检索实际失效 | `to_tsvector('simple', ...)`（`note_enhance_service.py:384`）+ `plainto_tsquery('simple', ...)` | `simple` 配置**不切分中文**，中文查询只能退化到 `ILIKE` 兜底路径；GIN 索引对中文近乎无效 |
| **N4** | 语义检索只扫前 200 条 | `embedding_service.py:76` `.limit(200)` + Python 循环算余弦 | 静默漏召回，且排序无稳定 tie-break |
| **N5** | 写路径同步等待 embedding | `note_service.py:312-317` 在请求周期内 `await EmbeddingService.update_note_embedding(...)`（Ollama HTTP 30s 超时） | Ollama 慢/不可达时**保存变慢**，被 `except: pass` 掩盖 |
| **N6** | 链接重建是「全删全插」 | `note_enhance_service.py:187` 先 `delete(NoteLink).where(source_id==...)` 再逐条 `_resolve_target` | 每个链接一次查询（N 次往返）；且**仅正文变更时重建**（`note_service.py:310`），改名不改链接 → 历史引用断链 |
| **N7** | SSE 流全程持有 DB 连接 | `platform.py:998-1016`，`db` 由 `Depends(get_db)` 注入并传入 `AIService.chat_stream` | 连接池 `pool_size=10 + overflow=5`（`database.py:13-14`），并发聊天易耗尽 |
| **N8** | 检索高亮是伪高亮 | `routers/note/note.py:357` `note_preview_text(n, 200)` | 返回的是**前 200 字**，命中词可能根本不在其中，用户看不到关键词高亮 |
| **N9** | AI Provider API Key 明文入库 | `models/ai/ai.py:30` `api_key: Mapped[str] = Text`，无加密 | 仓库已有 `recording/secret_crypto.py`（Fernet，密钥派生自 `SECRET_KEY`）**可直接复用**，但 AI 模型未接 |
| **N10** | 生产默认开放 API 文档 | `config.py:21` `API_DOCS_ENABLED: bool = True`，`docker-compose.prod.yml` 未覆盖 | `/docs`、`/openapi.json` 对外暴露全部接口结构 |
| **N11** | `note_type` 无枚举约束 | `routers/note/note.py:57` `note_type: str` | 任意字符串可入库；下游按类型分支易漏分支 |
| **N12** | 文件夹删除是递归 Python 往返 | `note_service.py:85-94` `_collect_descendant_folder_ids` | 深层树 O(depth) 次查询 |
| **N13** | `note_no` 并发竞态 | `note_service.py:100-109` `SELECT MAX(note_no)+1` | 并发创建可拿到**相同编号**，撞唯一约束 |

---

## 二、差距诊断（对照笔记类最佳实践）

| 维度 | 业界最佳实践 | AIDriveNote 现状 | 差距编号 |
|------|--------------|-----------------|----------|
| **链接颗粒度** | 块级引用 + 嵌入（Obsidian `![[note#^block]]`、Roam `((block-id))`） | 仅文档级 `[[标题]]`，正则全文匹配（`link_parser.py:9`） | G1 |
| **知识网络** | 全局/局部交互式图谱、孤岛检测 | 只有反链文本列表（`NoteEditorPanel.tsx:1280`） | G2 |
| **形态融合** | 无限画布混排卡片/导图/图片（Obsidian Canvas、Heptabase） | 4 种类型互斥，一篇笔记只能一种 | G3 |
| **结构化组织** | 属性/Frontmatter + 表格/看板/日历多视图（Notion、Capacities） | 仅文件夹 + 标签；`status` 字段存在但无 UI 消费 | G4 |
| **链接健壮性** | 别名、改名级联、增量索引（Obsidian 自动更新） | 无别名表；改名不重解析（N6） | G5 |
| **协同底座** | CRDT 状态同步（Yjs / Automerge） | 时间戳 + 冲突副本的全量比对（`syncEngine.ts`） | G6 |
| **资源管理** | 资源解耦 + Hash 寻址 | Base64 内嵌（N2） | G7 |
| **检索底座** | 中文分词（jieba/zhparser/pg_jieba）+ 向量索引 | `simple` 配置（N3）+ Python 暴力扫描（N4） | G8 |
| **AI 上下文** | 图增强 RAG（GraphRAG）、主动式关联建议 | 纯向量+全文混合，无拓扑利用 | G9 |

---

## 三、优化方案

### P0 · 立即修复（低风险、高收益，先把地基补上）

#### P0-1 修订历史容量治理（对应 N1）
**问题**：README 承诺「保留最近 50 条」，实际只限制查询返回 50 条，底层无限增长。

**方案**：
- `create_revision` 后按 `note_id` 保留最新 N 条（N 默认 50，可配 `NOTE_REVISION_KEEP`），超出用一条 SQL 删除：
  ```sql
  DELETE FROM note_revisions
  WHERE note_id = :note_id AND id NOT IN (
      SELECT id FROM note_revisions WHERE note_id = :note_id
      ORDER BY created_at DESC LIMIT :keep
  );
  ```
- **注意**：需保留「恢复前快照」不被修剪（建议给修订加 `is_pinned` 标志，恢复产生的快照置位）。
- 同步修正 README:131 的表述，明确「保留最近 50 条，自动清理更早的修订」。

#### P0-2 中文全文检索修复（对应 N3）
**问题**：`simple` 配置不切分中文，GIN 索引对中文无效，中文检索长期走 `ILIKE %q%` 全表扫描。

**方案（二选一，建议先 A 后 B）**：
- **A. 零依赖**：PostgreSQL 启用 `pg_trgm`（中文三元组同样有效），`search` 走 GIN trigram 索引 + `similarity()` 排序 + `pg_trgm.similarity_threshold`。
- **B. 精确**：安装 `zhparser`（`CREATE EXTENSION zhparser`），`to_tsvector('zhparser', ...)` + 配置 `zhparser.word_dict`（可用 `/settings/common-terms` 的专有名词表直接喂词典），并**用触发器或统一 service 保证写入路径一致**（当前是应用层 UPDATE SQL，容易遗漏）。
- 建议同时**把 `try/except` 降级改为显式分支**并上报指标，而不是静默 `pass`（`note_enhance_service.py:388`）。

#### P0-3 API Key 加密（对应 N9）
**问题**：AI 模型 `api_key` 明文。

**方案**：**复用已有** `backend/app/services/note/recording/secret_crypto.py`：
- `encrypt_secret` / `decrypt_secret`（自动跳过非密文，天然兼容存量明文迁移）；
- 模型创建/更新时加密落库（参考 `asr_settings_service.py:140-145` 的 `encrypt_secret` 用法）；
- 出站调用点 `llm_router.py:80`、`platform.py:439-476` 改为读时解密；
- API 出参已是 `hasApiKey` 布尔（`platform.py:258`），**无需改响应结构**；
- 加 Alembic 迁移或启动时一次性任务，把存量明文加密。

#### P0-4 生产环境关闭 API 文档（对应 N10）
`docker-compose.prod.yml` 的 backend `environment` 增加 `API_DOCS_ENABLED: "false"`，同步在 `start.sh`/部署文档说明。

#### P0-5 `note_no` 竞态与 `note_type` 约束（对应 N13、N11）
- `note_no`：改用 PostgreSQL `SEQUENCE`（如 `note_no_seq`），或保留现有逻辑但捕获 `IntegrityError` 后重试 3 次；同时移除 `max_no[-6:]` 的脆弱切片。
- `note_type`：改 Pydantic `Literal["rich_text","markdown","mindmap","flowchart"]`，数据库加 `CHECK` 约束（Alembic）。

#### P0-6 SSE 流与 DB 连接解耦（对应 N7）
`platform.py:998` 的 `chat_stream`：
- 把**建会话、加载历史、落库消息**收敛到流开始前的短事务；
- 流式输出阶段只用一个短生命周期的独立 session 写最终消息，或收集后批量落库；
- 连接池配置配合长流：`pool_size` 提升 + 明确 `pool_timeout` 行为，避免请求排队无提示。

#### P0-7 富文本图片去 Base64（对应 N2、G7）
这是**当前最影响可用性与性能的单点**（5MB/图内嵌 JSONB）。

**方案**：
1. 新增 `POST /api/notes/assets`（multipart），服务端：
   - 校验 MIME 与大小（建议 ≤ 2MB，客户端自动压缩至长边 1600px/WebP）；
   - 计算 SHA-256 → `uploads/note_assets/{hash[:2]}/{hash}.webp`；
   - 命中同 hash 直接复用（天然去重）；
   - 返回 `{url: "/api/notes/assets/{hash}.webp"}`。
2. `blocknoteImageUpload.ts` 改为「压缩 → 上传 → 写 URL」；保留**离线降级**：离线时先写本地 blob 占位，联网后自动回填。
3. `NoteRichTextEditor` 的 URL 渲染需支持相对路径经 `client.ts` 的 baseURL 拼接。
4. **一次性迁移脚本**：扫描存量 `rich_text` 内容中的 `data:image/...;base64,`，落盘后替换为 URL。
5. Draw.io 的 XML 内嵌保持不变（`flowchart_format.py` 依赖它），但同样给出体积上限提示。

**收益**：笔记行体积从数十 MB 降到几 KB，直接改善列表接口、`search_text` 构建、备份与同步传输。

---

### P1 · 知识网络升级（对应 G1、G2、G5、G9）

#### P1-1 块级引用与嵌入（G1）
- **块 ID**：Markdown 渲染时为每个标题/列表项/代码块/待办生成稳定锚点（`^` + 内容哈希 + 序号），保证同一内容重命名后 ID 稳定；
- **语法扩展**：`link_parser.py` 的 `WIKI_LINK_PATTERN` 扩展为支持 `[[笔记#^块ID]]` 与 `![[笔记#^块ID]]`（嵌入）；
- **嵌入渲染**：Markdown 预览端（`NoteMarkdownEditor.tsx:52` 的 `previewPlugins`）加一个自定义 remark/rehype 插件，遇到 `![[...]]` 时按 `note_id` 拉取目标块并内联渲染；
- **后端**：新增 `GET /api/notes/{id}/blocks/{block_id}`，或复用 `get_note` 返回 `blocks` 摘要；
- **链接表扩展**：`note_links` 增加 `block_id` 与 `is_embed` 列，并把唯一约束从 `(source_id,target_id,link_text)` 调整为 `(source_id,target_id,link_text,block_id)`。

#### P1-2 增量链接索引 + 改名级联（G5、N6）
- **增量**：不再「全删全插」。改为对比新旧链接集合，只 `DELETE` 消失的、`INSERT` 新增的；`_resolve_target` 的 N 次查询用一次 `WHERE title IN (...) OR note_no IN (...)` 批量解析。
- **改名级联**：`update_note` 检测 `title_changed` 时（`note_service.py:278` 已计算该标志，但只用于 revision），异步触发反向链接重解析；并提供「同时重命名 N 处引用」的显式操作（写入 `link_text` 更新）。
- **别名表**：新增 `note_aliases(note_id, alias)`，解析时一并匹配，避免「同一概念两个标题就断链」。

#### P1-3 交互式知识图谱（G2）
- 新增 `GraphViewPage`（或编辑器侧栏模式），用 `cytoscape` / `react-force-graph-2d`；
- **后端新增** `GET /api/notes/graph?depth=1|2&folder_id=&tag=`：
  - 节点：笔记（半径 ∝ `backlink_count`，颜色 ∝ 顶级文件夹/标签）；
  - 边：`note_links` 的 `source → target`；
  - 支持「只看孤岛」（入度=出度=0）与「未链接笔记建议」；
- 与现有 `⌘K` 命令面板（`NoteEditorPanel.tsx:852`）打通，加 `view.graph` 命令项。

#### P1-4 Graph-RAG 与主动式 Copilot（G9）
- **Graph-RAG**：在 `rag_service.build_context` 里，命中 Top-K 后沿 `note_links` 扩展 1 跳（可配 2 跳），把「直接引用者 / 被引用者」的预览片段并入上下文，并**给扩展片段单独标注来源**，避免模型误认为是直接检索结果；
- **主动建议**：新建/保存笔记时，后台比对向量，给出「与《X》相似度 0.82，建议建立链接 / 归档到《Y》文件夹」，以侧栏轻提示呈现，可一键执行；
- **元数据自动化**：录音转写生成的笔记（`recording` 服务）自动推荐标签与归档路径（现有 `title_generator.py` / `title_derive.py` 可作为范式扩展）。

---

### P2 · 空间与结构化组织（对应 G3、G4）

#### P2-1 无限画布 Canvas（G3）
- 新增第 5 种 `note_type: "canvas"`，`content` 结构：
  ```json
  { "nodes": [{"id","type":"note|md|image|pdf|mindmap","ref","x","y","w","h","props"}],
    "edges": [{"id","from","to","label","style"}] }
  ```
- 实现要点：视口虚拟化（只渲染可视区节点）、节点内容按 `type` 懒加载（复用现有 4 个编辑器组件）、连线用贝塞尔 + 语义标签（「前提/支撑/反例」）。
- 与 P1-3 图谱区分：图谱是**自动生成**的全局视图，Canvas 是**用户手工编排**的空间。
- 前端增量资产建议：`@xyflow/react`（轻量、维护活跃）。

#### P2-2 导图 ↔ Markdown 大纲双向无损转换（G3 附）
- 现有 `mindmap_format.py`（9.1KB）已有 `simple-mind-map` JSON 处理，可在此基础上：
  - `mindmap → markdown`：深度优先遍历生成 `#` 层级标题；
  - `markdown → mindmap`：按标题层级还原节点，保留备注/标签/图标；
- 转换结果作为**新笔记**或**块级嵌入**插入，不原地覆盖（避免破坏式操作）。

#### P2-3 结构化属性与多维视图（G4）
- **属性系统**：新增 `note_properties(note_id, key, value)`（或复用 `status` + 扩展列）。建议先落地最小集：`status`、`priority`、`due_date`、`project`（关联笔记）。
  - Markdown 笔记支持 YAML Frontmatter（读写用 `gray-matter` 或 `js-yaml`），富文本笔记在顶部渲染属性表单。
- **多维视图**：`NotesPage` 的列表区增加视图切换
  - **Table**：列 = 属性，单元格可编辑（行内 PATCH）；
  - **Kanban**：按 `status` 分列，拖拽即改属性；
  - **Calendar**：按 `due_date` 排布。
- 与现有 `NoteListPanel.tsx:971` 的虚拟化共存：Table 视图复用 `useVirtualizer`。
- **导出联动**：现有批量导出（`noteExport.ts`）在 Markdown 导出时把 Frontmatter 一并写出，保证「所见即所得」。

---

### P3 · 协同与检索底座（对应 G6、G8）

#### P3-1 写路径异步化（N5、A2 延续）
- embedding、检索字段、链接同步统一进入**后台任务队列**（进程内 `asyncio.create_task` + 指数退避重试，或引入 `arq`/`PG LISTEN-NOTIFY`）；
- 写路径只做核心落库 + `search_text`（纯 CPU，可同步），embedding 与链接入队；
- 收益：保存延迟与 Ollama 可用性解耦，杜绝「保存卡住」。

#### P3-2 语义检索迁到 pgvector（G8、N4）
- `content_embedding` 从 `JSONB` 迁为 `vector(N)`（`nomic-embed-text` 为 768 维），建 HNSW/IVFFlat 索引；
- 检索下沉到 Postgres：`ORDER BY content_embedding <=> :query_vec LIMIT k`，消除 `.limit(200)` 的静默截断；
- **长笔记分块**：embedding 目前只取 2000 字预览（`embedding_service.py:53`），改为按标题层级分块（chunk），每块独立向量 + 引用可定位到块；
- 嵌入模型可配置维度需在迁移时校验，避免混用不同维度的模型。

#### P3-3 Local-First CRDT 协同（G6）
- **渐进路线**（不要一步到位）：
  1. **第一步**：给 `note_notes` 增加 `content_rev`（单调递增）与 `content_hash`；同步引擎在检测到「两端都改过同一笔记」时，除冲突副本外，再提供**块级三方合并**（Markdown 可用 `diff3` 语义合并，冲突块才要求人工裁决）。
  2. **第二步**：富文本编辑器（BlockNote 基于 ProseMirror）接入 `@yjs/prosemirror`，Markdown 用 `y-codemirror.next`；Y.Doc 持久化到 IndexedDB，服务端只存增量 Update。
  3. **第三步**：WebSocket 广播 + 多人光标，为「分享协作」（`NoteShareService` 已有 view/edit 权限模型）打好底座。
- 风险提示：CRDT 与现有「整篇覆盖 + 修订快照」语义冲突，**迁移期需双写**，并保证版本历史仍可回滚。

---

## 四、实施路线图

```
Phase 0 · 地基加固（1~2 周）—— 与《优化方向分析》P0 合并执行
  ├─ P0-1 修订容量治理（+ 修正 README）
  ├─ P0-2 中文检索（pg_trgm 先行）
  ├─ P0-3 API Key 加密（复用 secret_crypto）
  ├─ P0-4 生产关闭 /docs
  ├─ P0-5 note_no 竞态 + note_type 枚举
  ├─ P0-6 SSE 流与连接池解耦
  └─ P0-7 图片资产去 Base64（含存量迁移脚本）★ 收益最大

Phase 1 · 知识网络（3~4 周）
  ├─ P1-2 增量链接索引 + 改名级联 + 别名表
  ├─ P1-1 块级引用与嵌入
  ├─ P3-1 写路径异步化 + P3-2 pgvector + 分块
  └─ P1-3 交互式图谱页
  └─ P1-4 Graph-RAG 上下文扩展 + 主动建议

Phase 2 · 空间与结构化（4~6 周）
  ├─ P2-1 无限画布 Canvas
  ├─ P2-2 导图 ↔ Markdown 双向转换
  └─ P2-3 属性系统 + Table/Kanban/Calendar 视图

Phase 3 · 协同底座（长期）
  ├─ P3-3 第一步：content_rev + diff3 三方合并
  ├─ P3-3 第二步：Yjs 接入双编辑器
  └─ P3-3 第三步：WebSocket 多人协同
```

---

## 五、与既有文档的关系

| 文档 | 范围 | 关系 |
|------|------|------|
| [《AIDriveNote-优化方向分析》](./AIDriveNote-优化方向分析.md) | 架构/性能/安全/CI（工程层） | 本文**不重复**其 A2/A3/C1/C2/D1；本文新增 N1–N13 发现，并规划产品能力 |
| [《AI助手优化方案》](./AI助手优化方案.md) | 已完成：技能路由、RAG v1、编辑器 AI 入口 | P1-4 是其**下一代**：从混合检索升级到 Graph-RAG + 主动建议 |
| [《笔记原格式批量导出》](./笔记原格式批量导出.md) | 已完成：按原格式批量导出 | P2-3 的 Frontmatter 需与导出逻辑对齐 |

---

## 六、风险与取舍

| 项 | 风险 | 缓解 |
|----|------|------|
| P0-7 图片资产化 | 离线场景上传失败导致图片丢失 | 保留 IndexedDB 占位 + 联网自动回填；导入时检测 `data:` 前缀走旧路径 |
| P1-1 块级嵌入 | 递归嵌入导致循环引用（A 嵌 B，B 嵌 A） | 渲染层限制嵌套深度 ≤ 2 并检测环 |
| P2-1 画布 | 新增第 5 种类型影响所有按类型分支的代码（AI 工具、导出、同步、邮件） | 统一走「类型注册表」，新增类型只需注册 handler；先做只读画布 |
| P3-2 pgvector | 嵌入模型换维度会导致索引失效 | 迁移脚本校验维度，不匹配则重建索引并全量重算 |
| P3-3 CRDT | 与版本历史语义冲突，回滚能力可能退化 | 双写期保留旧快照链路，CRDT 稳定后再下线 |
| 全部 | 改动面大、缺 CI 门禁 | **先落地工程层 CI/测试门禁**（优化方向分析 D1/D3），再动数据模型 |

> **原则**：先用门禁（lint + pytest + type-check + Playwright）锁住当前最易回退的编辑器与 AI 逻辑，再做会改数据模型（pgvector、属性表、CRDT）的改造；每个 Phase 独立可交付、可回滚。