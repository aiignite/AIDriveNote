# Gemini 每日邮件摘要 → AIDriveNote「Mails」文件夹

> 完整方案（含 Gemini 定时任务、Gmail 过滤器、AIDriveNote 设置、接口契约、运维与排障）见
> [《AIDriveNote × Gemini × Gmail 每日邮件摘要接入方案》](../../docs/guides/AIDriveNote-Gemini-Gmail邮件摘要接入方案.md)。
> 本文只保留最短的上手步骤。

Gemini 的定时任务不支持 MCP，但会发邮件。这里用 **Gmail 标签 + Google Apps Script** 把邮件内容通过 AIDriveNote 的 `/clip` 接口归档到指定文件夹。

## 一、准备

1. 在 AIDriveNote「设置 → 访问令牌」新建令牌，勾选 **写入**。
2. 在 Gmail 建过滤器：Gemini 日报邮件 → 打标签 `GeminiDaily`（标签名可自定义）。
3. 确认后端已部署包含 `folderName` 支持的版本，且 `/clip` 可访问：
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST \
     https://www.aiignite.com.cn/note/api/v1/clip
   # 401 = 路由存在；404 = 还没部署
   ```

## 二、创建 Apps Script

1. 打开 <https://script.google.com> → 新建项目。
2. 把 `Code.gs` 的内容粘贴进去。
3. 项目设置 → **脚本属性**，添加：

| 属性 | 值 |
|------|----|
| `ADN_TOKEN` | 你的 `adn_...` 令牌（勾选写入） |
| `ADN_API_URL` | `https://www.aiignite.com.cn/note/api/v1/clip` |
| `GMAIL_LABEL` | `GeminiDaily`（可选） |
| `NOTE_FOLDER` | `Mails`（可选，默认就是 Mails） |
| `NOTE_TITLE` | `Gemini 每日邮件摘要`（可选，追加目标标题） |

4. 先手动运行一次 `syncGeminiDigest`，在「执行记录」里确认返回 `{"noteId": "...", "title": "..."}`。
5. 添加触发器：`syncGeminiDigest`，时间驱动，每天一次，时间设在 Gemini 任务之后 10–30 分钟。
6. 首次运行会申请 Gmail / 网络访问权限，按提示授权。

## 三、行为说明

- 邮件正文写入 Markdown 笔记，标题取邮件主题，末尾附 Gmail 链接。
- `folderName: "Mails"`：根级不存在同名文件夹会自动创建，存在则复用。
- **`mode: "append"` + `noteTitle`**：所有日报追加到同一篇《Gemini 每日邮件摘要》，按日期分节，**不会每天新建笔记**，避免撞上 `USER_MAX_NOTES` 配额。
- 首次执行会创建目标笔记；若账号已达笔记上限，会返回 `400 笔记数量已达上限`，需要先清空回收站/删除部分笔记，或调大 `USER_MAX_NOTES`。
- 同一封邮件只处理一次：脚本用 `lastMessageId` 去重；重跑不会重复追加。
- 标签默认 `Gmail摘要`、`AI日报`，可在 `Code.gs` 的 `DEFAULTS.tags` 修改；追加模式不会重复加标签。

## 四、按文件夹 ID 精确归档（可选）

若已有多层文件夹，建议改用 `folderId`（在笔记 URL/接口中获取），比名称更稳：

```js
payload: JSON.stringify({
  title: msg.getSubject(),
  text,
  folderId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  tags: ['Gmail摘要'],
})
```

`folderId` 优先于 `folderName`，且会校验文件夹归属，防止越权写入。
