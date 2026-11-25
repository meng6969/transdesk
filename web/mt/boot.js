/* 译台 TransDesk — 本地神经翻译层（Bergamot / Marian int8 学生模型）
   ------------------------------------------------------------------
   模型与运行时都是本机文件，不联网：清单 mt/registry.json 列出可用的语向，
   权重在 mt/models/ 下，wasm 运行时在 mt/runtime/ 下（Mozilla 的
   bergamot-translator 单线程构建，MPL-2.0，见 mt/runtime/LICENSE-mpl2-mozilla.txt）。

   没有清单就安静退出：网页版不带模型，翻译仍旧全部走词典引擎。
   模型加载失败（例如内核太旧、不支持 wasm SIMD）也只会退回词典引擎。 */
import { BatchTranslator } from './runtime/translator.js';

var REG_URL = 'mt/registry.json';
/* 译台的方向名 -> Bergamot 的语向代码（清单里的键是 from+to 四个字母）。 */
var DIR2PAIR = {
  zh2en: ['zh', 'en'], en2zh: ['en', 'zh'],
  zh2ja: ['zh', 'ja'], ja2zh: ['ja', 'zh']
};

function log() {
  if (window.console) console.info.apply(console, ['[译台 MT]'].concat([].slice.call(arguments)));
}

fetch(REG_URL, { cache: 'no-store' })
  .then(function (r) { return r && r.ok ? r.json() : null; })
  .then(function (reg) {
    if (!reg) { log('未找到模型清单，使用词典引擎'); return; }
    var have = {};
    Object.keys(reg).forEach(function (k) { if (k.length === 4) have[k] = true; });
    var pairs = Object.keys(have);
    if (!pairs.length) { log('模型清单为空'); return; }

    var mt = null;
    try {
      /* 注意：options 会被 postMessage 传给 worker，里面不能放函数
         （放过 onerror 就会卡在 "Could not be cloned"），错误交给 Promise 链。 */
      mt = new BatchTranslator({
        registryUrl: REG_URL,
        workers: 1,
        batchSize: 1,
        pivotLanguage: 'en',     // 中⇄日 走「中→英→日」两段，前提是两段的模型都在
        downloadTimeout: 0       // 本机文件，不设超时
      });
    } catch (e) {
      log('初始化失败，使用词典引擎：', e && e.message);
      return;
    }

    function legs(dir) {
      var p = DIR2PAIR[dir];
      if (!p) return null;
      if (have[p[0] + p[1]]) return { from: p[0], to: p[1], pivoted: false };
      if (p[0] !== 'en' && p[1] !== 'en' && have[p[0] + 'en'] && have['en' + p[1]]) {
        return { from: p[0], to: p[1], pivoted: true };
      }
      return null;
    }

    /* Bergamot 逐句翻译后直接拼接，英文句末标点后常常漏空格
       （"…every morning.This book…"），这里补上；中文输出不动。
       只认「两个以上小写字母 + 句末标点」，免得把 a.m. / U.S. 这类缩写拆开。 */
    function tidy(text, to) {
      var t = String(text == null ? '' : text);
      if (to === 'en') t = t.replace(/([a-z]{2,}[.!?;,:])(?=[A-Za-z"'“‘])/g, '$1 ');
      return t.replace(/[ \t]+$/gm, '').trim();
    }

    window.TransMT = {
      pairs: pairs,
      supports: function (dir) { return !!legs(dir); },
      translate: function (text, dir) {
        var l = legs(dir);
        if (!l) return Promise.reject(new Error('没有这个方向的模型'));
        var t0 = Date.now();
        return mt.translate({
          from: l.from, to: l.to, text: String(text || ''),
          html: false, qualityScores: false
        }).then(function (res) {
          var out = res && res.target ? res.target.text : '';
          return { text: tidy(out, l.to), ms: Date.now() - t0, pivoted: l.pivoted };
        });
      },
      dispose: function () { try { mt.delete(); } catch (e) { /* 忽略 */ } }
    };
    log('可用语向：' + pairs.join(' '));
    window.dispatchEvent(new CustomEvent('transdesk-mt-ready', { detail: { pairs: pairs } }));
  })
  .catch(function (e) { log('读取模型清单失败：', e && e.message ? e.message : e); });
