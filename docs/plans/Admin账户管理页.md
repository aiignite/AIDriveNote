---
title: "Admin 账户管理页"
cursor_plan: "admin_账户管理页_5c09474f.plan.md"
overview: "为 AIDriveNote 增加用户角色体系（user/admin），提供 Admin 专用的用户列表与编辑 API，并在前端新增仅 Admin 可访问的账户管理页；通过环境变量 ADMIN_EMAIL 自动授予首个管理员权限。"
status: completed
synced_at: "2026-07-05"
---

> 由 Cursor Plan 同步。内部路径：`~/.cursor/plans/admin_账户管理页_5c09474f.plan.md`

# Admin 账户管理页

## 范围

| 项 | 决策 |
|----|------|
| Admin 操作 | 查看用户列表；编辑姓名、状态（Active/Inactive）、角色（user/admin） |
| 不含 | 创建用户、删除用户、重置密码 |
| 首个 Admin | 环境变量 `ADMIN_EMAIL`，启动时 + 注册时自动赋权 |

## 后端

- `users.role` 字段（`user` / `admin`），迁移 `004_user_role.py`
- `get_current_admin` 权限依赖
- `GET/PATCH /api/v1/admin/users` 管理 API
- `AdminBootstrap` 启动时按 `ADMIN_EMAIL` 赋权
- 业务规则：禁止自禁用、禁止自降级、禁止降级末位 admin

## 前端

- 路由 `/admin/users`（`ProtectedRoute` + `AdminRoute`）
- `UsersPage` 用户列表与编辑弹窗
- Header 中 admin 可见「账户管理」入口（Users 图标）

## 部署

1. `alembic upgrade head`
2. `.env` 设置 `ADMIN_EMAIL=your@email.com`
3. 重启后端，Admin 登录后访问 `/admin/users`

## 后续可扩展

- 禁用公开注册、Admin 创建用户、重置密码
- AI 平台配置限制为 Admin 专用
- 审计日志
