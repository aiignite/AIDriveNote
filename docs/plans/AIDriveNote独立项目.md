---
title: "AIDriveNote 独立项目"
cursor_plan: "笔记功能独立项目_cf687631.plan.md"
overview: "从 AIIgnite PLM 提取 NOTE 模块为独立 SaaS AIDriveNote，本地 PG ai_drive_note:5432"
status: completed
synced_at: "2026-07-04"
---

> 代码路径：`/Users/wyh/Documents/AIDriveAll/AIDriveNote`

## 实施结果

- **后端**：9 张 note 表 + users + JWT + Alembic `001_initial` / `002_ai_platform`
- **前端**：React 19 + 8 编辑器 + Login/Notes + AI 设置三页
- **AI 平台**：模型/助手/设置/会话/技能 + 「笔记助手」seed + RAG + SSE + 确认流
- **测试**：24 pytest 通过；`npm run build` 通过
- **数据库**：`postgresql://...@localhost:5432/ai_drive_note`
- **端口**：前端 3270 / 后端 3275

## 启动

```bash
cd backend && uvicorn app.main:app --reload --port 3275
cd frontend && npm run dev
```

## AI 配置入口

| 页面 | 路径 |
|------|------|
| AI 设置 | `/settings/ai` |
| 模型管理 | `/settings/ai/models` |
| 助手管理 | `/settings/ai/assistants` |

## 与 PLM 关系

PLM **保留**完整笔记功能；AIDriveNote 为独立产品，两者并行维护。

## Phase 2 待办

- pgvector 语义搜索
- 知识图谱 UI
- Slash inline AI
