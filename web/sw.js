// 版本号变化时旧缓存整体作废。改了前端文件记得改这里，否则用户可能拿到旧版界面。
const VERSION = 'v3';
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;
const DATA_KEEP = 8; // 缓存最近 8 天，够离线翻一周

const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/** 数据走网络优先：拿到新的就用新的，断网时回落到上次缓存 */
async function dataFirstNetwork(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) {
      cache.put(request, res.clone());
      trimDataCache(cache);
    }
    return res;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

/** 只保留最近若干天的数据文件，避免缓存无限增长 */
async function trimDataCache(cache) {
  const keys = await cache.keys();
  const dayFiles = keys.filter((k) => /\d{4}-\d{2}-\d{2}\.json/.test(k.url));
  if (dayFiles.length <= DATA_KEEP) return;
  dayFiles
    .sort((a, b) => a.url.localeCompare(b.url))
    .slice(0, dayFiles.length - DATA_KEEP)
    .forEach((k) => cache.delete(k));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/data/')) {
    event.respondWith(dataFirstNetwork(request));
    return;
  }

  // 界面外壳走缓存优先，冷启动更快
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => cached ?? fetch(request))
  );
});
