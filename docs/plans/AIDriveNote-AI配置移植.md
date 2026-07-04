---
title: "AIDriveNote AI 配置移植"
cursor_plan: "aidrivenote_ai配置移植_e5715063.plan.md"
overview: "笔记专用 AI 平台：模型/助手/设置/会话/技能 + 笔记助手 seed"
status: completed
synced_at: "2026-07-04"
---

> 由 Cursor Plan 同步。

## 已完成

### 后端

- 迁移 `002_ai_platform`：`ai_models`、`ai_assistants`、`ai_conversations`、`ai_messages`、`user_ai_settings`、`ai_skills`、绑定表
- `AISeedService`：Ollama 默认模型 + 「笔记助手」+ 5 内置笔记技能
- `ai_providers`（Ollama）+ `llm_router` + `ai_service` + `tool_executor` + `SkillRouter`
- API：`/ai/models`、`/assistants`、`/settings`、`/conversations`、`/chat/stream`、`/tools/registry`、`/skills`、page/assistant 技能绑定

### 前端

- `services/ai/ai.ts`
- `/settings/ai`、`/settings/ai/models`、`/settings/ai/assistants`
- `AISidebar`：助手选择、SSE 流式、会话历史、NoteChangeConfirmCard
- `NotesPage`：pageContext + 快捷操作

### 内置笔记技能

| code | 名称 |
|------|------|
| `note_read_summarize` | 读取并总结 |
| `note_continue` | 续写 |
| `note_optimize` | 优化润色 |
| `note_create` | 创建笔记 |
| `note_mindmap_expand` | 扩展导图 |

## 验收

- `pytest` 24 passed
- `npm run build` 通过
- Alembic head: `002_ai_platform`
