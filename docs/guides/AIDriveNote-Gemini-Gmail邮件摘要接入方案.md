# AIDriveNote × Gemini × Gmail 每日邮件摘要接入方案

> 版本：v1.0 ｜ 更新日期：2026-10-28 ｜ 适用部署：`https://www.aiignite.com.cn/note/`
>
> 目标：Gemini 每天定时整理 Gmail 并发送摘要邮件，AIDriveNote 自动把邮件正文归档到 **Mails** 文件夹下的《Gemini 每日邮件摘要》，按日期追加，不重复、不消耗额外笔记配额。

---

## 一、方案概述

Gemini 的定时任务不支持 MCP，但它可以把结果发到 Gmail。因此本方案把 **Gmail 作为集成总线**：

```
Gemini 定时任务
      │ 每天生成摘要并发送邮件
      ▼
Gmail 收件箱 ──► Gmail 过滤器打标签 GeminiDaily
      │
      ▼
Google Apps Script（每天定时）
      │ 读取带标签的邮件 → 提取正文 → 调 AIDriveNote /clip
      ▼
AIDriveNote /api/v1/clip
      │ mode=append + noteTitle
      ▼
Mails/Gemini 每日邮件摘要（同一篇，按日期追加）
```

各部分职责：

| 组件 | 职责 |
|------|------|
| Gemini 定时任务 | 按固定提示词生成摘要邮件 |
| Gmail | 接收邮件，用过滤器打标签，作为触发源 |
| Google Apps Script | 读取邮件、去重、调用 AIDriveNote 接口 |
| AIDriveNote 后端 | 校验令牌、写入/追加笔记、归档文件夹 |
| AIDriveNote 前端 | 阅读、搜索、AI 问答 |

---

## 二、前置条件

1. AIDriveNote 已部署，且后端包含 `/api/v1/clip` 路由（本次已部署）。
2. 你的账号可以登录 `https://www.aiignite.com.cn/note/`。
3. 你的 Google 账号可以使用：
   - Gemini 定时任务（Scheduled actions / Scheduled tasks，视账号版本）；
   - Gmail；
   - Google Apps Script（`script.google.com`）。
4. 你能创建一个 AIDriveNote 访问令牌（需要「写入」权限）。

验证后端是否就绪（返回 401 表示路由存在，404 表示尚未部署）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://www.aiignite.com.cn/note/api/v1/clip
```

---

## 三、AIDriveNote 端配置

### 3.1 健康检查

```bash
curl -s https://www.aiignite.com.cn/note/health
# {"status":"ok","app":"AIDriveNote"}
```

### 3.2 创建写入令牌

1. 进入「设置 → 访问令牌」。
2. 新建令牌，名称建议 `Gemini Digest`。
3. **勾选「写入」**（`/clip` 需要 write scope；只读令牌会返回 403）。
4. 复制 `adn_...` 明文令牌（只显示一次）。
5. 把令牌填到 Apps Script 顶部 `ADN_TOKEN`，不要发到聊天、仓库或截图里。
6. 若令牌曾泄露，立即在本页撤销并重新生成。

### 3.3 Mails 文件夹

- 不需要手动创建：`/clip` 收到 `folderName: "Mails"` 时会自动在**根级**创建同名文件夹，存在则复用。
- 如果需要放进 `Archive/Mails` 这类子目录，请改用 `folderId`（见 3.5）。
- 文件夹名称按名称精确匹配（**区分大小写**）；重名只会取最早创建的一个。

### 3.4 笔记配额

- 生产 `.env`：`USER_MAX_NOTES=1000`（已配置并部署）。
- 匿名账号使用独立的 `GUEST_MAX_NOTES=50`。
- 配额**包含回收站**；达到上限时 `/clip` 返回：

```json
{"detail":"笔记数量已达上限（1000 篇，含回收站），请先删除或清理部分笔记"}
```

- 采用 `mode=append` 后，日报只占 1 篇笔记，不会每天消耗配额。

### 3.5 `/clip` 接口契约

`POST /api/v1/clip`，需要 `Authorization: Bearer <token>`。

| 字段 | 必填 | 说明 |
|------|------|------|
| `text` | 是 | 正文，1–200,000 字符 |
| `title` | 否 | 邮件主题；创建新笔记时作为候选标题 |
| `url` | 否 | 来源链接，写入正文末尾 |
| `tags` | 否 | 标签数组，最多取前 5 个；**仅新建时应用** |
| `folderId` | 否 | 目标文件夹 UUID，优先级最高；会校验归属 |
| `folderName` | 否 | 根级文件夹名称，不存在则按 `createFolder` 创建 |
| `createFolder` | 否 | 默认 `true` |
| `mode` | 否 | `new`（默认）/ `append` / `daily` |
| `noteId` | 否 | `append` 模式的目标笔记 ID（优先于 `noteTitle`） |
| `noteTitle` | 否 | `append` 模式按标题精确匹配（不区分大小写） |

响应：

```json
{"noteId":"…","title":"Gemini 每日邮件摘要","mode":"append"}
```

三种模式：

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `new` | 每次新建一篇 | 一次性剪藏、测试 |
| `append` | 追加到 `noteId`/`noteTitle` 指定笔记；不存在则新建 | **每日日报（推荐）** |
| `daily` | 追加到当天「每日笔记」 | 希望和当日日记合并 |

追加内容格式：

```
---

