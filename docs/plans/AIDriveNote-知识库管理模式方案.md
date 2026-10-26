# AIDriveNote 知识库管理模式方案

| 项目 | 内容 |
|------|------|
| 状态 | **P0 implemented**（2026-10-26） |
| 起草日期 | 2026-10-26 |
| 关联 | 本地 Markdown 知识库与 Agent 集成设计（`~/Documents/KnowledgeBase`） |
| 结论 | AIDriveNote 不做知识库的**事实源**，而做它的**管理软件**：阅读 / 查询 / 新增 |

---

## 1. 起因：为什么不是「替代 Obsidian」

本地知识库的设计结论是三层结构：

```
~/Documents/KnowledgeBase/
├── AGENTS.md      规则层（唯一必读）
├── index.md       全局目录（Agent 定位用）
├── log.md         追加日志
├── inbox/         收件箱
├── raw/           真相层：原始资料，只读
├── wiki/          编译层：concepts / entities / topics / decisions
├── templates/     模板，只读
└── archive/       归档
```

Obsidian 在这套方案里只是**阅读器**——它不存数据，数据就是 `.md` 文件本身。
AIDriveNote 现有的定位是「PostgreSQL 为真相源 + 本地文件夹双向同步」，**角色与 Obsidian 根本不同**，谈不上替代。

但 AIDriveNote 有几件 Obsidian 给不了的真本事：中文三级降级检索（zhparser → pg_trgm → ILIKE）、混合 RAG、17 个笔记工具、13 个技能、四种笔记形态、版本历史、加密、多端。

**所以本方案的目标不是"替代"，是"接管管理软件的位置"**：

| 层 | 归属 | 职责 | 谁写 |
|---|---|---|---|
| **文件层** | `~/Documents/KnowledgeBase/` | 事实源，纯 Markdown + git | Agent / 人 |
| **索引层** | PostgreSQL | 检索、RAG、标签、双链、版本 | AIDriveNote 后端 |
| **交互层** | AIDriveNote 前端 | 阅读、查询、新增、AI 对话 | 人 |

一句话：**文件是真相，数据库是索引，应用是窗口。**

### 1.1 现有实现与知识库的真实冲突

下面全部来自源码核实，不是推测。

| # | 冲突 | 代码位置 | 后果 |
|---|------|----------|------|
| C1 | frontmatter 只写 `id/title/tags/folder/updated_at` | `syncEngine.ts:391-399` | 知识库页的 `type / topic / sources / related / confidence` **被静默抹掉**——真实数据丢失 |
| C2 | 未知 frontmatter 键不保留 | `parseFrontmatter:424`（只识别 `tags`） | 同上，且顺序与注释丢失 |
| C3 | 无忽略规则 | `listAllFiles:502` 只跳过 `.` 开头 | `AGENTS.md`、`index.md`、`log.md`、`README.md`、`raw/**` 全被当孤儿扫出，报告噪音 |
| C4 | 只有 `mode: compare\|apply`，无方向开关 | `SyncOptions:135` | 一接上知识库就是双向，必然污染 |
| C5 | 双改必生成冲突副本 | `buildConflictPath:883` + `applyNoteAction:1045` | 会在 `wiki/` 里拉出 `xxx.conflict-*.md` 垃圾副本，还会被 Agent 当知识页索引 |
| C6 | 本地文件被删 → 服务端软删 | `localDelete:1057` | 误删/搬家本地文件会连带删掉数据库笔记 |
| C7 | 服务端删除 → 本地文件进回收站 | `remoteDelete:1051` | 知识库文件被应用搬走，违反 `raw/` 只读红线 |

> **对文档的一处更正**：`.git/`、`.gitkeep` 其实已经被 `name.startsWith('.')` 跳过了，不需要额外处理。真正漏的是**非点开头的元文件**（`AGENTS.md`/`index.md`/`log.md`/`README.md`）。

---

## 2. 核心模型：知识库根文件夹（KB Root）

> 来自需求：*「可以在笔记中特殊定义一个文件夹作为知识库的管理文件夹」*

### 2.1 模型定义

在笔记树中指定**一个文件夹**为「知识库根」，本地目录挂载到它：

