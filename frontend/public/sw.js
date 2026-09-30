/**
 * AIDriveNote Service Worker —— 应用壳离线缓存。
 *
 * 职责边界：
 * - 本文件只负责让「网页本身」在断网时可打开（导航请求 + 静态资源）；
 * - 笔记数据（列表、正文、离线写入队列）全部由前端 IndexedDB 层负责，
 * 这里刻意**不缓存 API 响应**：CacheStorage 无法与 Authorization 头可靠绑定，
 * 一旦缓存接口响应，同一浏览器切换账号时可能把上一个用户的数据回给新用户。
 *
 * 部署约束：应用以子路径方式部署（如 /note/），
 * 所有缓存 URL 均基于 `self.registration.scope` 推导，绝不硬编码根路径。
 */

/** 缓存版本号：修改缓存策略时递增，可让旧缓存被自动清理 */
const CACHE_VERSION = 'v1';
/** 应用壳缓存名 */
const SHELL_CACHE = `aidrivenote-shell-${CACHE_VERSION}`;
/** 预缓存清单文件名（由构建期插件生成） */
const MANIFEST_FILE = 'sw-manifest.json';
/** 导航请求的 network-first 超时（毫秒），超时即回退缓存 */
const NAV_TIMEOUT = 3000;

/**
 * 带超时的 fetch。
 * 断网时 fetch 可能长时间挂起而不立即 reject，必须靠超时兜底才能及时回退缓存。
 * @param {Request} request 原始请求
 * @param {number} timeout 超时毫秒数
 * @returns {Promise<Response>} 响应
 */
function fetchWithTimeout(request, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

/**
 * 取得应用 base 路径（子路径部署时为 /note/ 这类形式）。
 * @returns {string} 以 / 结尾的 base 路径
 */
function getBase() {
  try {
    const scopePath = new URL(self.registration.scope).pathname;
    return scopePath.endsWith('/') ? scopePath : `${scopePath}/`;
  } catch {
    return '/';
  }
}

/**
 * 应用壳 HTML 的缓存键。
 * 所有导航请求都回退到同一个壳，避免为每个路由各存一份 HTML。
 * @returns {string} 壳的绝对 URL
 */
function shellUrl() {
  return new URL('index.html', self.registration.scope).toString();
}

/**
 * 断网且无缓存可用时返回的兜底页面。
 * @returns {Response} 503 响应
 */
function offlineResponse() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>离线</title>' +
      '<body style="font-family:system-ui;padding:40px;color:#374151">' +
      '<h2>当前处于离线状态</h2>' +
      '<p>本页尚未被缓存，请联网后再访问一次。</p></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

// ── 安装：预缓存应用壳 ────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const manifestUrl = new URL(MANIFEST_FILE, self.registration.scope).toString();
      try {
        const response = await fetch(manifestUrl, { cache: 'no-store' });
        if (!response.ok) return;
        const assets = await response.json();
        // 逐条缓存：单个资源失败（如某 chunk 404）不应让整批预缓存失败
        for (const url of assets) {
          try {
            await cache.add(url);
          } catch {
            /* 忽略单个资源失败 */
          }
        }
      } catch {
        /* 清单不可用时跳过预缓存，运行时缓存仍会补齐 */
      }
    })(),
  );
  // 注意：这里不调用 skipWaiting。
  // 新 SW 立即接管会让正在打开的页面去请求新版 chunk（旧页面已加载的 index.html 指向旧文件名），
  // 从而出现 404；改由页面提示用户手动刷新。
});

// ── 激活：清理旧版本缓存 ──────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('aidrivenote-') && key !== SHELL_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

// ── 请求拦截 ──────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // 只接管 GET；写请求（含离线队列回传）必须直达网络，绝不缓存或伪造
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 清单文件本身必须走网络，否则新版本清单永远拿不到
  if (url.pathname.endsWith(MANIFEST_FILE)) return;
  // SW 自身脚本由浏览器管理，不参与缓存
  if (url.pathname.endsWith('/sw.js')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }
  event.respondWith(handleAsset(request));
});

/**
 * 导航请求：network-first（带超时），失败时回退到缓存的 index.html。
 * 与 nginx 的 try_files 语义一致，保证 SPA 深链在离线时也能打开。
 * @param {Request} request 导航请求
 * @returns {Promise<Response>} 响应
 */
async function handleNavigate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const key = shellUrl();
  try {
    const response = await fetchWithTimeout(request, NAV_TIMEOUT);
    if (response && response.ok) {
      // 顺带刷新壳缓存，让下次离线能用上较新的构建产物
      void cache.put(key, response.clone());
      return response;
    }
    const cached = await cache.match(key);
    return cached ?? response;
  } catch {
    const cached = (await cache.match(key)) ?? (await cache.match(request));
    return cached ?? offlineResponse();
  }
}

/**
 * 静态资源：cache-first。
 * 构建产物文件名带内容 hash，内容变化即换名，因此 cache-first 不会读到过期代码。
 * @param {Request} request 资源请求
 * @returns {Promise<Response>} 响应
 */
async function handleAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      void cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

// ── 与页面通信 ────────────────────────────────────────

self.addEventListener('message', (event) => {
  // 页面提示「有新版本」后，用户点击刷新时才让新 SW 接管
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});