## 2026-10-28 09:32

<邮件正文>

> 来源：<https://mail.google.com/...>
```

---

## 四、Gemini 定时任务配置

> 不同账号的入口名称可能是「定时任务 / Scheduled actions / Scheduled tasks」，以实际界面为准。

### 4.1 任务目标

每天固定时间整理过去 24 小时的 Gmail，生成中文摘要，并发送到你的邮箱。

### 4.2 提示词模板（建议直接使用）

```text
你是我的邮件整理助手。请整理我 Gmail 中过去 24 小时收到的邮件，
生成一份中文摘要，并发送到邮箱：<你的邮箱地址>。

格式要求：
1. 邮件主题固定为：每日邮件整理 YYYY-MM-DD 邮件摘要
2. 正文使用纯文本 Markdown，不要使用 HTML、不要内联图片；
   图标一律用 emoji 文本代替（例如 🚨 📋 🏭）。
3. 结构：
   # 每日邮件整理
   ## 重点关注与待办事项
   - [ ] 事项（截止时间 / 负责人）
   ## 项目研发与工程试制
   - 事项
   ## 其他
4. 只保留有行动项、风险、节点或决策的信息；没有内容的模块可以省略。
5. 不要编造邮件中不存在的信息。
```

### 4.3 频率与时间

- 频率：每天 1 次。
- 时间：建议 09:00 左右（Apps Script 触发器设在 09:30，留出投递时间）。
- 收件人：你自己的 Gmail。
- 主题：务必保持固定前缀 `每日邮件整理`，Gmail 过滤器依赖它。

### 4.4 验证

任务执行后，在 Gmail 中确认收到主题类似：

```
每日邮件整理 2026-10-28 邮件摘要
```

记录发件人地址（如果有固定发件人），后续过滤器可以加上发件人条件。

> 若 Gemini 仍然发送 HTML 富文本，邮件正文里的标题/列表符号可能被渲染掉。此时优先调整提示词（要求纯文本 Markdown）；后端 HTML→Markdown 转换属于后续优化项（见第十二节）。

---

## 五、Gmail 配置

### 5.1 创建标签

Gmail → 左侧标签列表 → 「创建新标签」→ 名称 `GeminiDaily`。

### 5.2 创建过滤器

Gmail → 设置（齿轮）→ 查看所有设置 → 过滤器和已封锁地址 → 创建新过滤器。

条件（任选其一，推荐主题匹配）：

- 主题包含：`每日邮件整理`
- 或：发件人 = Gemini 的固定发件地址

操作：

- ☑ 应用标签：`GeminiDaily`
- ☑ 永不发送到垃圾邮件
- ☐ 跳过收件箱（可选；勾选后日报不干扰收件箱）

保存后，用一条测试邮件确认标签已自动打上。

### 5.3 时区

Apps Script 的触发器按**项目时区**执行：

Apps Script 编辑器 → 项目设置 → 时区 → `Asia/Shanghai`。

---

## 六、Google Apps Script 配置

完整脚本见附录 A，也可直接复制
[`integrations/gmail-gemini-clip/Code.gs`](../../integrations/gmail-gemini-clip/Code.gs)。

### 6.1 创建项目

1. 打开 <https://script.google.com> → 新建项目。
2. 删除默认代码，粘贴附录 A 全文。
3. 把顶部的占位符替换成真实令牌：

```js
const ADN_TOKEN = 'adn_在这里粘贴你的令牌';
```

4. 保存（Ctrl/Cmd + S）。

### 6.2 可选脚本属性

项目设置 → 脚本属性（不填则使用默认值）：

| 属性 | 默认值 | 说明 |
|------|--------|------|
| `GMAIL_LABEL` | `GeminiDaily` | Gmail 标签名 |
| `GMAIL_QUERY` | `label:"GeminiDaily" newer_than:2d` | 自定义 Gmail 搜索语句（优先级最高） |
| `NOTE_FOLDER` | `Mails` | 目标文件夹（根级） |
| `NOTE_TITLE` | `Gemini 每日邮件摘要` | 追加目标标题 |

> 令牌不再从脚本属性读取，直接使用脚本顶部常量。

### 6.3 连通性测试

在编辑器中选择 `testApiConnection` → 运行 → 首次会请求授权（Gmail 读取、外部请求），允许后查看执行记录：

```
HTTP 状态码: 200
服务器响应: {"noteId":"…","title":"【连通性测试】Gemini 邮件同步","mode":"new"}
```

测试会在 Mails 下新建一篇测试笔记，确认后可手动删除。

### 6.4 首次同步

选择 `syncGeminiDigest` → 运行。

- 默认查询最近 2 天的邮件；
- 第一次会在 Mails 下创建《Gemini 每日邮件摘要》，返回 `"mode":"new"`；
- 之后每天追加到同一篇，返回 `"mode":"append"`；
- 执行日志会输出成功/跳过/失败数量。

### 6.5 创建每日触发器

选择 `createDailyTrigger` → 运行，日志出现：

```
已创建每日 09:30 的 syncGeminiDigest 触发器
```

也可在左侧「触发器」页面手动确认：`syncGeminiDigest`，时间驱动，每天 09:30。

### 6.6 首次授权范围

- Gmail：读取邮件与标签（`GmailApp.search`）；
- 外部请求：访问 AIDriveNote `/clip`；
- 脚本属性：保存去重记录。

---

## 七、运行行为与数据模型

| 项目 | 行为 |
|------|------|
| 目标文件夹 | `Mails`（根级；不存在自动创建） |
| 目标笔记 | 标题 `Gemini 每日邮件摘要`（可通过 `NOTE_TITLE` 修改） |
| 首次运行 | 创建目标笔记，`mode=new` |
| 后续运行 | 追加到同一篇，`mode=append` |
| 分节 | 每次追加 `---` + `## 日期` + 正文 + 来源链接 |
| 去重 | 按 Gmail Message-ID，记录最近 200 封；成功一封立即落盘 |
| 空正文 | 记录并跳过，不调用接口，不阻塞后续邮件 |
| 单封失败 | 记录错误，继续处理其他邮件；结束后统一抛错 |
| 标签 | 仅新建笔记时应用；追加模式不重复加标签 |
| 查询范围 | 默认 `label:"GeminiDaily" newer_than:2d` |
| 正文上限 | 180,000 字符（超出截断） |