```
笔记树（PostgreSQL）                    本地文件系统
─────────────────────                  ────────────────────────────
📁 我的笔记                              ~/Documents/KnowledgeBase/   ← 绑定目录
📁 知识库  ⬅️ KB Root（打标）      ⇄     ├── AGENTS.md   （忽略）
   ├── 📁 raw/   🔒 保护                  ├── index.md    （忽略）
   ├── 📁 wiki/                          ├── raw/        🔒 只导入
   │   ├── 📁 concepts/                  ├── wiki/
   │   ├── 📁 entities/                  │   ├── concepts/
   │   └── 📁 topics/                    │   │   └── 模块化单体.md
   └── 📁 templates/ 🔒 保护              └── templates/  🔒 只读
```

- **KB Root 子树** = 参与同步的全部笔记范围（路径相对 KB Root 计算）。
- **绑定目录** = 那个文件夹在磁盘上的投影。
- KB Root 之外的普通笔记**不受本方案影响**，保持原有双向同步语义（见 §10 限制）。

### 2.2 为什么"根文件夹"由客户端存，而不是加数据库字段

本地目录授权（`showDirectoryPicker` 句柄）本身就存在**每台设备的 IndexedDB** 里，天生 per-device。
把「哪个文件夹是 KB Root」也放客户端，与本机绑定天然对齐，**零后端改动、零迁移风险**：

```ts
// 新增 frontend/src/services/sync/kbConfig.ts
export interface KbConfig {
  enabled: boolean;
  /** 笔记树中被指定为知识库根的文件夹 ID */
  rootFolderId: string | null;
  /** 展示用，句柄丢失时仍能提示用户 */
  rootFolderName: string;
  /** 相对 KB Root 的忽略清单 */
  ignore: string[];
  /** 相对 KB Root 的保护目录（禁止写回/删除/重命名） */
  protect: string[];
}
```

保存在 `localStorage`（键 `aidrivenote.sync.kb`），与现有 `aidrivenote.sync.dirName` 镜像同一套路。

---

## 3. 方向模型：五种数据流

现有 `SyncOptions` 只有 `mode`。新增 `direction`：

```ts
export type SyncDirection = 'two-way' | 'kb';
```

`two-way` = 现状，不动。`kb` = 本方案的全部规则。

### 3.1 KB 模式下的五种场景

| # | 场景 | 触发条件 | 动作 | 是否动本地文件 |
|---|------|----------|------|----------------|
| D1 | **本地新增** | 本地有文件、manifest 无基线 | **导入**：DB 新建笔记 | 否（只读） |
| D2 | **本地修改** | 本地 hash ≠ base，远端未变 | **上传**：更新 DB 笔记 | 否 |
| D3 | **应用内新增** | DB 有笔记、manifest 无基线、本地无对应文件 | **写入**：按路径规则落盘 | 是（新增文件） |
| D4 | **应用内修改** | 远端 `updatedAt` 变、**本地未变** | **写回**：更新本地文件 | 是（安全覆盖） |
| D5 | **删除** | 任一端删除 | **只报告，不执行** | 否 |

关键点：

- **D4 只在「本地未变」时写回**（`localHash === base.contentHash`）。本地一旦有未同步的修改，绝不覆盖——这是「本地文件不被覆盖」红线的落点。
- **D5 是硬规则**：KB 模式下引擎**不再调用 `moveToTrash` / `noteApi.delete`**。这是本次改造里唯一需要"删代码"的地方，也是最重要的安全变化。

### 3.2 三方比对裁决表（KB 模式）

| base 本地基线 | local 文件 | remote 笔记 | 裁决 | 动作 |
|---|---|---|---|---|
| 有 | 未变 | 未变 | 无差异 | 刷新基线 |
| 有 | 变 | 未变 | D2 | 上传（本地为准） |
| 有 | **未变** | 变 | D4 | 写回本地（安全） |
| 有 | **变** | **变** | **本地优先** | 上传；远端变更记入 `skippedRemoteChanges` 报告 |
| 有 | **文件消失** | 任意 | **不删服务端** | 记入 `missingLocal` |
| 有 | 任意 | **笔记删除** | **不删本地** | 记入 `unlinkedLocal`，解除映射 |
| 无 | 有 | 无 | D1 | 导入建笔记 |
| 无 | 无 | 有 | D3 | 写入本地新增文件 |
| 无 | 有 | 有（同路径） | 认领 | 按 D1/D2 处理，绝不覆盖本地 |

