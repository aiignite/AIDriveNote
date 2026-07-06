---
title: "AI助手优化方案"
cursor_plan: "ai助手优化方案_b2b0a467.plan.md"
overview: "修复四种笔记类型 AI 能力断层，升级技能路由与 RAG，补齐前端配置接入，增加编辑器内 AI 入口"
status: completed
synced_at: "2026-07-06"
---

> 由 Cursor Plan 同步。内部路径：`~/.cursor/plans/ai助手优化方案_b2b0a467.plan.md`

## 实施摘要

### P0 — 类型能力闭环
- `note_tools.py`：mindmap/flowchart 内容预览更新、`append_to_mindmap`、`get_note` 摘要模式
- `rich_text_blocks.py`：导图树形 / 流程图节点列表预览
- 前端：`NotesPage` 动态快捷操作、`NoteChangeConfirmCard` 结构化预览

### P1 — 技能与 RAG
- `SkillRouter`：noteType 加权、AssistantSkillBinding、激活技能 SSE
- `RagService`：当前笔记优先 + 混合检索 + 引用标记
- 前端：技能 badge、`recommendedAssistant`、侧栏宽度、会话模型选择

### P2 — 编辑器集成
- `EditorAIButton` + `useAIChat` hook
- 行内选区 AI（润色/续写/翻译/总结）
- `⌘J` 打开 AI 侧栏

### P2 — 语义 RAG
- `content_embedding` JSONB 列 + `EmbeddingService`（Ollama embeddings）
- 笔记更新时异步生成 embedding

### P3 — 平台可靠性
- `delete_note` 确认预览
- OpenAI 兼容 Provider
- `tool_calls` 持久化、`MAX_TOOL_ROUNDS=5`
- `batch_summarize_notes` / `batch_add_tags` 批量工具