---

## 八、运维手册

### 8.1 日常检查

- AIDriveNote：Mails 文件夹中《Gemini 每日邮件摘要》最后一条日期是否为今天；
- Apps Script：左侧「执行」页面查看最近一次是否成功；
- Gmail：标签 `GeminiDaily` 下是否有未处理的日报。

### 8.2 修改目标文件夹 / 标题

- 修改脚本属性 `NOTE_FOLDER` / `NOTE_TITLE`；
- 修改 `NOTE_TITLE` 后，下次运行会创建一篇新笔记（旧的保留，不会自动迁移）。

### 8.3 补同步历史邮件

1. 临时设置脚本属性 `GMAIL_QUERY=label:"GeminiDaily" newer_than:7d`；
2. 运行 `syncGeminiDigest`；
3. 完成后删除该属性，恢复默认查询。

> 去重记录只保留 Message-ID；补同步期间已处理过的邮件不会重复追加。

### 8.4 令牌轮换

1. AIDriveNote 新建令牌并勾选写入；
2. 修改脚本顶部 `ADN_TOKEN`，保存；
3. 运行 `testApiConnection` 确认 200；
4. 回到 AIDriveNote 撤销旧令牌。

### 8.5 重置去重记录

仅在调试时使用：

```js
resetProcessed()
```

