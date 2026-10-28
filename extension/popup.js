/** 扩展弹窗：配置 API/令牌，载入当前选区并保存。 */

const DEFAULT_BASE = 'http://localhost:3275/api/v1';
const $ = (id) => document.getElementById(id);

let pageMeta = { title: '', url: '' };

async function loadSettings() {
  const stored = await chrome.storage.sync.get(['apiBase', 'token']);
  $('apiBase').value = stored.apiBase || DEFAULT_BASE;
  $('token').value = stored.token || '';
}

async function persistSettings() {
  await chrome.storage.sync.set({
    apiBase: $('apiBase').value.trim() || DEFAULT_BASE,
    token: $('token').value.trim(),
  });
}

async function loadSelection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      title: document.title,
      url: location.href,
      text: window.getSelection()?.toString() || '',
    }),
  });
  const result = injected?.result || { title: '', url: '', text: '' };
  pageMeta = { title: result.title, url: result.url };
  $('text').value = result.text || '';
  if (!result.text) $('text').placeholder = '当前页面没有选中文字，可手动粘贴';
}

async function save() {
  await persistSettings();
  const token = $('token').value.trim();
  const apiBase = $('apiBase').value.trim() || DEFAULT_BASE;
  const text = $('text').value.trim();
  if (!token) {
    alert('请先填写访问令牌');
    return;
  }
  if (!text) {
    alert('内容不能为空');
    return;
  }
  const response = await fetch(`${apiBase.replace(/\/$/, '')}/clip`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ title: pageMeta.title, url: pageMeta.url, text }),
  });
  if (!response.ok) {
    alert(`保存失败（${response.status}）`);
    return;
  }
  window.close();
}

$('load').addEventListener('click', () => void loadSelection());
$('save').addEventListener('click', () => void save());
void loadSettings();
