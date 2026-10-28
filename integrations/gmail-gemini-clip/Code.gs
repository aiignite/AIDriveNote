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
  if (!cfg.token) throw new Error('缺少 ADN_TOKEN');

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