**"本地优先"的理由**：知识库的事实源是文件。双改时若远端赢，会覆盖用户的文件；若本地赢，最多让数据库暂时落后——后者可重放，前者不可逆。

---

## 4. 忽略清单与保护目录

### 4.1 忽略清单（不扫描、不导入、不出现在报告）

内置「知识库预设」（UI 一键填入）：

```ts
export const KB_PRESET_IGNORE = [
  'AGENTS.md', 'CLAUDE.md', 'MEMORY.md',   // 规则层
  'README.md', 'index.md', 'log.md',       // 索引与日志
  'archive', 'templates',                   // 归档与模板
];
```

匹配规则（相对 KB Root 的路径）：

- 纯名字（无 `/`）→ 匹配**任意层级**上的同名文件或目录；
- 含 `/` → 按相对路径前缀匹配（`archive/2025` 只忽略该子树）。

点开头的项（`.git/`、`.obsidian/`、`.aidrivenote/`、`.gitignore`、`.gitkeep`）由 `listAllFiles:502` 的既有规则**天然跳过**，不进清单。

`inbox/` 与 `raw/` **默认不忽略**——它们是知识库的主要阅读对象。`raw/files/` 下的 PDF / 图片由 `parseLocalFile` 按扩展名自动跳过（只处理 `.md` / `.json` / `.drawio`）。

### 4.2 保护目录（可导入，但禁止写回/删除/重命名）

```ts
export const KB_PRESET_PROTECT = ['raw', 'templates'];
```

对齐知识库 `AGENTS.md` 第 2 节权限表（`raw/` 只读且只允许新增，`templates/` 只读）。

保护规则在两处生效：

1. **写方向**：任何落到保护目录的 `download` / 写回动作 → 降级为「仅报告」，记入 `blockedByProtection`；
2. **删方向**：保护目录下的路径永不出现在删除动作里。

这是**第二道保险**：即使忽略清单被用户改错了，原始资料依然伤不到。

---

## 5. frontmatter 保真策略

这是 C1/C2 两个数据丢失缺陷的修复，也是"本地文件永不被污染"的核心。

### 5.1 原则：不注入、不重排、不丢失

| 场景 | 策略 |
|---|---|
| **读**（本地 → DB） | 解析全部 `key: value` 与 `key: [a, b]`，**未知键原样保留在内存**；只用 `title` / `tags` 做语义映射 |
| **写**（DB → 本地） | 若目标文件已存在且将被覆盖 → **保留其全部未知键、键顺序、注释行**，只更新 `title` / `tags` 等本应用负责的字段 |
| **新建**（D3） | 写知识库规范 frontmatter：`title` / `tags` / `created` / `updated`，**不写裸 `id`** |

### 5.2 命名空间隔离

现有实现把笔记 ID 写成裸 `id:`，这在知识库场景有冲突风险（`id` 是外部工具最常用的通用键）。改为：

```yaml
adn_id: 3f2a...        # AIDriveNote 笔记 ID
adn_updated_at: 2026-10-26T23:30:00Z
```

**读方向同时兼容旧 `adn_id` 与历史 `id`**，老目录不需要重新绑定。

> 注：KB 模式下 D3 写入的知识库页**仍不写 `adn_id`**——因为 KB Root 的映射由 manifest 承担，写进去反而污染 Agent 的 frontmatter 规范。`adn_` 命名空间只在 `two-way` 模式（通用镜像）下使用。

### 5.3 知识库 frontmatter → 笔记属性的映射

