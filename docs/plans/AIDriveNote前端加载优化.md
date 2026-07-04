---
title: "AIDriveNote 前端加载优化"
overview: "针对生产环境首屏 40–70s 白屏，通过 gzip、路由懒加载、编辑器按需加载降低传输体积与解析成本"
status: completed
synced_at: "2026-07-05"
---

> 生产部署优化方案，2026-07-05 实施。

## 问题诊断

| 指标 | 优化前 |
|------|--------|
| 首屏 JS（未压缩） | ~4.1 MB |
| 首屏 JS（gzip 估算） | ~1.25 MB |
| 外网下载耗时 | 40–70s |
| nginx gzip | 未开启 |
| 路由代码分割 | 无（登录页也加载 BlockNote） |

根因：**低带宽（~55 KB/s）× 大体积未压缩 JS × 无代码分割**。

## 优化方案

### P0 — nginx 传输层

`frontend/nginx.conf`：

- 开启 `gzip`（JS/CSS/JSON/SVG）
- `/assets/` 长期缓存 `Cache-Control: public, immutable`

预期：同等体积下传输时间约 **×0.3**。

### P1 — 路由懒加载

`App.tsx` 使用 `React.lazy` + `Suspense`：

- 登录/注册、NotesPage、AppLayout、AI 设置子页独立 chunk
- 通用 `PageLoader` 作为 fallback

预期：登录首屏 JS gzip **~100 KB**（原 ~1.25 MB）。

### P2 — 功能按需加载

| 模块 | 策略 |
|------|------|
| AISidebar | AppLayout 内 lazy |
| 四类编辑器 | NoteEditorContainer 按 `note_type` lazy |
| 笔记导出 | `getExportOptions` 轻量独立；`exportNote` 点击时 dynamic import |

### P3 — 构建分包

`vite.config.ts` 仅保留 `vendor-react` 独立 chunk；**勿**将 BlockNote 强行打入 manualChunks（会导致入口误引用）。

## 优化后构建产物（参考）

| 场景 | 主要 chunk | gzip 约 |
|------|-----------|---------|
| 登录页 | entry + vendor-react + LoginPage | ~100 KB |
| 笔记列表 | + NotesPage | +18 KB |
| 富文本编辑 | + NoteRichTextEditor | +314 KB（打开时） |
| 导出 PDF | + noteExport | +231 KB（点击时） |

## 部署

```bash
cd ~/AIDriveNote && ./deploy.sh
```

## 后续可选

- 服务器升级带宽或 CDN
- 腾讯云安全组确认 3270 已放行
- Brotli 预压缩静态资源
