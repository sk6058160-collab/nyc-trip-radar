import { defineConfig, type Plugin } from 'vite';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Emits dist/sw.js with a precache list of every built asset + public file (app shell + data).
// Deployed at https://sk6058160-collab.github.io/nyc-trip-radar/ — override with VITE_BASE=/ for root hosting.
const BASE = process.env.VITE_BASE ?? '/nyc-trip-radar/';

function serviceWorker(): Plugin {
  return {
    name: 'trip-radar-sw',
    apply: 'build',
    generateBundle(_, bundle) {
      const pub = 'public'; const files: string[] = [];
      const walk = (d: string) => readdirSync(d).forEach(f => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(relative(pub, p)); });
      walk(pub);
      const assets = [BASE, BASE + 'index.html', ...Object.keys(bundle).map(f => BASE + f), ...files.filter(f => f !== 'sw.js' && f !== 'manifest.webmanifest').map(f => BASE + f), BASE + 'manifest.webmanifest'];
      // manifest with absolute start_url/scope/icons for the deploy base
      const manifest = JSON.parse(readFileSync(join(pub, 'manifest.webmanifest'), 'utf8'));
      manifest.id = BASE; manifest.start_url = BASE; manifest.scope = BASE;
      manifest.icons = manifest.icons.map((i: { src: string }) => ({ ...i, src: BASE + i.src.replace(/^\.?\//, '') }));
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify(manifest, null, 2) + '\n' });
      const version = Date.now().toString(36);
      const src = `// generated at build
const CACHE = 'trip-radar-${version}';
const PRECACHE = ${JSON.stringify(assets)};
const TILE_CACHE = 'trip-radar-tiles';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.origin === location.origin) {
    // app shell + data: cache first, fall back to network; navigation falls back to cached index
    e.respondWith(caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then(r => r || fetch(e.request).catch(() => caches.match('${BASE}index.html'))));
  } else if (u.hostname === 'services.arcgisonline.com') {
    // map tiles: stale-while-revalidate, kept in a separate cache
    e.respondWith(caches.open(TILE_CACHE).then(async c => { const hit = await c.match(e.request); const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit); return hit || net; }));
  }
  // live APIs: network only (never cached, so stale live data is never shown as fresh)
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}
export default defineConfig({ base: BASE, plugins: [serviceWorker()], build: { target: 'es2020', chunkSizeWarningLimit: 800 } });