| KB 字段 | 映射到 Note | 说明 |
|---|---|---|
| `title` | 笔记标题 | 缺失时回退文件名 |
| `tags` | 笔记标签 | 不存在自动创建 |
| `type`（concept/entity/topic/decision） | 追加标签 `kb:concept` 等 | 避免与既有标签撞名 |
| `topic` | 追加标签 `topic:产品开发` | 同上 |
| `confidence` | 笔记描述前缀 `[kb] confidence: medium` | 不新加数据库字段 |
| `sources` / `related` | 同上，写入描述 | 见下方说明 |
| `created` / `updated` | 保留在文件里，不入库 | 入库用服务端时间，避免时钟依赖 |

> **与原稿的偏差（实现期修正）**：原设计打算把 `sources` / `related` 转成 `[[双链]]` 注入正文。
> 实做时发现这会造成**同步震荡**：注入后 DB 正文 ≠ 磁盘文件正文 → 下次同步判定为「本地变更」→
> 上传 → 覆盖 DB 正文（注入内容丢失）→ 再注入 …… 无限循环。
> 因此改为写入**笔记描述**（描述不参与内容比对），并剔除写回文件时的派生标签
> （`kb:` / `topic:` 前缀），保证「比对用的序列化」与「写回用的序列化」结果一致。
> 若知识页作者本人在正文里写了 `[[...]]`，反向链接面板照样生效。

> 读写一致性铁律：**比对与写回必须传入同一个 `preserve`（已存在文件的 frontmatter），
> 且使用同一组序列化选项**，否则每次同步都会判定为变更并重复上传。

---

## 6. 目录 → 笔记树映射

| KB 路径 | 笔记树 | 同步行为 |
|---|---|---|
| `wiki/concepts/出风口执行器.md` | `知识库/wiki/concepts/出风口执行器` | 双向（本地为准） |
| `wiki/entities/*.md` | 同名文件夹 | 双向（本地为准） |
| `raw/web/*.md` | `知识库/raw/web/*` | **只导入**（保护目录） |
| `raw/files/*.pdf` | — | 跳过（非支持的扩展名） |
| `templates/*.md` | — | 忽略 |
| `AGENTS.md` / `index.md` / `log.md` | — | 忽略 |
| `inbox/*.md` | `知识库/inbox/*` | 只导入（收件箱内容会变动，不写回） |

文件夹树以**本地为权威**：本地新建目录 → 上报为服务端文件夹；服务端 KB Root 子树下的文件夹在本地不存在 → **创建**（不删除任何本地目录）。

---

## 7. 代码级改动清单

### 7.1 新增 `frontend/src/services/sync/kbConfig.ts`（约 90 行）

- `KbConfig` 类型 + `KB_PRESET_IGNORE` / `KB_PRESET_PROTECT` 常量
- `loadKbConfig()` / `saveKbConfig()` / `clearKbConfig()`（localStorage，容错）
- `isIgnored(relPath, ignore)` / `isProtected(relPath, protect)` 两个纯函数（可单测）

### 7.2 `frontend/src/services/sync/folderAccess.ts`（改）

| 改动 | 说明 |
|---|---|
| `listAllFiles(root, baseRel, maxFiles, opts?)` | 新增 `opts.ignore` 谓词，跳过忽略项；点文件规则保留 |

### 7.3 `frontend/src/services/sync/syncEngine.ts`（改，主要工作量）

| 改动 | 说明 |
|---|---|
| `SyncDirection` 类型 | `'two-way' \| 'kb'` |
| `SyncOptions` | 新增 `direction?`、`kb?: { rootFolderId, ignore, protect }` |
| `SyncReport` | 新增 `direction`、`imported`、`skippedRemoteChanges`、`missingLocal`、`unlinkedLocal`、`blockedByProtection` |
| `runSync` 范围裁剪 | KB 模式下把远端笔记过滤到 KB Root 子树；`buildFolderPath` 结果去掉 KB Root 前缀 |
| `parseFrontmatter` | 改为**保序解析**，返回 `{ entries, unknown, body }` |
| `serializeNoteText` | 支持「保留已有 frontmatter 未知键」；`id` → `adn_id` |
| 新增 `importLocalFile` 动作 | D1：`noteApi.create` + 标签/双链映射 |
| `applyNoteAction` | KB 模式下 `remoteDelete` / `localDelete` → 只记录，不删；保护目录写回 → 只报告 |
| 冲突分支 | KB 模式下走 `upload`（本地优先），不生成 conflict 副本 |

