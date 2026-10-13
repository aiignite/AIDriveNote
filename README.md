# AIDriveNote

独立 AI 笔记应用：**富文本 / Markdown / 思维导图 / 流程图** 四种笔记形态，配合 **Wiki 双向链接、中文全文检索、版本历史、文档加密、分享协作、录音转写、发送到邮箱、离线可用、本机文件夹双向同步、RAG 增强 AI 助手与 MCP 开放集成**。

从 AIIgnite PLM 的 NOTE 模块独立拆分，可单独部署运行。

---

## 目录

- [功能概览](#功能概览)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [核心功能详解](#核心功能详解)
- [AI 助手](#ai-助手)
- [录音与语音转写](#录音与语音转写)
- [离线使用与本地同步](#离线使用与本地同步)
- [导出与邮件](#导出与邮件)
- [账号、权限与集成](#账号权限与集成)
- [MCP 接入（外部 Agent 写入笔记）](#mcp-接入外部-agent-写入笔记)
- [API 一览](#api-一览)
- [前端路由](#前端路由)
- [部署](#部署)
- [配置项](#配置项)
- [项目结构](#项目结构)
- [测试](#测试)
- [更新日志](#更新日志)
- [路线图](#路线图)

---

## 功能概览

| 类别 | 能力 |
|------|------|
| 笔记类型 | 富文本（BlockNote，类 Notion）、Markdown（GFM / 数学公式 / 代码高亮 / 目录锚点）、思维导图（simple-mind-map）、流程图（Draw.io 内嵌） |
| 组织 | 多级文件夹树、标签、置顶 / 收藏、模板库、回收站（可恢复 / 永久删除） |
| 知识链接 | `[[Wiki 链接]]` 双链、反向链接面板 |
| 搜索 | 三级降级检索：zhparser 分词 → pg_trgm 三元组 → ILIKE 模糊；标题 / 描述 / 正文 |
| 加密 | 单篇笔记与整个文件夹加密（密码 ≥ 4 位），解锁票据仅存内存，忘记密码不可恢复 |
| 协作 | 笔记分享（view / edit 权限）、用户搜索、管理员用户管理（含软删除） |
| 版本 | 自动保存修订、严格递增序号、置位快照不淘汰、保留最近 N 条、一键恢复 |
| 录音 | 浏览器录音 / 上传音频、Whisper 转写、章节化、说话人分离、AI 整理润色、一键插入笔记 |
| 语音输入 | 编辑器与 AI 助手统一入口：Web Speech 实时听写，不可用时自动降级为录音转写 |
| 邮件 | 把笔记以附件发送到邮箱（QQ SMTP）；注册三步验证码 |
| 图片 | 粘贴 / 拖拽 / 本地选择 / **拍照**上传，服务端资源化存储（同内容去重），断网降级 base64 |
| 离线 | PWA 可安装、离线阅读与编辑、IndexedDB 缓存、写队列与冲突处理 |
| 同步 | 本机文件夹双向同步（File System Access API，三方比对） |
| 导出 | 富文本/Markdown → PDF / DOCX / HTML / MD；导图 → PDF / PNG / SVG / JSON / XMind；流程图 → PDF / PNG / SVG / XML；全部笔记原格式批量导出（保留文件夹层级） |
| AI | 侧栏 SSE 流式对话（Markdown + Mermaid 渲染）、笔记页快捷操作、混合 RAG、17 个笔记工具、13 个内置技能、写入需确认、OpenCode Zen 免 Key 公共模型（含匿名可用） |
| 集成 | MCP Server（外部 Agent 写入笔记）、SSO 单点登录、API 访问令牌（PAT） |
| 界面 | 深色 / 浅色主题、统一命令面板（⌘K）、大纲面板、移动端适配、安装到桌面 |
| 开放策略 | 注册开关、单用户笔记配额与上传体积上限、匿名免注册试用（自动销毁） |

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python 3.12 · FastAPI · SQLAlchemy 2（async）· Alembic · Pydantic v2 · JWT |
| 前端 | React 19 · Vite 6 · TypeScript 5.8 · Tailwind CSS 4 · React Router 7 |
| 编辑器 | BlockNote（富文本）· @uiw/react-md-editor（Markdown）· simple-mind-map（导图）· Draw.io embed（流程图） |
| 渲染 | KaTeX（公式）· rehype-highlight（代码）· Mermaid（AI 回复中的图表） |
| 数据库 | PostgreSQL 16+ |
| 语音 | faster-whisper · ffmpeg（本地或独立 asr_gateway 网关） |
| AI | Ollama（默认）· OpenAI · Anthropic · MiniMax · LM Studio（OpenAI 兼容） |
| 邮件 | QQ SMTP（`smtplib`，465 隐式 SSL） |
| 部署 | Docker Compose（4 服务）· nginx · 可选子路径部署（`/note/`） |

---

## 快速开始

### 环境要求

- Python 3.12+
- Node.js 20+
- PostgreSQL 16+（默认 `localhost:5432`）
- Ollama（可选，AI 功能；默认 `http://localhost:11434`）

### 初始化数据库

```bash
psql -U postgres -c "CREATE DATABASE ai_drive_note;"
cd backend
cp .env.example .env      # 按需修改 DATABASE_URL、SECRET_KEY
alembic upgrade head      # 也可依赖 app.main lifespan 自动建表
```

### 一键启动（推荐）

```bash
./start.sh
```

| 服务 | 地址 |
|------|------|
| 前端 | http://localhost:3270 |
| 后端 | http://localhost:3275 |
| API 文档 | http://localhost:3275/docs |

`start.sh` 会检查依赖、清理残留进程、释放 3270 / 3275 端口、自动补齐 `.env` 与 `node_modules`，最后轮询 `/health` 确认就绪。日志写入 `.runtime-logs/`。首次运行请确保已创建数据库并执行迁移。

### 手动启动

```bash
# 后端 :3275
cd backend && pip install -r requirements.txt
uvicorn app.main:app --reload --port 3275

# 前端 :3270
cd frontend && npm install && npm run dev
```

浏览器打开 http://localhost:3270 ，注册账号后使用（`SELF_REGISTRATION_ENABLED=false` 时注册入口隐藏，账号需管理员创建）。

---

## 核心功能详解

### 四种笔记

| 类型 | `note_type` | 存储结构 | 能力 |
|------|-------------|----------|------|
| 富文本 | `rich_text` | `{blocks: [...]}` | 标题 1–6、列表/待办/引用/代码块/表格/图片、色板与高亮、语音输入、录音转写插入、图片上传（粘贴/拖拽/本地/拍照）、大纲 |
| Markdown | `markdown` | `{text: "..."}` | GFM 表格与任务列表、KaTeX 数学公式、代码高亮、标题锚点、图片上传与拍照、编辑/实时预览/纯预览三态、字数与阅读时长 |
| 思维导图 | `mindmap` | simple-mind-map JSON | 7 种形状、图标/图片/超链接/备注/标签/概要、关联线、6 种布局、4 种主题、小地图、节点搜索 |
| 流程图 | `flowchart` | `{xml: "<mxGraphModel…"}` | Draw.io 全功能编辑、模板对话框、只读查看器、导出 PNG/SVG/PDF/XML |

### 图片上传

富文本与 Markdown 编辑器的图片一律走**资源化上传**：`POST /notes/assets` 保存到磁盘并返回稳定 URL（同内容按哈希去重），正文只存 URL 而非 base64。

- 允许类型：`image/*`；大小上限 `USER_MAX_UPLOAD_BYTES`（默认 **2MB**）。
- 入口：粘贴、拖拽、本地选择、以及**拍照**（移动端调用 `capture: environment`，拍完直接上传并插入光标处）。
- 断网或请求失败时降级为本地 base64 内联，保证离线编辑不丢图。
- 资源地址在子路径部署下会按部署前缀解析（`resolveAssetUrl`），避免 `/note/` 场景 404。

### 知识链接

在 Markdown 或富文本正文中写 `[[笔记标题]]` 或 `[[NT2026000001]]` 即可建立双链。笔记页的反向链接面板列出所有引用了当前笔记的来源。

> 链接在笔记**创建后**或**正文变更后**全量重建；仅改标题不会重新解析历史链接。

### 版本历史

更新正文或标题时自动留存修订（快照的是变更**前**的内容）：

- 每条修订有**严格递增的 `seq`**，同一秒内的多次修改也能正确排序（不再依赖 `created_at`）。
- 保留最近 `NOTE_REVISION_KEEP`（默认 **50**）条，超出后淘汰最旧的**未置位**修订。
- 点击历史版本恢复时，会先为当前状态再存一条**置位的**「恢复前快照」，该快照**不参与淘汰**，因此恢复操作本身永远可回退。

### 笔记与文件夹加密

除账号体系外，笔记内容可选择单独加密（AES，密钥由笔记密码派生）：

- **加密范围**：单篇笔记（`/notes/{id}/encrypt`）或整个文件夹（`/notes/folders/{id}/encrypt`，会同时加密其下笔记）。
- **解锁票据**：解锁后服务端签发一次性票据，前端仅保存在**内存**（`unlockStore`），通过 `X-Note-Unlock` 请求头传递；刷新页面或退出登录即失效，需重新输入密码。
- **可执行操作**：加密 / 解锁 / 解密（永久取消加密）/ 修改文档密码。
- **密码要求**：至少 4 位；**忘记密码将无法恢复文档内容**，界面会明确提示。

### 搜索与组织

- **三级检索降级**（启动时探测并缓存，`/notes` 搜索接口）：
  1. **zhparser**：真正的中文分词，召回质量最好（PG 已装该扩展时启用）；
  2. **pg_trgm**：三元组相似度，对中日韩同样有效，无需额外词典（默认走这一层）；
  3. **ILIKE**：上述都不可用时全表模糊匹配兜底。
- 文件夹支持多级嵌套，删除文件夹时其下笔记回落根目录、子文件夹级联软删。
- 列表支持全部 / 最近 / 置顶 / 收藏 / 回收站分类页签，按类型与标签筛选，并按修改时间 / 创建时间 / 标题排序；长列表虚拟滚动。

### 命令面板

`⌘K` 打开统一命令面板，聚合全局命令与当前编辑器的全部命令：保存、导入、导出、另存为模板、复制、移动、删除，以及视图（大纲、全屏、反向链接、版本历史、分享）与各编辑器专属操作。

### 键盘快捷键

| 作用域 | 快捷键 |
|--------|--------|
| 全局 | `⌘/Ctrl+S` 保存 · `⌘/Ctrl+K` 命令面板 · `⌘/Ctrl+J` AI 助手 · `⌘/Ctrl+N` 新建笔记 · `⌘/Ctrl+⇧F` 聚焦搜索 · `Esc` 关闭弹层 |
| 富文本 | `⌘Z` 撤销 · `⌘⇧Z` 重做 · `⌘B/I/U` 粗体/斜体/下划线 · `⌘⇧S` 删除线 · `⌘E` 行内代码 · `⌘⌥1–6` 标题 · `⌘⇧7/8/9` 有序/无序/待办列表 |
| 思维导图 | `Tab` 子节点 · `Enter` 兄弟节点 · `Space` 编辑 · `Del` 删除 · `⌘F` 搜索节点 · `⌘=/-` 缩放 |

### 主题与移动端

深色 / 浅色主题随偏好持久化；移动端为单列前进/返回布局（列表与编辑器互斥全宽），适配刘海屏安全区，输入框字号提至 16px 防止 iOS 自动缩放，支持相机拍照录入，并可直接安装到桌面/主屏。

---

## AI 助手

### 对话

侧栏 AI 抽屉（宽度可拖拽）支持选择助手、查看历史会话、**SSE 流式对话**。流式事件包含正文增量、推理过程、工具执行与结果、技能激活、结束与错误；单次对话最多 5 轮工具调用，历史上下文取最近 20 条消息。

回复以 Markdown 渲染，**Mermaid 代码块会实时渲染为图表**（失败时回退展示源码）。

笔记页还提供总结 / 续写 / 优化等快捷操作，对应四种笔记类型均有适配。

### 模型管理（`/settings/models`）

| Provider | 鉴权 | 默认地址 | 推荐模型 |
|----------|------|----------|----------|
| Ollama | 免 Key | `http://localhost:11434` | `qwen2.5` |
| LM Studio | 免 Key | `http://localhost:1234` | `local-model` |
| OpenCode Zen | **免 Key**（匿名公共通道） | `https://opencode.ai/zen/v1` | `ling-3.1-flash-free` |
| OpenAI | API Key | `https://api.openai.com/v1` | `gpt-4o`（支持图片） |
| Anthropic | API Key | 原生 `api.anthropic.com` | `claude-3-5-sonnet-latest`（支持图片） |
| MiniMax | API Key | `https://api.minimax.chat/v1` | `abab6.5s-chat` |

支持新增 / 编辑 / 删除模型与**连通性测试**（按 provider 分别调用真实接口并返回延迟）。API Key 采用加密存储，接口只返回 `hasApiKey` 布尔值，留空即不修改。

模型解析优先级：请求指定 → 助手绑定 → 用户默认 → 数据库首个 → 兜底 Ollama（环境变量）。

#### 添加 OpenCode Zen 免费公共模型

OpenCode Zen 是 OpenCode 的匿名免费通道，**不需要任何 API Key**（固定 `Bearer public`），适合作为免费公共 / 备用模型：

1. 进入 `/settings/models` → 「新增模型」；
2. Provider 选 **OpenCode Zen（免费公共）**，表单会自动填入默认地址 `https://opencode.ai/zen/v1`，API Key 留空即可；
3. 模型 ID 填 Zen 免费名单中的任意一个（以 `-free` 结尾，完整已验证名单见 `backend/app/services/ai_providers/opencode.py` 的 `get_opencode_free_models()`），如 `ling-3.1-flash-free`、`mimo-v2.6-flash-free`、`step-5-preview-free`；
4. 保存后点「测试连接」，走 Zen `/models` 真实验证并返回延迟。

> 公共部署已由系统种子内置 5 个 `OpenCode/*` 公共模型，全站用户（含匿名）开箱可用，无需重复添加；自行添加仅用于扩大名单。
>
> 限制：匿名通道**按 IP 限流**（服务端所有用户共享同一出口 IP 额度，429 自动退避重试），仅支持免费模型（服务端自动补齐 free-lane 请求形状），不适合作为高并发主力渠道。

### 助手与技能（`/settings/assistants`、`/settings/skills`）

**3 个内置助手**：📝 笔记助手（默认）· 🧠 思维导图设计助手 · 🔀 流程图设计助手，支持克隆。

**13 个内置技能**：

| 技能 | 说明 |
|------|------|
| 读取并总结 / 续写 / 优化润色 / 创建笔记 | 通用笔记能力 |
| 行内编辑 | 对选区做润色、翻译、改写 |
| 扩展导图 / 扩展流程图 | 在既有图上补充节点或步骤 |
| 思维导图框架设计 / 流程图规范设计 | 从自然语言设计结构 |
| 文本转思维导图 / 文本转流程图 | 大纲转图 |
| 联网查询 | 调用 `web_search`（需开启 `AI_WEB_SEARCH_ENABLED`） |
| 整理成笔记 | 把对话内容整理成文档并存入笔记 |

**技能路由**：按页面绑定权重、助手绑定权重、笔记类型匹配、命中关键词、负向关键词与优先级加权打分，取分数最高的 3 个技能激活并注入提示词；也可在对话中手动指定技能强制命中。

### 工具（17 个）

| 工具 | 功能 | 需确认 |
|------|------|--------|
| `list_notes` / `get_note` | 查询笔记列表 / 详情 | 否 |
| `create_note` | 创建笔记 | 否 |
| `update_note` | 更新笔记 | **是** |
| `append_to_note` | 末尾追加（Markdown / 富文本） | **是** |
| `append_to_mindmap` | 导图追加子节点 | **是** |
| `delete_note` | 删除笔记 | **是**（二次确认） |
| `list_note_folders` / `list_note_tags` / `list_note_templates` | 列出文件夹 / 标签 / 模板 | 否 |
| `move_note_to_folder` | 移动到文件夹 | 否 |
| `create_note_from_template` | 从模板创建笔记 | 否 |
| `add_tags_to_note` / `batch_add_tags` | 打标签（不存在自动创建） | 否 |
| `batch_summarize_notes` | 批量摘要 | 否 |
| `generate_note_title` | 依据正文生成标题并保存 | 否 |
| `web_search` | 联网搜索（Bing，免 Key） | 否 |

写入类工具返回变更预览卡片，用户确认后才真正落库。

### RAG

混合检索：PostgreSQL 全文检索（权重 0.4）与 Ollama embedding 余弦相似度（权重 0.6）融合排序，取 **Top-5** 相关笔记；当前打开的笔记以预览单独置顶。上下文以「引用格式 `[标题](note_id=...)`」注入系统提示词，并要求回答中标注来源。

### 附件

对话支持上传图片、PDF、Word、Excel、文本与 JSON：图片在支持视觉的模型上以多模态注入，文档正文抽取后并入提问。限制：单文件 `USER_MAX_UPLOAD_BYTES`（默认 2MB），视觉图片 10MB，抽取文本 5 万字符。

---

## 录音与语音转写

### 录音转写流程

录音（浏览器 `MediaRecorder`，最长 60 分钟）或上传音频（mp3 / wav / m4a / aac / flac / ogg / opus / webm / mp4，单文件 ≤ `NOTE_MAX_RECORDING_BYTES`，默认 **25MB**）→ **Whisper 转写** → **章节化**（每 60 秒一章）→ **说话人分离**（可选）→ **AI 整理润色**（去重、修正同音字、补标点、按停顿重组段落、简繁转换）→ 按章节生成标题与正文块插入笔记，并附带带签名的音频块。

- 转写在后台任务中串行执行（并发上限默认 1），前端每 2 秒轮询进度（远程模式有 15 秒心跳）。
- 若上传时携带浏览器 Web Speech 识别结果，则直接入库并跳过服务端转写。
- 工具栏提供「**AI 整理润色**」（单一入口）与「重新转写」两个操作；AI 整理润色**使用当前笔记对应助手所绑定的模型**（思维导图 / 流程图笔记用对应设计助手，其余用笔记助手，优先取当前用户自建的助手），助手缺失或未配置模型时回退系统默认模型。
- 音频存放在 `backend/uploads/note_recordings/{年}/{月}/`，访问需签名或属主校验；删除为软删并清理磁盘文件。

### ASR 引擎

- **远程模式**（默认）：调用独立的 [asr_gateway](asr_gateway/README.md)，后端镜像无需安装 ffmpeg 与模型。compose 内 `NOTE_ASR_REMOTE_URL` 默认指向 `http://asr_gateway:8090/api/v1/transcribe`。
- **本地模式**：本机 faster-whisper，远程失败时可自动降级（`NOTE_ASR_FALLBACK_LOCAL`）。

ASR 设置（`/settings/asr`）以数据库为准、覆盖环境变量；网关 API Key 使用 Fernet 加密（密钥派生自 `SECRET_KEY`），接口只回掩码。网关连通性可一键测试。

**章节化**为纯规则实现；**说话人分离**按 通义听悟 → pyannote → 能量 VAD 降级（默认关闭）；**专有名词词表**（`/settings/common-terms`）按使用频次注入提示词以提升专有词识别率。

### 语音输入

编辑器与 **AI 助手输入框**使用同一套语音入口，按可用性自动切换：

1. **实时识别**（Web Speech API）：逐句出字，零延迟；
2. **录音转写**：Web Speech 不可用、被浏览器限制（移动端常见 `not-allowed` / `service-not-allowed`）或权限被拒时自动降级为 `MediaRecorder` 录音 → 上传 `/note-recordings` → 轮询转写结果回填，随后清理临时录音。

> 移动端浏览器普遍限制 Web Speech API，因此手机上的语音输入实际走的是录音转写通道；两条链路都不依赖付费服务。

---

## 离线使用与本地同步

### 离线（`/settings/offline`）

应用可安装为 PWA，断网后仍可阅读与编辑：

- **缓存**：IndexedDB 按账号隔离存储笔记正文、列表快照与元数据；
- **预缓存分包**：关键壳（HTML / 入口 JS / CSS / 图标）在 SW 安装时缓存，惰性页面与编辑器、字体、导出模块在空闲时段预热；
- **写队列**：离线的新建 / 修改 / 删除入队，恢复联网后按时间顺序自动回传；
- **冲突处理**：与云端同时修改时，本地另存为「（冲突副本 时间戳）」新笔记，**不覆盖**远端；删除冲突则跳过并保留本地副本待人工处理；
- 离线队列有批量删除保护与重试上限，Service Worker **刻意不缓存任何 API 响应**以避免跨账号串数据。

### 本机文件夹同步（`/settings/sync`）

基于 File System Access API（Chromium 桌面浏览器），与本机选定文件夹做双向同步：

- 以 `.aidrivenote/sync.json` 记录同步基线，文件内容 SHA-256 与服务端 `updated_at` 三方比对；
- 文件夹树以服务端为权威，远端删除的文件移入 `.aidrivenote/trash/`，本地删除会软删除服务端笔记；
- 同步前可先执行**只读对比**，生成差异报告后再决定是否写入；
- Markdown 文件带 YAML frontmatter（id / title / tags / folder），导图与流程图分别为 `.json` 与 `.drawio`。

---

## 导出与邮件

### 导出

单篇导出入口：编辑器「文件 → 导出为…」菜单、命令面板，或导图 / 流程图各自的工具条。

| 笔记类型 | 可导出格式 | 批量原格式 |
|----------|-----------|-----------|
| 富文本 / Markdown | PDF、Word（.docx）、HTML、Markdown | `.md` |
| 思维导图 | PNG、SVG、PDF、XMind、JSON | `.json` |
| 流程图 | PNG、SVG、PDF、XML | `.drawio` |

**全部笔记批量导出**：列表头的导出按钮会把所有笔记按原格式导出到本机目录（`AIDriveNote-export-YYYY-MM-DD`，保留文件夹层级，重名自动编号）；浏览器不支持目录写入时自动回退为 ZIP 下载。

> 导出全部在前端完成（jspdf / docx / html2canvas / jszip），后端不提供导出接口。

### 发送到邮箱

编辑器「文件 → 发送到邮箱…」或列表右键菜单可把当前笔记发送到指定邮箱（`POST /notes/email/send`）。依赖根目录 `.env` 的 `EMAIL_*` 配置（QQ SMTP）；`EMAIL_MOCK=true` 时只记日志不发信，用于本地验证。未配置 `EMAIL_USER` / `EMAIL_PASS` 时前端会提示功能不可用。

同一套 SMTP 配置也用于**注册验证码**邮件的投递。

---

## 账号、权限与集成

### 认证

- 登录 / 刷新令牌（access 30 分钟，refresh 14 天），密码 bcrypt 加密。
- **SSO 单点登录**：对接 AIDriveAll 门户，校验签名与 `iss`；`SSO_AUTO_CREATE_USERS=false` 时仅允许管理员预建的账号登录（公网测试部署的默认值）。`scripts/enable-sso.sh` 可一键开启。
- **API 访问令牌（PAT）**：在 `/settings/tokens` 生成 `adn_` 前缀令牌，服务端只存 SHA-256 摘要，明文仅显示一次，可设置有效期与撤销。令牌权限等同于本人全部权限（唯一限制：不能用令牌管理访问令牌）。

### 自助注册与邮箱验证

`SELF_REGISTRATION_ENABLED`（默认 `true`；compose 生产默认 `false`）控制是否开放自助注册。开放时为**三步验证码流程**（提交邮箱 → 收取验证码 → 完成注册），验证码有效期 `EMAIL_CODE_TTL_MINUTES`、重发冷却 `EMAIL_CODE_SEND_COOLDOWN_SECONDS`、最大错误尝试 `EMAIL_CODE_MAX_VERIFY_ATTEMPTS`（超限作废需重新获取）。关闭时前端隐藏注册入口，账号一律由管理员在 `/settings/users` 创建。

### 角色与管理员

角色分为 `user` 与 `admin`。`ADMIN_EMAIL` 指定的首个注册用户自动成为管理员。管理员可在 `/settings/users` 按关键字 / 角色 / 状态筛选用户，并修改其名称、状态与角色；**删除用户为软删除**（保留笔记数据归属），系统禁止停用或降级自己，也禁止降级最后一名管理员。

### 匿名登录（免注册试用）

登录页提供「匿名使用」入口，无需邮箱密码即可使用笔记功能与 AI 助手。

- **每个匿名会话一个独立账号**：这是隐私硬要求。笔记按 `created_by` 隔离，若所有匿名访客共用一个账号，所有人将互相看到对方的笔记。
- **数据不长期保存**：匿名账号超过 `GUEST_IDLE_TIMEOUT_MINUTES`（默认 30 分钟）无任何请求后，后台定时任务会**物理删除**其笔记、文件夹、标签、AI 会话与附件、**自建的模型与助手**、上传文件乃至账号行。主动点击「退出」则立即清除，无需等待宽限期。
- **可用**：笔记全功能（富文本 / Markdown / 思维导图 / 流程图）、离线缓存、AI 对话与工具调用、AI 生成标题、AI 偏好设置，以及**创建和使用自己的** AI 模型 / 助手 / 技能。
- **不可用**：录音转写、本地同步、访问令牌（PAT）、笔记分享、发送到邮箱、语音转写与常用词库设置（后两者是全局配置，匿名写入无法按用户回收）。前端隐藏入口，后端以 `require_not_guest` 拦截。
- **匿名登录事件**：管理员可在 `/settings/guest-events` 查看匿名用户的登录信息与会话生命周期（类型、时间、IP、User-Agent、存活时长、笔记数）与汇总统计，并可点击「立即清除超时账号」。事件**仅记录元数据**，绝不包含笔记标题或正文；`guest_events` 表刻意不设 `users` 外键，因此账号被清除后事件仍保留，便于统计与审计。

### AI 模型与助手的归属

模型与助手**归属于创建它们的用户**，彼此隔离：

| 对象 | 可见范围 | 可写范围 |
|------|----------|----------|
| 系统预置模型 / 助手（`user_id IS NULL`，由种子创建） | 所有用户 | **不可写**——改动会全站生效，请先克隆或新建 |
| 系统预置 **OPENCODE 公共免费模型** | 所有用户（**含匿名**） | 不可写；走免 Key 匿名通道，不携带任何站点 Key |
| 本人创建的 | 本人 | 本人 |
| 其他用户创建的 | **不可见** | 不可写（返回 404） |

匿名用户的可见范围收紧为「**本人创建 + 系统 OPENCODE 公共免费模型**」：其余系统预置（可能携带站点 Key）与他人的模型一律不可见。若匿名用户没有任何可用模型，AI 对话会明确提示「请先添加模型」——**不会**回退到站点管理员配置的环境变量模型或付费 API Key。

> 早期版本的 `ai_models.user_id` / `ai_assistants.user_id` 是「只写不读」字段，所有查询都不按归属过滤，`LLMRouter` 甚至从全库随机取一行兜底，导致任何用户都可能用上他人的付费 Key。上述隔离口径由 `backend/app/services/ai/ownership.py` 统一提供，回归测试见 `backend/tests/test_ai_ownership.py`。

### 配额与上传限制（公网部署防护）

| 限制 | 变量 | 默认值 |
|------|------|--------|
| 单用户笔记数（含回收站，0 = 不限） | `USER_MAX_NOTES` | 100 |
| 单个上传文件大小（图片资产 / AI 附件） | `USER_MAX_UPLOAD_BYTES` | 2MB |
| 单条录音大小 | `NOTE_MAX_RECORDING_BYTES` | 25MB |
| 匿名用户笔记数 | `GUEST_MAX_NOTES` | 50 |
| 生产接口文档 | `API_DOCS_ENABLED` | compose 中 `false` |

> `NOTE_MAX_RECORDING_BYTES` 变更时，nginx 各层 `client_max_body_size` 需 ≥ 该值 + 1MB。

### MCP 集成

详见下一节 [MCP 接入](#mcp-接入外部-agent-写入笔记)。

---

## MCP 接入（外部 Agent 写入笔记）

内置 [mcp-server](mcp-server/README.md)，让 Claude Desktop / Cursor / Trae 等外部 Agent 把检索到的文档直接写入笔记。

调用链路：

```
Claude Desktop / Cursor / Trae
        │  stdio（MCP 协议）
        ▼
aidrivenote-mcp          ← 在你本机运行
        │  HTTPS + Bearer 访问令牌
        ▼
AIDriveNote 后端 /api/v1
```

### 第 1 步：获取访问令牌

在笔记应用进入 **设置 → 访问令牌**，点击「新建令牌」，填写名称（如 `Claude Desktop`）并选择有效期，然后复制 `adn_` 开头的明文令牌。

> 令牌等同账号的长期通行证：只粘贴到本机 MCP 配置，不要提交到公开仓库；怀疑泄露时回到同一页面撤销即可。服务端仅保存 SHA-256 摘要，明文只显示这一次。

### 第 2 步：安装 MCP Server

**方式一：uvx 免安装（推荐）**

已安装 [uv](https://docs.astral.sh/uv/) 时无需手动安装，客户端会在启动时自动拉取并运行。国内网络建议先设置镜像：

```bash
export UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
```

**方式二：pipx 安装**（适合私有仓库 / 离线环境）

```bash
pipx install --pip-args "-i https://pypi.tuna.tsinghua.edu.cn/simple" ./mcp-server
```

**方式三：本地虚拟环境**（开发调试）

```bash
cd mcp-server
uv venv && uv pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -e .
```

**方式四：安装到当前解释器**

```bash
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -e ./mcp-server
```

安装后可手动执行验证（未配置令牌时会打印中文配置指引）：

```bash
aidrivenote-mcp
```

### 第 3 步：配置客户端

**Claude Desktop** —— 编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "aidrivenote": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/aiignite/AIDriveNote.git@main#subdirectory=mcp-server",
        "aidrivenote-mcp"
      ],
      "env": {
        "AIDRIVENOTE_BASE_URL": "https://www.aiignite.com.cn/note/api/v1",
        "AIDRIVENOTE_API_TOKEN": "adn_替换为你的令牌"
      }
    }
  }
}
```

**Cursor** —— 编辑项目内 `.cursor/mcp.json` 或全局 `~/.cursor/mcp.json`，内容同上。

**用 pipx / 方式四安装后的配置** —— 把 `command` 换成已安装的可执行文件，省去 `args`：

```json
{
  "mcpServers": {
    "aidrivenote": {
      "command": "aidrivenote-mcp",
      "env": {
        "AIDRIVENOTE_BASE_URL": "https://www.aiignite.com.cn/note/api/v1",
        "AIDRIVENOTE_API_TOKEN": "adn_替换为你的令牌"
      }
    }
  }
}
```

**开发调试（免安装，直接跑源码）**：

```json
{
  "mcpServers": {
    "aidrivenote": {
      "command": "uv",
      "args": ["run", "--directory", "/绝对路径/AIDriveNote/mcp-server", "aidrivenote-mcp"],
      "env": {
        "AIDRIVENOTE_API_TOKEN": "adn_替换为你的令牌"
      }
    }
  }
}
```

**连接本地开发的后端**：把地址指向本机服务即可，根路径部署时无需额外配置：

```json
"AIDRIVENOTE_BASE_URL": "http://localhost:3275/api/v1"
```

> 子路径部署（如 `/note/`）时地址须带子路径，且后端 `CORS_ORIGINS` 需包含客户端来源。

### 第 4 步：验证连通性

在 Agent 中让它调用 `list_folders`，能返回文件夹列表即表示地址与令牌配置正确。

也可使用官方 Inspector 逐个调试工具：

```bash
npx -y @modelcontextprotocol/inspector aidrivenote-mcp
```

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AIDRIVENOTE_API_TOKEN` | 是 | — | 设置 → 访问令牌 生成的 `adn_…` 令牌 |
| `AIDRIVENOTE_BASE_URL` | 否 | `https://www.aiignite.com.cn/note/api/v1` | 后端 API 根地址 |
| `AIDRIVENOTE_TIMEOUT` | 否 | `30` | 单次请求超时（秒） |

### 可用工具

| 工具 | 说明 |
|------|------|
| `create_note` | 把文档写入为新笔记；支持指定文件夹、标签、类型（`markdown` / `rich_text`） |
| `append_to_note` | 向已有笔记末尾追加内容（`markdown` / `rich_text` 类型） |
| `search_notes` | 全文检索，定位要追加的笔记 |
| `list_folders` | 列出文件夹层级路径，确认归档位置 |
| `list_tags` | 列出已有标签，避免重复创建 |

行为约定：

- 正文一律用 Markdown 传入。`markdown` 类型保留源码；`rich_text` 类型会做行级转换（标题 / 列表 / 待办 / 引用 / 代码块），复杂排版建议用 `markdown`。
- `folder_name` 只做匹配、**不会自动创建文件夹**：找不到或匹配到多个时，会返回可用文件夹列表请 Agent 向你确认，避免误建目录。
- `tags` 中不存在的标签会**自动创建**并挂到笔记上。
- 每次追加都会生成笔记修订记录，可在版本历史中回滚。

### 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| 启动即退出，stderr 提示未配置 `AIDRIVENOTE_API_TOKEN` | 令牌没有写进 MCP 配置的 `env` 段 |
| 提示「令牌无效或已撤销」 | 令牌填错、已被撤销或已过期；到设置页重新生成 |
| 提示「无法连接 …，请检查地址与网络」 | `AIDRIVENOTE_BASE_URL` 写错（含子路径时最常见），或本机网络不可达 |
| 工具列表为空 | 客户端未重启，或 `command` 路径不可用（可先用 `aidrivenote-mcp` 手动执行验证） |
| 追加提示「仅支持 markdown/rich_text」 | 目标笔记是思维导图或流程图，改用 `create_note` 新建 |

---

## API 一览

开发环境文档：http://localhost:3275/docs （生产默认关闭，见 `API_DOCS_ENABLED`）

所有业务接口统一前缀 `/api/v1`：

| 前缀 | 说明 |
|------|------|
| `/auth` | 登录、刷新令牌、当前用户、匿名登录、注册与邮箱验证码 |
| `/users/search` | 分享时搜索用户 |
| `/admin/users` | 管理员用户管理（仅 admin，含软删除） |
| `/admin` | 匿名登录事件与统计、手动清除超时账号（仅 admin） |
| `/notes` | 笔记 CRUD、文件夹、标签、模板、搜索、版本、分享、双链、**加密 / 解锁 / 解密 / 改密**、图片资源 `/notes/assets` |
| `/notes/email` | 发送笔记到邮箱 |
| `/notes/title` | AI 生成 / 派生标题 |
| `/note-recordings` | 录音上传、列表、详情、转写文本、音频流、重新转写 / AI 整理润色、删除 |
| `/note-asr` | ASR 设置读写、网关连通性测试、常用词库 CRUD |
| `/ai` | 模型 / 助手 / 技能 / 会话 / 附件 / SSE 流式对话（匿名禁用） |
| `/api-tokens` | 访问令牌签发、列表、撤销 |

健康检查：`GET /health` → `{ "status": "ok", "app": "AIDriveNote" }`

---

## 前端路由

| 路径 | 页面 | 说明 |
|------|------|------|
| `/login` | 登录 | 含「匿名使用」入口 |
| `/register` | 注册 | 三步邮箱验证码；`SELF_REGISTRATION_ENABLED=false` 时入口隐藏 |
| `/` | 笔记页 | 列表 + 编辑器 + AI 侧栏；移动端单列导航 |
| `/settings` | 设置 | 匿名账号默认落到 `offline`，普通用户落到 `models` |
| `/settings/models` | AI 模型 | 匿名禁用 |
| `/settings/assistants` | AI 助手 | 匿名禁用 |
| `/settings/skills` | AI 技能 | 匿名禁用 |
| `/settings/asr` | 语音转写 | 匿名禁用 |
| `/settings/common-terms` | 专有名词词表 | 匿名禁用 |
| `/settings/sync` | 本机同步 | 匿名禁用 |
| `/settings/offline` | 离线缓存 | 匿名可用 |
| `/settings/tokens` | 访问令牌 | 匿名禁用 |
| `/settings/users` | 用户管理 | 仅管理员 |
| `/settings/guest-events` | 匿名登录事件 | 仅管理员 |

旧路径 `/settings/ai/*` 与 `/admin/users` 会重定向到新地址。

---

## 部署

### Docker Compose

`docker-compose.prod.yml` 定义 4 个服务：

| 服务 | 端口 | 说明 |
|------|------|------|
| frontend | `3270:80` | nginx 托管构建产物，对外入口 |
| backend | `127.0.0.1:3275` | FastAPI，仅本机，不对外暴露 |
| postgres | 内部 | 数据卷 `postgres_data` |
| asr_gateway | `127.0.0.1:8091` | 语音转写网关（默认 CPU `small + int8`，`mem_limit 1536m`、`cpus 1.5`） |

```bash
# 1. 配置根目录 .env（参考 backend/.env.example，额外需要 POSTGRES_PASSWORD）
cp backend/.env.example .env

# 2. 构建并启动
docker compose -f docker-compose.prod.yml up -d --build

# 3. 数据库迁移
docker compose -f docker-compose.prod.yml exec backend alembic upgrade head
```

也可省略 compose 中的 postgres 服务，将 `DATABASE_URL` 指向外置 PostgreSQL。

> 前端镜像构建需要 `NODE_OPTIONS=--max-old-space-size=3072`（已写入 `frontend/Dockerfile`），否则在 4GB 内存以下的小机上 `vite build` 会堆溢出。

### 服务器端脚本

```bash
./deploy.sh                # 服务器 ~/AIDriveNote 目录执行
./scripts/deploy-remote.sh # 本地一键 rsync + 远程部署（发布前校验 .env 漂移）
./scripts/backup-remote.sh # 备份数据库、上传文件、nginx 配置与证书
```

`backup-remote.sh` 备份 5 类产物：数据库转储、上传目录归档、服务器 `.env`、compose 文件、nginx 与 Let's Encrypt 配置，并在本地校验完整性、输出恢复顺序。

### nginx 与子路径部署

前端容器内 nginx 按 `NGINX_SUBPATH` 构建参数在根路径与 `/note/` 子路径两套配置间二选一；`deploy/nginx/aiignite-note.conf` 提供域名入口（TLS、安全响应头、SSE 长连接配置）。`scripts/setup-note-domain.sh` 可一键安装该站点配置。

### 数据库迁移

`backend/alembic/versions/` 目前 **14 个**迁移：初始表 → AI 平台 → 模型扩展字段 → 用户角色 → 技能扩展与笔记向量 → AI 附件 → 笔记性能索引 → 访问令牌 → 录音 → P0 可靠性（修订置位/序号、`note_type` 约束、中文检索扩展）→ 笔记加密 → 邮箱验证码 → 匿名用户 → 匿名事件。

---

## 配置项

### 必填

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | 异步连接串（`postgresql+asyncpg://…`） |
| `DATABASE_URL_SYNC` | 同步连接串，供 Alembic 使用 |
| `SECRET_KEY` | JWT 与加密密钥，长度 ≥ 32 |
| `POSTGRES_PASSWORD` | 仅 compose 模式需要 |
| `NOTE_ASR_REMOTE_API_KEY` | 仅 compose 模式需要（backend 与 asr_gateway 共用） |

### 应用与安全

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ADMIN_EMAIL` | — | 首个管理员邮箱 |
| `ACCESS_TOKEN_EXPIRE_MINUTES` / `REFRESH_TOKEN_EXPIRE_DAYS` | 30 / 14 | 令牌有效期 |
| `CORS_ORIGINS` | `http://localhost:3270` | 允许来源，逗号分隔 |
| `API_DOCS_ENABLED` | `true`（compose 为 `false`） | 是否开放 `/docs` |
| `SELF_REGISTRATION_ENABLED` | `true`（compose 为 `false`） | 是否开放自助注册 |
| `USER_MAX_NOTES` | 100 | 单用户笔记数上限，0 = 不限 |
| `USER_MAX_UPLOAD_BYTES` | 2097152 | 单文件上传上限（2MB） |
| `SSO_ENABLED` / `SSO_SECRET_KEY` / `SSO_ISSUER` / `SSO_COOKIE_NAME` | `false` / — / `aidriveall` / `aidrive_token` | 门户单点登录 |
| `SSO_AUTO_CREATE_USERS` | `true`（compose 为 `false`） | SSO 首次登录是否自动建号 |

### 匿名登录

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GUEST_LOGIN_ENABLED` | `true` | 是否开放匿名登录 |
| `GUEST_IDLE_TIMEOUT_MINUTES` | 30 | 离线宽限期，超时即物理清除 |
| `GUEST_PURGE_INTERVAL_SECONDS` | 300 | 清除任务扫描间隔（兼作心跳节流） |
| `GUEST_MAX_NOTES` | 50 | 匿名用户笔记配额 |
| `GUEST_EVENTS_ENABLED` | `true` | 是否记录匿名登录事件 |

### 笔记与 AI

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NOTE_REVISION_KEEP` | 50 | 每篇笔记保留的修订条数（置位快照不参与淘汰） |
| `NOTE_AI_MODEL` | 空 | 语音整理 / 润色默认模型；留空走模型解析链 |
| `OLLAMA_BASE_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `qwen2.5` | 默认模型服务 |
| `AI_PROVIDER` | `ollama` | 默认供应商 |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `MINIMAX_API_KEY` | — | 云端模型兜底密钥 |
| `AI_WEB_SEARCH_ENABLED` / `_TIMEOUT` / `_MAX_RESULTS` | `false` / 10 / 5 | AI 联网搜索（免 Key 网页抓取） |

### 录音与转写

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NOTE_ASR_MODE` | `remote` | `remote` 或 `local` |
| `NOTE_ASR_REMOTE_URL` / `_API_KEY` / `_TIMEOUT` | 空 / 空 / 3600 | 远程转写网关 |
| `NOTE_ASR_FALLBACK_LOCAL` | `false` | 远程失败是否降级本机 |
| `NOTE_WHISPER_MODEL` / `_LANGUAGE` / `_DEVICE` / `_COMPUTE_TYPE` | `medium` / `zh` / `cpu` / `int8`（compose 模型为 `small`） | 本地转写 |
| `NOTE_WHISPER_MAX_CONCURRENT` | 1 | 并发转写上限（串行避免 CPU 峰值） |
| `NOTE_MAX_RECORDING_BYTES` | 26214400 | 单条录音上限（25MB） |
| `NOTE_ENABLE_SPEAKER_DIARIZATION` | `false` | 说话人分离 |
| `NOTE_SPLIT_SILENCE_DB` / `_DURATION` / `NOTE_SPLIT_MAX_SEGMENT_SECONDS` / `NOTE_SPLIT_MIN_SEGMENT_SECONDS` | -40 / 0.5 / 60 / 3.0 | 静音切分参数 |
| `NOTE_MERGE_MIN_PARAGRAPH_CHARS` / `_MAX_PARAGRAPH_CHARS` / `_SOFT_PAUSE_SECONDS` / `_HARD_PAUSE_SECONDS` | 80 / 400 / 3.0 / 4.0 | 段落合并规则 |
| `ASR_MODEL` / `ASR_DEVICE` / `ASR_COMPUTE_TYPE` / `ASR_PRELOAD` / `ASR_MEM_LIMIT` / `ASR_CPUS` | `small` / `cpu` / `int8` / 1 / 1536m / 1.5 | asr_gateway 侧 |

### 邮件

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EMAIL_HOST` / `EMAIL_PORT` | `smtp.qq.com` / 465 | SMTP 服务 |
| `EMAIL_USER` / `EMAIL_PASS` / `EMAIL_FROM` | 空 | 留空则「发送到邮箱」与验证码邮件不可用 |
| `EMAIL_USE_SSL` | `true` | 465 走隐式 SSL，否则按 starttls |
| `EMAIL_MOCK` | `true` | 只记日志不发信，用于本地验证 |
| `EMAIL_CODE_TTL_MINUTES` / `_LENGTH` / `_SEND_COOLDOWN_SECONDS` / `_MAX_VERIFY_ATTEMPTS` | 10 / 6 / 60 / 5 | 注册验证码策略 |

### 前端构建

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VITE_BASE_PATH` / `VITE_API_URL` / `NGINX_SUBPATH` | `/` / `/api/v1` / `0` | 子路径部署 |

---

## 项目结构

```
AIDriveNote/
├── backend/                  FastAPI + SQLAlchemy + Alembic
│   ├── app/
│   │   ├── routers/          auth、api_tokens、users、admin/{users,guest_events}、
│   │   │                     note/{note,email,title,recordings,asr}、ai
│   │   ├── services/         note（含加密、资源、检索、增强）、AI 平台与供应商、录音转写
│   │   ├── models/           用户、笔记、AI、录音、匿名事件数据模型
│   │   └── ai_tools/         17 个 AI 工具（note_tools 16 + web_tools 1）
│   └── alembic/versions/     14 次迁移
├── frontend/                 React 19 + Vite + 四种编辑器
│   ├── src/pages/            笔记页、登录、注册、settings/ 11 个设置页
│   ├── src/components/       笔记组件、AI 组件、录音组件、通用组件
│   ├── src/services/         API 客户端、离线缓存与队列、本机同步、解锁票据
│   ├── src/hooks/            语音输入、取图拍照、移动端判定、持久化状态
│   └── public/sw.js          Service Worker（离线与分包预缓存）
├── asr_gateway/              独立语音转写网关（GPU 可选）
├── mcp-server/               MCP Server（stdio，外部 Agent 集成）
├── nginx/、deploy/nginx/     nginx 站点配置
├── scripts/                  部署、备份、SSO、域名脚本
├── docs/plans/               设计方案与实施记录
├── start.sh                  本地一键启动
└── deploy.sh                 生产部署脚本
```

---

## 测试

```bash
cd backend  && pytest --asyncio-mode=auto      # 214 个用例
cd frontend && npm run type-check
cd frontend && npm run build                   # tsc + vite build + gzip
```

后端测试基于内存 SQLite 运行，覆盖认证、管理员、笔记接口、双链解析、加密锁定、中文检索策略、修订治理、图片资产、录音与 ASR 设置、AI 平台、AI 供应商、会话历史、工具注册表、技能路由、匿名登录与附件抽取。

---

## 更新日志

### 2026-10-13

- **OpenCode Zen 免 Key 公共模型通道**：新增 `OPENCODE` provider——固定 `Bearer public` 免 API Key、OpenCode CLI 同形请求头、free-lane 请求形状自动补齐（`bash`/`read` 占位工具 + `tool_choice: none`）、会话 id 确定性规范化（`ses_<12hex><14base62>`）、429 静默退避重试。系统种子内置 5 个免费公共模型（ling-3.1-flash / mimo-v2.6-flash / step-5-preview / nemotron-3.5-lightning / space-bunny），全站用户开箱可用；设置页可按免费名单自行追加，步骤见「模型管理」。
- **匿名用户可见口径调整**：由「仅本人创建」放宽为「本人创建 + 系统 OPENCODE 公共免费模型」；付费系统种子对其仍不可见、不可用，不泄露站点 Key。
- **连通性测试修复**：`POST /ai/models/{id}/test-connection` 由「可写」口径（仅本人创建）改为「可见」口径（本人 + 系统种子），修复系统公共模型对所有人返回 404 的问题；他人私有模型仍不可探测。
- 测试：新增 `test_ai_ownership.py`（归属与可见口径回归）与 `test_opencode_provider.py`（free-lane 形状 / 会话 id 规范化 / Key 解析），后端用例 187 → 214。

### 2026-10-12

- **匿名免注册试用**：每个匿名会话独立账号，超过宽限期自动物理清除（笔记、附件、自建模型 / 助手、账号行），主动退出立即清除；管理员可在 `/settings/guest-events` 查看匿名登录事件与统计，匿名登录支持整体开关。
- **公网部署加固**：自助注册默认关闭（可选开启三步验证码流程）、单用户笔记配额与 2MB 上传上限、生产关闭 `/docs` 接口文档、部署文档剥离真实服务器 IP。

---

## 路线图

- pgvector 语义检索（当前 embedding 以 JSONB 存储并全量扫描）
- 知识图谱 UI
- 编辑器内 Slash 唤起 AI
- 块级双链、画布视图与协作编辑（CRDT）

设计方案与实施记录见 [docs/plans/](docs/plans/README.md)。