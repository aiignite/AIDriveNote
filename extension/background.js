/** AIDriveNote Web Clipper —— 右键菜单保存选中内容 */

const DEFAULT_BASE = 'http://localhost:3275/api/v1';

async function getSettings() {
  const stored = await chrome.storage.sync.get(['apiBase', 'token']);
  return {
    apiBase: stored.apiBase || DEFAULT_BASE,
    token: stored.token || '',
  };
}

function flashBadge(text) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#FF6B35' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

async function sendClip(payload) {
  const { apiBase, token } = await getSettings();
  if (!token) {
    flashBadge('!');
    console.warn('AIDriveNote: 请先在扩展弹窗中填写访问令牌');
    return;
  }
  const response = await fetch(`${apiBase.replace(/\/$/, '')}/clip`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    flashBadge('!');
    console.warn('AIDriveNote: 保存失败', response.status);
    return;
  }
  flashBadge('✓');
}

async function clipSelection(tab) {
  if (!tab?.id) return;
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      title: document.title,
      url: location.href,
      text: window.getSelection()?.toString() || '',
    }),
  });
  const { title, url, text } = injected?.result || {};
  if (!text || !text.trim()) {
    flashBadge('!');
    console.warn('AIDriveNote: 请先选中要保存的文字');
    return;
  }
  await sendClip({ title, url, text });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'aidrivenote-clip',
    title: '保存选中内容到 AIDriveNote',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'aidrivenote-clip') void clipSelection(tab);
});