### 7.4 `frontend/src/pages/settings/SyncSettingsPage.tsx`（改）

- 「同步模式」选择器：**双向镜像（默认）** / **知识库管理模式**
- 知识库模式展开：KB Root 文件夹选择（读现有文件夹树）、忽略清单编辑（含「填入知识库预设」按钮）、保护目录展示（只读）
- 报告面板：新增 `imported` / `missingLocal` / `unlinkedLocal` / `blockedByProtection` 四张卡片
- 同步说明区：按当前模式切换文案（明确写出「知识库模式下不会删除任何本地文件」）

### 7.5 `frontend/src/components/note/NoteListPanel.tsx`（改，小）

- KB Root 文件夹旁显示 `Database` 图标徽标 + tooltip「知识库管理文件夹」

### 7.6 文档

- `README.md`：本地同步章节增加「知识库管理模式」小节
- `docs/plans/README.md`：登记本方案

---

## 8. 红线（实现时必须守住）

对齐知识库 `AGENTS.md` 第 8 节：

1. **KB 模式下引擎永不调用 `removeEntry`**（即永不调用 `moveToTrash`），也不调用 `noteApi.delete`。
2. **永不覆盖本地存在未同步修改的文件**（D4 的前置条件是 `localHash === base.contentHash`）。
3. **保护目录只导入**，`raw/`、`templates/` 永不写回。
4. **破坏性动作前必须过 compare**：UI 上 `开始同步` 前自动跑一次 `compare`，把计划列清。
5. **知识库内容不外发**：KB Root 子树下的笔记在「发送到邮箱 / 分享」入口前加确认提示（对齐 KB 红线 5）。

---

## 9. 验收标准

| # | 场景 | 通过条件 |
|---|---|---|
| A1 | 空库 + KB Root 挂载 `~/Documents/KnowledgeBase`，compare | 报告列出 N 个待导入文件，**零写入**，忽略项不出现在任何列表里 |
| A2 | 执行 apply | 笔记树出现 `知识库/wiki/...` 结构；**本地文件 hash 与 mtime 全部不变** |
| A3 | 在 `wiki/` 下手工改一个页面的 `type` / `sources` 字段后重新同步 | DB 侧更新；**本地文件的 `type` / `sources` 原样保留**，未被抹掉 |
| A4 | 手工删除 `~/Documents/KnowledgeBase/wiki/xxx.md` 后同步 | 报告 `missingLocal` +1；**数据库笔记仍在**，可正常阅读 |
| A5 | 在应用内删除一篇已导入的笔记后同步 | 本地文件**仍在磁盘上**，报告 `unlinkedLocal` +1 |
| A6 | 在 `raw/` 下的页面里改内容后同步 | DB 更新；本地 `raw/` 文件**零改动** |
| A7 | 应用内新建一篇笔记到「知识库/wiki/topics」后同步 | 本地新增 `wiki/topics/标题.md`，且 frontmatter 是 KB 规范形态 |
| A8 | 非安全上下文 / 句柄丢失 | 提示重新绑定，不误判为「全部文件删除」 |
| A9 | `npm run type-check` | 零错误 |

A2 与 A3 是**最重要的两条**：它们直接证明「本地文件夹不可被删、不可被污染」这条需求成立。

---

## 10. 已知限制与分期

### v1 限制

- **单一绑定**：一个账号同时只能挂一个本地目录。若既要全量镜像又要挂知识库，需等 P1 的多挂载。
- **manifest 是映射表**：删除 `.aidrivenote/sync.json` 后，KB Root 子树会触发一轮"重新导入"，可能产生重复笔记（保护目录内无 `adn_id` 可回退）。恢复方式是按路径认领，UI 会提示。
- **`raw/` 下的 PDF / 图片不入库**：`parseLocalFile` 只处理 `.md` / `.json` / `.drawio`。要检索 PDF 需另接文档抽取（后端已有附件抽取能力可复用）。

### 分期

