/* 译台 TransDesk — 应用层：加载词库、即时翻译、我的词典（IndexedDB）、本地 OCR
   所有文字与图片都只在本机处理：除了加载本站自己的词库/引擎文件，不发生任何网络请求。 */
(function () {
  'use strict';

  var E = window.TransEngine;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var DIRS = ['en2zh', 'ja2zh', 'zh2en', 'zh2ja'];
  var DIR_LABEL = { en2zh: '英 → 中', ja2zh: '日 → 中', zh2en: '中 → 英', zh2ja: '中 → 日' };
  var SWAP = { en2zh: 'zh2en', zh2en: 'en2zh', ja2zh: 'zh2ja', zh2ja: 'ja2zh' };
  /* 两个方向按键：一个管中⇄英，一个管中⇄日；四个方向都还在，靠 ⇄ 翻面。 */
  var PAIR_OF = { en2zh: 'en', zh2en: 'en', ja2zh: 'ja', zh2ja: 'ja' };
  var PAIR_DEFAULT = { en: 'en2zh', ja: 'ja2zh' };
  var DIR_TAG = { en2zh: ['EN', 'ZH'], zh2en: ['ZH', 'EN'], ja2zh: ['JA', 'ZH'], zh2ja: ['ZH', 'JA'] };
  var DATA = [
    { file: 'data/en2zh.json', dir: 'en2zh' },
    { file: 'data/en2core.json', dir: 'en2zh' },
    { file: 'data/ja2zh.json', dir: 'ja2zh' },
    { file: 'data/zh2en.json', dir: 'zh2en' },
    { file: 'data/zh2ja.json', dir: 'zh2ja' }
  ];

  /* ================================================== 小工具 */
  function lsGet(k, d) {
    try { var v = localStorage.getItem('transdesk:' + k); return v == null ? d : JSON.parse(v); }
    catch (e) { return d; }
  }
  function lsSet(k, v) { try { localStorage.setItem('transdesk:' + k, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ } }

  var toastTimer = 0;
  function toast(msg, ms) {
    var t = $('#toast'); if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2400);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function hasKanji(s) { return /[㐀-鿿]/.test(String(s || '')); }
  function hasKana(s) { return /[぀-ゟ゠-ヿ]/.test(String(s || '')); }
  function hasLatin(s) { return /[A-Za-z]/.test(String(s || '')); }
  function words(text) {
    var m = String(text || '').match(/[A-Za-z][A-Za-z0-9'\-]*|\d+(?:[.,]\d+)?|[㐀-鿿぀-ヿ]/g);
    return m ? m.length : 0;
  }
  /* 双击取词：拉丁词 / 数字 / 汉字假名串 */
  function wordAt(text, pos) {
    text = String(text || '');
    var re = /[A-Za-z][A-Za-z0-9'\-]*|\d+(?:[.,]\d+)?|[㐀-鿿぀-ヿー〜]+/g, m;
    while ((m = re.exec(text))) {
      if (m.index <= pos && pos <= m.index + m[0].length) return m[0];
      if (m.index > pos) break;
    }
    var sel = String(window.getSelection() || '').trim();
    return sel && sel.length <= 24 ? sel : '';
  }

  /* ================================================== 我的词典（IndexedDB） */
  var DB = { db: null, ok: true };
  function idb() {
    return new Promise(function (res) {
      if (DB.db) return res(DB.db);
      if (!window.indexedDB) { DB.ok = false; return res(null); }
      var rq;
      try { rq = indexedDB.open('transdesk', 1); } catch (e) { DB.ok = false; return res(null); }
      rq.onupgradeneeded = function () { rq.result.createObjectStore('entries', { keyPath: 'id' }); };
      rq.onsuccess = function () { DB.db = rq.result; res(DB.db); };
      rq.onerror = function () { DB.ok = false; res(null); };
    });
  }
  function store(mode, fn) {
    return idb().then(function (db) {
      if (!db) return null;
      return new Promise(function (res, rej) {
        var t = db.transaction('entries', mode), out;
        try { out = fn(t.objectStore('entries')); } catch (e) { return rej(e); }
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : null); };
        t.onerror = function () { rej(t.error || new Error('idb')); };
      });
    }).catch(function (err) { console.warn('词典存储不可用', err); return null; });
  }
  function dictAll() { return store('readonly', function (st) { return st.getAll(); }); }
  function dictPut(rows) {
    if (!Array.isArray(rows)) rows = [rows];
    return store('readwrite', function (st) { rows.forEach(function (r) { st.put(r); }); });
  }
  function dictDel(id) { return store('readwrite', function (st) { st.delete(id); }); }
  function dictClear() { return store('readwrite', function (st) { st.clear(); }); }
  var USER = { rows: [], byDir: {} };
  function guessDir(term) {
    if (hasKana(term)) return 'ja2zh';
    if (hasKanji(term)) return 'zh2en';
    return 'en2zh';
  }
  function srcKind(t) {
    if (hasKana(t)) return 'ja';
    if (hasKanji(t)) return 'zh';
    if (hasLatin(t)) return 'en';
    return 'x';
  }
  function dirFor(force, term) {
    var k = srcKind(term);
    if (!force || DIRS.indexOf(force) < 0) return k === 'ja' ? 'ja2zh' : (k === 'zh' ? 'zh2en' : 'en2zh');
    var fs = force.slice(0, 2);
    if (fs === 'en') return k === 'en' || k === 'x' ? force : guessDir(term);
    if (fs === 'ja') return k === 'ja' || k === 'zh' || k === 'x' ? force : guessDir(term);
    return k === 'zh' || k === 'ja' || k === 'x' ? force : guessDir(term);
  }
  function joinKey(a, b) { return a + '##' + b; }
  function mkRow(dir, term, gloss) {
    return { id: joinKey(dir, term), dir: dir, term: term, gloss: gloss, at: Date.now() };
  }
  function wipeUser(d) {
    var T = E.D[d]; if (!T) return;
    [T.w, T.p].forEach(function (mp) {
      var kill = [];
      mp.forEach(function (v, k) { if (v && v.prio >= 2) kill.push(k); });
      kill.forEach(function (k) { mp.delete(k); });
    });
  }
  function applyUser(rows) {
    USER.rows = rows || [];
    USER.byDir = {};
    USER.rows.forEach(function (r) {
      if (DIRS.indexOf(r.dir) < 0) return;
      (USER.byDir[r.dir] = USER.byDir[r.dir] || []).push(r);
    });
    if (!E) return;
    DIRS.forEach(function (d) {
      var w = {}, p = {};
      wipeUser(d);
      (USER.byDir[d] || []).forEach(function (r) {
        var k = E.keyOf(d, r.term);
        if (!k || !r.gloss) return;
        // 带空格 / 较长的词条走短语表（最长匹配），单词才进词表——人名靠这条才生效
        var phrase = /\s/.test(k) || (d !== 'en2zh' && Array.from(k).length >= 3);
        (phrase ? p : w)[k] = [r.gloss, 'x'];
      });
      if (Object.keys(w).length || Object.keys(p).length) {
        E.load(d, { w: w, p: p }, { prio: true, label: '我的词典（' + DIR_LABEL[d] + '）', attribution: '用户本机数据' });
      }
    });
    var n = USER.rows.length;
    $('#dict-count').textContent = n;
    $('#dict-count').title = n ? '已加载 ' + n + ' 条本机词条，优先级最高' : '还没有自定义词条';
  }
  var TERM_H = /^(term|terms|word|english|english_word|en|src|source|词条|单词|原文|词语)$/i;
  var GLOSS_H = /^(translation|trans|zh|cn|chinese|gloss|mean|means|definition|译文|释义|中文|意思|翻译|译义)$/i;
  var PHON = /^[\[\/／].{0,60}[\]\/／]$/;
  function pickCols(cells) {
    for (var i = 0; i < cells.length; i++) {
      for (var j = 0; j < cells.length; j++) {
        if (i === j) continue;
        if (cells[i] && cells[j]) return [cells[i], cells[j]];
      }
    }
    return null;
  }
  function cutRow(line) {
    var s = line.trim();
    if (/^\|.*\|?$/.test(s)) s = s.replace(/^\|/, '').replace(/\|$/, '');
    var cand = ['\t', '|', ';', '，', ','].map(function (sep) {
      return [sep, s.split(sep).filter(function (x) { return x.trim(); }).length];
    }).sort(function (a, b) { return b[1] - a[1]; })[0];
    if (!cand || cand[1] < 2) return null;
    return s.split(cand[0]).map(function (x) { return x.trim().replace(/^["']|["']$/g, ''); });
  }
  function parseText(text, forceDir) {
    var rows = [], seen = {}, col = null;
    String(text || '').split(/\r?\n/).forEach(function (line) {
      if (!line.trim() || /^\s*[#\/]/.test(line)) return;
      var c = cutRow(line); if (!c || c.length < 2) return;
      var hi = -1, gi = -1;
      c.forEach(function (x, i) { if (hi < 0 && TERM_H.test(x.trim())) hi = i; });
      c.forEach(function (x, i) { if (gi < 0 && i !== hi && GLOSS_H.test(x.trim())) gi = i; });
      if (hi >= 0 && gi >= 0) { col = [hi, gi]; return; }   // 表头：记住取哪两列
      var t = col ? c[col[0]] : c[0];
      var rest = col ? c.slice(col[1]) : c.slice(1);
      rest = rest.filter(function (x) { return x && !PHON.test(x); });  // 跳过音标列
      var g = rest.join('；').replace(/<[^>]*>/g, '').replace(/\\n/g, '\n').split('\n').filter(function (x) { return x.trim(); }).join(' ');
      if (!t || !g) return;
      t = t.trim();
      var dir = dirFor(forceDir, t);
      var id = joinKey(dir, t);
      if (seen[id]) return; seen[id] = 1;
      rows.push(mkRow(dir, t, g.trim()));
    });
    return rows;
  }
  function parseJSON(any, forceDir) {
    var rows = [];
    function add(dir, t, g) {
      if (!t || !g) return;
      t = String(t).trim();
      g = typeof g === 'string' ? g.split('\n')[0].trim() : g;
      if (!t || !g) return;
      rows.push(mkRow(DIRS.indexOf(dir) >= 0 ? dir : dirFor(forceDir, t), t, g));
    }
    function plain(obj) {
      Object.keys(obj).forEach(function (k) {
        if (['meta', 'kind', 'exported', 'attribution', 'label'].indexOf(k) >= 0) return;
        var v = obj[k];
        if (typeof v === 'string') add(null, k, v);
        else if (Array.isArray(v)) add(null, k, v[0]);
        else if (v && typeof v === 'object') {
          add(v.dir || null, v.term || v.word || k, v.translation || v.gloss || v.zh || v.trans || v.definition || v.g || '');
        }
      });
    }
    function list(arr) {
      arr.forEach(function (o) {
        if (!o || typeof o !== 'object') return;
        var t = o.term || o.word || o.en || o.src || o[0];
        var g = o.translation || o.gloss || o.zh || o.dst || o.trans || o.definition || o[1];
        if (typeof t === 'string' && g) add(o.dir || o.direction, t, g);
      });
    }
    if (Array.isArray(any)) list(any);
    else if (any && typeof any === 'object') {
      if (Array.isArray(any.entries) || Array.isArray(any.rows) || Array.isArray(any.data)) {
        list(any.entries || any.rows || any.data);
      } else if ((any.w && typeof any.w === 'object') || (any.p && typeof any.p === 'object')) {
        if (any.w) plain(any.w);
        if (any.p) plain(any.p);
      } else plain(any);
    }
    var seen = {};
    return rows.filter(function (r) {
      var id = r.id; if (!r.term || !r.gloss || seen[id]) return false; seen[id] = 1; return true;
    });
  }
  /* ================================================== 翻译与渲染 */
  var S = { dir: lsGet('dir', 'en2zh'), last: null, ready: false, timer: 0, mtSeq: 0 };
  if (DIRS.indexOf(S.dir) < 0) S.dir = 'en2zh';

  function paintDirs() {
    $$('.dir').forEach(function (b) {
      var on = PAIR_OF[S.dir] === b.dataset.pair;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      var tag = DIR_TAG[on ? S.dir : PAIR_DEFAULT[b.dataset.pair]] || ['EN', 'ZH'];
      b.innerHTML = '<span>' + tag[0] + '</span>→<span>' + tag[1] + '</span>';
    });
    var ph = S.dir === 'ja2zh' ? '把日文粘贴到这里……（也可以直接 Ctrl+V，无需点击）'
      : S.dir.indexOf('zh2') === 0 ? '输入中文，得到' + (S.dir === 'zh2en' ? '英文' : '日文') + '……（短句效果最好）'
        : '把英文粘贴到这里……（也可以直接 Ctrl+V，无需点击）';
    $('#src').placeholder = ph + '\n也可以拖一张图片进来，本地识别文字后再翻译。';
  }
  function renderMeta(text, r) {
    var t = String(text || '');
    $('#src-meta').textContent = t.length + ' 字符 · ' + words(t) + ' 词';
    if (!r) { $('#dst-meta').textContent = t.trim() ? '等待引擎' : '等待输入'; return; }
    var hit = r.stats.hits || {}, pct = r.stats.units ? Math.round(100 * (r.stats.units - (hit.miss || 0)) / r.stats.units) : 100;
    $('#dst-meta').textContent = r.stats.ms + ' ms · ' + r.segs.length + ' 句 · 单元命中 ' + pct + '%';
    $('#perf').textContent = r.stats.ms + ' ms / ' + r.stats.units + ' 单元（' + DIR_LABEL[S.dir] + '）';
  }
  function termSpans(txt, dir) {
    var out = [], re = /[A-Za-z][A-Za-z0-9'\-]*|[㐀-鿿぀-ヿ]{1,6}|\d+(?:[.,]\d+)?|\s+|[^\s]/g, m, guard = 0;
    while ((m = re.exec(txt)) && guard++ < 4000) {
      var x = m[0];
      if (/^\s+$/.test(x) || x.length === 1 && !/[A-Za-z㐀-鿿぀-ヿ]/.test(x)) { out.push(esc(x)); continue; }
      out.push('<b class="term" data-w="' + esc(x) + '">' + esc(x) + '</b>');
    }
    return out.join('');
  }
  function renderOut(text) {
    var box = $('#out');
    if (!String(text || '').trim()) {
      box.innerHTML = '<p class="empty">译文会出现在这里。左侧一输入就即时计算，全程不联网。</p>';
      $('#trace').innerHTML = ''; S.last = null; renderMeta(text, null); return;
    }
    if (!S.ready || !E) {
      box.innerHTML = '<p class="empty">词库还在加载（或加载失败）。刷新一次试试；本地预览需通过 http://127.0.0.1 打开。</p>';
      renderMeta(text, null); return;
    }
    var r = E.translate(text, S.dir);
    S.last = r;
    var wrap = S.dir.indexOf('zh2') === 0;      // 结果是外文时才做「双击加词」的热区
    var html = r.segs.map(function (sg, i) {
      var body = wrap ? termSpans(sg.dst, S.dir) : esc(sg.dst);
      var num = r.segs.length > 1 ? '<span class="num">' + (i + 1) + '</span>' : '';
      var note = sg.notes ? '<span class="note">' + esc(sg.notes) + '</span>' : '';
      return '<p class="seg">' + num + body + note + '</p>';
    }).join('');
    box.innerHTML = html || '<p class="empty">没有可翻译的内容。</p>';
    renderTrace(r);
    renderMeta(text, r);
    runMT(text);
  }
  /* 神经模型（可选层）：打包了本地 Bergamot 模型才有 window.TransMT，
     网页版没有模型文件时这里什么都不做，仍旧只走词典引擎。 */
  function runMT(text) {
    var mb = $('#mt-box');
    if (!mb) return;
    var t = String(text || '');
    var MT = window.TransMT;
    if (!t.trim() || !MT || !MT.supports(S.dir)) { mb.hidden = true; S.mtSeq++; return; }
    var seq = ++S.mtSeq, dir = S.dir;
    $('#mt-out').textContent = '模型计算中……';
    $('#mt-meta').textContent = DIR_LABEL[dir];
    mb.hidden = false;
    MT.translate(t, dir).then(function (res) {
      if (seq !== S.mtSeq || dir !== S.dir) return;
      $('#mt-out').textContent = res.text || '（模型没有给出译文）';
      $('#mt-meta').textContent = DIR_LABEL[dir] + ' · ' + res.ms + ' ms' + (res.pivoted ? ' · 经英文中转' : '');
    }).catch(function (e) {
      if (seq !== S.mtSeq) return;
      mb.hidden = true;
      toast('模型不可用，已回退词典：' + ((e && e.message) || e));
    });
  }
  var HOW = { user: '我的词典', phrase: '短语', dict: '词典', morph: '词形还原', rule: '规则', num: '数量', sym: '标点', miss: '未收录', raw: '原样' };
  function renderTrace(r) {
    var box = $('#trace');
    if (!r || !r.trace.length) { box.innerHTML = '<div class="tr-row"><span>暂无单元</span><span></span><span class="how">—</span></div>'; return; }
    box.innerHTML = r.trace.map(function (u) {
      var cls = u.how === 'miss' ? '' : (u.how === 'user' || u.how === 'dict' || u.how === 'morph' ? ' hit' : (u.how === 'phrase' ? ' phrase' : ''));
      return '<div class="tr-row" data-src="' + esc(u.src) + '"><b>' + esc(u.src) + '</b>' +
        '<span>' + esc(u.dst || '（并入语序）') + (u.feat ? ' <i class="meta">' + esc(u.feat) + '</i>' : '') + '</span>' +
        '<span class="how' + cls + '">' + esc(HOW[u.how] || u.how) + '</span></div>';
    }).join('');
  }
  function schedule(now) {
    clearTimeout(S.timer);
    var go = function () {
      var btn = $('#btn-go');
      btn.classList.add('working');
      setTimeout(function () { btn.classList.remove('working'); }, 260);
      renderOut($('#src').value);
    };
    if (now) go(); else S.timer = setTimeout(go, 240);
  }
  function setDir(d, keep) {
    if (DIRS.indexOf(d) < 0) return;
    S.dir = d; lsSet('dir', d); paintDirs(); schedule(true);
    if (!keep) toast('方向：' + DIR_LABEL[d]);
  }
  function swapDir() {
    var t = $('#src').value, r = S.last;
    setDir(SWAP[S.dir], true);
    if (r && r.segs.length) {
      var joined = r.segs.map(function (x) { return x.dst; }).join('\n');
      $('#src').value = joined; schedule(true);
      toast('已交换方向，原文与译文对调');
    } else toast('已交换方向：' + DIR_LABEL[S.dir]);
    void t;
  }
  function outText() {
    if (!S.last) return '';
    return S.last.segs.map(function (s, i) {
      return (S.last.segs.length > 1 ? (i + 1) + '. ' : '') + s.dst;
    }).join('\n\n');
  }
  function copyOut() {
    var t = outText(); if (!t) { toast('还没有译文可复制'); return; }
    var done = function () { toast('译文已复制到剪贴板'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, fallback);
    else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选中'); }
      document.body.removeChild(ta);
    }
  }
  function downloadOut() {
    var t = outText(); if (!t) { toast('还没有译文可下载'); return; }
    var src = $('#src').value;
    var body = '译台 TransDesk · ' + DIR_LABEL[S.dir] + ' · ' + new Date().toLocaleString() +
      '\n（纯离线词典+规则引擎，内容未离开本机）\n\n【原文】\n' + src + '\n\n【译文】\n' + t + '\n';
    var blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'transdesk-' + S.dir + '-' + new Date().toISOString().slice(0, 10) + '.txt';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('已导出 TXT');
  }
  /* ================================================== 取词弹窗 */
  var POP = { term: '', dir: '' };
  function openPop(term, dir, x, y) {
    if (!term) return;
    POP.term = term; POP.dir = DIRS.indexOf(dir) >= 0 ? dir : guessDir(term);
    $('#pop-term').textContent = term;
    $('#pop-src').textContent = DIR_LABEL[POP.dir] + ' · ' + (E && E.explain(POP.dir, term) ? '内置词库已有' : '内置词库没有');
    var ex = E ? E.explain(POP.dir, term) : null;
    $('#pop-body').innerHTML = ex
      ? '<p class="pop-body-item">当前译法：' + esc(E.short(ex.g)) + '（' + esc(ex.prio >= 2 ? '来自我的词典' : '内置词库') + '）</p>' +
      '<p class="pop-body-item">保存后本词按你的译法走，其它地方不受影响。</p>'
      : '<p class="pop-body-item">这个词没被收录。写下你的译法，之后遇到它就直接用你的。</p>';
    $('#pop-gloss').value = ex ? E.short(ex.g) : '';
    var p = $('#pop');
    p.hidden = false;
    var w = p.offsetWidth || 320, h = p.offsetHeight || 150;
    p.style.left = Math.max(10, Math.min(window.innerWidth - w - 10, (x || 120))) + 'px';
    p.style.top = Math.max(10, Math.min(window.innerHeight - h - 10, (y || 120))) + 'px';
    setTimeout(function () { $('#pop-gloss').focus(); $('#pop-gloss').select(); }, 20);
  }
  function closePop() { $('#pop').hidden = true; }
  function savePop() {
    var g = $('#pop-gloss').value.trim();
    if (!g) { toast('先写一个译法'); return; }
    addTerm(POP.dir, POP.term, g);
    closePop();
  }
  function addTerm(dir, term, gloss) {
    var row = mkRow(dir, term, gloss);
    return dictPut([row]).then(function () {
      USER.rows = USER.rows.filter(function (r) { return r.id !== row.id; }).concat([row]);
      applyUser(USER.rows); renderDict(); schedule(true);
      toast('已加入我的词典：' + term + ' → ' + gloss);
    }).catch(function () { toast('存储不可用，这次只在当前页面生效'); });
  }
  /* ================================================== 词典面板 */
  var SHOWN = 300;
  function renderDict() {
    var box = $('#dict-list');
    var q = (($('#dict-filter') && $('#dict-filter').value) || '').trim().toLowerCase();
    var rows = USER.rows.slice().sort(function (a, b) { return (a.dir + a.term) < (b.dir + b.term) ? -1 : 1; });
    var total = rows.length;
    if (q) {
      rows = rows.filter(function (r) {
        return (r.term + ' ' + r.gloss + ' ' + r.dir + ' ' + (DIR_LABEL[r.dir] || '')).toLowerCase().indexOf(q) >= 0;
      });
    }
    var n = $('#dict-n');
    if (n) n.textContent = total ? (q ? '筛出 ' + rows.length + ' / 共 ' + total + ' 条' : '共 ' + total + ' 条') : '';
    if (!total) {
      box.innerHTML = '<div class="void">还没有自定义词条。翻译结果里双击一个词，或在上面手动添加，也可以导入 CSV / JSON。</div>';
      return;
    }
    if (!rows.length) {
      box.innerHTML = '<div class="void">没有匹配「' + esc(q) + '」的词条。</div>';
      return;
    }
    var html = '<div class="hd"><span>方向</span><span>词条</span><span>你的译法</span><span></span></div>';
    html += rows.slice(0, SHOWN).map(function (r) {
      return '<div class="dr"><span class="meta">' + esc(DIR_LABEL[r.dir] || r.dir) + '</span>' +
        '<b>' + esc(r.term) + '</b><span>' + esc(r.gloss) + '</span>' +
        '<button class="del" data-id="' + esc(r.id) + '" title="删除">✕</button></div>';
    }).join('');
    if (rows.length > SHOWN) {
      html += '<div class="void">只列出前 ' + SHOWN + ' 条（共 ' + rows.length + ' 条）—— 用上面的筛选框定位，或导出 JSON 在本地改好后再导入。</div>';
    }
    box.innerHTML = html;
    $$('.del', box).forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.id;
        dictDel(id).then(function () {
          USER.rows = USER.rows.filter(function (r) { return r.id !== id; });
          applyUser(USER.rows); renderDict(); schedule(true); toast('已删除 1 条');
        });
      });
    });
  }
  var MAX_ROWS = 20000;
  function putBatch(list, i, done) {
    if (i >= list.length) return done();
    dictPut(list.slice(i, i + 1500)).then(function () { putBatch(list, i + 1500, done); }, function () { done(); });
  }
  function importRows(rowsIn, tag) {
    var rows = rowsIn || [], cut = 0;
    if (rows.length > MAX_ROWS) { cut = rows.length - MAX_ROWS; rows = rows.slice(0, MAX_ROWS); }
    var fresh = rows.filter(function (r) { return !USER.rows.some(function (x) { return x.id === r.id; }); });
    var map = {};
    USER.rows.concat(rows).forEach(function (r) { map[r.id] = r; });
    USER.rows = Object.keys(map).map(function (k) { return map[k]; });
    return new Promise(function (res) {
      putBatch(rows, 0, function () {
        applyUser(USER.rows); renderDict(); schedule(true);
        var msg = (tag || '导入') + ' ' + rows.length + ' 条'
          + (fresh.length < rows.length ? '（其中 ' + (rows.length - fresh.length) + ' 条覆盖了同名旧词条）' : '')
          + (cut ? '，超出 ' + MAX_ROWS + ' 条上限的 ' + cut + ' 条已忽略' : '');
        $('#dict-msg').textContent = msg; toast(msg, 4200);
        res();
      });
    });
  }
  function readFile(f) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result || '')); };
      fr.onerror = function () { rej(fr.error || new Error('read')); };
      fr.readAsText(f, 'utf-8');
    });
  }
  /* ================================================== 面板与外观 */
  var SHEETS = ['#ocr', '#dict', '#about'];
  function openSheet(sel) {
    SHEETS.forEach(function (s) { $(s).hidden = s !== sel; });
    closePop();
    if (sel === '#dict') renderDict();
    if (sel === '#about') renderCov();
  }
  function closeSheets() { SHEETS.forEach(function (s) { $(s).hidden = true }); }
  function anySheetOpen() { return SHEETS.some(function (s) { return !$(s).hidden; }); }
  function renderCov() {
    var el = $('#cov'); if (!el || !E) return;
    var c = E.counts(), parts = DIRS.map(function (d) {
      return DIR_LABEL[d] + ' ' + (c[d] ? c[d].w + ' 词 / ' + c[d].p + ' 短语' : '—');
    });
    var src = (E.SOURCES || []).map(function (s) { return s.label; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    el.innerHTML = '本机已加载词条：' + parts.join(' · ') + '<br>来源：' + esc(src.join('、')) +
      '。英文词库来自 Word Atlas（CC BY 4.0，署名 Word Atlas contributors）；日/中文基础词库为本站整理。' +
      '<br>我的词典：' + USER.rows.length + ' 条（优先级最高，仅存本机 IndexedDB）。';
  }
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    var chip = { light: '#f7f5f1', dark: '#141312' }[t] || '#f7f5f1';
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', chip);
    lsSet('theme', t);
  }
  /* ================================================== 本地 OCR（tesseract.js 自托管） */
  var OCR = { lib: null, workers: {}, busy: false };
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = res;
      s.onerror = function () { rej(new Error('加载失败：' + src)); };
      document.head.appendChild(s);
    });
  }
  function ocrStatus(t) { $('#ocr-status').textContent = t; }
  function ocrProg(p) {
    var box = $('#ocr-prog'), bar = box && box.firstElementChild;
    if (!bar) return;
    box.hidden = p == null;
    bar.style.width = Math.max(0, Math.min(100, Math.round(p * 100))) + '%';
  }
  function getOCRWorker(lang) {
    if (OCR.workers[lang]) return Promise.resolve(OCR.workers[lang]);
    var p = (OCR.lib ? Promise.resolve() : loadScript('lib/tesseract.min.js').then(function () { OCR.lib = window.Tesseract; }))
      .then(function () {
        ocrStatus('正在加载本机识别引擎与 ' + lang + ' 语言包（首次稍慢，之后走缓存）…');
        // worker 里用 importScripts 取引擎核心，相对路径会相对 worker 自己的 URL 解析，
        // 所以这里一律给绝对 URL —— 文件仍然全部来自本站，不发生外部请求。
        var base = new URL('./', location.href).href;
        return OCR.lib.createWorker(lang, 1, {
          workerPath: base + 'worker/worker.min.js',
          corePath: base + 'lib/',
          langPath: base + 'data/ocr/',
          gzip: false,
          logger: function (m) {
            if (!m || typeof m.progress !== 'number') return;
            ocrProg(m.progress);
            if (m.status) ocrStatus(String(m.status).replace(/^loading/, '载入').replace(/recognizing/, '识别中'));
          }
        });
      }).then(function (w) { OCR.workers[lang] = w; ocrStatus('识别引擎就绪（Tesseract.js · Apache-2.0，全部本地文件）'); return w; });
    OCR.workers[lang] = p.catch(function (e) { delete OCR.workers[lang]; throw e; });
    return p;
  }
  function runOCR(input) {
    var lang = $('#ocr-lang').value || 'eng';
    OCR.busy = true; $('#ocr-run').disabled = true; ocrProg(0.02);
    return getOCRWorker(lang).then(function (w) {
      ocrStatus('正在识别…');
      return w.recognize(input);
    }).then(function (res) {
      var txt = (res && res.data && res.data.text || '').replace(/\n{3,}/g, '\n\n').trim();
      $('#ocr-text').value = txt;
      ocrProg(null);
      ocrStatus('识别完成：' + txt.length + ' 字符（识别与翻译都在本机，未上传）' + (txt ? '' : ' · 没识别到文字，试试更清晰的截图'));
      if (txt && $('#ocr-auto').checked) { $('#src').value = txt; schedule(true); }
      OCR.busy = false; $('#ocr-run').disabled = false;
    }).catch(function (e) {
      OCR.busy = false; $('#ocr-run').disabled = false; ocrProg(null);
      ocrStatus('识别失败：' + (e && e.message || e) + '（引擎文件需与本站同源加载）');
      toast('OCR 失败，详见面板提示', 3600);
    });
  }
  function showImage(f) {
    var img = $('#ocr-thumb');
    img.hidden = false;
    img.onload = function () { runOCR(img); };
    img.src = URL.createObjectURL(f);
    $('#ocr-file').dataset.name = f.name || '';
  }
  /* ================================================== 事件绑定 */
  function bind() {
    var src = $('#src');
    src.addEventListener('input', function () { schedule(false); });
    src.addEventListener('paste', function () { setTimeout(function () { schedule(true); }, 30); });
    src.addEventListener('drop', function (ev) {
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f && /^image\//.test(f.type)) { ev.preventDefault(); openSheet('#ocr'); showImage(f); }
    });
    src.addEventListener('dblclick', function (ev) {
      var w = wordAt(src.value, caret(src, ev));
      if (w) openPop(w, S.dir, ev.clientX + 8, ev.clientY + 12);
    });
    $('#out').addEventListener('dblclick', function (ev) {
      var b = ev.target.closest && ev.target.closest('b.term');
      var w = b ? b.dataset.w : wordAt(ev.target.textContent, caret(ev.target, ev));
      if (!w) return;
      var d = hasLatin(w) || hasKana(w) ? guessDir(w) : S.dir;
      openPop(w, d, ev.clientX + 8, ev.clientY + 12);
    });
    $('#trace').addEventListener('click', function (ev) {
      var row = ev.target.closest && ev.target.closest('.tr-row');
      if (!row || !row.dataset.src) return;
      var d = S.dir.indexOf('zh2') === 0 ? (hasKanji(row.dataset.src) ? S.dir : guessDir(row.dataset.src)) : S.dir;
      openPop(row.dataset.src, d, ev.clientX + 8, ev.clientY + 12);
    });
    $('#btn-go').addEventListener('click', function () { schedule(true); });
    $('#btn-clear').addEventListener('click', function () { src.value = ''; schedule(true); src.focus(); });
    $('#btn-paste').addEventListener('click', function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) { src.focus(); toast('浏览器不允许直接读剪贴板，请按 Ctrl+V'); return; }
      navigator.clipboard.readText().then(function (t) {
        src.value = (src.value ? src.value.replace(/\s+$/, '') + '\n' : '') + t;
        schedule(true); toast('已粘贴 ' + t.length + ' 字符');
      }).catch(function () { src.focus(); toast('读不到剪贴板，请按 Ctrl+V'); });
    });
    $('#btn-copy').addEventListener('click', copyOut);
    $('#btn-dl').addEventListener('click', downloadOut);
    $$('.dir').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = b.dataset.pair;
        setDir(PAIR_OF[S.dir] === p ? SWAP[S.dir] : PAIR_DEFAULT[p]);
      });
    });
    $('#btn-swap').addEventListener('click', swapDir);
    /* 神经翻译层是可选模块：只有构建里带了 mt/registry.json（安卓 APP 版）才会真的启用，
       网页版加载后自己退出。用 module 脚本挂载，失败也不影响词典引擎。 */
    (function () {
      var s = document.createElement('script');
      s.type = 'module'; s.src = 'mt/boot.js';
      s.onerror = function () { /* 没有模型层，保持词典模式 */ };
      document.head.appendChild(s);
    })();
    $('#btn-theme').addEventListener('click', function () {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
    $('#btn-about').addEventListener('click', function () { anySheetOpen() ? closeSheets() : openSheet('#about'); });
    $('#about-close').addEventListener('click', closeSheets);
    $('#btn-dict').addEventListener('click', function () { anySheetOpen() ? closeSheets() : openSheet('#dict'); });
    $('#dict-close').addEventListener('click', closeSheets);
    $('#btn-image').addEventListener('click', function () { openSheet('#ocr'); $('#file-image').click(); });
    $('#ocr-close').addEventListener('click', closeSheets);
    $('#file-image').addEventListener('change', function () { if (this.files[0]) { openSheet('#ocr'); showImage(this.files[0]); } });
    $('#ocr-file').addEventListener('change', function () { if (this.files[0]) showImage(this.files[0]); });
    $('#ocr-run').addEventListener('click', function () {
      var img = $('#ocr-thumb');
      if (img && !img.hidden && img.src) runOCR(img);
      else if ($('#ocr-text').value.trim()) toast('已有识别结果；重新识别请先选一张图片');
      else { $('#ocr-file').click(); toast('先选一张图片'); }
    });
    $('#ocr-lang').addEventListener('change', function () {
      var img = $('#ocr-thumb'); if (img && !img.hidden && img.src) runOCR(img);
    });
    $('#ocr-fill').addEventListener('click', function () {
      var t = $('#ocr-text').value.trim();
      if (!t) { toast('识别结果为空'); return; }
      $('#src').value = t; closeSheets(); schedule(true); toast('已填入左侧');
    });
    ['dragenter', 'dragover'].forEach(function (t) {
      $('#drop').addEventListener(t, function (ev) { ev.preventDefault(); $('#drop').classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      $('#drop').addEventListener(t, function (ev) { ev.preventDefault(); $('#drop').classList.remove('hot'); });
    });
    $('#drop').addEventListener('drop', function (ev) {
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f && /^image\//.test(f.type)) showImage(f); else toast('请拖入图片文件');
    });
    $('#dict-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var t = $('#d-term').value.trim(), g = $('#d-gloss').value.trim();
      if (!t || !g) { $('#dict-msg').textContent = '词条和译文都要填'; return; }
      addTerm($('#d-dir').value, t, g);
      $('#d-term').value = ''; $('#d-gloss').value = ''; $('#dict-msg').textContent = '';
    });
    $('#dict-import').addEventListener('change', function () {
      var f = this.files && this.files[0]; if (!f) return;
      var force = $('#d-dir').value;
      readFile(f).then(function (txt) {
        var rows;
        if (/\.json$/i.test(f.name) || /^\s*[[{]/.test(txt)) {
          try { rows = parseJSON(JSON.parse(txt), force); }
          catch (e) { $('#dict-msg').textContent = 'JSON 解析失败：' + e.message; return; }
        } else rows = parseText(txt, force);
        if (!rows.length) { $('#dict-msg').textContent = '没解析出任何词条：需要「源语,译文」两列'; return; }
        $('#dict-msg').textContent = '解析出 ' + rows.length + ' 条，正在写入本机词典……';
        importRows(rows, '导入 ' + f.name);
      });
      this.value = '';
    });
    $('#dict-export').addEventListener('click', function () {
      var body = JSON.stringify({ kind: 'transdesk-user-dict', exported: new Date().toISOString(), entries: USER.rows }, null, 1);
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
      a.download = 'transdesk-dict-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('已导出 ' + USER.rows.length + ' 条');
    });
    $('#dict-clear').addEventListener('click', function () {
      if (!USER.rows.length) { toast('我的词典本来就是空的'); return; }
      if (!confirm('清空我的词典？这会删掉本机 ' + USER.rows.length + ' 条自定义词条（不可撤销）。')) return;
      dictClear().then(function () {
        USER.rows = []; applyUser([]); renderDict(); schedule(true);
        $('#dict-msg').textContent = '已清空'; toast('我的词典已清空');
      });
    });
    $('#dict-filter').addEventListener('input', function () { renderDict(); });
    $('#pop-save').addEventListener('click', savePop);
    $('#pop-gloss').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); savePop(); } });
    document.addEventListener('mousedown', function (ev) {
      if ($('#pop').hidden) return;
      if (!ev.target.closest || !ev.target.closest('#pop')) closePop();
    });
    document.addEventListener('keydown', function (ev) {
      var mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key === 'Enter') { ev.preventDefault(); schedule(true); return; }
      if (ev.altKey && (ev.key === 's' || ev.key === 'S')) { ev.preventDefault(); swapDir(); return; }
      if (ev.key === 'Escape') { closePop(); if (anySheetOpen()) closeSheets(); }
      if (mod && ev.key === 'k' && ev.shiftKey) { ev.preventDefault(); $('#src').value = ''; schedule(true); $('#src').focus(); }
    });
  }
  function caret(el, ev) {
    if (el.selectionStart != null && document.activeElement === el) return el.selectionStart;
    if (document.caretPositionFromPoint) {
      var r = document.caretPositionFromPoint(ev.clientX, ev.clientY);
      return r ? r.offset : 0;
    }
    if (document.caretRangeFromPoint) {
      var q = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      return q ? q.startOffset : 0;
    }
    return 0;
  }
  /* ================================================== 启动 */
  function chip(text, warn, title) {
    var c = $('#net-chip'); if (!c) return;
    c.textContent = text; c.classList.toggle('warn', !!warn); if (title) c.title = title;
  }
  function fetchJSON(file) {
    return fetch(file, { cache: 'default' }).then(function (r) {
      if (!r.ok) throw new Error(file + ' → HTTP ' + r.status);
      return r.json();
    });
  }
  function boot() {
    applyTheme(lsGet('theme', window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    paintDirs(); bind();
    var h = (location.hash || '').replace(/^#/, '');
    if (DIRS.indexOf(h) >= 0) setDir(h, true);
    else if (h === 'ocr' || h === 'dict' || h === 'about') openSheet('#' + h);
    window.addEventListener('hashchange', function () {
      var k = (location.hash || '').replace(/^#/, '');
      if (DIRS.indexOf(k) >= 0) setDir(k, true);
      else if (k === 'ocr' || k === 'dict' || k === 'about') openSheet('#' + k);
    });
    if (!E) {
      chip('引擎缺失', true, 'web/engine.js 没有加载成功');
      $('#out').innerHTML = '<p class="empty">引擎文件缺失（web/engine.js）。请确认站点目录完整后刷新。</p>';
      return;
    }
    chip('正在载入词库…', true);
    var t0 = performance.now();
    Promise.all(DATA.map(function (d) {
      return fetchJSON(d.file).then(function (j) { return { d: d, j: j }; }, function (e) { return { d: d, err: e }; });
    })).then(function (rs) {
      var n = 0, fail = [];
      rs.forEach(function (x) {
        if (x.err) { console.warn(x.err); fail.push(x.d.file); return; }
        n += E.load(x.d.dir, x.j, {
          label: (x.j.meta && x.j.meta.label) || x.d.file,
          attribution: (x.j.meta && x.j.meta.attribution) || ''
        });
      });
      S.ready = n > 0;
      var ms = Math.round(performance.now() - t0);
      if (fail.length) chip('词库不全（缺 ' + fail.length + ' 个）', true, fail.join('、'));
      else chip('离线就绪', false, '引擎与词库都是本机文件，断网也能用');
      $('#dst-meta').textContent = '词库 ' + n.toLocaleString() + ' 条 · ' + ms + ' ms';
      renderCov();
      if (fail.length) toast('有 ' + fail.length + ' 个词库文件没加载到：' + fail.join('、'), 5000);
    });
    dictAll().then(function (rows) {
      if (rows && rows.length) USER.rows = rows.filter(function (r) { return r && r.dir && r.term; });
      applyUser(USER.rows); renderDict();
      var saved = lsGet('text', '');
      if (saved) { $('#src').value = saved; toast('已恢复上次输入'); }
      schedule(true);
    });
    $('#src').addEventListener('input', function () { lsSet('text', $('#src').value.slice(0, 20000)); });
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW 未注册', e); });
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();