执行后最近 2 天的邮件会被重新追加（可能产生重复内容）。

---

## 九、故障排查

| 现象 | 原因 | 处理 |
|------|------|------|
| `404 {"detail":"Not Found"}` | 后端未部署 `/clip` 或 URL 错误 | 检查 `POST /note/api/v1/clip` 是否返回 401 而非 404；必要时重新部署 |
| `401 Could not validate credentials` | 令牌错误、被撤销、含空格、未复制完整 | 重新复制新令牌；确认没有多余空格 |
| `403 当前访问令牌只有只读权限` | 令牌未勾选「写入」 | 重新生成令牌并勾选写入 |
| `400 笔记数量已达上限（1000 篇，含回收站）` | 配额满 | 清空回收站/删除笔记，或调大 `USER_MAX_NOTES` |
| `400 剪藏内容不能为空` | 邮件正文为空 | 脚本已自动跳过；自写脚本需先判空 |
| `422` | `text` 缺失或字段名错误 | 检查请求体为 `application/json` 且包含 `text` |
| 笔记建在根目录，不在 Mails | `folderName` 未传/名称不匹配 | 确认 `folderName: "Mails"`；多层目录改用 `folderId` |
| 每天新建一篇 | 未传 `mode` / `noteTitle`，或标题不精确 | 使用 `mode:"append"` + 固定 `noteTitle` |
| 同一封邮件重复追加 | 去重记录被清空，或复制了新的 Apps Script 项目 | 检查 `processedMessageIds`；避免多个项目同时运行 |
| Gmail 搜索不到邮件 | 标签名不一致、过滤器未生效 | 在 Gmail 搜索框手动执行 `label:GeminiDaily` 验证 |
| 触发器不执行 | 时区错误、触发器被禁用、授权失效 | 检查项目时区与「触发器」页面；重新授权 |
| 邮件格式在笔记中丢失 | 脚本使用 `getPlainBody()`，HTML 结构被抹平 | 按第四节提示词要求 Gemini 输出纯文本 Markdown；见第十二节优化路线 |

---

## 十、安全与隐私

1. **令牌等同密码**：脚本顶部的 `ADN_TOKEN` 可创建/修改笔记；项目保持私有，不要分享、截图或提交到仓库。
2. 怀疑泄露时立即在「设置 → 访问令牌」撤销，并更新脚本常量。
3. 令牌使用 HTTPS Header 传输，不会出现在 URL 或日志中。
4. Apps Script 会获得 Gmail 读取权限；请只在自己信任的 Google 账号下部署。
5. 执行日志包含邮件主题（不含完整正文）；分享日志前请自行检查。
6. 聚合笔记中包含工作邮件内容，建议为该笔记开启访问控制（加密或仅本人可见）。

---

## 十一、已知限制

1. **HTML 格式丢失**：当前脚本优先使用 `getPlainBody()`，标题层级、颜色、加粗、列表符号可能被抹平；通过 Gemini 提示词输出 Markdown 可解决大部分问题。
2. **内联图片（cid:）无法显示**：邮件里的图标/图片属于 Gmail 内联资源，离开 Gmail 后无法渲染；建议用 emoji 文本代替。
3. **追加笔记会持续增长**：可每年更换 `NOTE_TITLE`（如加年份），或改用 `mode=daily`。
4. **标签只在新建时写入**：`append`/`daily` 不会重复加标签。
5. **无服务端 Message-ID 幂等**：去重依赖 Apps Script 脚本属性；跨项目/清空记录后可能重复。
6. **正文截断**：超过 180,000 字符会被截断。
7. **生产 RAG v2 未启用**：当前 PostgreSQL 无 pgvector，检索回退 v1；不影响本接入流程。

### 优化路线（后续可选）

- 后端 `/clip` 增加 `html` 字段，使用 `markdownify/html2text` 把邮件 HTML 转 Markdown（保留标题/列表/加粗/链接/表格）；
- 把 `cid:` 内联图片上传为笔记资产，替换为可访问 URL；
- 后端增加 `sourceId`（Gmail Message-ID）唯一约束，实现服务端幂等；
- 支持按年份自动拆分目标笔记，控制单篇体积。

