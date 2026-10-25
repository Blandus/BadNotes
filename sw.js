// Offline cache for the app shell. Network first, so updates arrive as soon as you're online.
const CACHE = 'notizen-v7';
const ASSETS = [
  './', 'index.html', 'style.css', 'manifest.json', 'favicon.png', 'logo.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png',
  'js/main.js', 'js/util.js', 'js/icons.js', 'js/store.js', 'js/render.js', 'js/ui.js',
  'js/library.js', 'js/editor.js', 'js/tools.js', 'js/pdf.js', 'js/sync.js', 'js/suggest.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];

// App files are always revalidated with the server ('no-cache'): GitHub Pages lets browsers
// keep files for 10 minutes, which otherwise delays updates. Offline, the cached copy is used.
const fresh = req => new URL(req.url).origin === self.location.origin ? new Request(req, { cache: 'no-cache' }) : req;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => new Request(a, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.hostname.endsWith('google.com') || url.hostname.endsWith('googleapis.com')) return;
  e.respondWith(
    fetch(fresh(e.request))
      .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
