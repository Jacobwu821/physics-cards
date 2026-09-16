// 构建后生成 Service Worker：预缓存 dist 下全部静态文件（含 KaTeX 字体），
// 让「添加到主屏幕」后的应用在没有网络时也能打开并渲染公式。
// 必须通过 https（或 localhost）访问才会注册 Service Worker。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(__dirname, '..', 'dist')

function walk(dir, base = '') {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel))
    else if (e.name !== 'sw.js') out.push(rel)
  }
  return out
}

const files = walk(dist)
const hash = crypto.createHash('sha1')
for (const f of files) hash.update(f).update(fs.readFileSync(path.join(dist, f)))
const version = hash.digest('hex').slice(0, 12)

const sw = `// 自动生成，请勿手改。版本 ${version}
const VERSION = ${JSON.stringify(version)};
const CACHE = 'physics-cards-' + VERSION;
const ASSETS = ${JSON.stringify(files.map((f) => './' + f), null, 0)};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('physics-cards-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'GET_VERSION') event.source?.postMessage({ type: 'VERSION', version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // 同步服务器在其他域名时不经过缓存
  if (url.pathname.includes('/api/')) return;            // API 永远走网络
  const scopePath = new URL(self.registration.scope).pathname;
  if (req.mode === 'navigate') {
    // 页面：先网络（拿到新版本），失败则用缓存的 index.html（离线打开）
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(new Request(scopePath + 'index.html'), fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(scopePath + 'index.html') || await caches.match('./index.html');
        return cached || Response.error();
      }
    })());
    return;
  }
  // 静态资源：缓存优先，未命中再走网络并写入缓存
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok) { const cache = await caches.open(CACHE); cache.put(req, res.clone()); }
      return res;
    } catch (e) {
      return Response.error();
    }
  })());
});
`
fs.writeFileSync(path.join(dist, 'sw.js'), sw)
console.log(`sw.js 已生成：预缓存 ${files.length} 个文件，版本 ${version}`)