---

## 十二、验收清单

- [ ] `POST /api/v1/clip` 无令牌返回 401（不是 404）
- [ ] `testApiConnection()` 返回 200 并生成测试笔记
- [ ] 首次 `syncGeminiDigest()` 在 Mails 下创建《Gemini 每日邮件摘要》
- [ ] 第二次运行返回 `"mode":"append"`，且仍是同一 `noteId`
- [ ] 同一封邮件不会被重复追加
- [ ] 每日 09:30 触发器已创建，时区为 `Asia/Shanghai`
- [ ] 执行失败时能在「执行」页面看到具体 HTTP 错误
- [ ] 旧令牌已撤销，脚本只使用新令牌

---

## 附录 A：完整 Apps Script

```js
/**
 * AIDriveNote × Gemini 每日邮件摘要同步（Google Apps Script）
 *
 * ===== 唯一必改的地方（第 1 段）=====
 * 把 ADN_TOKEN 的值换成你的真实令牌（adn_ 开头，勾选「写入」）。
 * 其余 label / 文件夹 / 标题可使用下面的默认值，或写到脚本属性里覆盖。
 */

// ↓↓↓ 改这一行 ↓↓↓
const ADN_TOKEN = 'adn_在这里粘贴你的令牌';
// ↑↑↑ 改这一行 ↑↑↑

const API_URL = 'https://www.aiignite.com.cn/note/api/v1/clip';

const DEFAULTS = {
  label: 'GeminiDaily',
  folder: 'Mails',
  noteTitle: 'Gemini 每日邮件摘要',
  tags: ['Gmail摘要', 'AI日报'],
  maxThreads: 20,
  maxTextChars: 180000,
  maxProcessedIds: 200,
};

const PROCESSED_KEY = 'processedMessageIds';

/** 主任务：同步最近两天的 Gemini 日报 */
function syncGeminiDigest() {
  const cfg = getConfig();
  if (!cfg.token) throw new Error('请先在脚本顶部配置 ADN_TOKEN');

  const processedSet = loadProcessedIds();
  const messages = GmailApp.search(cfg.query, 0, cfg.maxThreads)
    .flatMap(thread => thread.getMessages())
    .sort((left, right) => left.getDate().getTime() - right.getDate().getTime());

  let success = 0;
  let skipped = 0;
  const errors = [];

  for (const message of messages) {
    const messageId = message.getId();
    if (processedSet.has(messageId)) continue;

    const text = extractText(message);
    if (!text) {
      console.warn('跳过空正文邮件:', message.getSubject(), messageId);
      processedSet.add(messageId);
      skipped += 1;
      continue;
    }

    const payload = {
      title: message.getSubject().slice(0, 120),
      text: text.slice(0, cfg.maxTextChars),
      url: 'https://mail.google.com/mail/u/0/#all/' + messageId,
      tags: cfg.tags,
      folderName: cfg.folder,
      createFolder: true,
      mode: 'append',
      noteTitle: cfg.noteTitle,
    };

    const response = UrlFetchApp.fetch(cfg.apiUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + cfg.token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    const statusCode = response.getResponseCode();
    if (statusCode >= 300) {
      const error = `[${statusCode}] ${response.getContentText()} (${messageId})`;
      console.error('投送失败:', error);
      errors.push(error);
      continue;
    }

    success += 1;
    processedSet.add(messageId);
    saveProcessedIds(processedSet);
    console.log('已同步:', message.getSubject(), response.getContentText());
  }

  saveProcessedIds(processedSet);
  console.log(`本次完成：成功 ${success}，跳过 ${skipped}，失败 ${errors.length}`);
  if (errors.length > 0) {
    throw new Error('部分邮件同步失败：' + errors.join('; '));
  }
}

/** 连通性测试：会在 Mails 下新建一篇测试笔记（可手动删除） */
function testApiConnection() {
  const cfg = getConfig();

  const response = UrlFetchApp.fetch(cfg.apiUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.token },
    payload: JSON.stringify({
      title: '【连通性测试】Gemini 邮件同步',
      text: '这是一条用于验证 Apps Script 与 AIDriveNote 连通性的测试笔记。',
      url: 'https://mail.google.com',
      tags: ['测试', 'Gmail摘要'],
      folderName: cfg.folder,
      createFolder: true,
      mode: 'new',
    }),
    muteHttpExceptions: true,
  });

  console.log('HTTP 状态码:', response.getResponseCode());
  console.log('服务器响应:', response.getContentText());
  if (response.getResponseCode() >= 300) {
    throw new Error('连通性测试失败: ' + response.getContentText());
  }
}

/** 创建每天 09:30 的触发器（会先清理同名触发器） */
function createDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'syncGeminiDigest')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('syncGeminiDigest')
    .timeBased()
    .atHour(9)
    .nearMinute(30)
    .everyDays(1)
    .create();

  console.log('已创建每日 09:30 的 syncGeminiDigest 触发器');
}

/** 清空去重记录（调试用；清空后最近两天的邮件会被重新追加） */
function resetProcessed() {
  PropertiesService.getScriptProperties().deleteProperty(PROCESSED_KEY);
  console.log('已清空 processedMessageIds');
}

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  const label = props.getProperty('GMAIL_LABEL') || DEFAULTS.label;
  const token = (ADN_TOKEN || '').trim();
  if (!token || token.includes('在这里粘贴')) {
    throw new Error('请先把脚本顶部的 ADN_TOKEN 改成你的真实令牌');
  }
  return {
    token,
    apiUrl: API_URL,
    query: props.getProperty('GMAIL_QUERY') || `label:"${label}" newer_than:2d`,
    folder: (props.getProperty('NOTE_FOLDER') || DEFAULTS.folder).trim(),
    noteTitle: (props.getProperty('NOTE_TITLE') || DEFAULTS.noteTitle).trim(),
    tags: DEFAULTS.tags,
    maxThreads: DEFAULTS.maxThreads,
    maxTextChars: DEFAULTS.maxTextChars,
  };
}

function extractText(message) {
  const plain = (message.getPlainBody() || '').trim();
  if (plain) return plain;

  return message.getBody()
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function loadProcessedIds() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_KEY);
  try {
    const parsed = JSON.parse(raw || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch (error) {
    console.warn('processedMessageIds 解析失败，已重置:', error);
    return new Set();
  }
}

function saveProcessedIds(set) {
  const ids = Array.from(set).slice(-DEFAULTS.maxProcessedIds);
  PropertiesService.getScriptProperties().setProperty(PROCESSED_KEY, JSON.stringify(ids));
}
```

