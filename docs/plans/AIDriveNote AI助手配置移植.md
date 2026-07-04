---
title: "AIDriveNote AI 助手配置移植"
cursor_plan: "aidrivenote_ai配置移植_e5715063.plan.md"
overview: "为 AIDriveNote 补齐 PLM 笔记 AI 的配置与设置能力：DB 驱动的模型/助手/会话/用户设置、笔记助手 seed、笔记技能绑定，并升级 AISidebar 与设置页。"
status: completed
synced_at: "2026-07-04"
---

> 由 Cursor Plan 同步。内部路径：`~/.cursor/plans/aidrivenote_ai配置移植_e5715063.plan.md`

# AIDriveNote AI 助手配置移植

## 实施摘要

已为 AIDriveNote 补齐 DB 驱动的 AI 平台（模型、助手、会话、用户设置、笔记技能），并升级前端 AISidebar 与设置页。

### 后端

| 组件 | 路径 |
|------|------|
| 迁移 | `backend/alembic/versions/002_ai_platform.py` |
| 模型 | `backend/app/models/ai/ai.py`（7 表） |
| Seed | `backend/app/services/ai/seed_service.py`（Ollama 模型 + 笔记助手 + 5 内置技能） |
| 服务 | `ai_service.py`、`llm_router.py`、`tool_executor.py`、`rag_service.py` |
| Provider | `backend/app/services/ai_providers/`（Ollama + 可选云 key 检测） |
| 技能 | `backend/app/services/ai_skills/skill_router.py` |
| API | `backend/app/routers/ai/platform.py` |

### 前端

| 路由 | 页面 |
|------|------|
| `/settings/ai` | `AISettingsPage` — 默认模型、侧栏宽度 |
| `/settings/ai/models` | `AIModelsPage` — 模型 CRUD + 连接测试 |
| `/settings/ai/assistants` | `AIAssistantsPage` — 助手编辑 + 技能 Tab |

- `frontend/src/services/ai/ai.ts` — AI API + SSE `chatStream`
- `frontend/src/components/ai/AISidebar.tsx` — 助手选择、会话历史、流式、快捷操作、确认卡片
- `NotesPage` — `setPageAIContext` 注册页面上下文

### 内置笔记技能（seed）

| code | 名称 |
|------|------|
| `note_read_summarize` | 读取并总结 |
| `note_continue` | 续写 |
| `note_optimize` | 优化润色 |
| `note_create` | 创建笔记 |
| `note_mindmap_expand` | 扩展导图 |

### 验收

1. `/settings/ai/models` 可添加 Ollama 模型并测试连接
2. 「笔记助手」含完整 system_prompt 与 12 个 note tools
3. AISidebar 可选助手、历史会话、SSE 流式
4. 用户默认模型在 `/settings/ai` 可保存
5. 笔记页快捷操作触发技能 + 工具链
6. `update_note`/`append_to_note` 经 NoteChangeConfirmCard 确认
7. `pytest` + `npm run build` 通过

### 与 PLM 关系

单向参考 PLM 代码并精简；PLM 笔记 AI 保持独立，不做改动。
