# 设计方案索引（Plans）

本目录与 Cursor Plan 同步。

## 方案列表

| 标题 | 状态 | 同步日期 | 说明 |
|------|------|----------|------|
| [AIDriveNote独立项目](./AIDriveNote独立项目.md) | completed | 2026-07-04 | 笔记模块独立产品 |
| [AIDriveNote AI 配置移植](./AIDriveNote-AI配置移植.md) | completed | 2026-07-04 | AI 模型/助手/技能平台 |
| [AIDriveNote AI助手配置移植](./AIDriveNote%20AI助手配置移植.md) | completed | 2026-07-04 | DB 驱动 AI 平台 + 设置页 + AISidebar 升级 |
| [AIDriveNote 前端加载优化](./AIDriveNote前端加载优化.md) | completed | 2026-07-05 | gzip + 路由懒加载 + 编辑器按需加载 |
| [Admin 账户管理页](./Admin账户管理页.md) | completed | 2026-07-05 | 用户角色体系 + Admin 用户管理页 |
| [笔记原格式批量导出](./笔记原格式批量导出.md) | completed | 2026-07-06 | 全部笔记原格式导出，保留文件夹层级 |
| [AI助手优化方案](./AI助手优化方案.md) | completed | 2026-07-06 | 笔记类型 AI 能力、技能路由、RAG、编辑器 AI 入口 |
| [笔记MCP集成方案](../../.trae/documents/笔记MCP集成方案.md) | completed | 2026-10-01 | PAT 认证 + 访问令牌页 + mcp-server 独立包 |
| [AIDriveNote 优化方向分析](./AIDriveNote-优化方向分析.md) | draft | 2026-10-06 | 工程层：架构、性能、安全、CI 门禁 |
| [AIDriveNote 全量优化方案](./AIDriveNote-全量优化方案.md) | draft | 2026-10-06 | 会话起草稿：现状/差距诊断 + 五项系统级优化 + 路线图 |
| [AIDriveNote 产品能力演进方案](./AIDriveNote-产品能力演进方案.md) | draft | 2026-10-06 | **代码核实版**：13 项新发现缺陷 + 块级双链/图谱/画布/属性/CRDT/Graph-RAG 分级方案 |
| [AIDriveNote 产品优化方案 v2](./AIDriveNote-产品优化方案-v2.md) | draft | 2026-10-27 | **代码核实版**：对标 Notion/Obsidian/Reflect；RAG v2（分块+pgvector+引用契约）、AI 写作现场化（选区工具条/相关笔记/引用溯源）、MCP 双向平台化、笔记 URL/全局搜索/快速捕获、KB 2.0，含 P0/P1/P2 路线图 |
| [AIDriveNote 产品优化方案 v2 · 实施与差距](./AIDriveNote-产品优化方案-v2-实施与差距.md) | implemented-p0-p2 | 2026-10-28 | **实施记录**：P0/P1/P2 全部任务落地（块引用为 spike 结论）；275 后端测试 + 8 前端单测 + 真实 PG/pgvector + 浏览器 E2E 通过；差距与补差设计 |
| [AIDriveNote 块引用技术验证](./AIDriveNote-块引用技术验证.md) | spike-completed | 2026-10-28 | BlockNote 块锚点 vs 自定义内联节点：Go/Hold/No-Go 结论与分阶段落地建议 |
| [AIDriveNote 知识库管理模式方案](./AIDriveNote-知识库管理模式方案.md) | P0 implemented | 2026-10-26 | **代码核实版**：7 项同步冲突（含 2 处数据丢失）+ 知识库根文件夹模型 + 忽略/保护目录 + 单向导入与不删不覆盖规则 |