---

## 附录 B：接口调用示例

### B.1 追加到固定笔记（日报推荐）

```bash
curl -X POST 'https://www.aiignite.com.cn/note/api/v1/clip' \
  -H "Authorization: Bearer $ADN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "每日邮件整理 2026-10-28",
    "text": "## 重点关注\n- [ ] 完成报价",
    "url": "https://mail.google.com/",
    "tags": ["Gmail摘要"],
    "folderName": "Mails",
    "createFolder": true,
    "mode": "append",
    "noteTitle": "Gemini 每日邮件摘要"
  }'
```

### B.2 追加到当天每日笔记

```json
{
  "text": "## 09:30 邮件摘要\n- [ ] 事项",
  "mode": "daily"
}
```

### B.3 按文件夹 ID 归档

```bash
# 先查文件夹列表
curl -H "Authorization: Bearer $ADN_TOKEN" \
  'https://www.aiignite.com.cn/note/api/v1/notes/folders/list'
```

响应中取 `Mails` 的 `id`，请求里使用 `"folderId": "<uuid>"`。

---

## 附录 C：Gemini 提示词（可直接粘贴）

```text
你是我的邮件整理助手。请整理我 Gmail 中过去 24 小时收到的邮件，
生成一份中文摘要，并发送到邮箱：<你的邮箱地址>。

格式要求：
1. 邮件主题固定为：每日邮件整理 YYYY-MM-DD 邮件摘要
2. 正文使用纯文本 Markdown，不要使用 HTML、不要内联图片；
   图标一律用 emoji 文本代替。
3. 结构：
   # 每日邮件整理
   ## 重点关注与待办事项
   - [ ] 事项（截止时间 / 负责人）
   ## 项目研发与工程试制
   - 事项
   ## 其他
4. 只保留有行动项、风险、节点或决策的信息；没有内容的模块可以省略。
5. 不要编造邮件中不存在的信息。
```