| 期 | 内容 |
|---|---|
| **P0（本方案）** | 引擎改造（方向 / 忽略 / 保护 / 导入 / 不删不覆盖）+ 设置页 UI + KB Root 打标 |
| P1 | 多挂载点、KB Root 徽标全局联动、Lint 体检对接（孤儿页 / 断链 / 无源断言） |
| P2 | 写回 KB schema 完整字段（`type` / `topic` / `confidence` 由 AI 推断）、「落库」动作编排、`raw/files` 文档抽取入库 |

---

## 11. 与 MCP 方案的关系

两条路**互补，不冲突**：

| 通道 | 方向 | 用途 |
|---|---|---|
| **本方案（同步引擎）** | 文件 ⇄ 笔记树 | 人读、人查、人在应用里增删 |
| **MCP Server** | Agent → 笔记 | Agent 完成一次咨询后，把结论直接写进笔记 |

MCP 的 `create_note` / `append_to_note` 与本方案的 D3 是同一件事的两种入口。**建议先上 P0**——引擎不改造，Agent 通过 MCP 写进去的笔记在下次同步时会被双向同步逻辑搅乱。

---

## 12. 实施记录（P0）

### 12.1 改了什么

| 文件 | 类型 | 说明 |
|---|---|---|
| `frontend/src/services/sync/kbConfig.ts` | 新增 | `KbConfig` 类型、`KB_PRESET_IGNORE` / `KB_PRESET_PROTECT`、localStorage 读写、`matchRules` / `isIgnored` / `isProtected`、`KB_CONFIG_EVENT` 变更广播 |
| `frontend/src/services/sync/folderAccess.ts` | 改 | `listAllFiles` 新增 `ignoreDir` / `ignoreFile` 谓词 |
| `frontend/src/services/sync/syncEngine.ts` | 改 | `SyncDirection`、`SyncOptions.direction/kb`、`SyncReport` 六项新计数、`planKbActions`、`importLocalNote`、`toScopedPath`、frontmatter 保序、`SerializeOptions`、`kbFileTags`、`kbDescriptionFromFrontmatter` |
| `frontend/src/pages/settings/SyncSettingsPage.tsx` | 改 | 同步模式选择、知识库根文件夹选择器、忽略/保护清单编辑、确认框、报告新计数与四条路径列表、模式化说明 |
| `frontend/src/components/note/NoteListPanel.tsx` | 改 | 知识库根文件夹 `Database` 徽标；快捷同步按模式传参并计入 `imported` |
| `README.md` / `docs/plans/README.md` | 改 | 新增「知识库管理模式」章节与索引 |

### 12.2 实现期发现并修掉的问题

| # | 问题 | 处理 |
|---|---|---|
| I1 | **比对与写回序列化不一致 → 无限上传**：写回用 `preserve` 保留未知键，比对不用，产出文本必然不同 | 两处传入同一个 `preserve` 与同一组选项 |
| I2 | **派生标签写回污染**：`kb:` / `topic:` 前缀标签会随写回进入文件 | 新增 `kbFileTags()`，写回前剔除 |
| I3 | **删除的本地文件被复活**：`missingLocal` 时丢掉基线，下次被当成「应用内新建」重新落盘 | 保留基线，并登记内容指纹 |
| I4 | **改名/搬走 → 重复导入**：路径变了就认不出 | 用内容 hash 认领（`missingHashClaims`） |
| I5 | **文件夹挂错父节点**：`resolveFolderId` 从账号根起算，KB 模式下会建到根目录 | 初始 `parentId` 改为 `ctx.kbRootId`；`executeFolderPlan` 同理 |
| I6 | **根文件夹丢失退化成全量同步**：`buildFolderPath` 返回空串时 `toScopedPath` 会放行全部笔记 | 显式判空并中止，报错提示重新指定 |
| I7 | **远端标题变化导致本地改名 → 旧文件被当新文件** | KB 模式忽略路径变化，一律原地更新 `base.relPath` |
| I8 | **规则无法区分根目录与深层同名文件** | 支持 `/` 首斜杠根锚定 |

### 12.3 验证结果

- `npx tsc --noEmit` —— 通过，零错误；
- `vite build` —— 通过（8332 模块，产物完整）；
- 运行期验证（A1–A9）需在浏览器中绑定真实知识库目录执行，见 §9。

