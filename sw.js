// 离线缓存：断网时也能打开应用、查看已有笔记、使用本机识别
// 修改了任何文件后，把下面的版本号加一，手机上才会更新。
const VERSION = 'whisper-note-v4';

// 本机识别模型（60MB 或 170MB）由 local-asr/worker.js 自己分块下载并存进这个缓存，
// 升级应用版本时不能清掉它，否则每次更新都要重新下载
const MODEL_CACHE_PREFIX = 'wn-local-model';

const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/db.js',
  'js/recorder.js',
  'js/pcm-worklet.js',
  'js/session.js',
  'js/settings.js',
  'js/transcriber.js',
  'js/local-engine.js',
  'local-asr/worker.js',
  'local-asr/sherpa-onnx-asr.js',
  'local-asr/sherpa-onnx-wasm-main-asr.js',
  'local-asr/sherpa-onnx-wasm-main-asr.wasm',
  'local-asr/models/small/manifest.json',
  'local-asr/models/accurate/manifest.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== VERSION && !k.startsWith(MODEL_CACHE_PREFIX)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 转写接口等外部请求不经过缓存
  if (/\/local-asr\/models\/[^/]+\/data\.part\d+$/.test(url.pathname)) return; // 模型分块由 worker 自己管

  // 识别引擎有 13MB，内容随版本号固定，直接用缓存，不在后台重复下载
  const pinned = url.pathname.includes('/local-asr/');

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached && pinned) return cached;
      // 其余文件：先用缓存秒开，同时在后台拉取新版本，下次打开生效
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
