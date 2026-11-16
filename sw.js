// ひらく 暗記マーカー: Service Worker（オフラインでも起動できるようにする）
// ・アプリ本体（HTML / JS / CSS など）は「ネットワーク優先」。つながる時は必ず最新を取りに行き、
//   つながらない時・遅い時だけ保存済みのものを使う → 更新が反映されなくなる事故を避ける。
// ・vendor/（OCR・PDFの同梱ライブラリ。大きくて変わらない）は「キャッシュ優先」。
// ・教材や学習記録はここでは扱わない（IndexedDB にあり、キャッシュとは別）。
const SHELL = 'hiraku-shell-v1';
const VENDOR = 'hiraku-vendor-v1';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'css/style.css', 'js/app.js'];
const NET_TIMEOUT = 4000;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    let list = CORE;
    try { const r = await fetch('offline-files.json', { cache: 'no-cache' }); if (r.ok) list = [...new Set([...CORE, ...(await r.json()).shell])]; } catch { /* 一覧が無くても最低限で進む */ }
    const cache = await caches.open(SHELL);
    await Promise.all(list.map(async (u) => { try { const r = await fetch(u, { cache: 'no-cache' }); if (r.ok) await cache.put(u, r); } catch { /* 取れなかった分は次回 */ } }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('hiraku-') && k !== SHELL && k !== VENDOR) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function cacheFirst(req) {
  const cache = await caches.open(VENDOR);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(e, url) {
  const cache = await caches.open(SHELL);
  const req = e.request;
  const net = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
    if (res.ok && res.status === 200) cache.put(url.href, res.clone()).catch(() => {});
    return res;
  });
  const cached = async () => (await cache.match(url.href, { ignoreSearch: true })) || (req.mode === 'navigate' ? (await cache.match('./')) || (await cache.match('index.html')) : undefined);
  const timeout = new Promise((r) => setTimeout(r, NET_TIMEOUT, 'timeout'));
  try {
    const first = await Promise.race([net, timeout]);
    if (first !== 'timeout') { if (first.ok) return first; return (await cached()) || first; }
    e.waitUntil(net.catch(() => {})); // 遅いだけなら裏で取り終えて、次回に反映
    return (await cached()) || (await net);
  } catch (err) {
    const c = await cached(); if (c) return c;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部（任意でオンにしたAIのAPIなど）には一切関与しない
  if (req.headers.has('range')) return;
  if (url.pathname.includes('/vendor/')) e.respondWith(cacheFirst(req));
  else e.respondWith(networkFirst(e, url));
});
