---
title: "AIDriveNote 块引用技术验证（Spike）"
overview: "评估在 BlockNote 富文本与 Markdown 笔记中实现块级引用 ((block-id)) / 嵌入的技术路径、工作量与风险，并给出 go/no-go 结论与分阶段落地建议。"
status: spike-completed
synced_at: "2026-10-28"
---

# 块引用技术验证（Spike）

> 对应《[产品优化方案 v2](./AIDriveNote-产品优化方案-v2.md)》P2-3。本文件是**技术验证与决策记录**，不是实现承诺。

## 一、验证目标

1. 能不能给块分配**稳定 ID**（跨编辑、跨导出、跨同步不变）？
2. 能不能在不破坏现有 `[[标题]]` 双链的前提下，支持 `((block-id))` 引用与 `!((block-id))` 嵌入？
3. 编辑器的自定义节点能力是否够用，升级 BlockNote 的兼容风险多大？
4. 两周内能否做出可演示版本？

## 二、代码事实（验证依据）

| 事实 | 位置 | 影响 |
|------|------|------|
| 富文本以 BlockNote blocks JSONB 存储 | `backend/app/models/note/note.py:69` | 块结构可直接扩展字段 |
| 持久化前会剥离自定义 id | `services/note/rich_text_blocks.py:85-112`（`normalize_block`） | 当前块 id 不稳定，必须改为保真或重新生成 |
| Wiki 链接只解析文档级 `[[标题]]` | `services/note/link_parser.py:9-30` | `((...))` 需要新的解析器与链接表字段 |
| 反链表为 `source_id/target_id/link_text` | `models/note/note.py:242-260` | 扩展 `block_id`/`is_embed` 需要迁移 |
| Markdown 预览用 rehype-slug 生成标题锚点 | `frontend/src/components/note/NoteMarkdownEditor.tsx:23` | 标题级引用成本低，段落级需要内容哈希 |
| 块引用跳转已有基础 | `GET /notes/{id}?chunk=` + 编辑器定位 | 可复用引用定位横幅机制 |

## 三、两条候选路径

### 路径 A：块锚点（低成本，推荐先做）

- **富文本**：保存时给每个 block 写入 `props.blockId`（不存在则生成 `blk_` + 8 位随机），`normalize_block` 改为保留该字段；编辑器渲染时输出 `data-block-id`。
- **Markdown**：标题沿用 rehype-slug 的 slug；段落/列表用 `blk_ + sha1(内容).slice(0,8)`，内容变化即锚点失效（符合 Roam 语义）。
- **语法**：`((blk_xxxxxxxx))`；解析器写入 `note_links(block_id, is_embed)`。
- **UI**：反链面板按块展示；点击滚动到 `[data-block-id]` 并短暂高亮。
- **工作量**：3–5 人日（含迁移与测试）。

### 路径 B：自定义内联节点 + 嵌入（高成本）

- BlockNote 自定义 inline content spec，渲染可编辑的块引用 chip；
- `!((id))` 拉取目标块并内联渲染（需防循环嵌入，深度 ≤2）；
- 导出 Markdown/HTML 时还原为 `((id))`；
- **工作量**：8–12 人日，且依赖 BlockNote 版本升级与自定义 schema 稳定性。

## 四、Spike 结论

- **Go（路径 A）**：块锚点方案与现有 JSONB 存储、反链表、引用定位机制兼容，无需改动编辑器内核；建议在 P2 先做 3–5 人日版本。
- **Hold（路径 B）**：自定义 inline node 需要 BlockNote schema 深度定制，升级风险高；在路径 A 上线并收集真实使用数据后再评估。
- **No-Go（当前）**：不做"任意块实时双向同步编辑"（接近 CRDT 语义），与现有 REST + 修订模型冲突。

## 五、风险与缓解

| 风险 | 缓解 |
|------|------|
| 块 ID 在复制/粘贴/导入时丢失 | 加载时按内容哈希补齐；导入器写入新 ID |
| Markdown 内容变化导致锚点失效 | 引用显示"原文已变更"，保留引用文本快照 |
| 同步/导出丢失自定义字段 | 导出保留 frontmatter/JSON 自定义键；同步按原格式写入 |
| 循环嵌入 | 渲染层限制深度 + 环检测 |
| BlockNote 升级破坏 props | 把 `blockId` 放进 props 白名单并加升级回归测试 |

## 六、验收标准（若进入实现）

1. 富文本与 Markdown 各 20 条块引用用例，创建/展示/跳转全部通过；
2. 复制粘贴、导入导出、本地同步后引用仍可解析；
3. 块被删除时反链显示"目标已删除"而不是静默消失；
4. 不回归现有 `[[标题]]` 双链与反链测试（当前 264 项后端测试全绿）。
