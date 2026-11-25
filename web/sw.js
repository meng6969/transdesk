/* 译台 TransDesk — 离线服务工作者
   策略：本地优先（stale-while-revalidate）。首屏与词库直接从缓存返回，后台静默更新；
   断网 / 飞行模式下依旧可用。所有资源都来自本站，不涉及任何第三方域名。 */
'use strict';

var VER = 'transdesk-v5';
var SHELL = [
  './', 'index.html', 'styles.css', 'engine.js', 'app.js',
  'manifest.webmanifest', 'assets/icon.svg'
];
var DICTS = [
  'data/en2zh.json', 'data/en2core.json', 'data/ja2zh.json',
  'data/zh2en.json', 'data/zh2ja.json', 'data/en2zh.sample.txt'
];
/* OCR 引擎与语言包体积大，不做安装期预取，首次用到时再缓存。
   只保留 SIMD 版 wasm 内核：非 SIMD 版功能相同、体积多 3.9 MB，
   而安卓 APP 版的神经模型同样要求内核支持 wasm SIMD（Chrome/WebView 91+）。 */
var LAZY = [
  'lib/tesseract.min.js', 'lib/tesseract-core-simd-lstm.wasm.js',
  'worker/worker.min.js', 'data/ocr/eng.traineddata', 'data/ocr/jpn.traineddata'
];
var BIG = /(?:traineddata|wasm\.js)$/;

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(VER).then(function (c) {
      var urls = SHELL.concat(DICTS).map(function (p) { return new URL(p, self.location).href; });
      return Promise.all(urls.map(function (u) { return c.add(u).catch(function () { /* 单文件缺失不致命 */ }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VER; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function pick(req) {
  return caches.match(req, { ignoreSearch: false }).then(function (hit) {
    if (hit) return hit;
    var u = new URL(req.url);
    if (u.pathname.slice(-1) === '/') {
      return caches.match(new URL(u.pathname + 'index.html', self.location).href);
    }
    return null;
  });
}

function save(u, res) {
  if (!res || res.status !== 200) return;
  /* 神经模型与 wasm 运行时上百 MB：不进 Cache Storage（配额风险），
     交给浏览器 HTTP 缓存；离线场景由安卓 APP 的 assets 承担。 */
  if (u.pathname.indexOf('/mt/') === 0) return;
  caches.open(VER).then(function (c) { c.put(u, res.clone()); });
}

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  var u = new URL(req.url);
  if (u.origin !== self.location.origin) return;   // 本站之外没有请求；有也不接管

  ev.respondWith(pick(req).then(function (cached) {
    var net = fetch(req).then(function (res) { save(u.href, res); return res; }).catch(function () { return null; });
    if (cached) {
      if (!BIG.test(u.pathname)) ev.waitUntil(net);   // 小文件后台刷新，大文件不重复下载
      return cached;
    }
    return net.then(function (res) {
      if (res) return res;
      if (req.mode === 'navigate') return caches.match('index.html');
      return new Response('离线且本机尚无缓存：' + u.pathname, { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    });
  }));
});

self.addEventListener('message', function (ev) {
  if (ev.data === 'skip') self.skipWaiting();
});
