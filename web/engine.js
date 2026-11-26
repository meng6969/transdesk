/* 译台 TransDesk — 离线词典 + 规则引擎 (v2)
 *
 * 管线：分句 → 单元化（英文词形还原 / 日文活用还原 / 中文最长匹配）
 *      → 功能词上下文归并 → 成分切分（主/谓/宾/介词短语）
 *      → 目标语语序重排（状语前置、of→的、比较、疑问、时态助词）
 *      → 成句 + 逐单元可解释轨迹
 * 引擎不发出任何网络请求；所有词典与规则均来自本站文件。
 */
(function (global) {
'use strict';

var E = {};

/* ====================================================== 词典容器 */
var DIRS = ['en2zh', 'ja2zh', 'zh2en', 'zh2ja'];
var D = {};
DIRS.forEach(function (d) { D[d] = { w: new Map(), p: new Map(), pmax: 1 }; });
var SOURCES = [];
E.D = D; E.SOURCES = SOURCES;

function srcIsCJK(dir) { return dir !== 'en2zh'; }
function keyOf(dir, s) {
  s = String(s).replace(/[\u3000\uff01-\uff5e]/g, function (c) { return srcIsCJK(dir) ? c : String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  s = s.replace(/\s+/g, ' ').trim();
  return srcIsCJK(dir) ? s.replace(/\s/g, '') : s.toLowerCase();
}

var POS_ALIAS = { n: 'n', noun: 'n', pron: 'r', num: 'm', v: 'v', vt: 'v', vi: 'v', a: 'a', adj: 'a', adv: 'd', prep: 'p', conj: 'c', aux: 'x', int: 'i', det: 't', art: 't' };

/* 只剔除明确的参照/变体释义，不把 see-saw、compare notes 等实词误删。
   Python 构建时已做同样过滤；这里同时防御旧缓存和用户导入的脏数据。 */
var REF_SENSE = /^(?:(?:erroneous|erhua|old|unofficial|ancient|archaic|classical|japanese|taiwan|obscure|emphatic|alternative|variant|literary|dialectal|dated|colloquial|simplified|traditional|a|short|contracted|nonstandard|respectful|causative|polite) )?(?:variant|spelling)(?: (?:chinese )?(?:character|pronunciation))?(?: of\b|$)|^(?:(?:erroneous|erhua|old|unofficial|ancient|archaic|classical|japanese|taiwan|obscure|emphatic|alternative|variant|literary|dialectal|dated|colloquial|simplified|traditional|a|short|contracted|nonstandard|respectful|causative|polite) )form(?: (?:chinese )?(?:character|pronunciation))? of\b|^(?:(?:erroneous|erhua|old|unofficial|ancient|archaic|classical|japanese|taiwan|obscure|emphatic|alternative|variant|literary|dialectal|dated|colloquial|simplified|traditional|a|short|contracted|nonstandard|respectful|causative|polite) )?form(?: (?:chinese )?(?:character|pronunciation))?$|^see (?:the )?(?:entry|article|sense|above|below)\b|^参见(?:某|该|此|上|下)?条/i;
function cleanGloss(g) {
  var parts = String(g || '').split(/[；;｜|]/).filter(function (s) { return s.trim() && !REF_SENSE.test(s.trim()); });
  return parts.join('；');
}
function cleanAlt(alt) {
  return String(alt || '').split(';').filter(function (kv) {
    var i = kv.indexOf(':');
    return i < 1 || !REF_SENSE.test(kv.slice(i + 1).trim());
  }).join(';');
}

/** raw: "尊重；敬佩" | ["尊重","n","B1","n:尊重;v:遵守"] */
function mk(raw, prio) {
  var g = '', pos = '', tag = '', alt = null;
  if (Array.isArray(raw)) { g = raw[0] || ''; pos = raw[1] || ''; tag = raw[2] || ''; alt = raw[3] || ''; }
  else if (raw && typeof raw === 'object') { g = raw.g || ''; pos = raw.pos || ''; tag = raw.tag || ''; alt = raw.alt || ''; }
  else g = String(raw == null ? '' : raw);
  g = cleanGloss(g); alt = cleanAlt(alt);
  if (!g && !alt) return null;
  var m = g.match(/^\s*([a-zA-Z]{1,6})\.\s*/);
  if (m && !pos) pos = POS_ALIAS[m[1].toLowerCase()] || '';
  var map = {};
  if (alt) String(alt).split(';').forEach(function (kv) {
    var i2 = kv.indexOf(':'); if (i2 < 1) return;
    var k = POS_ALIAS[kv.slice(0, i2)] || kv.slice(0, i2), v = kv.slice(i2 + 1);
    if (v && !map[k]) map[k] = v;
  });
  return { g: g, pos: POS_ALIAS[pos] || pos || 'x', tag: tag, senses: map, prio: prio || 1 };
}

/** 取用于句中的短译：首个分句、去括注；不再截断完整外文短语。 */
function short(g) {
  var s = String(g || '').split(/[；;｜|]/)[0];
  s = s.replace(/[（(][^）)]{0,14}[)）]/g, '').replace(/^[^，,]{0,4}[。]/, '');
  s = s.replace(/…[…]?/g, '…');
  s = s.trim();
  return s;
}

/** 按上下文词性挑义项 */
function sense(e, want) {
  if (!e) return '';
  if (want && e.senses && e.senses[want]) return e.senses[want];
  var keys = Object.keys(e.senses || {});
  if (want && keys.length) { for (var i = 0; i < keys.length; i++) if (keys[i][0] === want[0] && e.senses[keys[i]]) return e.senses[keys[i]]; }
  return e.g;
}

/* 词库随行词频表：两个 36 进制字符一个词头，0 表示词表里没这个词 */
var B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
var FREQ_STEPS = 1295;
function freqLog(s, at, fmin) {
  var hi = B36.indexOf(s.charAt(at)), lo = B36.indexOf(s.charAt(at + 1));
  if (hi < 0 || lo < 0) return 0;
  var v = hi * 36 + lo;
  return v ? fmin * v / FREQ_STEPS : 0;      // 0 → 交给调用方兜底
}

E.load = function (dir, obj, opts) {
  opts = opts || {};
  var T = D[dir];
  if (!T) throw new Error('unknown dir ' + dir);
  var prio = opts.prio ? 2 : 1, n = 0;
  /* 词频串按 w 的键序对齐（词头里没有纯数字键，JSON 的键序才不会被重排）。
     长度对不上就整体不用，词库和词序表不会各说各话。 */
  var fs = typeof obj.f === 'string' ? obj.f : '';
  var fmin = (obj.meta && obj.meta.fmin) || -18;
  function set(map, k, v) {
    var old = map.get(k);
    if (old && old.prio >= prio) return false;
    if (v.lf == null && old && old.lf != null) v.lf = old.lf;   // 用户覆盖层不带词频
    map.set(k, v); return true;
  }
  if (obj && obj.w) {
    var wk = Object.keys(obj.w), useF = fs.length === wk.length * 2;
    wk.forEach(function (k, wi) {
      var key = keyOf(dir, k);
      if (!key) return;
      var ent = mk(obj.w[k], prio);
      if (!ent) return;
      if (useF) ent.lf = freqLog(fs, wi * 2, fmin);
      if (set(T.w, key, ent)) n++;
    });
  }
  if (obj && obj.p) Object.keys(obj.p).forEach(function (k) {
    var key = keyOf(dir, k);
    if (!key) return;
    var ent = mk(obj.p[k], prio);
    if (!ent) return;
    if (set(T.p, key, ent)) n++;
    var wc = key.indexOf(' ') >= 0 ? key.split(' ').length : key.length;
    if (wc > T.pmax) T.pmax = Math.min(wc, 8);
  });
  if (opts.label) SOURCES.push({ label: opts.label, dir: dir, n: n, prio: prio, attribution: opts.attribution || '' });
  return n;
};
E.unload = function (dir, term) {
  var T = D[dir], k = keyOf(dir, term), hit = false;
  if (T.w.get(k) && T.w.get(k).prio >= 2) { T.w.delete(k); hit = true; }
  if (T.p.get(k) && T.p.get(k).prio >= 2) { T.p.delete(k); hit = true; }
  return hit;
};
E.lookup = function (dir, term) { var T = D[dir], k = keyOf(dir, term); return T.w.get(k) || T.p.get(k) || null; };
E.counts = function () { var o = {}; DIRS.forEach(function (d) { o[d] = { w: D[d].w.size, p: D[d].p.size }; }); return o; };
E.mk = mk; E.keyOf = keyOf; E.short = short; E.sense = sense;

/* ============================================ 封闭类（英文功能词） */
var DET = { a: 1, an: 1, the: 1, some: 1, any: 1, every: 1, each: 1, no: 1 };
var DEMO = { this: '这个', these: '这些', that: '那个', those: '那些' };
var PRON = {
  i: '我', me: '我', my: '我的', mine: '我的', myself: '我自己', we: '我们', us: '我们', our: '我们的', ours: '我们的', ourselves: '我们自己',
  you: '你', your: '你的', yours: '你的', yourself: '你自己', yourselves: '你们自己',
  he: '他', him: '他', his: '他的', himself: '他自己', she: '她', her: '她的', hers: '她的', herself: '她自己',
  it: '它', its: '它的', itself: '它本身', they: '他们', them: '他们', their: '他们的', theirs: '他们的', themselves: '他们自己',
  someone: '有人', somebody: '有人', anyone: '任何人', anybody: '任何人', everyone: '每个人', everybody: '每个人',
  everything: '一切', something: '某件事', nothing: '什么都没', nobody: '没人', one: '一个', all: '全部', both: '两者都', none: '没有一个'
};
var WH = { what: '什么', when: '什么时候', where: '哪里', why: '为什么', who: '谁', whom: '谁', whose: '谁的', which: '哪个', how: '怎么', whether: '是否', whatever: '无论什么' };
var WH_OBJ = { what: 1, whom: 1, who: 1, which: 1, whose: 1 };      // 中文里回到宾语位置
var WH_ADV = { when: 1, where: 1, why: 1, how: 1 };                   // 中文里作状语
var BE = { be: 'x', am: 'x', is: 'x', are: 'x', was: 'past', were: 'past', been: 'pp', being: 'ing' };
var MODAL = { will: 'fut', would: 'fut2', shall: 'fut', can: 'abil', could: 'abil', may: 'proh', might: 'proh', must: 'nec', should: 'nec', ought: 'nec' };
var AUXPERF = { have: 1, has: 1, had: 1 };
var AUXDUMMY = { do: 1, does: 1, did: 1 };
/** do/does/did 只有后面紧跟主语或否定词时才是「疑问/时态助动词」，否则是实义动词「做」 */
function doAux(toks, i) {
  var n = toks[i + 1];
  if (!n || n.type !== 'w') return false;
  return /^(i|we|you|he|she|it|they|me|him|us|them|someone|somebody|anyone|anybody|everyone|everybody|nobody|no one|there|not|never|hardly|always|often)$/.test(n.l);
}
var NEG = { not: '不', "n't": '不', never: '从不', neither: '既不', nor: '也不' };
var CONJ = { and: '并且', but: '但是', or: '或者', so: '所以', because: '因为', although: '虽然', though: '虽然', while: '而', unless: '除非', if: '如果', however: '然而', therefore: '因此', thus: '因此', yet: '不过', plus: '而且', since: '既然', whereas: '而', until: '直到', after: '在…之后', before: '在…之前', when: '当', as: '由于' };
/* 介词 → 角色 */
var PP = {
  in: 'loc', on: 'loc', at: 'loc', upon: 'loc', inside: 'loc', outside: 'loc', near: 'loc', around: 'loc',
  by: 'ag', with: 'co', without: 'wo', about: 'abt', against: 'ag2', between: 'loc', among: 'loc',
  from: 'src', to: 'dst', into: 'dst', onto: 'dst', toward: 'dst', towards: 'dst',
  for: 'for', of: 'gen', as: 'as', like: 'like', per: 'per', except: 'ex', beyond: 'loc', over: 'loc',
  under: 'loc', above: 'loc', below: 'loc', behind: 'loc', beside: 'loc', during: 'tmp', since: 'tmp',
  until: 'tmp', till: 'tmp', after: 'tmp', before: 'tmp', through: 'ag', across: 'loc', versus: 'ag2'
};
var PP_ZH = {
  loc: '在', ag: '通过', co: '和', wo: '不', abt: '关于', ag2: '反对', src: '来自', dst: '到',
  for: '为了', gen: '的', as: '作为', like: '像', per: '每', ex: '除了', tmp: '在', 'of': '的'
};
var TEMPORAL = { time: 1, day: 1, days: 1, week: 1, month: 1, year: 1, morning: 1, evening: 1, night: 1, noon: 1, afternoon: 1, weekend: 1 };
var ADV = {
  very: '很', really: '确实', too: '太', quite: '相当', rather: '比较', just: '只是', now: '现在', today: '今天',
  tomorrow: '明天', yesterday: '昨天', always: '总是', often: '经常', sometimes: '有时', usually: '通常',
  already: '已经', still: '仍然', yet: '还', soon: '很快', again: '再次', maybe: '也许', perhaps: '也许',
  almost: '几乎', hardly: '几乎不', only: '只', even: '甚至', also: '也', more: '更', most: '最', less: '更少',
  much: '非常', many: '许多', enough: '足够', well: '好', here: '这里', there: '那里', then: '那时',
  together: '一起', quickly: '很快地', slowly: '缓慢地', clearly: '清楚地', probably: '大概', certainly: '肯定',
  actually: '其实', finally: '最终', simply: '仅仅', generally: '通常', particularly: '尤其', hardly2: ''
};
var ADJ_PRE = { good: '好', bad: '坏', big: '大', small: '小', new: '新', old: '旧', long: '长', hot: '热', cold: '冷' };

/* ============================================ 封闭类（日文） */
var JA_PART = {
  'は': { f: 'topic', zh: '' }, 'が': { f: 'subj', zh: '' }, 'を': { f: 'obj', zh: '' },
  'に': { f: 'obl', role: 'tgt' }, 'で': { f: 'obl', role: 'pla' }, 'へ': { f: 'obl', role: 'dst' },
  'と': { f: 'obl', role: 'com' }, 'も': { f: 'subj', zh: '也' }, 'から': { f: 'obl', role: 'src' },
  'まで': { f: 'obl', role: 'end' }, 'より': { f: 'obl', role: 'cmp' }, 'や': { f: 'none', zh: '和' },
  'など': { f: 'none', zh: '之类' }, 'しか': { f: 'obl', role: 'only' }, 'だけ': { f: 'none', zh: '只' },
  'ずつ': { f: 'none', zh: '各' }, 'の': { f: 'gen', zh: '的' }, 'ば': { f: 'cond', zh: '如果' },
  'ので': { f: 'caus', zh: '因为' }, 'のに': { f: 'conc', zh: '却' }, 'ため': { f: 'obl', role: 'for' },
  '通り': { f: 'obl', role: 'as' }, '向け': { f: 'obl', role: 'for' }, 'について': { f: 'obl', role: 'abt' }
};
var JA_ROLE_ZH = { tgt: '对', pla: '在', dst: '往', com: '和', src: '从', end: '到', cmp: '比', only: '只有', 'for': '为了', abt: '关于', as: '按照' };
var JA_CONJ = { 'が': '不过', 'けど': '但是', 'けれども': '但是', 'けれど': '但是', 'でも': '不过', 'しかし': '但是', 'そして': '然后', 'そこで': '于是', 'だから': '所以', 'ですから': '所以', 'なので': '所以', 'また': '另外', 'なお': '另外', 'もし': '如果', 'または': '或者', 'あるいは': '或者', 'つまり': '也就是说', '例えば': '例如', 'ところで': '话说', 'すると': '于是' };
var JA_FINAL = {
  'か': { q: 1 }, 'ませんか': { sug: 1 }, 'ましょうか': { sug: 1 }, 'たいですか': { sug: 1 }, 'でしょうか': { q: 1, guess: 1 },
  'かな': { q: 1, soft: '呢' }, 'かね': { q: 1 }, 'ね': { soft: '呢' }, 'ねぇ': { soft: '呢' }, 'よ': { soft: '' },
  'ですよ': { soft: '哦' }, 'ですね': { soft: '是啊' }, 'でしょう': { guess: '吧' }, 'だろう': { guess: '吧' },
  'だろ': { guess: '吧' }, 'っしょ': { guess: '吧' }, 'じゃない': { qnot: 1 }, 'な': { ban: '别' }, 'なよ': { ban: '别' },
  'んだ': { expl: 1 }, 'のだ': { expl: 1 }, 'のです': { expl: 1 }, 'んですよ': { expl: 1, soft: '哦' }
};
var JA_MODAL = [
  [/^(?:て|で)いただけませんか$/, '能否请'],
  [/^(?:て|で)いただけますか$/, '能否请'],
  [/^(?:て|で)もらえませんか$/, '能否'],
  [/^(?:て|で)ください$/, '请'],
  [/^(?:て|で)くださいませんか$/, '能否请'],
  [/^ことが(?:できませんでした|できませんでしたか)$/, '没能'],
  [/^ことが(?:できません|できませんでした)$/, '不能'],
  [/^ことが(?:できました|できます|できる|出来た|出来ません)$/, '能'],
  [/^(?:と|って)思いました$/, '觉得'],
  [/^(?:と|って)思います$/, '觉得'],
  [/^(?:と|って)思って(?:いました|います)$/, '觉得'],
  [/^(?:と|って)思いませんか$/, '不觉得'],
  [/^たい(?:と思います|思いました)$/, '想'],
  [/^(?:かもしれません|かも知れません)$/, '可能'],
  [/^すぎ(?:て|で)(?:います|いました|ます|ました|た)?$/, '太多'],
  [/^すぎ(?:ます|ました|た|る)?$/, '太'],
  [/^(?:て|で)しまいます$/, '不小心'],
  [/^ましょう$/, '吧'],
  [/^(?:て|で)みます$/, '尝试'],
  [/^(?:て|で)みました$/, '尝试过'],
  [/^ない(?:で|では)$/, '不'],
  [/^(?:ない|ありません)?はずです$/, '应该']
];
var JA_TIME = ['今日', '昨日', '明日', '明後日', '一昨日', '今朝', '今', '朝', '昼', '夜', '夕方', '午前', '午後', '毎日', '毎年', '毎月', '毎朝', '先週', '今週', '来週', '先月', '今月', '来月', '去年', '今年', '来年', '最近', '当時', '現在', '将来', '昔', 'いつも', 'すぐ', 'やっと', 'まだ', 'もう', '何時', '何日', '何時も'];
var JA_TIME_M = {}; JA_TIME.forEach(function (x) { JA_TIME_M[x] = 1; });
var JA_COUNTER = { 'つ': '个', '個': '个', '人': '个人', '回': '次', '度': '次', '枚': '张', '台': '台', '冊': '本', '本': '根', '匹': '只', '杯': '杯', '歳': '岁', '年': '年', '月': '个月', '日': '号', '時': '点', '分': '分', '秒': '秒', '円': '日元', '件': '件', '通': '封', '口': '份', '艘': '艘', '架': '架', '頭': '头', '軒': '家', '泊': '晚', '問': '间' };
var JA_MOTION = { '行く': '去', '来る': '来', '戻る': '回', '帰る': '回', '入る': '进', '出る': '出', '登る': '爬', '降りる': '下' };
var PUNCT_JA = { '、': '，', '。': '。', '「': '“', '」': '”', '『': '‘', '』': '’', '（': '（', '）': '）', '！': '！', '？': '？', '：': '：', '；': '；', '…': '……', '・': '、', '〜': '~', 'ー': 'ー', ',': '，', '.': '。', '?': '？', '!': '！', ':': '：', ';': '；' };
var PUNCT_EN = { ',': '，', ';': '；', ':': '：', '!': '！', '?': '？', '(': '（', ')': '）', '"': '', "'": '', '-': '—', '–': '—', '…': '……', '/': '/', '%': '%', '&': '&', '+': '+', '=': '=', '#': '#', '@': '@', '*': '*', '[': '［', ']': '］', '<': '', '>': '', '|': '', '_': '' };

/* ==================================================== 分句与分词 */
function splitBlocks(txt) {
  return String(txt).replace(/\r\n?/g, '\n').split(/\n/).map(function (s) { return s.trim(); });
}
var LISTHEAD = /^(\s*)(\d{1,2}[.)、]|[a-z][.)]|[·•\-–—*])\s+/i;

function splitSentences(block, dir) {
  if (!block) return [];
  if (dir === 'zh2en' || dir === 'zh2ja') {
    var z = block.split(/(?<=[。！？；])/).map(trim).filter(Boolean);
    return z.length ? z : [trim(block)];
  }
  var s = block.replace(/(\d)\.(\d)/g, '$1\u0002$2')
               .replace(/\b(Mr|Mrs|Ms|Dr|Prof|St|vs|etc|Jr|Sr|Inc|Ltd|Co|No|Fig|approx|e\.g|i\.e)\.\s/gi, '$1\u0001 ');
  var out = [], buf = '';
  for (var i = 0; i < s.length; i++) {
    buf += s[i];
    var c = s[i], nx = s[i + 1] || '';
    if ((c === '。' || c === '！' || c === '？' || c === '.' || c === '!' || c === '?') && (nx === '' || /[\s\)”』」’']/.test(nx))) { out.push(trim(buf)); buf = ''; }
    else if ((c === '；' || c === ';') && (nx === '' || /\s/.test(nx))) { out.push(trim(buf)); buf = ''; }
    else if (c === '…' && (s[i + 1] === '' || /\s/.test(nx))) { out.push(trim(buf)); buf = ''; }
  }
  if (trim(buf)) out.push(trim(buf).replace(/\u0001/g, '.').replace(/\u0002/g, '.'));
  return out.length ? out : [trim(block)];
}
function trim(s) { return String(s == null ? '' : s).replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''); }

var RE_EN = /[A-Za-z][A-Za-z0-9'’\-]*|[0-9]+(?:[.,][0-9]+)*(?:\s?%|[KkMmBb])?|[$€£¥][0-9][0-9,.]*|[^\sA-Za-z0-9]/g;
function tokenizeEn(str) {
  var ms = str.match(RE_EN) || [], out = [];
  for (var i = 0; i < ms.length; i++) {
    var x = ms[i];
    out.push({ src: x, type: /^[A-Za-z]/.test(x) ? 'w' : /^[0-9$€£¥]/.test(x) ? 'n' : 's', l: x.toLowerCase() });
  }
  return out;
}
/* 假名片段按平/片分段：プレゼント、コーヒー 这类外来语混在平假名串里就查不到词了。 */
var RE_JA = /[一-鿿㐀-䶿〆々ー〜]+|[぀-ゟ]+|[゠-ヿー]+|[A-Za-z]+|[0-9]+(?:\.[0-9]+)?|\s+|[^\s]/g;
function tokenizeJa(str) {
  var ms = str.match(RE_JA) || [], out = [];
  for (var i = 0; i < ms.length; i++) {
    var x = ms[i];
    if (/^\s+$/.test(x)) continue;
    out.push({ src: x, type: /^[一-鿿㐀-䶿〆々]/.test(x) ? 'k' : /^[぀-ゟ]/.test(x) ? 'h' : /^[゠-ヿ]/.test(x) ? 'c' : /^[0-9]/.test(x) ? 'n' : /^[A-Za-z]/.test(x) ? 'r' : 's' });
  }
  return out;
}

/* =============================================== 英文词形还原 */
var IRR = {};
[['was', 'be', 'past'], ['were', 'be', 'past'], ['been', 'be', 'pp'], ['being', 'be', 'ing'],
 ['had', 'have', 'past'], ['has', 'have', '3sg'], ['having', 'have', 'ing'],
 ['did', 'do', 'past'], ['does', 'do', '3sg'], ['done', 'do', 'pp'], ['doing', 'do', 'ing'],
 ['went', 'go', 'past'], ['gone', 'go', 'pp'], ['comes', 'come', '3sg'], ['came', 'come', 'past'], ['coming', 'come', 'ing'],
 ['made', 'make', 'past'], ['makes', 'make', '3sg'], ['making', 'make', 'ing'],
 ['took', 'take', 'past'], ['takes', 'take', '3sg'], ['taken', 'take', 'pp'], ['taking', 'take', 'ing'],
 ['got', 'get', 'past'], ['gotten', 'get', 'pp'], ['gets', 'get', '3sg'], ['getting', 'get', 'ing'],
 ['gave', 'give', 'past'], ['given', 'give', 'pp'], ['gives', 'give', '3sg'], ['giving', 'give', 'ing'],
 ['knew', 'know', 'past'], ['known', 'know', 'pp'], ['knows', 'know', '3sg'],
 ['thought', 'think', 'past'], ['thinks', 'think', '3sg'], ['thinking', 'think', 'ing'],
 ['saw', 'see', 'past'], ['seen', 'see', 'pp'], ['sees', 'see', '3sg'], ['seeing', 'see', 'ing'],
 ['said', 'say', 'past'], ['says', 'say', '3sg'], ['saying', 'say', 'ing'],
 ['told', 'tell', 'past'], ['tells', 'tell', '3sg'], ['telling', 'tell', 'ing'],
 ['found', 'find', 'past'], ['finds', 'find', '3sg'], ['finding', 'find', 'ing'],
 ['held', 'hold', 'past'], ['holds', 'hold', '3sg'], ['holding', 'hold', 'ing'],
 ['left', 'leave', 'past'], ['leaves', 'leave', '3sg'], ['leaving', 'leave', 'ing'],
 ['met', 'meet', 'past'], ['meets', 'meet', '3sg'], ['meeting', 'meet', 'ing'],
 ['ran', 'run', 'past'], ['runs', 'run', '3sg'], ['running', 'run', 'ing'],
 ['felt', 'feel', 'past'], ['feels', 'feel', '3sg'], ['feeling', 'feel', 'ing'],
 ['showed', 'show', 'past'], ['shown', 'show', 'pp'], ['shows', 'show', '3sg'], ['showing', 'show', 'ing'],
 ['heard', 'hear', 'past'], ['hears', 'hear', '3sg'], ['hearing', 'hear', 'ing'],
 ['began', 'begin', 'past'], ['begun', 'begin', 'pp'], ['begins', 'begin', '3sg'], ['beginning', 'begin', 'ing'],
 ['wrote', 'write', 'past'], ['written', 'write', 'pp'], ['writes', 'write', '3sg'], ['writing', 'write', 'ing'],
 ['became', 'become', 'past'], ['becomes', 'become', '3sg'], ['becoming', 'become', 'ing'],
 ['stood', 'stand', 'past'], ['stands', 'stand', '3sg'], ['standing', 'stand', 'ing'],
 ['lost', 'lose', 'past'], ['loses', 'lose', '3sg'], ['losing', 'lose', 'ing'],
 ['paid', 'pay', 'past'], ['pays', 'pay', '3sg'], ['paying', 'pay', 'ing'],
 ['sat', 'sit', 'past'], ['sits', 'sit', '3sg'], ['sitting', 'sit', 'ing'],
 ['spoke', 'speak', 'past'], ['spoken', 'speak', 'pp'], ['speaks', 'speak', '3sg'], ['speaking', 'speak', 'ing'],
 ['fell', 'fall', 'past'], ['fallen', 'fall', 'pp'], ['falls', 'fall', '3sg'], ['falling', 'fall', 'ing'],
 ['kept', 'keep', 'past'], ['keeps', 'keep', '3sg'], ['keeping', 'keep', 'ing'],
 ['meant', 'mean', 'past'], ['means', 'mean', '3sg'], ['meaning', 'mean', 'ing'],
 ['brought', 'bring', 'past'], ['brings', 'bring', '3sg'], ['bringing', 'bring', 'ing'],
 ['ate', 'eat', 'past'], ['eaten', 'eat', 'pp'], ['eats', 'eat', '3sg'], ['eating', 'eat', 'ing'],
 ['drank', 'drink', 'past'], ['drunk', 'drink', 'pp'], ['drinks', 'drink', '3sg'], ['drinking', 'drink', 'ing'],
 ['bought', 'buy', 'past'], ['buys', 'buy', '3sg'], ['buying', 'buy', 'ing'],
 ['built', 'build', 'past'], ['builds', 'build', '3sg'], ['building', 'build', 'ing'],
 ['caught', 'catch', 'past'], ['catches', 'catch', '3sg'], ['catching', 'catch', 'ing'],
 ['chose', 'choose', 'past'], ['chosen', 'choose', 'pp'], ['chooses', 'choose', '3sg'], ['choosing', 'choose', 'ing'],
 ['drew', 'draw', 'past'], ['drawn', 'draw', 'pp'], ['draws', 'draw', '3sg'], ['drawing', 'draw', 'ing'],
 ['drove', 'drive', 'past'], ['driven', 'drive', 'pp'], ['drives', 'drive', '3sg'], ['driving', 'drive', 'ing'],
 ['flew', 'fly', 'past'], ['flown', 'fly', 'pp'], ['flies', 'fly', '3sg'], ['flying', 'fly', 'ing'],
 ['grew', 'grow', 'past'], ['grown', 'grow', 'pp'], ['grows', 'grow', '3sg'], ['growing', 'grow', 'ing'],
 ['rode', 'ride', 'past'], ['ridden', 'ride', 'pp'], ['rides', 'ride', '3sg'], ['riding', 'ride', 'ing'],
 ['rose', 'rise', 'past'], ['risen', 'rise', 'pp'], ['rises', 'rise', '3sg'], ['rising', 'rise', 'ing'],
 ['sang', 'sing', 'past'], ['sung', 'sing', 'pp'], ['sings', 'sing', '3sg'], ['singing', 'sing', 'ing'],
 ['spent', 'spend', 'past'], ['spends', 'spend', '3sg'], ['spending', 'spend', 'ing'],
 ['swam', 'swim', 'past'], ['swum', 'swim', 'pp'], ['swims', 'swim', '3sg'], ['swimming', 'swim', 'ing'],
 ['taught', 'teach', 'past'], ['teaches', 'teach', '3sg'], ['teaching', 'teach', 'ing'],
 ['threw', 'throw', 'past'], ['thrown', 'throw', 'pp'], ['throws', 'throw', '3sg'], ['throwing', 'throw', 'ing'],
 ['understood', 'understand', 'past'], ['understands', 'understand', '3sg'], ['understanding', 'understand', 'ing'],
 ['won', 'win', 'past'], ['wins', 'win', '3sg'], ['winning', 'win', 'ing'],
 ['wore', 'wear', 'past'], ['worn', 'wear', 'pp'], ['wears', 'wear', '3sg'], ['wearing', 'wear', 'ing'],
 ['children', 'child', 'pl'], ['women', 'woman', 'pl'], ['men', 'man', 'pl'], ['teeth', 'tooth', 'pl'],
 ['feet', 'foot', 'pl'], ['mice', 'mouse', 'pl'], ['geese', 'goose', 'pl'], ['lives', 'life', 'pl'],
 ['knives', 'knife', 'pl'], ['wives', 'wife', 'pl'], ['leaves', 'leaf', 'pl'], ['people', 'person', 'pl'],
 ['better', 'good', 'comp'], ['best', 'good', 'sup'], ['worse', 'bad', 'comp'], ['worst', 'bad', 'sup'],
 ['older', 'old', 'comp'], ['eldest', 'old', 'sup'], ['happier', 'happy', 'comp'], ['happiest', 'happy', 'sup'],
 ['studied', 'study', 'past'], ['studies', 'study', '3sg'], ['studying', 'study', 'ing'],
 ['tried', 'try', 'past'], ['tries', 'try', '3sg'], ['trying', 'try', 'ing'], ['carried', 'carry', 'past'], ['carries', 'carry', '3sg']
].forEach(function (r) { if (!IRR[r[0]]) IRR[r[0]] = { base: r[1], feat: r[2] }; });

/* 纯词形计算不依赖词库；小容量 LRU 避免重复输入/词形反复扫描。
   返回的数组在引擎中只读，不清空或改写。 */
var morphCache = new Map();
function cachedMorph(key, make) {
  var hit = morphCache.get(key);
  if (hit) { morphCache.delete(key); morphCache.set(key, hit); return hit; }
  var made = make();
  morphCache.set(key, made);
  if (morphCache.size > 2048) morphCache.delete(morphCache.keys().next().value);
  return made;
}
function enForms(word) {
  var original = String(word);
  return cachedMorph('en:' + original, function () { return makeEnForms(original); });
}
function makeEnForms(word) {
  var l = String(word).toLowerCase().replace(/[^\w'’-]/g, '').replace(/[’']s$/, '');
  var out = [], seen = {};
  function push(b, f) { if (b && !seen[b]) { seen[b] = 1; out.push({ base: b, feat: f || '' }); } }
  if (IRR[l]) push(IRR[l].base, IRR[l].feat);
  push(l, '');
  if (/ies$/.test(l)) push(l.slice(0, -3) + 'y', 'pl');
  if (/(ses|xes|zes|ches|shes)$/.test(l)) push(l.slice(0, -2), 'pl');
  if (/ves$/.test(l)) { push(l.slice(0, -3) + 'f', 'pl'); push(l.slice(0, -3) + 've', 'pl'); }
  if (/s$/.test(l) && !/ss$/.test(l)) push(l.slice(0, -1), 'pl');
  if (/ying$/.test(l)) push(l.slice(0, -4) + 'ie', 'ing');
  if (/ing$/.test(l)) { var st = l.slice(0, -3); push(st, 'ing'); push(st + 'e', 'ing'); if (/([^aeiou])\1$/.test(st)) push(st.slice(0, -1), 'ing'); }
  if (/ied$/.test(l)) push(l.slice(0, -3) + 'y', 'past');
  if (/ed$/.test(l)) { var s2 = l.slice(0, -2); push(s2, 'past'); push(s2 + 'e', 'past'); if (/([^aeiou])\1$/.test(s2)) push(s2.slice(0, -1), 'past'); }
  if (/d$/.test(l) && !/^[aeiou]d$/.test(l)) push(l.slice(0, -1), 'past');
  if (/ily$/.test(l)) push(l.slice(0, -3) + 'y', 'adv');
  if (/ly$/.test(l)) { push(l.slice(0, -2), 'adv'); if (/lly$/.test(l)) push(l.slice(0, -3), 'adv'); }
  if (/ier$/.test(l)) push(l.slice(0, -3) + 'y', 'comp');
  if (/iest$/.test(l)) push(l.slice(0, -4) + 'y', 'sup');
  if (/er$/.test(l) && l.length > 4) { var s3 = l.slice(0, -2); push(s3, 'comp'); push(s3 + 'e', 'comp'); if (/([^aeiou])\1$/.test(s3)) push(s3.slice(0, -1), 'comp'); }
  if (/est$/.test(l) && l.length > 5) { var s4 = l.slice(0, -3); push(s4, 'sup'); push(s4 + 'e', 'sup'); }
  if (/ness$/.test(l)) push(l.slice(0, -5), 'noun');
  if (/ments?$/.test(l)) push(l.replace(/s$/, '').slice(0, -4), 'noun');
  if (/tions?$/.test(l)) push(l.replace(/s$/, '').slice(0, -4) + 'e', 'noun');
  if (/(ities|ity)$/.test(l)) push(l.replace(/ities$/, 'y').replace(/ity$/, 'y'), 'noun');
  return out;
}

/* =============================================== 日文活用还原
 * JA_BACK：尾部 → [候选词尾, 语法特征]。按尾部长度倒序尝试，
 * 所有候选都会送入词典逐一命中（见 jaForms），宁可多列不要漏列。
 */
var JA_V = ['る', 'く', 'す', 'つ', 'う', 'む', 'ぶ', 'ぬ', 'ぐ'];
var JA_I = ['る', 'く', 'す', 'つ', 'う', 'い'];

var JA_BACK = [
  // 促音音便：言って／言った／死んだ ← う・る・つ・む・ぶ・ぐ・ぬ・く・す 词干
  ['って', ['う', 'る', 'つ', 'む', 'ぶ', 'ぐ', 'く', 'す', 'ぬ'], 'te'],
  ['った', ['う', 'る', 'つ', 'む', 'ぶ', 'ぐ', 'く', 'す', 'ぬ'], 'past'],
  ['んで', ['ぬ', 'む', 'ぶ'], 'te'], ['んだ', ['ぬ', 'む', 'ぶ'], 'past'],
  ['いて', ['く'], 'te'], ['いた', ['く'], 'past'], ['いで', ['ぐ'], 'te'], ['いだ', ['ぐ'], 'past'],
  ['して', ['す'], 'te'], ['した', ['す'], 'past'],
  ['ていただく', ['く', 'する'], 'pol'], ['ていただけ', ['く', 'する'], 'pol'],
  ['ていただい', ['く', 'する'], 'pol'],
  ['ていました', ['る', 'する'], 'prog'], ['ていた', ['る', 'する'], 'prog'],
  ['ています', ['る', 'する'], 'prog'], ['てます', ['る', 'する'], 'prog'], ['てる', ['る', 'する'], 'prog'],
  ['でいます', ['る'], 'prog'], ['でいる', ['る'], 'prog'], ['でる', ['る'], 'prog'],
  ['てください', JA_V, 'imp'], ['てあげます', ['る'], 'benef'], ['てあげ', ['る'], 'benef'],
  ['てはいけない', JA_V, 'ban'], ['ないで', JA_I, 'negte'], ['なくて', JA_I, 'negte'],
  ['たかったです', JA_I, 'want'], ['たかった', JA_I, 'want'],
  ['たくない', JA_I, 'wantneg'], ['たいです', JA_V, 'want'], ['たい', JA_V, 'want'],
  ['られます', ['る'], 'pot'], ['られる', ['る'], 'pot'], ['れます', ['る'], 'pot'], ['れる', ['る'], 'pot'],
  ['せます', ['す'], 'pot'], ['せる', ['る', 'す'], 'pot'],
  ['させます', ['る', 'す'], 'caus'], ['させる', ['る', 'す'], 'caus'],
  ['されます', ['る'], 'pass'], ['される', ['る'], 'pass'],
  ['ませんでした', JA_V, 'negpast'], ['ません', JA_V, 'neg'],
  ['ではありません', [''], 'neg'], ['じゃありません', [''], 'neg'], ['ではありませんか', [''], 'negq'],
  ['じゃないですか', [''], 'negq'], ['じゃなかった', [''], 'negpast'], ['ではない', [''], 'neg'], ['じゃない', [''], 'neg'],
  ['でしょう', [''], 'guess'], ['ですか', [''], 'polq'], ['でした', [''], 'pastpol'], ['です', [''], 'pol'],
  ['ましょうか', JA_V, 'volq'], ['ましょう', JA_V, 'vol'],
  ['ました', JA_V, 'pastpol'], ['ます', JA_V, 'pol'],
  ['なかった', JA_I, 'negpast'], ['なければ', JA_I, 'condneg'],
  ['ない', JA_V.concat(['い', 'な', 'の', 'べ']), 'neg'],
  ['ってください', ['く', 'つ', 'う', 'る', 'む', 'ぬ', 'ぶ'], 'imp'],
  ['って', ['つ', 'う', 'る', 'む', 'ぬ', 'ぶ'], 'te'], ['った', ['つ', 'う', 'る', 'む', 'ぬ', 'ぶ'], 'past'],
  ['いて', ['く'], 'te'], ['いた', ['く'], 'past'], ['いで', ['ぐ'], 'te'], ['いだ', ['ぐ'], 'past'],
  ['じて', ['ず', 'づ'], 'te'], ['じた', ['ず', 'づ'], 'past'],
  ['して', ['す', 'ず', 'づ'], 'te'], ['した', ['す', 'ず', 'づ'], 'past'],
  ['た', ['る', 'つ', 'う', 'む', 'ぬ', 'ぶ', 'ぐ', 'す', 'く'], 'past'],
  ['て', ['る', 'つ', 'う', 'む', 'ぬ', 'ぶ', 'ぐ', 'す', 'く', 'で'], 'te'],
  ['で', ['る', 'ぬ', 'ぶ', 'む', 'ぐ'], 'te'],
  ['れば', ['る'], 'cond'], ['ければ', ['い'], 'cond'],
  ['たら', ['る', 'す', 'く', 'つ', 'う', 'む', 'ぶ', 'ぬ', 'ぐ'], 'cond'],
  ['ば', ['る', 'す', 'く', 'つ', 'う', 'ぶ', 'ぬ', 'む', 'ぐ', 'い'], 'cond'],
  ['かった', ['い'], 'past'], ['くない', ['い'], 'neg'], ['くなく', ['い'], 'neg'],
  ['くて', ['い'], 'te'], ['く', ['い'], 'adv'], ['さ', ['い'], 'noun'], ['い', ['い'], ''],
  ['き', ['る', 'く'], 'stem'], ['り', ['る'], 'stem'], ['し', ['す'], 'stem'], ['ち', ['つ'], 'stem'],
  ['み', ['む'], 'stem'], ['び', ['ぶ'], 'stem'], ['に', ['ぬ'], 'stem'], ['ぎ', ['ぐ'], 'stem'],
  ['い', ['く', 'う'], 'stem'], ['じ', ['ず', 'づ'], 'stem'], ['せ', ['す'], 'stem'],
  ['しよう', ['する'], 'vol'], ['します', ['する'], 'pol'], ['しました', ['する'], 'pastpol'],
  ['したい', ['する'], 'want'], ['すれば', ['する'], 'cond'], ['しない', ['する'], 'neg'],
  ['できる', ['する'], 'pot']
].filter(function (x) { return x && x[0] && x[1]; });

// 需要「最长尾部优先」；建立末字索引时保持该顺序及同长度候选的原有顺序。
JA_BACK.sort(function (a, b) { return b[0].length - a[0].length; });
var JA_BY_TAIL = {};
JA_BACK.forEach(function (rule) {
  var c = rule[0].slice(-1);
  (JA_BY_TAIL[c] || (JA_BY_TAIL[c] = [])).push(rule);
});

const JA_KANA_STEM = {
  'き': ['く', 'きる'], 'し': ['す', 'する'], 'ち': ['つ'], 'み': ['む'], 'び': ['ぶ'], 'べ': ['べる'],
  'に': ['ぬ'], 'ね': ['ねる'], 'め': ['める'], 'ぎ': ['ぐ'], 'げ': ['げる', 'ぐ'], 'ぜ': ['ずる'],
  'じ': ['ず'], 'い': ['う', 'いる', 'い'], 'り': ['る'], 'れ': ['る'], 'で': ['でる'], 'て': ['てる', 'つ'],
  'え': ['える', 'る'], 'け': ['ける', 'く'], 'せ': ['する', 'せる'], 'す': ['する'], 'づ': ['ずる']
};
const KANJI_ONLY = /^[一-鿿㐀-䶿々〆ー〜]+$/;

/** 词干 → 辞書形候选（ます/て/た 各形的词干都走这里） */
function jaStemForms(stem) {
  var res = [];
  if (!stem) return res;
  var last = stem.slice(-1), pre = stem.slice(0, -1);
  var m = JA_KANA_STEM[last];
  if (m) for (var i = 0; i < m.length; i++) res.push(pre + m[i]);
  if (KANJI_ONLY.test(stem)) { res.push(stem + 'する'); res.push(stem + 'になる'); res.push(stem + 'がする'); }
  if (/[ぁ-んー〜]$/.test(stem) && last !== 'す') { res.push(stem + 'る'); res.push(stem + 'する'); }  // す 结尾是する动词词干，不能再挂「る」
  if (/[ー〜]+$/.test(stem)) res.push(stem.replace(/[ー〜]+$/, '') + 'る');
  return res;
}

function jaForms(seg) {
  return cachedMorph('ja:' + seg, function () { return makeJaForms(seg); });
}
function makeJaForms(seg) {
  var out = [{ k: seg, feat: '' }], seen = {}; seen[seg] = 1;
  var rules = JA_BY_TAIL[seg.slice(-1)] || [];
  function push(k, f) { if (k && k.length && !seen[k]) { seen[k] = 1; out.push({ k: k, feat: f }); } }
  // 1) 后缀 + 词干还原（最可信的候选排在前面）
  for (var i = 0; i < rules.length; i++) {
    var tl = rules[i][0];
    if (seg.length <= tl.length || seg.slice(-tl.length) !== tl) continue;
    var stem = seg.slice(0, seg.length - tl.length);
    if (!stem) continue;
    jaStemForms(stem).forEach(function (k) { push(k, rules[i][2]); });
    rules[i][1].forEach(function (rep) { push(stem + rep, rules[i][2]); });
  }
  // 2) 低优先：只剥后缀（体言＋で／名詞＋です 一类）
  for (var j = 0; j < rules.length; j++) {
    var t2 = rules[j][0];
    if (seg.length <= t2.length || seg.slice(-t2.length) !== t2) continue;
    if (rules[j][1].indexOf('') >= 0) push(seg.slice(0, seg.length - t2.length), rules[j][2]);
  }
  if (seg.length > 1 && !/す$/.test(seg)) push(seg.slice(0, -1) + 'る', 'infl');
  // 3) 送假名本身就是一个う段音节：食べ → 食べる、飲み → 飲む
  if (JA_KANA_STEM[seg.slice(-1)]) jaStemForms(seg).forEach(function (k) { push(k, 'okuri'); });
  if (KANJI_ONLY.test(seg)) { push(seg + 'する', 'suru'); push(seg + 'になる', 'naru'); push(seg + 'がする', 'gasuru'); }
  if (/[一-鿿〆々]ー?$/.test(seg)) push(seg.replace(/ー+$/, '') + 'る', 'infl');
  return out;
}
/* ================================================== 单元化：英文 */
function unitsEn(str) {
  var toks = tokenizeEn(str), T = D.en2zh, out = [], i = 0;
  while (i < toks.length) {
    var tk = toks[i];
    if (tk.type === 's') {
      if (/^['’]$/.test(tk.src) && out.length && i + 1 < toks.length && toks[i + 1].type === 'w' && /^(s|re|ve|ll|d|m)\b/i.test(toks[i + 1].src)) {
        // 缩写：'s / 'll / 've …
        var c = toks[i + 1].l, map = { s: 'gen', re: 'be', ve: 'have', ll: 'will', d: 'had', m: 'am' }[/^['’]?(s|re|ve|ll|d|m)\b/i.exec(toks[i + 1].src)[1]];
        out.push({ src: tk.src + toks[i + 1].src, pos: map === 'gen' ? 'gen' : 'x', feat: map, how: 'rule' });
        i += 2; continue;
      }
      out.push({ src: tk.src, zh: punct(tk.src, PUNCT_EN), pos: 'sym', how: 'sym' }); i++; continue;
    }
    if (tk.type === 'n') { out.push({ src: tk.src, zh: numEn(tk.src), pos: 'm', how: 'num' }); i++; continue; }
    var ph = phraseEn(T, toks, i);
    if (ph) {
      out.push({ src: ph.src, zh: short(ph.e.g), pos: ph.e.pos, how: ph.e.prio >= 2 ? 'user' : 'phrase', e: ph.e });
      i = ph.next; continue;
    }
    var l = tk.l.replace(/[’']s$/, '');
    // 封闭类优先（功能词的词典义项会干扰结构）
    if (NEG[l] !== undefined && l !== 'not') { } // never/nor 走 NEG
    if (NEG[l] !== undefined) { out.push({ src: tk.src, zh: NEG[l], pos: 'neg', how: 'rule' }); i++; continue; }
    if (WH[l]) { out.push({ src: tk.src, zh: WH[l], pos: 'wh', wtype: WH_OBJ[l] ? 'obj' : 'adv', how: 'rule' }); i++; continue; }
    if (PRON[l]) { out.push({ src: tk.src, zh: PRON[l], pos: 'r', how: 'rule' }); i++; continue; }
    if (DEMO[l]) { out.push({ src: tk.src, zh: DEMO[l], pos: 'det', how: 'rule' }); i++; continue; }
    if (DET[l]) { out.push({ src: tk.src, zh: l === 'a' || l === 'an' ? '一' : '', pos: 'det', how: 'rule' }); i++; continue; }
    if (MODAL[l]) { out.push({ src: tk.src, zh: '', pos: 'aux', feat: MODAL[l], how: 'rule' }); i++; continue; }
    if (BE[l]) { out.push({ src: tk.src, zh: '是', pos: 'be', feat: BE[l], how: 'rule' }); i++; continue; }
    if (AUXPERF[l]) { out.push({ src: tk.src, zh: '', pos: 'have', feat: l === 'had' ? 'past' : '', how: 'rule' }); i++; continue; }
    if (AUXDUMMY[l] && doAux(toks, i)) { out.push({ src: tk.src, zh: '', pos: 'dummy', feat: l === 'did' ? 'past' : '', how: 'rule' }); i++; continue; }
    if (l === 'than') { out.push({ src: tk.src, zh: '比', pos: 'than', how: 'rule' }); i++; continue; }
    if (l === 'there') { out.push({ src: tk.src, zh: '', pos: 'there', how: 'rule' }); i++; continue; }
    if (l === 'of') { out.push({ src: tk.src, zh: '的', pos: 'gen', how: 'rule' }); i++; continue; }
    if (PP[l] && !D.en2zh.w.has(l)) { out.push({ src: tk.src, zh: '', pos: 'p', role: PP[l], how: 'rule' }); i++; continue; }
    if (ADV[l] && !D.en2zh.w.has(l)) { out.push({ src: tk.src, zh: ADV[l], pos: 'd', how: 'rule' }); i++; continue; }
    // 词典
    var found = null;
    var forms = enForms(tk.src);
    var prev = null;
    for (var pv = out.length - 1; pv >= 0; pv--) { if (out[pv].pos !== 'sym') { prev = out[pv]; break; } }
    var nominal = !prev || prev.pos === 'det' || prev.pos === 'p' || prev.pos === 'd' || prev.pos === 'gen' || prev.pos === 'num';
    var exactHit = null, verbHit = null;
    for (var f = 0; f < forms.length; f++) {
      var e = T.w.get(forms[f].base);
      if (!e) continue;
      if (!forms[f].feat && !exactHit) exactHit = { e: e, feat: '', key: forms[f].base };
      if (forms[f].feat && e.pos === 'v' && !verbHit) verbHit = { e: e, feat: forms[f].feat, key: forms[f].base };
      if (!found) found = { e: e, feat: forms[f].feat, key: forms[f].base };
    }
    // 「the meeting」取名词本形，「committee decided」取动词活用形：靠前一个单元的槽位判断
    if (exactHit && (nominal || exactHit.e.pos === 'v')) found = exactHit;
    else if (verbHit && !nominal) found = verbHit;
    if (found) {
      var epos = found.e.pos;
      var want = found.feat === 'past' || found.feat === 'pp' || found.feat === 'ing' || found.feat === '3sg' ? 'v'
        : found.feat === 'comp' || found.feat === 'sup' || found.feat === 'adv' ? 'd' : '';
      var isVerbish = epos === 'v' || (found.feat && (found.feat === 'past' || found.feat === 'pp' || found.feat === 'ing'));
      if (PP[found.key] && !isVerbish) {
        out.push({ src: tk.src, zh: '', pos: 'p', role: PP[found.key], how: 'dict' });
      } else if (CONJ[found.key] && epos === 'c') {
        out.push({ src: tk.src, zh: CONJ[found.key], pos: 'c', how: 'rule' });
      } else if (ADV[found.key] && found.feat === 'adv') {
        out.push({ src: tk.src, zh: short(sense(found.e, 'd')) || ADV[found.key], pos: 'd', feat: found.feat, how: found.e.prio >= 2 ? 'user' : 'morph' });
      } else {
        out.push({
          src: tk.src, zh: short(sense(found.e, want || (isVerbish ? 'v' : ''))), pos: isVerbish ? 'v' : epos,
          feat: found.feat, key: found.key, how: found.e.prio >= 2 ? 'user' : (found.feat ? 'morph' : 'dict'), e: found.e
        });
      }
      i++; continue;
    }
    if (CONJ[l] !== undefined) { out.push({ src: tk.src, zh: CONJ[l], pos: 'c', how: 'rule' }); i++; continue; }
    if (PP[l]) { out.push({ src: tk.src, zh: '', pos: 'p', role: PP[l], how: 'rule' }); i++; continue; }
    if (ADV[l]) { out.push({ src: tk.src, zh: ADV[l], pos: 'd', how: 'rule' }); i++; continue; }
    out.push({ src: tk.src, zh: tk.src, pos: 'x', how: 'miss' });
    i++;
  }
  return out;
}

function phraseEn(T, toks, i) {
  var max = Math.min(T.pmax, toks.length - i);
  for (var n = max; n >= 2; n--) {
    var parts = [], bad = false;
    for (var k = i; k < i + n; k++) {
      if (toks[k].type === 's' && !/^['’]$/.test(toks[k].src)) { bad = true; break; }
      parts.push(toks[k].l.replace(/[.,!?;:"'’]$/g, ''));
    }
    if (bad) { if (n <= 2) break; continue; }
    var e = T.p.get(parts.join(' ').trim());
    if (e) return { e: e, src: toks.slice(i, i + n).map(function (x) { return x.src; }).join(' '), next: i + n };
  }
  return null;
}

function punct(c, table) {
  if (table[c] !== undefined) return table[c];
  if (/^["“”‘’']+$/.test(c)) return '';
  if (/^[\-–—]+$/.test(c)) return '—';
  return c;
}
function numEn(x) {
  var s = trim(x);
  var m = s.match(/^([$€£¥])\s?([\d,.]+)(.*)$/);
  if (m) return m[2] + ({ '$': '美元', '€': '欧元', '£': '英镑', '¥': '日元' }[m[1]] || m[1]) + trim(m[3]);
  var m2 = s.match(/^([\d,.]+)\s?(km\/h|kph|mph|km|kg|cm|mm|mb|gb|hz|ml|mg|%)$/i);
  if (m2) return m2[1] + (m2[2].toLowerCase() === '%' ? '%' : (m2[2] || ''));
  return s.replace(/\s+/g, '');
}

/* ================================================== 单元化：日文 */
function unitsJa(str) {
  var segs = tokenizeJa(str), T = D.ja2zh, out = [], i = 0, guard = 0;
  while (i < segs.length && guard++ < 4000) {
    var sg = segs[i];
    if (sg.type === 's') { out.push({ src: sg.src, zh: punct(sg.src, PUNCT_JA), pos: 'sym', how: 'sym' }); i++; continue; }
    if (sg.type === 'n') {
      var nx = segs[i + 1];
      if (nx && (nx.type === 'k') && JA_COUNTER[nx.src]) { out.push({ src: sg.src + nx.src, zh: sg.src + JA_COUNTER[nx.src], pos: 'm', how: 'rule' }); i += 2; continue; }
      out.push({ src: sg.src, zh: sg.src, pos: 'm', how: 'num' }); i++; continue;
    }
    if (sg.type === 'r') { out.push({ src: sg.src, zh: sg.src, pos: 'x', how: 'miss' }); i++; continue; }
    // 1) 跨段短语优先（用户词典里的多词条目、复合词）
    var ph = phraseJaAt(T, segs, i);
    if (ph) { out.push({ src: ph.src, zh: short(ph.e.g), pos: ph.e.pos === 'v' ? 'v' : ph.e.pos || 'x', how: ph.e.prio >= 2 ? 'user' : 'phrase', e: ph.e }); i = ph.next; continue; }
    // 2) 汉字段 + 送假名：从最长到最短试「汉字+假名」，剩余假名回灌成新的假名段
    var nxt = segs[i + 1];
    if (sg.type === 'k' && nxt && nxt.type === 'h') {
      var ok = false;
      for (var L = Math.min(6, nxt.src.length); L >= 1; L--) {
        var cand = sg.src + nxt.src.slice(0, L);
        var uc = jaWordUnit(T, cand);
        if (!uc) continue;
        out.push(uc);
        var rest = nxt.src.slice(L);
        i += 2;
        if (rest) segs.splice(i, 0, { type: 'h', src: rest });
        ok = true; break;
      }
      if (ok) continue;
    }
    // 3) 本段原形 / 活用
    if (sg.type !== 'h') {
      var u3 = jaWordUnit(T, sg.src);
      if (u3) { out.push(u3); i++; continue; }
      if (sg.type === 'k') {                    // 纯汉字段：按最长匹配切成若干名词
        var ku = kanjiUnits(T, sg.src);
        if (ku.length > 1) {
          var kLast = ku[ku.length - 1];
          // 末尾单字更像动词词干（一度言 + って…）：留给「汉字+送假名」再试
          if (kLast.how === 'miss' && kLast.src.length === 1 && segs[i + 1] && segs[i + 1].type === 'h') {
            out = out.concat(ku.slice(0, -1));
            segs.splice(i, 1, { type: 'k', src: kLast.src });
            continue;
          }
          out = out.concat(ku); i++; continue;
        }
      }
    }
    // 4) 助词 / 接续 / 时间 / 句末
    var pu = jaPartUnit(sg.src);
    if (pu) { out.push(pu); i++; continue; }
    // 5) 段末语气：動詞 + ですか/でしょう/ね
    var fm = sg.src.match(/(でしょうか|ませんか|ましょうか|たいですか|でしょう|じゃない|ですね|ですよ|ですか|ますか|かな|かね|わね|ね|よ|な|か)$/);
    if (fm && JA_FINAL[fm[1]] && sg.src.length > fm[1].length) {
      var head5 = sg.src.slice(0, sg.src.length - fm[1].length);
      var c5 = jaWordUnit(T, head5);
      if (c5) { c5.final = JA_FINAL[fm[1]]; out.push(c5); i++; continue; }
    }
    // 5.5) 句末句型：〜てください／〜ることができる／〜ていただけませんか …
    if (sg.type === 'h') {
      var hitR = null;
      for (var R = 0; R < JA_MODAL.length; R++) {
        var mm = sg.src.match(JA_MODAL[R][0]);
        if (mm) { hitR = [JA_MODAL[R][1], mm[0]]; break; }
      }
      if (hitR) {
        var hTxt = sg.src.slice(0, sg.src.length - hitR[1].length);
        if (hTxt) { segs.splice(i, 1, { type: 'h', src: hTxt }); }        // 先处理前缀，句型留下一轮
        else { out.push({ src: hitR[1], zh: hitR[0], pos: 'x', how: 'rule' }); i++; }
        continue;
      }
    }
    // 6) 假名串：词与助词混排的贪心切分
    if (sg.type === 'h') {
      var ks = kanaUnits(T, sg.src);
      if (ks.length) { out = out.concat(ks); i++; continue; }
    }
    out.push({ src: sg.src, zh: sg.src, pos: 'x', how: 'miss' });
    i++;
  }
  var last = out[out.length - 1];
  if (last && JA_FINAL[last.src] && last.pos !== 'v') { last.pos = 'fin'; last.final = JA_FINAL[last.src]; last.zh = ''; }
  return out;
}

/** 单词层：原形 → 词典；活用形 → jaForms 候选逐一命中 */
function jaWordUnit(T, surf) {
  var e = T.w.get(surf) || T.p.get(surf);   // 短语表的整段写法（こんにちは／手紙を書く）也能单段命中
  if (e) return { src: surf, zh: short(e.g), pos: e.pos, how: e.prio >= 2 ? 'user' : 'dict', e: e };
  var c = tryJa(T, surf);
  if (!c) return null;
  return { src: surf, zh: c.zh, pos: c.pos, feat: c.feat, key: c.key, how: c.how, e: c.e };
}

/** 功能层：助词 / 接续 / 时间 / 句末 */
function jaPartUnit(s) {
  var pr = JA_PART[s];
  if (pr) return { src: s, zh: pr.zh || '', pos: 'part', f: pr.f, role: pr.role, how: 'rule' };
  if (JA_CONJ[s]) return { src: s, zh: JA_CONJ[s], pos: 'c', how: 'rule' };
  if (JA_TIME_M[s]) return { src: s, zh: short((D.ja2zh.w.get(s) || {}).g || s), pos: 'time', how: 'rule' };
  if (JA_FINAL[s]) return { src: s, zh: '', pos: 'fin', final: JA_FINAL[s], how: 'rule' };
  return null;
}

/** 汉字段贪心切分：毎朝七時 → 毎朝 / 七 / 時 */
function kanjiUnits(T, s) {
  var units = [], i = 0, guard = 0, buf = '';
  function flush() {
    if (!buf) return;
    units.push({ src: buf, zh: buf, pos: 'x', how: 'miss' });
    buf = '';
  }
  while (i < s.length && guard++ < 200) {
    var hit = null, hlen = 0;
    for (var L = Math.min(4, s.length - i); L >= 2; L--) {
      var w = s.slice(i, i + L);
      var e = T.w.get(w) || T.p.get(w);
      if (e) { flush(); hit = { src: w, zh: short(e.g), pos: e.pos, how: e.prio >= 2 ? 'user' : (e.pos === 'phr' ? 'phrase' : 'dict'), e: e }; hlen = L; break; }
    }
    if (hit) { units.push(hit); i += hlen; continue; }
    var one = T.w.get(s[i]);
    if (one) { flush(); units.push({ src: s[i], zh: short(one.g), pos: one.pos, how: one.prio >= 2 ? 'user' : 'dict', e: one }); i++; continue; }
    if (JA_COUNTER[s[i]]) {   // 量词单字（杯／枚／冊…）：让「汉字串」能把「一杯」和后面的动词词干分开
      flush(); units.push({ src: s[i], zh: JA_COUNTER[s[i]], pos: 'm', how: 'rule' }); i++; continue;
    }
    buf += s[i]; i++;
  }
  flush();
  return units;
}

/** 纯假名串（は + とても 会连成一个段）：按「词典 > 助词 > 活用」从长到短贪心切 */
/** 「なると」式误切：末字是助词、前面本身就是词条时，这一串其实是「词 + 助词」。 */
function kanaSplit(T, w) {
  var tail = jaPartUnit(w.charAt(w.length - 1));
  if (!tail || tail.pos !== 'part') return 0;
  return T.w.get(w.slice(0, w.length - 1)) ? w.length - 1 : 0;
}

function kanaUnits(T, s) {
  var units = [], i = 0, guard = 0;
  while (i < s.length && guard++ < 200) {
    var hit = null, hlen = 0;
    for (var L = Math.min(9, s.length - i); L >= 1; L--) {   // 词典/短语探针：允许更长的固定句型
      var w = s.slice(i, i + L);
      var e = T.w.get(w) || T.p.get(w);
      if (e) {
        // 「なる + と」可能被长词探针当成「なると」：末字是助词、前面另有词条时短切。
        // 用户短语（こんにちは）不参与拆分。
        if (L >= 3 && T.w.get(w) && !T.p.get(w)) {
          var cut = kanaSplit(T, w);
          if (cut) { w = w.slice(0, cut); e = T.w.get(w); }
        }
        // 「は + とても」被当成「はと」：首字本身是助词时，比一比「助词 + 后移的
        // 词」和「这一整块」谁盖住的假名多，盖得多的那个算法才算数。
        var p0 = w.length >= 2 ? jaPartUnit(s.charAt(i)) : null;
        if (p0 && p0.pos === 'part') {
          for (var M = Math.min(9, s.length - i - 1); M >= 1; M--) {
            if (T.w.get(s.slice(i + 1, i + 1 + M)) || T.p.get(s.slice(i + 1, i + 1 + M))) {
              if (1 + M > w.length) { hit = p0; hlen = 1; }
              break;
            }
          }
          if (hit) break;
        }
        hit = { src: w, zh: short(e.g), pos: e.pos, how: e.prio >= 2 ? 'user' : 'dict', e: e }; hlen = w.length; break;
      }
      if (L <= 3) { var pr = jaPartUnit(w); if (pr) { hit = pr; hlen = L; break; } }
      if (L >= 2 && L <= 6) {
        var c = tryJa(T, w);
        // 助词把动词的第一个假名一起吃掉了（にな → なる）：如果后移一位正好是
        // 这个词的原形，说明这里是「助词 + 动词」两段，不是活用形，退回去短切。
        if (c && c.key && jaPartUnit(w.charAt(0)) && T.w.get(s.slice(i + 1, i + 1 + c.key.length))) {
          c = null;
        }
        if (c && c.feat) { hit = { src: w, zh: c.zh, pos: c.pos, feat: c.feat, key: c.key, how: c.how, e: c.e }; hlen = L; break; }
      }
    }
    if (!hit) { units.push({ src: s[i], zh: s[i], pos: 'x', how: 'miss' }); i++; continue; }
    units.push(hit); i += hlen;
  }
  return units;
}

function tryJa(T, surf) {
  var forms = jaForms(surf);
  for (var f = 0; f < forms.length; f++) {
    var e = T.w.get(forms[f].k) || T.p.get(forms[f].k);
    if (e) {
      var want = (forms[f].feat && /past|prog|pol|neg|want|pot|caus|imp|ban|vol|cond/.test(forms[f].feat)) ? 'v' : '';
      return { zh: short(sense(e, want || e.pos)), pos: e.pos === 'x' ? (want ? 'v' : 'x') : e.pos, feat: forms[f].feat, key: forms[f].k, how: e.prio >= 2 ? 'user' : (forms[f].feat ? 'morph' : 'dict'), e: e, consumed: true };
    }
  }
  return null;
}

function phraseJaAt(T, segs, i) {
  var max = Math.min(7, segs.length - i);
  for (var n = max; n >= 2; n--) {
    var key = segs.slice(i, i + n).map(function (x) { return x.src; }).join('');
    var e = T.p.get(key) || T.w.get(key);
    if (e) return { e: e, src: key, next: i + n };
  }
  return null;
}
/* ================================================== 单元化：中文 */
function unitsZh(str, dir) {
  var T = D[dir], out = [];
  /* 汉字整段切开：十来个字符一刀下去会把「就可以」这种连排虚词截断，词就丢了。
     切词本身的开销由 greedyZh 的 guard 兜底，这里不另设长度上限。 */
  var re = /[\u3400-\u9fff\uF900-\uFAFF]+|[0-9]+(?:[.,][0-9]+)?\s*[%％]?|[A-Za-z][A-Za-z0-9\-']*|[^\sA-Za-z0-9\u3400-\u9fff\uF900-\uFAFF]/g;
  var m, guard = 0;
  while ((m = re.exec(str)) && guard++ < 3000) {
    var x = m[0];
    if (/^[\u3400-\u9fff\uF900-\uFAFF]/.test(x)) out = out.concat(greedyZh(x, T));
    else if (/^[A-Za-z0-9]/.test(x)) out.push({ src: x, zh: x, pos: /^[A-Za-z]/.test(x) ? 'x' : 'm', how: 'raw' });
    else out.push({ src: x, zh: x, pos: 'sym', how: 'sym' });
  }
  return out;
}
/* 切词打分：MISS 比任何罕见词都贵，词库有但词频表没收录的按长度给保底 */
var MISS_LOG = -26;
var NOFREQ_LOG = -18;

function edgeLog(o) {
  if (!o.e) return MISS_LOG;
  var lp = o.e.lf;
  return lp ? lp : NOFREQ_LOG + (o.L - 1);
}

/** 从 s[off] 起的最长词条 */
function zhHit(T, s, off, max) {
  for (var L = Math.min(max, s.length - off); L >= 1; L--) {
    var w = s.slice(off, off + L);
    var e = (L > 1 ? T.p.get(w) : null) || T.w.get(w);
    if (e) return { w: w, e: e };
  }
  return null;
}

/* 切词：先列出每个位置能接上的词头，再按词频走一遍最大概率路径。
   纯最长匹配会把 有时间 切成 有时＋间、写作业 切成 写作＋业——一比词频
   就知道后一种切法在中文里几乎不成立。词序表缺失时退回逐位最长匹配。 */
function greedyZh(run, T) {
  var out = [], n = run.length, MAXW = 6, i, L, q;
  if (!n) return out;
  var dag = new Array(n);
  for (i = 0; i < n; i++) {
    var opts = [];
    for (L = Math.min(MAXW, n - i); L >= 1; L--) {
      var w = run.slice(i, i + L);
      var e = (L > 1 ? T.p.get(w) : null) || T.w.get(w);
      if (e) opts.push({ w: w, e: e, L: L });
      else if (L > 1 && ZH_AUX[w]) opts.push({ w: w, e: null, L: L });
    }
    /* 「不是」「没吃」在词典里是整词条，切开后引擎才看得到否定词，
       拼得出 am not / do not。只在后面那截本身是引擎认得的虚词时才切，
       免得把「没有电话」切成「有电 ＋ 话」。 */
    var one = run.charAt(i);
    if ((one === '不' || one === '没') && opts.length > 1) {
      var self = T.w.get(one), nx = zhHit(T, run, i + 1, MAXW);
      if (self && nx && ZH_AUX[nx.w]) opts = [{ w: one, e: self, L: 1 }];
    }
    dag[i] = opts.length ? opts : [{ w: one, e: null, L: 1 }];
  }
  var best = new Array(n + 1), cnt = new Array(n + 1), next = new Array(n + 1);
  best[n] = 0; cnt[n] = 0;
  for (i = n - 1; i >= 0; i--) {
    var bb = null, bn = 0, bw = null;
    for (q = 0; q < dag[i].length; q++) {
      var o = dag[i][q], tail = best[i + o.L];
      if (tail == null) continue;
      var sc = tail + edgeLog(o), wc = 1 + cnt[i + o.L];
      /* 同分时词少的赢：切得越碎越不像话 */
      if (bb === null || sc > bb + 1e-9 || (Math.abs(sc - bb) <= 1e-9 && wc < bn)) {
        bb = sc; bn = wc; bw = o;
      }
    }
    best[i] = bb; cnt[i] = bn; next[i] = bw;
  }
  function push(kk, e) {
    out.push({ src: kk, zh: short(e.g), pos: e.pos, how: e.prio >= 2 ? 'user' : (kk.length > 1 ? 'phrase' : 'dict'), feat: e.tag, e: e });
  }
  for (i = 0; i < n && next[i]; i += next[i].L) {
    var pick = next[i];
    if (pick.e) push(pick.w, pick.e);
    else out.push({ src: pick.w, zh: pick.w, pos: 'x', how: 'miss' });
  }
  return out;
}

/* ================================================ 英文成句（英→中） */
function zhFromEn(units, sent) {
  // 1) 按连词/逗号切小句
  var clauses = [], cur = [], leadConj = '';
  units.forEach(function (u) {
    if (u.pos === 'c') {
      if (cur.some(function (x) { return x.pos !== 'det' && x.pos !== 'sym'; })) { clauses.push({ lead: leadConj, u: cur }); cur = []; leadConj = u.zh || ''; }
      else leadConj = (leadConj || '') + (u.zh || '');
    } else if (u.pos === 'sym' && /^[，,;；]$/.test(u.src)) {
      if (cur.length) { clauses.push({ lead: leadConj, u: cur }); cur = []; leadConj = ''; }
    } else cur.push(u);
  });
  if (cur.length || leadConj) clauses.push({ lead: leadConj, u: cur });

  var qSent = /[?？]\s*$/.test(sent);
  var built = clauses.map(function (cl) { return cl.lead + clauseZh(cl.u, qSent, sent); });
  return joinZh(built, sent, qSent);
}

/* ------------------------------------------------ 英文小句 → 中文
 * 处理顺序：结构预扫描（标点/疑问程度词/不定式）→ 谓语定位 → 功能词归并
 *          → tail 切分（宾语 / 介词短语 / 比较 / of / 从句）→ 中文语序拼装
 */
var HOWADJ = {
  long: '多久', far: '多远', much: '多少', many: '多少', often: '多久一次', old: '多大',
  big: '多大', high: '多高', wide: '多宽', heavy: '多重', fast: '多快', difficult: '多难', easy: '多容易'
};
// 后面直接带动词不定式的谓语（想/需要/喜欢 + V），不再补「去」
var CATENA = {
  want: 1, wanted: 1, need: 1, like: 1, love: 1, hate: 1, prefer: 1, decide: 1, plan: 1, hope: 1,
  try: 1, learn: 1, expect: 1, agree: 1, refuse: 1, promise: 1, offer: 1, manage: 1, fail: 1,
  seem: 1, appear: 1, pretend: 1, arrange: 1, choose: 1, attempt: 1, wish: 1, would: 1
};
// 疑问副词 how+形/副 的整词替换在 enStructPass 里完成

/** 结构预扫描：把「to do / more adj / how long」等先标成结构单元 */
function enStructPass(u, F) {
  var out = [], i = 0, guard = 0;
  function lastIs(pos, re) {
    var p = out[out.length - 1];
    return p && p.pos === pos && (!re || re.test((p.key || p.src || '').toLowerCase()));
  }
  while (i < u.length && guard++ < 2000) {
    var a = u[i], b = u[i + 1], c = u[i + 2];
    var al = a ? (a.key || a.src || '').toLowerCase() : '';
    var bl = b ? (b.key || b.src || '').toLowerCase() : '';
    if (!a) { i++; continue; }
    // how + 形容词/副词 → 多久 / 多远 / 多少
    if (a.pos === 'wh' && al === 'how' && b && (b.pos === 'd' || b.pos === 't' || b.pos === 'a')) {
      out.push({ src: a.src + ' ' + b.src, zh: HOWADJ[bl] || ('多' + short(b.zh)), pos: 'wh', wtype: 'adv', how: 'rule', degq: 1 });
      i += 2; continue;
    }
    // more / most + 形容词 → 更 / 最
    if (b && (b.pos === 'd' || b.pos === 'a') && /^(more|most)$/.test(al) && (a.pos === 't' || a.pos === 'd' || a.pos === 'n')) {
      b.deg = al === 'more' ? '更' : '最';
      out.push(b); i += 2; continue;
    }
    if (a.pos === 'det' && al === 'the' && b && /^(most|least)$/.test(bl) && c && (c.pos === 'd' || c.pos === 'a')) {
      out.push(a); c.deg = al === 'the' && bl === 'most' ? '最' : '最不'; i += 3; out.push(c); continue;
    }
    // be going to + V → 将
    if (a.pos === 'be' && b && bl === 'going' && c && /^to$/i.test(c.src || '') && u[i + 3] && u[i + 3].pos === 'v') {
      F.modal = F.modal || 'fut'; F.prog = false; i += 3; continue;
    }
    // used to + V → 过去常常
    if (a.pos === 'v' && bl === 'to' && /^used$/i.test(al) && c && c.pos === 'v') {
      a.zh = '过去常常'; out.push(a); i += 2; continue;
    }
    // have/has to + V → 必须
    if (a.pos === 'have' && b && /^to$/i.test(b.src || '') && c && (c.pos === 'v' || c.feat === 'ing')) {
      F.modal = F.modal || 'nec'; out.push(a); i += 2; continue;
    }
    // to + 动词 = 不定式标记（不是介词「到」）
    if (a.pos === 'p' && al === 'to' && b && (b.pos === 'v' || b.pos === 'be' || b.feat === 'ing') && ([ 'v', 'n', 'r', 'phr', 'm', 'x' ].indexOf((out[out.length - 1] || {}).pos) >= 0)) {
      out.push({ src: a.src, zh: '', pos: 'inf', how: 'rule' }); i++; continue;
    }
    // that/which/who 引导的定语从句（前面是名词/限定词，后面接句子）
    if (a.pos === 'det' && al === 'that' && b && (b.pos === 'r' || b.pos === 'v' || b.pos === 'n') && out.length &&
        (out[out.length - 1].pos === 'n' || out[out.length - 1].pos === 'det' || out[out.length - 1].pos === 'm')) {
      out.push({ src: a.src, zh: '', pos: 'rel', how: 'rule' }); i++; continue;
    }
    if (a.pos === 'wh' && /^(which|who|whom|whose)$/.test(al) && out.length &&
        (out[out.length - 1].pos === 'n' || out[out.length - 1].pos === 'r')) {
      out.push({ src: a.src, zh: '', pos: 'rel', how: 'rule' }); i++; continue;
    }
    out.push(a); i++;
  }
  return out;
}

function clauseZh(u, qSent, sent, depth) {
  depth = depth || 0;
  var F = { modal: '', neg: '', perf: false, prog: false, past: false, passive: false, dummy: false, there: false, wh: null, whadv: null, endp: '' };
  u = u.slice();
  // 句末标点交给 joinZh，先摘掉，避免「同事.」这类夹在短语里的句号
  while (u.length && u[u.length - 1].pos === 'sym' && /^[.!。？?；;，,！]$/.test(u[u.length - 1].src)) {
    F.endp = u[u.length - 1].src; u.pop();
  }
  u = enStructPass(u, F);

  // 谓语 = 第一个 v / be
  var vi = -1;
  for (var i = 0; i < u.length; i++) {
    if (u[i].pos === 'v' || u[i].pos === 'be') { vi = i; break; }
  }
  var subj = vi < 0 ? u.slice() : u.slice(0, vi);
  var verb = vi < 0 ? null : u[vi];
  var tail = vi < 0 ? [] : u.slice(vi + 1);
  var vk = verb ? (verb.key || verb.src || '').toLowerCase() : '';

  // 主语侧功能词归并
  subj = subj.filter(function (x) {
    if (x.pos === 'aux') { F.modal = F.modal || x.feat; return false; }
    if (x.pos === 'have') { F.perf = true; if (x.feat === 'past') F.past = true; return false; }
    if (x.pos === 'dummy') { F.dummy = true; if (x.feat === 'past') F.past = true; return false; }
    if (x.pos === 'neg') { F.neg = x.zh; return false; }
    if (x.pos === 'be') { F.prog = x.feat === 'ing'; return false; }
    if (x.pos === 'there') { F.there = true; return false; }
    if (x.pos === 'wh' && x.wtype === 'obj') { F.wh = x; return false; }
    if (x.pos === 'wh' && x.wtype === 'adv') { if (!F.whadv) F.whadv = x; return false; }
    return true;
  });
  tail = tail.filter(function (x) {
    if (x.pos === 'aux') { F.modal = F.modal || x.feat; return false; }
    if (x.pos === 'have') { F.perf = true; return false; }
    if (x.pos === 'neg') { F.neg = F.neg || x.zh; return false; }
    if (x.pos === 'dummy') { F.dummy = true; return false; }
    if (x.pos === 'be' && x.feat === 'pp') { F.passive = true; return false; }
    if (x.pos === 'be') { return false; }
    if (x.pos === 'wh' && x.wtype === 'obj' && !F.wh) { F.wh = x; return false; }
    if (x.pos === 'wh' && x.wtype === 'adv' && !F.whadv) { F.whadv = x; return false; }
    return true;
  });
  // do 支持的假主语 it 要丢掉（How long does it take …）
  if (F.dummy) subj = subj.filter(function (x) { return !(x.pos === 'r' && /^it$/i.test(x.src)); });
  if (F.dummy && !subj.length && verb && verb.pos === 'v') { /* 无主语疑问句 */ }

  if (verb) {
    if (verb.feat === 'past') F.past = true;
    if (verb.feat === 'pp') F.passive = F.passive || !!subj.length;
    if (verb.feat === 'ing' && verb.pos === 'v') F.prog = true;
  }
  // 被动：be + 过去分词（enForms 把 -ed 一律标成 past，这里补一次判定）
  if (verb && verb.pos === 'be' && subj.length && tail.length && tail[0].pos === 'v' && /^(past|pp)$/.test(tail[0].feat || '')) {
    F.passive = true; verb = tail[0]; tail = tail.slice(1);
    vk = (verb.key || verb.src || '').toLowerCase();
  }

  // 不定式：在主句 tail 里找第一个 inf，切成「主句 + 从句」
  var cut = -1;
  for (var t = 0; t < tail.length; t++) if (tail[t].pos === 'inf') { cut = t; break; }
  var mainTail = cut < 0 ? tail : tail.slice(0, cut);
  var infTail = cut < 0 ? [] : tail.slice(cut + 1);

  var segs = splitTail(mainTail);
  var obj = segs.obj, pps = segs.pps, thanBody = segs.than, comps = segs.comps;
  var infSegs = infTail.length ? splitTail(infTail.filter(function (x) { return x.pos !== 'inf'; })) : null;

  var subjZh = nounZh(subj, depth);
  var objZh = nounZh(obj, depth);
  // wh 宾语回到宾语位置
  var whObj = F.wh ? short(F.wh.zh) : '';
  if (whObj) objZh = objZh ? objZh + '的' + whObj : whObj;
  if (F.whadv && /多久|多少|多远|多大|多快|多高/.test(F.whadv.zh) && !objZh) objZh = F.whadv.zh;
  else if (F.whadv) pps.unshift({ role: 'advw', body: [F.whadv] });

  // 不定式子句
  var infZh = '';
  if (infTail.length) {
    var iv = -1;
    for (var q = 0; q < infTail.length; q++) {
      if (infTail[q].pos === 'v' || infTail[q].pos === 'be') { iv = q; break; }
    }
    if (iv < 0) infZh = nounZh(infTail, depth);
    else {
      var pre = nounZh(infTail.slice(0, iv), depth);
      var ivz = infTail[iv].pos === 'be' ? '是' : short(infTail[iv].zh);
      var is2 = splitTail(infTail.slice(iv + 1));
      var glue = (CATENA[vk] || !vk) ? '' : (/^(be|being)$/.test(vk) ? '要' : '去');
      infZh = pre + glue + orderPP(is2.pps, depth).join('') + ivz +
        nounZh(is2.obj, depth) + (is2.comps.length ? nounZh(is2.comps, depth) : '');
      if (is2.than) infZh += '比' + nounZh(is2.than, depth);
    }
  }

  // 「by …」在被动句里是施事者或时段：施事走「被 X 动词」，时长/度量挪到动词后面
  var agentZh = '', measZh = '';
  if (F.passive) {
    for (var ai = 0; ai < pps.length; ai++) {
      if (pps[ai].role !== 'ag') continue;
      var agZh = nounZh(pps[ai].body, depth);
      var NUM = '[零一二两三四五六七八九十百千万亿\\d]+';
      var meas = agZh.indexOf('的') < 0 && (new RegExp('^' + NUM + '(小时|分钟|分|秒|天|周|月|年|公里|千米|英里|海里|元|美元|欧元|磅|公斤|吨|倍|岁)$').test(agZh) || /^百分之|^大约/.test(agZh));
      if (agZh && meas) measZh = agZh;
      else if (agZh) agentZh = agZh;
      pps.splice(ai, 1);
      break;
    }
  }

  var advs = orderPP(pps, depth);
  var verbZh = verb ? (verb.pos === 'be' ? '是' : short(verb.zh)) : '';
  var adjZh = comps.map(function (c) { return (c.deg || '') + (c.pos === 'd' || c.pos === 'a' ? short(c.zh) : nounZh([c], depth)); }).join('，');
  if (verb && verb.pos === 'be') {
    var isAdj = comps.length || (obj[0] && (obj[0].pos === 'd' || obj[0].pos === 'a'));
    if (isAdj || (!objZh && !advs.length && !infZh)) verbZh = '';
  }
  // it takes + 时间 + to V → 花费
  if (vk === 'take' && F.dummy && /多久|多少|分钟|小时|天|年/.test(objZh + (F.whadv ? F.whadv.zh : ''))) verbZh = '花';

  var neg = F.neg || '';
  if (neg === '不' && /有|是|在/.test(verbZh + adjZh)) neg = '没';
  var modalZh = F.modal ? ({ fut: '会', fut2: '会', abil: '能', nec: '必须', proh: '可能' }[F.modal] || '') : '';
  if (F.perf && !F.past) F.past = true;

  var pred = verbZh || adjZh;
  if (!pred && objZh) pred = '是';
  if (F.there) pred = '有';

  // 无谓语：名词句 / 标题 / 列表项
  if (!pred) {
    var s0 = (advs.join('') + subjZh + (objZh ? '的' + objZh : '')).replace(/^的/, '');
    return finishClause(s0, F, sent, qSent, false);
  }

  var core = modalZh + neg + (F.passive && pred !== '是' ? '被' + agentZh : '');
  var body = objZh;
  if (F.prog) advs.unshift('正在');
  var aspect = (F.past || F.perf) ? '了' : '';
  var head = F.there ? '有' : subjZh;
  var verbPart = (F.there ? '' : core) + pred;
  // 状语放在「情态/否定」之后、谓语之前
  var out;
  if (F.there) out = '有' + body + infZh;
  else out = head + modalZh + neg + advs.join('') + (F.passive && pred !== '是' ? '被' + agentZh : '') + pred
    + (body ? body : '') + (aspect === '了' && !body && !infZh ? '了' : '')
    + (infZh ? infZh : '')
    + (thanBody ? '比' + nounZh(thanBody, depth) : '');
  if (!verbZh && adjZh && !thanBody) out = subjZh + modalZh + neg + (advs.join('') || '很') + (adjZh.indexOf('更') === 0 || adjZh.indexOf('最') === 0 ? adjZh : '很' + adjZh) + (aspect === '了' ? '了' : '');
  if (!subjZh && !F.there && out.indexOf(modalZh + neg) === 0) out = out.slice(0);
  out = out.replace(/的的/g, '的').replace(/(很)+(?=很)/g, '').replace(/^很很/, '很');
  if (aspect === '了' && body && !/了[。]?$/.test(out) && !/了/.test(out.slice(0, out.indexOf(body) + body.length))) out = out.replace(body, body + '了');
  // 被动 + 时长补语：被推迟了二小时
  if (measZh && pred && out.indexOf(pred) >= 0) {
    out = out.replace(pred, pred + '了' + measZh).replace(/了([。！？，,]?)$/, '$1');
  }
  return finishClause(out, F, sent, qSent, !!(verbZh || adjZh));
}

function finishClause(s, F, sent, qSent, hasPred) {
  s = trim(s);
  if (!s) return '';
  var isQ = F.wh || F.whadv || qSent || /\b(am|is|are|was|were|do|does|did|will|can|must|should|have|has)\b/i.test(sent) && /\?/.test(sent);
  if (isQ) {
    var isWh = !!(F.wh || F.whadv) || /^(what|when|where|why|who|which|how)\b/i.test(sent);
    s = s.replace(/[。！？]?$/, '');
    s += isWh ? '？' : '吗？';
  }
  return s;
}

function joinZh(parts, sent, qSent) {
  var s = parts.filter(Boolean).join('，');
  s = s.replace(/[，。；]\s*$/g, '').replace(/，?(。|！|？)+$/g, '').replace(/[，，]+/g, '，').replace(/，。/g, '。').replace(/\s+/g, '');
  if (!/[。！？；…]$/.test(s)) {
    var end = sent.match(/[.!?;…]+$/);
    if (qSent) s += '？';
    else if (end && end[0][0] === '!') s += '！';
    else if (end && end[0][0] === ';') s += '；';
    else s += '。';
  }
  return s.replace(/([，。；：？！])\1+/g, '$1').replace(/([^，。；！？])\?$/, '$1？');
}

function splitTail(tail) {
  var obj = [], pps = [], thanBody = null, comps = [], cur = obj;
  // 裸时间名词：last/next/this/every + 时间词，或 yesterday/tomorrow 单独成串
  var TMP_HEAD = { last: 1, next: 1, this: 1, that: 1, every: 1, each: 1 };
  var TMP_WORD = { morning: 1, afternoon: 1, evening: 1, night: 1, noon: 1, day: 1, week: 1, weekend: 1, month: 1, year: 1, century: 1, Monday: 1, Tuesday: 1, Wednesday: 1, Thursday: 1, Friday: 1, Saturday: 1, Sunday: 1 };
  var TMP_ALONE = { yesterday: 1, today: 1, tomorrow: 1, tonight: 1, lately: 1 };
  function tmpRun(list, from) {
    var j = from, seen = [];
    while (j < list.length) {
      var k = (list[j].key || list[j].src || '').toLowerCase().replace(/[^a-z]/g, '');
      if (list[j].pos === 'sym') break;
      if (TMP_ALONE[k]) { seen.push(list[j]); j++; continue; }
      if (TMP_HEAD[k]) {
        var t = j + 1;
        while (t < list.length && t - j <= 4) {
          var k2 = (list[t].key || list[t].src || '').toLowerCase().replace(/[^a-z]/g, '');
          if (TMP_WORD[k2] || k2 === 'and') { seen = list.slice(from, t + 1); j = t + 1; break; }
          if (list[t].pos === 'm' || list[t].pos === 'd' || list[t].pos === 'n') { t++; continue; }
          break;
        }
        if (seen.length) continue;
        break;
      }
      break;
    }
    return seen;
  }
  var lead = tmpRun(tail, 0);
  if (lead.length && lead.length <= tail.length) pps.push({ role: 'tmpbare', body: lead });
  for (var i = lead.length; i < tail.length; i++) {
    var u = tail[i];
    if (u.pos === 'than') { thanBody = []; cur = thanBody; continue; }
    if (u.pos === 'p') {
      var body = [];
      var j = i + 1;
      while (j < tail.length && tail[j].pos !== 'p' && tail[j].pos !== 'than' && !(tail[j].pos === 'v' && body.length >= 1)) { body.push(tail[j]); j++; }
      if (!body.length) { i = j - 1; cur = obj; continue; }
      pps.push({ role: u.role || 'loc', body: body });
      i = j - 1; cur = obj; continue;
    }
    if (u.pos === 'gen') {   // of / 's → B 的 A
      var right = [];
      var k = i + 1;
      while (k < tail.length && tail[k].pos !== 'p' && tail[k].pos !== 'gen' && tail[k].pos !== 'v') { right.push(tail[k]); k++; }
      var left = obj.slice();
      obj = [{ src: 'of', zh: nounZh(right) + '的' + nounZh(left), pos: 'n', how: 'rule' }];
      cur = obj;
      i = k - 1; continue;
    }
    if (u.pos === 'd' && !obj.length && !comps.length && (u.deg || cur === comps)) { comps.push(u); continue; }
    if (u.pos === 'd' && !obj.length && !comps.length) { comps.push(u); obj.push(u); continue; }
    cur.push(u);
  }
  return { obj: obj, pps: pps, than: thanBody, comps: comps };
}

var TMP_MOD = { last: '上', next: '下', this: '这', that: '那', every: '每', each: '每' };
/** 裸时间名词：last month → 上个月（不带「的」） */
function tmpBareZh(body) {
  var w = body.map(function (u) { return { u: u, k: (u.key || u.src || '').toLowerCase().replace(/[^a-z]/g, '') }; });
  var head = w[0] && TMP_MOD[w[0].k] ? TMP_MOD[w[0].k] : '';
  var rest = w.slice(head ? 1 : 0);
  var s = head + rest.map(function (x) {
    if (TMP_MOD[x.k]) return TMP_MOD[x.k];
    if (x.u.pos === 'det') return '';
    return (x.u.zh || '') + '';
  }).join('');
  return s.replace(/的/g, '');
}

var PP_RANK = { tmp: 0, loc: 1, pla: 1, src: 2, dst: 3, ag: 4, co: 5, wo: 5, for: 6, abt: 6, as: 7, like: 7, gen: 8, ex: 8, cmp: 9, only: 9, tgt: 4, com: 5, end: 3, advw: 2 };

function orderPP(pps, depth) {
  var sorted = (pps || []).slice().sort(function (a, b) {
    return (PP_RANK[a.role] == null ? 9.5 : PP_RANK[a.role]) - (PP_RANK[b.role] == null ? 9.5 : PP_RANK[b.role]);
  });
  return sorted.map(function (p) {
    if (p.role === 'advw') return nounZh(p.body, depth);
    var z = PP_ZH[p.role] || '在';
    var body = nounZh(p.body, depth);
    if (!body) return '';
    if (p.role === 'tmpbare') return tmpBareZh(p.body);
    if (p.role === 'tmp') return /的?时候$/.test(body) ? body : body + '的时候';
    if (p.role === 'loc') return /^在/.test(z) ? '在' + body : z + body;
    if (p.role === 'gen') return body + '的';
    if (p.role === 'wo') return '没有' + body + '地';
    return z + body;
  }).filter(Boolean);
}

function nounZh(list, depth) {
  if (!list || !list.length) return '';
  depth = depth || 0;
  var np = [];
  for (var i = 0; i < list.length; i++) {
    var u = list[i];
    if (u.pos === 'gen') {                       // X of Y → Y 的 X
      var right = [], k = i + 1;
      while (k < list.length && list[k].pos !== 'p' && list[k].pos !== 'gen') { right.push(list[k]); k++; }
      np.push({ pl: nounZh(right, depth + 1) + '的' + npZh(np.splice(0)), pos: 'n' });
      i = k - 1; continue;
    }
    if (u.pos === 'rel' && depth < 3) {          // the book [that I read] → 我读的 书
      var clause = [], j = i + 1;
      while (j < list.length) { clause.push(list[j]); j++; }
      var rel = clauseZh(clause, false, '', depth + 1).replace(/[。？！]$/, '');
      np.push({ pl: rel + '的' + npZh(np.splice(0)), pos: 'n' });
      i = j - 1; continue;
    }
    if (u.pos === 'det' && /^(a|an|the|some|any|no|every|each)$/i.test(u.src)) continue;
    if (u.pos === 'p') {                          // N in the room → 在房间里的 N
      var body = [], jj = i + 1;
      // （见下方空 body 保护）
      while (jj < list.length && list[jj].pos !== 'p' && list[jj].pos !== 'gen' && list[jj].pos !== 'v') { body.push(list[jj]); jj++; }
      if (!body.length) { i = jj - 1; continue; }
      np.push({ pl: nounZh(body, depth) + '里的' + npZh(np.splice(0)), pos: 'n' });
      i = jj - 1; continue;
    }
    if (u.pos === 'inf') {                        // 名词后的 to do：机会去做 → 做…的 机会
      var to = [], m = i + 1;
      while (m < list.length) { to.push(list[m]); m++; }
      np.push({ pl: clauseZh(to, false, '', depth + 1).replace(/[。？！]$/, '') + '的' + npZh(np.splice(0)), pos: 'n' });
      i = m - 1; continue;
    }
    if (u.pos === 'v' && np.length && list[i + 1] && (list[i + 1].pos === 'n' || list[i + 1].pos === 'det' || list[i + 1].pos === 'r')) {
      np.push({ pl: short(u.zh) + '的', pos: 'n' }); continue;
    }
    np.push(u);
  }
  return npZh(np);
}

function npZh(list) {
  if (!list || !list.length) return '';
  var s = '';
  list.forEach(function (u) {
    if (!u) return;
    if (u.pos === 'sym') { s += (u.zh || ''); return; }
    if (u.pl) { s += u.pl; return; }
    if (u.pos === 'det' && /^(a|an|the)$/i.test(u.src)) return;
    if (u.deg) { s += u.deg + (u.zh || ''); return; }
    s += (u.zh || '');
  });
  return s.replace(/[，,\s]+$/, '');
}
/* ================================================ 日文成句（日→中） */
function zhFromJa(units, sent) {
  // 以助词切「节」
  var groups = [], cur = [];
  units.forEach(function (u) {
    if (u.pos === 'part' && u.f !== 'gen') {
      groups.push({ w: cur.slice(), p: u }); cur = [];
    } else if (u.pos === 'part' && u.f === 'gen') {
      cur.push(u);
    } else if (u.pos === 'sym' || u.pos === 'c') {
      groups.push({ w: cur.slice(), p: null, sep: u }); cur = [];
    } else cur.push(u);
  });
  if (cur.length) groups.push({ w: cur.slice(), p: null });

  // 谓语节：最后一个含 v/a 的节
  var pi = -1;
  for (var g = groups.length - 1; g >= 0; g--) {
    if (groups[g].w.some(function (u) { return u.pos === 'v' || (u.pos === 'a') || u.feat; })) { pi = g; break; }
  }
  if (pi < 0) for (var g2 = groups.length - 1; g2 >= 0; g2--) if (groups[g2].w.length) { pi = g2; break; }

  var pred = pi >= 0 ? groups[pi] : null;
  var topic = '', subj = '', obj = '', obl = [], time = [], others = [], preAdv = '';
  groups.forEach(function (grp, idx) {
    if (idx === pi) return;
    var txt = jaText(grp);
    if (!txt) return;
    var f = grp.p ? grp.p.f : 'none';
    if (f === 'topic') topic += txt + '，';
    else if (f === 'subj') subj += txt;
    else if (f === 'obj') {
      // 「必ずコーヒーを」：副词属于谓语，不该被粘进宾语里
      var ds = grp.w.filter(function (u) { return u.pos === 'd' && !u.deg; });
      var ns = grp.w.filter(function (u) { return !(u.pos === 'd' && !u.deg); });
      if (ds.length && ns.length) {
        preAdv += ds.map(function (u) { return u.zh || ''; }).join('');
        obj = jaText({ w: ns });
      } else obj = txt;
    }
    else if (grp.w.some(function (u) { return u.pos === 'time'; }) || JA_TIME_M[grp.w.map(function (u) { return u.src; }).join('')]) time.push(txt);
    else if (f === 'none' && grp.w.every(function (u) { return u.pos === 'd'; })) preAdv += txt;
    else obl.push({ role: grp.p ? grp.p.role : 'none', txt: txt });
  });

  var predTxt = pred ? jaText(pred) : '';
  var F = {};
  if (pred) pred.w.forEach(function (u) { if (u.feat) F[u.feat] = 1; if (u.final) F.final = u.final; });
  else units.forEach(function (u) { if (u.final) F.final = u.final; });

  var neg = F.neg || F.negpast || F.negadv ? '不' : '';
  var past = F.past || F.pastpol || F.negpast ? '了' : '';
  var prog = F.prog ? '正在' : '';
  var want = F.want ? '想' : '';
  var pot = F.pot ? '能' : '';
  var caus = F.caus ? '让' : '';
  var fut = F.fut || F.vol ? '会' : '';
  if (F.negpast) neg = '没';
  var modal = [want, pot, caus, fut].filter(Boolean).join('');

  // 助词译法
  var oblStr = obl.map(function (o) {
    if (o.role === 'pla') return '在' + o.txt;
    if (o.role === 'tgt') return '对' + o.txt;
    if (o.role === 'dst') return '往' + o.txt;
    if (o.role === 'com') return '和' + o.txt;
    if (o.role === 'src') return '从' + o.txt;
    if (o.role === 'end') return '到' + o.txt;
    if (o.role === 'cmp') return '比' + o.txt;
    if (o.role === 'only') return '只有' + o.txt;
    if (o.role === 'for') return '为了' + o.txt;
    if (o.role === 'abt') return '关于' + o.txt;
    if (o.role === 'as') return '按照' + o.txt;
    return o.txt;
  }).join('');

  var s = topic + subj + time.join('') + oblStr + preAdv + prog + modal + neg + predTxt + obj + (past && !/了|过$/.test(predTxt + obj) ? past : '');
  if (!predTxt && !topic && !subj && !obj) s = units.map(function (u) { return u.zh || ''; }).join('');

  // 句末
  var fin = F.final || {};
  s = trim(s).replace(/[。、，]+$/, '');
  if (fin.sug) s = '要不要' + s.replace(topic, '') + '呢？';
  else if (fin.qnot) s += '，不是吗？';
  else if (fin.q) s += '吗？';
  else if (fin.guess) s += (fin.guess === '吧' ? '吧？' : '吧。');
  else if (fin.soft !== undefined) s += (fin.soft || '呢') + '。';
  else if (fin.expl) s += '的。';
  else if (fin.ban) s += fin.ban + '！';
  else if (/[？?]\s*$/.test(sent)) s += '？';
  else if (/[！!]\s*$/.test(sent)) s += '！';
  else s += '。';
  if (F.cond) s = '如果' + s;
  return cleanZh(s);
}

function jaText(grp) {
  var s = '';
  grp.w.forEach(function (u) {
    if (u.f === 'gen' || u.src === 'の') { s += '的'; return; }
    if (u.pos === 'part') { s += u.zh || ''; return; }
    if (u.pos === 'sym') { s += u.zh || ''; return; }
    s += u.zh || '';
  });
  if (grp.p && grp.p.f === 'obl' && !/^(から|まで|より)$/.test(grp.p.src)) {
    // 状语由上层加前缀
  }
  return s;
}

/* ============================================== 中→英 / 中→日 */
/** 量词在英/日里常不单独成词（这本书 → this book），按上下文丢弃 */
function clsDrop(units, keepContain) {
  var CLS = { '本': 1, '个': 1, '件': 1, '位': 1, '张': 1, '只': 1, '台': 1, '册': 1, '条': 1, '瓶': 1, '杯': 1, '座': 1, '间': 1, '朵': 1, '头': 1, '匹': 1 };
  var drop = {};
  units.forEach(function (u, ix) {
    if (!CLS[u.src]) return;
    var pv = units[ix - 1], nx = units[ix + 1];
    var num = pv && pv.pos === 'm';
    var dem = pv && /^(这|那|每|几|多|哪)$/.test(pv.src);
    /* 「一杯咖啡」的 杯 是真容器，英文要说 a cup of coffee，交给组句那条规则；
       「这杯咖啡」的 杯 才是纯量词（英文只说 this coffee），照旧丢掉。
       keepContain 只有中→英传：中→日有自己的助数词规则。 */
    if (keepContain && CONTAIN[u.src] && num && !dem && nx && nx.pos === 'n') return;
    if (num || dem || (nx && (nx.pos === 'n' || nx.pos === 'a'))) drop[ix] = 1;
  });
  return drop;
}
/* 不可数名词：英文动词后面不能补 a（喝水 → drink water，不是 drink a water）。
   词库没有可数性标注，这张表按中文里最常当宾语的那些不可数名词列。 */
var MASS = {};
('water money time work homework music rice food bread meat coffee tea sugar milk juice ' +
 'information advice weather traffic knowledge love help news progress luck fun energy ' +
 'power electricity transportation research business history science art sport exercise ' +
 'hair sleep rest peace beauty nature space light air salt pepper paper cloth cash ' +
 'travel study training education experience courage patience confidence interest').split(' ')
  .forEach(function (w) { MASS[w] = 1; });
/* 「功能性谓语」：be 系列、完成/进行助动词、do 系列、情态动词、否定词、介词。
   组句时到处要找真正的实义谓语、或者跳过这些词，四处用的词表以前各写各的。 */
var AUXISH = {};
('be am is are was were been being have has had do does did will would shall can could ' +
 'must should may might ought not no to of').split(' ').forEach(function (w) { AUXISH[w] = 1; });
function isAuxEn(w) { return AUXISH[String(w || '').trim().toLowerCase()] === 1; }
/* 英文句子不能没有主语：代词、或者不挂在介词/所有格/副词后面的名词都算有。
   「今天很热」两样都没有，才补 it；「昨天他没有来」有 he，别再补。 */
function hasSubj(list) {
  for (var hi = 0; hi < list.length; hi++) {
    if (list[hi].pos === 'r') return true;
    if (list[hi].pos !== 'n') continue;
    var hb = list[hi - 1];
    if (!hb || (hb.pos !== 'p' && hb.pos !== 't' && hb.pos !== 'd')) return true;
  }
  return false;
}
/* 数词（英文写法）：数量词后面的名词要变复数，两趟复数判断共用这张表。 */
var NUMWORD = {};
('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen ' +
 'sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety ' +
 'hundred thousand million several many few both dozen').split(' ').forEach(function (w) { NUMWORD[w] = 1; });
/* 有实义的容器量词：一杯水 → a cup of water。个、本、位 这类纯语法量词英文没有
   对应名词，照旧丢掉；这里只列中文当量词用、本身又确有器物义的常用字。 */
var CONTAIN = {};
'杯 碗 瓶 壶 桶 盘 碟 袋 箱 勺 罐 盆 片 份 口 卷'.split(' ')
  .forEach(function (z) { CONTAIN[z] = 1; });
/* 人称代词的所有格：中文「你的帮助」不显形，英文「thank you for your help」要变格。 */
var POSSESS = { '我': 'my', '你': 'your', '您': 'your', '他': 'his', '她': 'her', '它': 'its', '我们': 'our', '你们': 'your', '他们': 'their', '她们': 'their' };
/* 时间名词：英文说 in the morning / at seven o'clock，中文的时间状语摆在动词前，
   组句时要整块挪到句尾（每天早上七点起床 → get out of bed at seven o'clock every morning）。 */
var PARTDAY = {
  '早上': 'morning', '早晨': 'morning', '清晨': 'early morning', '上午': 'morning',
  '中午': 'noon', '下午': 'afternoon', '晚上': 'evening', '夜里': 'night',
  '半夜': 'midnight', '今晚': 'tonight', '今早': 'this morning'
};
var ZH_AUX = {
  '了': 'past', '过': 'exp', '正在': 'prog', '正': 'prog', '着': 'prog', '将': 'will', '将要': 'will', '会': 'will',  '被': 'pass', '把': 'ba', '吗': 'q', '呢': 'q2', '吧': 'sug', '很': 'very', '非常': 'very', '太': 'too',
  '都': 'all', '也': 'also', '还': 'still', '就': 'then', '才': 'onlythen', '又': 'again', '再': 'again',
  '不': 'neg', '没': 'neg', '没有': 'neg', '的': 'de', '地': 'de', '得': 'de', '和': 'and', '跟': 'with',
  '对': 'to', '为': 'for', '因为': 'because', '所以': 'so', '但是': 'but', '虽然': 'although', '如果': 'if',
  '在': 'at', '里': 'in', '上': 'on', '下': 'under', '中': 'in', '这': 'this', '那': 'that', '我': 'I',
  '我们': 'we', '你': 'you', '你们': 'you', '他': 'he', '她': 'she', '它': 'it', '他们': 'they',
  '谁': 'who', '什么': 'what', '哪里': 'where', '什么时候': 'when', '怎么': 'how', '为什么': 'why',
  '多少': 'how much', '几': 'how many', '哪': 'which', '一些': 'some', '有点': 'a bit', '可以': 'can',
  '很多': 'a lot of', '许多': 'a lot of', '没多少': 'little',
  '可能': 'may', '也许': 'may',
  '能': 'can', '要': 'want to', '想': 'want to', '应该': 'should', '必须': 'must', '需要': 'need',
  '喜欢': 'like', '爱': 'love', '吃': 'eat', '喝': 'drink', '看': 'watch', '读': 'read', '写': 'write',
  '说': 'say', '讲': 'speak', '去': 'go', '来': 'come', '做': 'do', '工作': 'work', '学习': 'study',
  '买': 'buy', '卖': 'sell', '给': 'give', '有': 'have', '是': 'be', '家': 'home', '朋友': 'friend',
  '请': 'please', '谢谢': 'thank'
};

/* 中文疑问句把疑问词留在原位（你去哪里？），英语要提前并倒装。
   有 be/助动词就把它提到主语前，没有就补 do/does/did，动词还原成原形。 */
var WH_EN = /^(who|whom|whose|what|where|when|why|how|which|how much|how many)$/i;
var AUX_EN = /^(am|is|are|was|were|be|will|would|can|could|must|should|may|might|have|has|had)$/i;

function zhInvert(list, F) {
  if (!F.q) return;
  var wi = -1;
  for (var i = list.length - 1; i >= 0; i--) {
    var w = String(list[i].w || '').trim();
    if (w && WH_EN.test(w)) { wi = i; break; }
  }
  if (wi < 0) return;
  var wh = list.splice(wi, 1)[0];
  list.unshift(wh);
  if (wi === 0) return;                       // 疑问词本来就是主语，不用倒装
  var ai = -1;
  for (var j = 1; j < list.length; j++) {
    var x = String(list[j].w || '').trim().toLowerCase();
    if (AUX_EN.test(x) || /^(do|does|did) not$/.test(x)) { ai = j; break; }
  }
  if (ai > 0) { list.splice(1, 0, list.splice(ai, 1)[0]); return; }
  /* 句子里本来就没有动词（这个多少钱）→ 补 be；有动词才补 do/does/did */
  var hasVerb = list.some(function (x) { return x.pos === 'v' || x.pos === 'a'; });
  if (!hasVerb) { list.splice(1, 0, { w: beOf(list, 1), pos: 'x' }); return; }
  var subj = String(list[1] ? list[1].w : '').trim().toLowerCase();
  list.splice(1, 0, { w: F.past ? 'did' : (/^(he|she|it|this|that)$/.test(subj) ? 'does' : 'do'), pos: 'x' });
  for (var k = 2; k < list.length; k++) {
    if (list[k].base) { list[k].w = list[k].base; delete list[k].base; break; }
  }
}

/* 词库存的是一个词最常见的说法，句子里要的可能是另一个词性：「做作业」要
   homework（词库主键是 operate），「这本书很奇怪」要 peculiar（主键 marvel 是动词）。
   构建时按词性另存了一份备选（词条第 4 位），这里按槽位取。 */
function reslot(list, vi) {
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (!it.e || !it.e.senses) continue;
    var want = '';
    if (i === vi) want = it.pos === 'a' ? 'a' : (it.pos === 'v' ? 'v' : '');
    else {
      var pv = i > 0 ? list[i - 1] : null, nx = list[i + 1];
      if (pv && /^(v|p|x)$/.test(pv.pos || '') && pv.adj !== 1 && it.pos !== 'v') want = 'n';
      else if (it.pos === 'n' && nx && nx.pos === 'n') want = 'a';
    }
    if (!want) continue;
    var cut = short(sense(it.e, want));
    if (cut && sense(it.e, want) !== it.e.g) { it.w = cut; it.pos = want; }
  }
}

/* 「来上班」「去吃饭」的 来/去 是趋向补语，译文里已经有了（go to work / 働く）。
   英文还要看后面那个动词的译法是不是 go/come 一类——「来帮助我」的 come 有实义，
   不能丢；日文的谓语本来就是另一个词，一律折掉。 */
function motionZh(units, drop, isJa) {
  units.forEach(function (u, ux) {
    var nx = units[ux + 1];
    if (!nx || !/^[来去]$/.test(u.src) || nx.pos !== 'v') return;
    if (isJa || /^(go|come|walk|drive|take)\b/i.test(String(nx.zh || ''))) drop[ux] = 1;
  });
}

function enFromZh(units, sent) {
  var F = { past: 0, exp: 0, prog: 0, will: 0, pass: 0, q: 0, sug: 0, neg: 0, have: 0, futureWord: 0, cond: 0 };
  if (/[？?]\s*$/.test(sent)) F.q = 1;         // 「你去哪里？」没有吗，也照样是问句
  var list = [];
  var drop = clsDrop(units, true);
  /* 「没有 + 动词」是否定，不是「have no」：切词把 没有 切成 没|有 时，
     后面还跟着动词就把 有 丢掉，否则英文会说 do not have to come。
     同理「来上班」「去上班」的 来/去 只是趋向补语，英文译在 上班 里就够了。 */
  units.forEach(function (u, ux) {
    var nx = units[ux + 1];
    if (!nx) return;
    if (/^没/.test(u.src) && nx.src === '有' && units[ux + 2] && units[ux + 2].pos === 'v') drop[ux + 1] = 1;
  });
  motionZh(units, drop, false);
  /* 「谢谢你的帮助」中文是「谢谢 + 你 + 的 + 名词」，英文要说 thank you for
     your help：谢谢 换成动词 thank 并补出宾格 you，的 换成 for，
     代词变成所有格，后面的名词不再当第二个谓语。 */
  var OBJP = { '我': 'me', '你': 'you', '您': 'you', '他': 'him', '她': 'her', '它': 'it',
    '我们': 'us', '你们': 'you', '他们': 'them', '她们': 'them' };
  var thanks = {};
  var cmd = 0;                      // 祈使句（谢谢你帮我）：开头的 thank 不是主语，别折成动名词
  units.forEach(function (u, ux) {
    if (u.src !== '谢谢') return;
    var pron = units[ux + 1], de = units[ux + 2], obj = units[ux + 3];
    if (!pron || !POSSESS[pron.src]) return;
    if (!de || !obj || de.src !== '的') {
      /* 「谢谢你帮我」：英文要说 thank you for helping me，
         后面的动词折成介词 for 的动名词。 */
      if (de && de.pos === 'v') {
        u.zh = 'thank'; u.pos = 'v'; u.how = 'rule';   // 宾格由 你 这一格自己变出来
        pron.zh = OBJP[pron.src]; pron.pos = 'r'; pron.keep = 1;
        de.forFor = 1; cmd = 1;
      }
      return;
    }
    u.zh = 'thank'; u.pos = 'v'; u.how = 'rule';
    thanks[ux] = OBJP[pron.src];
    pron.zh = POSSESS[pron.src]; pron.pos = 't';
    de.src = 'for'; de.zh = 'for'; de.pos = 'p'; de.how = 'rule';
    de.keep = 1;                     // 这个 for 是 thank you for 的一部分，别当处所状语挪走
    obj.pos = 'n';                   // 「你的帮助」里的 帮助 是名词，不是第二个谓语
  });
  /* 「很 + X」是中文形容词的鉴定式：热、忙、安静 这些字在词库里按名词收，
     被程度副词一修饰就该当谓语形容词用（今天很热 → It is hot today）。
     词库里标成动词、但带了形容词义项的（奇怪 → marvel/peculiar）也一样，
     「这本书很奇怪」要 is peculiar，不是 This book marvels。 */
  units.forEach(function (u, ui) {
    var av = ZH_AUX[u.src];
    var nx = units[ui + 1];
    if (!/^(very|too|most|a bit)$/.test(av || '') || !nx) return;
    if (/^(n|m)$/.test(nx.pos || '')) nx.pos = 'a';
    else if (nx.pos === 'v' && nx.e && nx.e.senses && (nx.e.senses.a || nx.e.senses.d)) nx.pos = 'a';
  });
  units.forEach(function (u, ux) {
    if (drop[ux]) return;
    if (u.how === 'sym') { list.push({ sym: u.src }); return; }
    if (u.forFor) {
      list.push({ w: 'for', pos: 'p', keep: 1 },
        { w: ing(String(u.zh || u.src).toLowerCase()), pos: 'v', ger: 1 });
      return;
    }
    if (thanks[ux]) { list.push({ w: 'thank', pos: 'v' }, { w: thanks[ux], pos: 'r' }); return; }
    var aux = ZH_AUX[u.src];
    if (aux === 'past') { F.past = 1; return; }
    if (aux === 'exp') { F.exp = 1; return; }
    if (aux === 'prog') { F.prog = 1; return; }
    if (aux === 'will') { F.will = 1; return; }
    if (aux === 'pass') { F.pass = 1; return; }
    if (aux === 'q') { F.q = 1; return; }
    if (aux === 'sug') { F.sug = 1; return; }
    if (aux === 'neg') {
      F.neg = 1;
      var ng = ux + 1;
      while (ng < units.length && units[ng].how === 'sym') ng++;
      /* 没 + 名词 = have no；切成 没|有 + 名词 时（他没有钱）也是同一个意思，
         英文靠 have no 表达，那个 有 不当谓语。 */
      if (/^没/.test(u.src)) {
        var nxt = units[ng];
        if (nxt && nxt.src === '有' && units[ng + 1] && /^(n|m)$/.test(units[ng + 1].pos || '')) {
          F.have = 1; drop[ng] = 1;
        } else if (nxt && /^(n|m)$/.test(nxt.pos || '')) F.have = 1;
      }
      return;
    }
    if (aux === 'at') {
      /* 「她在厨房做饭」的 在 引进处所，后面还有动词 → 英文用进行时；
         「车站在哪里」的 在 后面是疑问代词 → 干脆当系动词用；
         「你在哪里工作」后面还有动词，英文靠 do-support 提问，这个 在 丢掉。 */
      var nx2 = units[ux + 1];
      if (nx2 && /^哪/.test(nx2.src)) {
        var moreV = false;
        for (var mv = ux + 1; mv < units.length; mv++) if (units[mv].pos === 'v') { moreV = true; break; }
        if (!moreV) list.push({ w: 'be', pos: 'x' });
        return;
      }
      var laterV = false;
      for (var lv = ux + 1; lv < units.length; lv++) if (units[lv].pos === 'v') { laterV = true; break; }
      if (nx2 && nx2.pos === 'v') { F.prog = 1; return; }
      if (laterV) { F.prog = 1; list.push({ w: 'in', pos: 'p' }); return; }
      list.push({ w: 'at', pos: 'p' }); return;
    }
    if (/^(昨|上(个)?(月|周|年)$|去(年|月|周)$|前天$|上次$|过去$)/.test(u.src) && /^(t|d|n)$/.test(u.pos || '')) F.past = 1;
    /* 明天、下周把句子推到将来时（明天我们不去公园 → we will not go to the park tomorrow）。
       有没有主语、要不要真的补 will，等 list 建好再看（「明天见」不该说 will see）。 */
    if (/^(明天|后天|明年|明早|明晚|大后天|下次|以后|将来|下周|下个月|下年|今晚)$/.test(u.src) && /^(t|d|n)$/.test(u.pos || '')) F.futureWord = 1;
    /* 「每天早上」英文是 every morning，不是 every day early morning；
       光杆的「早上」则是 in the morning。 */
    if (/^(每天|天天)$/.test(u.src)) {
      var nx3 = units[ux + 1];
      if (nx3 && PARTDAY[nx3.src]) { list.push({ w: 'every ' + PARTDAY[nx3.src], pos: 't', isT: 1 }); drop[ux + 1] = 1; return; }
      list.push({ w: 'every day', pos: 't', isT: 1 }); return;
    }
    if (u.src === '现在') { list.push({ w: 'now', pos: 't', isT: 1 }); return; }
    var pd = PARTDAY[u.src];
    if (pd) { list.push({ w: /^(noon|midnight|tonight)$/.test(pd) ? pd : 'the ' + pd, pos: 't', isT: 1, isBare: 1 }); return; }
    if (aux === 'de' || aux === 'ba') return;
    /* 「很好」的 很 是中文的语法垫字（形容词直接作谓语要有它），英文不说 very good 也成立；
       「非常／十分／特别」是真的程度副词，丢了意思就轻了，要留在形容词前面。 */
    if (aux === 'very') {
      if (!/^(很|多|怪)$/.test(u.src)) list.push({ w: (u.zh || 'very'), pos: 'd' });
      return;
    }
    /* 请 是客气叹词，不是谓语：「请给我一杯咖啡」的动词是 给。 */
    if (aux === 'please') { list.push({ w: 'please', pos: 'd' }); return; }
    /* 「如果…就…」：英文的条件句不靠 then，就/才 直接丢掉。 */
    if (aux === 'if') { F.cond = 1; list.push({ w: 'if', pos: 'c' }); return; }
    if (aux === 'then' && F.cond) return;
    /* 「我要一杯咖啡」的 要 在虚词表里是 want to，可英文的 want to 后面必须有动词：
       后面接的是名词就把 to 收掉（I want a cup of coffee）。 */
    if (aux === 'want to') {
      var nverb = 0;
      for (var nvi = ux + 1; nvi < units.length && nvi < ux + 4; nvi++) {
        if (drop[nvi]) continue;
        if (units[nvi].pos === 'v') { nverb = 1; break; }
        if (/^(n|r|m)$/.test(units[nvi].pos || '')) break;
      }
      list.push({ w: nverb ? 'want to' : 'want', pos: 'v' }); return;
    }
    if (aux) { list.push({ w: (u.pos === 'x' ? aux : u.zh), pos: u.pos }); return; }
    if (u.how === 'miss') { list.push({ w: '[' + u.src + ']' }); return; }
    if (u.pos === 'q' && list.length && /^(m|t|d)$/.test(String(list[list.length - 1].pos || ''))) return;   // 量词（本书/个人）英文不译
    /* 「数词＋量词＋名词」里量词是真有义的（杯 cup、张 sheet）：英文要说
       a cup of water，不能像 一个人 那样直接丢掉量词。 */
    if (u.pos === 'm' && units[ux + 1] &&
        (units[ux + 1].pos === 'n' || (units[ux + 1].pos === 'q' && CONTAIN[units[ux + 1].src])) &&
        units[ux + 2] && /^(n|a)$/.test(units[ux + 2].pos || '') && !drop[ux + 1]) {
      list.push({ w: u.src === '一' ? 'a' : u.zh, pos: 'm' },
        { w: units[ux + 1].zh, pos: 'n', e: units[ux + 1].e },
        { w: 'of', pos: 'p', keep: 1 });
      drop[ux + 1] = 1;
      return;
    }
    if (u.src === '点' && /^(?:[0-9]+|[一二两三四五六七八九十]+)$/.test(units[ux - 1] ? units[ux - 1].src : '')) {
      if (list.length && list[list.length - 1].pos === 'm') list[list.length - 1].isNum = list[list.length - 1].isT = 1;
      list.push({ w: "o'clock", pos: 'n', isT: 1 }); return;      // 七点 → seven o'clock
    }
    if (/^(今天|明天|后天|上午|下午)$/.test(u.src)) {
      list.push({ w: u.zh, pos: 't', isT: 1 }); return;
    }
    list.push({ w: u.zh, pos: u.pos, e: u.e, keep: u.keep });
  });

  /* 有将来时间词、句子又有主语/宾语可挂，才补 will。 */
  if (F.futureWord && !F.past && !F.will && hasSubj(list)) F.will = 1;
  /* 「书在桌子上」：中文说「在 + 名词 + 上」，英文是一个介词短语 on the table。
     尾巴上的方位词（上/里/下…）并到名词前面，把 在（at）换掉，一个介词就够了。 */
  for (var mi = 2; mi < list.length; mi++) {
    var mw = String(list[mi].w || '').trim().toLowerCase();
    if (list[mi].pos !== 'p' || !/^(on|in|under|behind|beside|near|above|below|opposite)$/.test(mw)) continue;
    if (list[mi - 1].pos !== 'n') continue;
    var pb = mi - 2;
    if (list[pb].pos !== 'p' || list[pb].keep) continue;
    if (!/^(at|in)$/.test(String(list[pb].w || '').trim().toLowerCase())) continue;
    list.splice(mi, 1);
    list[pb] = { w: mw, pos: 'p' };
    mi = pb + 1;
  }
  /* 「谢谢 + 你 + 的 + 帮助」：的 换成 for 之后要站到所有格前面，
     英文是 thank you for your help，不是 thank you your for help。 */
  for (var xi = 0; xi + 2 < list.length; xi++) {
    if (!/^thank$/i.test(String(list[xi].w || '')) || !list[xi + 1] || list[xi + 1].pos !== 'r') continue;
    if (!list[xi + 2] || list[xi + 2].pos !== 't') continue;
    var fi2 = -1;
    for (var fj = xi + 3; fj < list.length && fj <= xi + 5; fj++) {
      if (list[fj].pos === 'p' && /^for$/i.test(String(list[fj].w || ''))) { fi2 = fj; break; }
      if (/^(n|v|a)$/.test(list[fj].pos || '')) break;
    }
    if (fi2 < 0) continue;
    var fitem = list.splice(fi2, 1)[0];
    list.splice(xi + 2, 0, fitem);
    xi = fi2;
  }

  // 谓语：中文连动式里变位的总是第一个动词（我爱吃肉 → I love to eat），
  // 没有动词时才用形容词谓语（这本书很有意思 → is enjoyable）。
  var vi = -1, va = -1;
  for (var i = 0; i < list.length; i++) {
    if (vi < 0 && list[i].pos === 'v') vi = i;
    if (list[i].pos === 'a') va = i;
  }
  if (vi < 0) vi = va;
  /* 「学习外语需要很多时间」的主语是一件事：英文把开头的动词折成动名词，
     谓语落到后面那个动词上（Learning a foreign language takes a lot of time）。 */
  if (vi === 0 && !cmd) {
    var vp = -1;
    for (var gi = 1; gi < list.length; gi++) {
      if (list[gi].pos === 'v' && !MODAL[String(list[gi].w || '').toLowerCase()]) { vp = gi; break; }
    }
    if (vp < 0 && va > 0) vp = va;    // 游泳对身体好：后面没有第二个动词，谓语是形容词
    if (vp > 0) {
      list[0].base = String(list[0].w).toLowerCase();
      list[0].w = ing(list[0].base);
      list[0].pos = 'n';
      list[0].ger = 1;               // 动名词作主语，别当成裸奔的可数名词补 the
      vi = vp;
    }
  }
  /* 「书在桌子上」「猫在桌子下面」中文没有谓语动词，英文的介词短语前面得有系动词。 */
  if (vi < 0) {
    var ppi = -1;
    for (var pzi = 1; pzi < list.length; pzi++) {
      if (list[pzi].pos === 'p' && !list[pzi].keep && /^(n|r)$/.test(list[pzi - 1].pos || '')) { ppi = pzi; break; }
    }
    if (ppi > 0) { list.splice(ppi, 0, { w: beOf(list, ppi), pos: 'x' }); vi = ppi; }
  }
  reslot(list, vi);
  /* some / many / 数词 后面的单数可数名词要变复数：一些苹果 → some apples、
     三十分钟 → thirty minutes。两趟复数共用一个 pluralize，变过一次就不再变
     （books → bookses 就是这么来的）；已经带复数词尾、以 s/x/z/ch/sh 结尾、
     词里有空格（a lot of）或撇号的都不动。 */
  var PLU_Q = /^(some|many|few|several|a lot of|lots of|both|other|these|those)$/;
  function isNumWord(w) { return NUMWORD[w] === 1 && w !== 'one' || /^\d+$/.test(w); }
  function pluralize(it) {
    var w = String(it.w || '').trim();
    if (!/^[a-z]+$/.test(w) || /(s|x|z|ch|sh)$/.test(w) || MASS[w]) return;   // 不可数名词不变复数
    it.w = pluralForm(w);
    it.plu = 1;
  }
  for (var pi = 1; pi < list.length; pi++) {
    if (list[pi].pos !== 'n') continue;
    var prevW = String(list[pi - 1].w || '').trim().toLowerCase();
    if (!PLU_Q.test(prevW) && !isNumWord(prevW)) continue;
    pluralize(list[pi]);
  }
  if (vi >= 0) {
    var base = String(list[vi].w).toLowerCase();
    var isAdj = list[vi].pos === 'a';
    if (isAdj) {
      // 形容词谓语要补系动词，否定也落在这个系动词上（她不漂亮 → is not pretty）
      /* 程度副词跟在系动词后面（is very interesting），不是前面：插入点往前挪过副词串。 */
      var bj = vi;
      while (bj > 0 && list[bj - 1].pos === 'd') bj--;
      var beW = beOf(list, vi) + (F.neg ? ' not' : '');
      list.splice(bj, 0, { w: beW, pos: 'x' });
      if (F.will) list.splice(bj, 0, { w: 'will', pos: 'x' });
      list[vi + 1 + (F.will ? 1 : 0)].adj = 1;
    } else {
      if (F.prog) { list.splice(vi, 0, { w: beOf(list, vi) }); vi++; list[vi].w = ing(base); }
      else if (F.exp) list[vi].w = 'have ever ' + past(base);
      else if (F.past) { list[vi].base = base; list[vi].w = F.neg ? base : past(base); }
      else if (F.neg || F.will) list[vi].w = base;   // 有助动词在前，谓语就不带三单词尾
      else if (thirdSg(list, vi) && !MODAL[base] && !BE[base]) { list[vi].base = base; list[vi].w = sForm(base); }
      if (F.pass && list[vi].pos === 'v') { list[vi].w = beOf(list, vi) + ' ' + past(String(list[vi].w).replace(/^is |are |was /, '')); }
      if (F.neg) list.splice(vi, 0, { w: F.will ? 'will not' : (F.past ? 'did not' : 'do not'), pos: 'x' });
      else if (F.will) list.splice(vi, 0, { w: 'will', pos: 'x' });
    }
  } else if (F.neg) {
    // 「我不是学生」这类没有实义谓语的否定句：否定词跟在 be 后面，
    // 时态人称交给下面的 be 变位一起处理。
    var bi = -1;
    for (var k = 0; k < list.length; k++) if (/^(be|am|is|are|was|were)$/i.test(String(list[k].w || '').trim())) { bi = k; break; }
    if (bi >= 0) list[bi] = { w: String(list[bi].w) + ' not', pos: 'x' };
    else {
      var ni = list.length - 1;
      while (ni > 0 && list[ni].sym) ni--;              // 句号、问号不算被否定的东西
      if (ni > 0 && (F.have || list[ni].pos === 'n')) {
        // 「她没有电话」→ has no telephone：中文的「没 + 名词」英文要说 have no
        var nw = list.splice(ni, 1)[0];
        list.splice(ni, 0, { w: haveOf(list, ni), pos: 'v' }, { w: 'no ' + nw.w, pos: nw.pos });
      } else list.unshift({ w: 'not' });
    }
  }

  /* 「游泳对身体好」的 对 引进的是受益对象，英文说 be good for：
     只有形容词谓语才这样换介词，「他对我说」的 对 还是 to。 */
  var ADJ_FOR = /^(good|bad|healthy|helpful|harmful|important|necessary|easy|difficult|dangerous|safe|fun|interesting|right|wrong|common|suitable)$/;
  var predAdj = '';
  for (var ai = 0; ai < list.length; ai++) {
    if (!/^(am|is|are|was|were|be)\b/i.test(String(list[ai].w || ''))) continue;
    var aj = ai + 1;
    while (aj < list.length && list[aj].pos === 'd') aj++;      // is very interesting：副词夹在中间
    if (list[aj] && list[aj].adj === 1) { predAdj = String(list[aj].w).toLowerCase(); break; }
  }
  if (ADJ_FOR.test(predAdj)) {
    for (var fi = 0; fi + 1 < list.length; fi++) {
      if (list[fi].pos === 'p' && /^to$/i.test(String(list[fi].w)) && /^(n|r|d)$/.test(list[fi + 1].pos || '')) list[fi].w = 'for';
    }
  }

  /* 连动第二个动词在英文里是不定式（爱吃肉 → love to eat meat），
     但助动词、be 后面直接跟原形，不能塞 to（应该鼓励 → should encourage）。 */
  for (var cj = 1; cj < list.length; cj++) {
    if (list[cj].pos !== 'v') continue;
    if (list[cj].ger) continue;      // thank you for helping：动名词后面不接 to
    var cprev = String(list[cj - 1].w || '').trim().toLowerCase();
    if (MODAL[cprev] || BE[cprev] || /^(do|does|did|not|no|have|has|had|to)$/.test(cprev) || /\bto$/.test(cprev)) continue;
    /* 中间隔了宾语也要补 to（骑自行车去上班 → ride a bicycle to go to work），
       但前提是前面确实有一个实义动词当地位语（I go 这种开头不算连动）。 */
    var hadV = list[cj - 1].pos === 'v';
    for (var hv = 0; !hadV && hv < cj - 1; hv++) {
      var hw = String(list[hv].w || '').trim().toLowerCase();
      if (list[hv].pos === 'v' && !isAuxEn(hw)) hadV = true;
    }
    if (!hadV) continue;
    list.splice(cj, 0, { w: 'to', pos: 'p' });
    cj++;
  }
  /* 数量词后面的名词要复数（两个朋友 → two friends），go 后面的处所要有 to */
  for (var qi = 1; qi < list.length; qi++) {
    var pw = String(list[qi - 1].w || '').trim().toLowerCase();
    if (list[qi].pos === 'n' && !list[qi].plu && !/'/.test(String(list[qi].w || '')) && isNumWord(pw)) {
      pluralize(list[qi]);
    }
    if (/^(go|goes|went|going|come|comes|came)$/i.test(pw) && list[qi].pos === 'n' &&
        !/^(home|there|here|abroad)$/.test(String(list[qi].w || '').trim().toLowerCase())) {
      list.splice(qi, 0, { w: 'to', pos: 'p' }); qi++;
    }
  }
  /* 「我喜欢苹果」说的是这一类东西，不是某一个：like/love/hate/enjoy/prefer 后面
     裸着的单数可数名词用复数（I like apples），冠词那一趟也就不会再补 a。 */
  var PREF = /^(like|likes|liked|love|loves|loved|enjoy|enjoys|enjoyed|hate|hates|hated|prefer|prefers|preferred)$/;
  for (var li2 = 0; li2 + 1 < list.length; li2++) {
    if (!PREF.test(String(list[li2].w || '').trim().toLowerCase())) continue;
    var objN = list[li2 + 1];
    if (objN && objN.pos === 'n' && /^[a-z]+$/.test(String(objN.w || '').trim()) && !MASS[String(objN.w || '').trim()]) {
      pluralize(objN);
      li2++;
    }
  }
  /* 时间副词中文摆在动词前，英文要挪到句尾（昨天去了学校 → went to school yesterday） */
  for (var ti = list.length - 2; ti >= 0; ti--) {
    if (!/^(yesterday|today|tomorrow|now|tonight)$/i.test(String(list[ti].w || '').trim())) continue;
    var adv = list.splice(ti, 1)[0];
    var pos2 = list.length;
    while (pos2 > 0 && list[pos2 - 1].sym) pos2--;        // 别挪到句号后面
    list.splice(pos2, 0, adv);
    if (ti === 0 && !hasSubj(list)) list.unshift({ w: 'it', pos: 'r' });    // 「今天很热」缺主语，英文要补 it
  }

  /* 中文的处所状语贴在动词前（她在厨房做饭），英文得挪到句尾：
     She in a kitchen is cooking → She is cooking in a kitchen。 */
  var pv2 = -1;
  for (var pvi = 0; pvi < list.length; pvi++) {
    var pw2 = String(list[pvi].w || '').trim().toLowerCase();
    if ((list[pvi].pos === 'v' && !isAuxEn(pw2)) || list[pvi].adj === 1) { pv2 = pvi; break; }
  }
  if (pv2 > 1) {
    for (var ppi = 1; ppi < pv2; ppi++) {
      if (list[ppi].pos !== 'p' || list[ppi].keep) continue;
      if (!/^(at|in|on|with|for|from|about|under|near|by)$/.test(String(list[ppi].w || '').toLowerCase())) continue;
      var pend = ppi + 1;
      while (pend < pv2 && list[pend].pos !== 'v' && list[pend].pos !== 'p' &&
!isAuxEn(list[pend].w)) pend++;
      var chunk = list.splice(ppi, pend - ppi);
      var insAt = list.length;
      while (insAt > 0 && list[insAt - 1].sym) insAt--;
      Array.prototype.splice.apply(list, [insAt, 0].concat(chunk));
      pv2 = ppi;                                   // 状语搬走后的谓语位置
      break;
    }
  }

  /* 时间块挪到句尾：先钟点（at seven o'clock），再频次（every morning）。 */
  var vt3 = -1;
  for (var k3 = 0; k3 < list.length; k3++) {
    var kw = String(list[k3].w || '').trim().toLowerCase();
    if (list[k3].pos === 'v' && !isAuxEn(kw)) { vt3 = k3; break; }
  }
  if (vt3 > 1) {
    var clocks = [], freqs = [];
    for (var k4 = vt3 - 1; k4 >= 1; k4--) {
      var it = list[k4];
      if (!it.isT) continue;
      if (/^o'clock$/i.test(String(it.w))) {
        clocks.unshift(it);
        if (k4 > 1 && list[k4 - 1].isNum) { clocks.unshift(list[k4 - 1]); list.splice(k4 - 1, 1); k4--; }
        clocks.unshift({ w: 'at', pos: 'p' });
      } else {
        freqs.unshift(it);
        if (it.isBare) freqs.unshift({ w: /^(noon|midnight)$/.test(String(it.w)) ? 'at' : 'in', pos: 'p' });
      }
      list.splice(k4, 1);
    }
    if (clocks.length || freqs.length) {
      var endT = list.length;
      while (endT > 0 && list[endT - 1].sym) endT--;
      Array.prototype.splice.apply(list, [endT, 0].concat(clocks, freqs));
    }
  }

  /* be 按主语变位：中文的「他是老师」在 list 里就是 he + be */
  for (var i2 = 0; i2 < list.length; i2++) {
    var mw = String(list[i2].w || '').match(/^be( not)?$/i);
    if (mw) list[i2].w = beOf(list, i2) + (mw[1] || '');
  }
  /* 中文的「给我一杯水」宾格不显形，英文动词、介词后面的代词要变格 */
  var OBJ = { i: 'me', he: 'him', she: 'her', it: 'it', we: 'us', they: 'them' };
  for (var oi = 1; oi < list.length; oi++) {
    var ow = String(list[oi].w || '').trim().toLowerCase();
    if (!OBJ[ow]) continue;
    var prev = String(list[oi - 1].w || '').trim().toLowerCase().replace(/ not$/, '');
    if (/^(am|is|are|was|were|be)$/.test(prev)) continue;      // It is I 不动
    if (list[oi - 1].pos === 'v' || list[oi - 1].pos === 'p' || /^(with|for|to|from)$/.test(prev)) list[oi].w = OBJ[ow];
  }
  zhInvert(list, F);
  /* 单数可数名词裸奔要补冠词：他是老师 → He is a teacher，
     她在厨房 → She is in the kitchen。专有名词（首字母大写）、复数、
     已有冠词/指示词/物主代词在前的都不管；by + 工具（by bus）也不加。
     倒装之后再补，疑问句里的 车站在哪里 → Where is the station 才拿得到冠词。 */
  for (var ai = list.length - 1; ai > 0; ai--) {
    if (list[ai].pos !== 'n') continue;
    var an = String(list[ai].w || '').trim();
    if (!/^[a-z]/.test(an) || /(s|es|x|ch|sh)$/.test(an) || /\s/.test(an)) continue;
    var before = String(list[ai - 1].w || '').trim().toLowerCase().replace(/ not$/, '');
    if (/^by$/.test(before)) continue;
    var need = /^(am|is|are|was|were|be)$/.test(before) ||
      /^(at|in|on|with|for|from|about|under|behind|beside|near|above|below)$/.test(before) ||
      (list[ai - 1].pos === 'v' && !MASS[an]);    // 及物动词后的单数名词：ride a bicycle
    var art = F.q ? 'the' : (/^[aeiou]/.test(an) ? 'an' : 'a');
    if (!need) {
      /* go to the park：去向后面的处所是特指，by bus 那种工具不加冠词 */
      var mv = String(list[ai - 2] ? list[ai - 2].w || '' : '').trim().toLowerCase();
      if (before !== 'to' || !/^(go|goes|went|going|come|comes|came|walk|walks|walking|travel|travels)$/.test(mv)) continue;
      art = 'the';
    }
    list.splice(ai, 0, { w: art, pos: 't' });
    ai--;
  }
  /* 句首那个裸奔的可数名词是主语：书在桌子上 → The book is on the table。
     不可数名词（音乐、爱）泛指时不加冠词，但有 today/now 这类具体时间状语时
     英文是特指的：今天天气很好 → The weather is good today。 */
  if (list.length && list[0].pos === 'n' && !list[0].ger) {
    var wn = String(list[0].w || '').trim();
    var hasWhen = list.some(function (x) {
      return /^(today|tonight|tomorrow|now|yesterday|this morning)$/.test(String(x.w || '').trim().toLowerCase());
    });
    /* 光查一个词（门 → door）不是句子，别补冠词。 */
    var hasPred = list.some(function (x) {
      return x.pos === 'v' || x.pos === 'a' || /^(am|is|are|was|were|be)$/i.test(String(x.w || '').trim());
    });
    if (hasPred && /^[a-z]/.test(wn) && !/(s|es|x|ch|sh)$/.test(wn) && !/\s/.test(wn) && (!MASS[wn] || hasWhen)) {
      list.unshift({ w: 'the', pos: 't' });
    }
  }

  var s = list.map(function (x) {
    if (x.sym) return { '，': ',', '。': '.', '？': '?', '！': '!', '；': ';', '：': ':', '、': ',', '“': '"', '”': '"', '（': '(', '）': ')' }[x.sym] || ' ';
    return x.w == null ? '' : String(x.w);
  }).join(' ');
  s = s.replace(/\s+([,.;:!?()"])/g, '$1').replace(/ {2,}/g, ' ').trim();
  /* 词典把 然后 记成「And」（句首形式），跟在逗号后面得改小写 */
  s = s.replace(/,\s+(And|But|So|Then)\b/g, function (m, w) { return ', ' + w.toLowerCase(); });
  s = s.replace(/\?{2,}/g, '?').replace(/!{2,}/g, '!');
  s = s.replace(/do not (is|are|am)\b/gi, 'not $1').replace(/does not\b/g, 'do not');
  if (F.q) {
    if (!/[?？]/.test(s)) s = /^(am|is|are|was|were|do|does|did|will|can|must|should|who|what|where|when|why|how|which)\b/i.test(s) ? s : 'Do ' + s;
    s = s.replace(/[.？?\s]*$/, '') + '?';
  }
  if (F.sug) s = s.replace(/[.]$/, '') + ', right?';
  if (/[？?]$/.test(sent)) s = s.replace(/[.]$/, '') + '?';
  if (!/[?!.]$/.test(s) && s) s += '.';
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); });
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return s.replace(/\s+/g, ' ').replace(/\s+([,?.!])/g, '$1').replace(/\?{2,}/g, '?').replace(/!{2,}/g, '!').trim();
}
function beOf(list, i) {
  var subj = list.slice(0, i).map(function (x) { return x.w; }).join(' ').toLowerCase();
  if (/i\b/.test(subj) && !/we/.test(subj)) return 'am';
  if (/\b(we|you|they)\b/.test(subj)) return 'are';
  return 'is';
}

/* 主语是第三人称单数吗（他没电话 → has）：代词看词形，名词没有复数标记就算单数。
   叹词、助动词、介词不算主语（请给我一杯咖啡 的主语是隐含的 you）。 */
function thirdSg(list, i) {
  var subj = list.slice(0, i).filter(function (x) { return !/^(d|x|c|p)$/.test(x.pos || ''); })
    .map(function (x) { return String(x.w || ''); }).join(' ').toLowerCase().trim();
  if (!subj) return false;
  if (/\b(i|we|you|they|these|those)\b/.test(subj)) return false;
  if (/\b(he|she|it|this|that)\b/.test(subj)) return true;
  return !/(s|es|xen|ren)$/.test(subj.split(' ').pop());
}
function haveOf(list, i) { return thirdSg(list, i == null ? list.length : i) ? 'has' : 'have'; }

/* 一般现在时的三单词尾、名词复数词尾：规则同 CEDICT/Atlas 里的常见写法 */
function sForm(w) {
  var IRR = { have: 'has', do: 'does', go: 'goes', be: 'is', say: 'says', have2: '' };
  if (IRR[w]) return IRR[w];
  if (/(s|x|z|ch|sh)$/.test(w)) return w + 'es';
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
  return w + 's';
}
function pluralForm(w) {
  if (/(s|x|z|ch|sh)$/.test(w)) return w + 'es';
  if (/f$/.test(w)) return w.slice(0, -1) + 'ves';
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
  if (/(fe)$/.test(w)) return w.slice(0, -2) + 'ves';
  return w + 's';
}

/* 日语组句的封闭规则表：指示词、助数词、疑问词、て形变格。
   这里放的都是语法标记（この・を・ですか 一类），和 ZH_AUX / MASS 同一性质；
   词条本身仍然只从词库来，不在引擎里手写单词。 */
var JA_DEMO = { '这': 'この', '那': 'その', '哪': 'どの' };
var JA_MEASURE = {
  '个': 'つ', '本': '冊', '张': '枚', '条': '本', '只': '匹', '台': '台', '件': '件',
  '双': '足', '副': '組', '块': '枚', '辆': '台', '架': '機', '间': '部屋', '层': '階',
  '位': '人', '顿': '回', '次': '度', '支': '本', '种': '種類', '座': '基'
};
/* 「每天早上」日语是一个词：毎朝。只收真能这样合并的时段。 */
var JA_PARTDAY = { '早上': '朝', '早晨': '朝', '清晨': '朝', '晚上': '夜', '夜里': '夜' };
/* 宾语在日语里挂「に」而不是「を」的那类谓语：适合・到着・会う…
   （这里定的是格位，不是词义，词义仍旧只来自词库。） */
var JA_NI_V = {};
'适合 适应 符合 属于 到达 抵达 见面 结婚 离婚 对不起 抱歉 担心 靠近 类似 等于 有助于 影响'.split(' ')
  .forEach(function (z) { JA_NI_V[z] = 1; });
var JA_WH = { 'どこ': 1, 'いつ': 1, 'だれ': 1, 'なに': 1, '何': 1, 'いくつ': 1,
              'どう': 1, 'どちら': 1, 'どれ': 1, 'どんな': 1, 'なぜ': 1, 'いくら': 1 };
var JA_ICHIDAN = { '見る': 1, '出る': 1, '起きる': 1, '食べる': 1, '教える': 1, '考える': 1, '合わせる': 1, '比べる': 1, 'できる': 1, 'いられる': 1 };
var JA_GODAN_RU = { '帰る': 1, '入る': 1, '走る': 1, '限る': 1, '要る': 1, '切る': 1, '知る': 1, '借りる': 1, '売る': 1, '作る': 1, '曲がる': 1, '変わる': 1, '終わる': 1, '分かる': 1 };
var TE_ROW = { く: 'いて', ぐ: 'いで', す: 'して', つ: 'って', ぬ: 'んで', む: 'んで', ぶ: 'んで', う: 'って', る: 'って' };

function isCaseJa(w) { return ['で', 'に', 'を', 'と', 'から', 'まで', 'へ', 'より', 'は', 'が'].indexOf(String(w)) >= 0; }
function teJa(v, conj) {
  // 辞書形 → て形：サ変はして、一段は去る加て、五段按语尾变化（行く→行って 是去る加って）
  v = String(v);
  if (conj === 'suru' || /する$/.test(v)) return v.replace(/する$/, '') + 'して';
  if (/く$/.test(v) && /^(行|来|告)/.test(v)) return v.slice(0, -1) + 'って';
  var end = v.slice(-1);
  if (end === 'る') {
    if (JA_ICHIDAN[v] || conj === 'v1' || (conj !== 'v5' && !JA_GODAN_RU[v] && /[いえ]る$/.test(v))) {
      return v.slice(0, -1) + 'て';
    }
    return v.slice(0, -1) + 'って';
  }
  return TE_ROW[end] ? v.slice(0, -1) + TE_ROW[end] : v + 'て';
}

function jaFromZh(units, sent) {
  var F = { past: 0, prog: 0, q: 0, neg: 0, will: 0, can: 0, want: 0, must: 0, sug: 0,
            thanks: 0, haveNo: '' };
  var parts = [];
  var dropJ = clsDrop(units);
  motionZh(units, dropJ, true);
  var qMark = /[？?]/.test(String(sent || ''));
  if (qMark) F.q = 1;                       // 日语的问号就等于句尾的「か」
  units.forEach(function (u, ux) {
    if (dropJ[ux]) return;
    if (u.how === 'sym') { parts.push({ sym: u.src }); return; }
    var aux = ZH_AUX[u.src], nu = units[ux + 1], nn = units[ux + 2];
    if (aux === 'past') { F.past = 1; return; }
    if (aux === 'prog') return;
    if (aux === 'q') { F.q = 1; return; }
    if (aux === 'neg') {
      /* 「没有 + 名词」在日语里不是动词句：名词挂「が」，句尾说「がありません」。 */
      var oi = u.src === '没有' ? ux + 1
        : (u.src.charAt(0) === '没' && nu && nu.src === '有' ? ux + 2 : -1);
      var ob = oi >= 0 ? units[oi] : null;
      if (ob && !ZH_AUX[ob.src] && /^(n|r)$/.test(ob.pos || '')) F.haveNo = ob.src;
      F.neg = 1; return;
    }
    if (u.pos === 'x' && /^[不没未非]/.test(u.src)) { F.neg = 1; return; }   // 「不是」整块切出来时也是否定
    /* 中文的虚词在日语里多半变成谓语词尾，不能让它们掉进词库去查（查不到就打方括号）。 */
    if (aux === 'be' || aux === 'ba' || aux === 'q2') return;
    if (aux === 'exp') { F.past = 1; return; }
    if (aux === 'will') { F.will = 1; return; }
    if (aux === 'can') { F.can = 1; return; }
    if (aux === 'may') { parts.push({ w: 'たぶん' }); return; }
    if (aux === 'want to') { F.want = 1; return; }
    if (aux === 'should' || aux === 'must' || aux === 'need') { F.must = 1; return; }
    if (aux === 'sug') { F.sug = 1; return; }
    if (aux === 'please') { parts.push({ w: 'どうぞ', pos: 'd' }); return; }
    if (aux === 'thank') { F.thanks = 1; return; }
    if (aux === 'all') { parts.push({ w: 'みんな' }); return; }
    if (aux === 'still') { parts.push({ w: 'まだ' }); return; }
    if (aux === 'again') { parts.push({ w: 'もう一度' }); return; }
    if (aux === 'then') { parts.push({ w: 'すぐ' }); return; }
    if (aux === 'onlythen') { parts.push({ w: 'ようやく' }); return; }
    if (aux === 'so') { parts.push({ w: 'だから' }); return; }
    if (aux === 'because') { parts.push({ w: 'ので' }); return; }
    if (aux === 'but') { parts.push({ w: 'しかし' }); return; }
    if (aux === 'if') { parts.push({ w: 'もし' }); return; }
    if (aux === 'with' || aux === 'in') { parts.push({ w: 'に' }); return; }
    if (aux === 'a lot of') { parts.push({ w: 'たくさん' }); return; }
    if (aux === 'too') { parts.push({ w: 'とても' }); return; }
    if (aux === 'de') { parts.push({ w: 'の' }); return; }
    /* 这/那/哪 直接修饰名词时要用连体形 この/その/どの，中间的量词不占位置。 */
    if (JA_DEMO[u.src] && nu && !ZH_AUX[nu.src] && /^(n|r|q)$/.test(nu.pos || '')) {
      parts.push({ w: JA_DEMO[u.src], pos: 'det' });
      if (JA_MEASURE[nu.src]) dropJ[ux + 1] = 1;
      return;
    }
    /* 数词＋量词 → 日语的助数词：三本书 → 三冊の本。 */
    if (u.pos === 'm' && !aux && nu && JA_MEASURE[nu.src]) {
      parts.push({ w: u.zh + JA_MEASURE[nu.src] + (nn && nn.pos === 'n' ? 'の' : ''), pos: 'det' });
      dropJ[ux + 1] = 1;
      return;
    }
    /* 「每天早上七点」→ 毎朝七時：中文说两遍，日语是一个词。 */
    if (/^(每天|天天)$/.test(u.src) && nu && JA_PARTDAY[nu.src]) {
      parts.push({ w: '毎' + JA_PARTDAY[nu.src], pos: 'n' });
      dropJ[ux + 1] = 1;
      return;
    }
    /* 「七点」词库里是「点（dot）」，日语要说 七時 */
    if (u.src === '点' && parts.length &&
        /^[0-9０-９一二三四五六七八九十]+$/.test(String(parts[parts.length - 1].w || ''))) {
      var lp = parts[parts.length - 1];
      lp.w = String(lp.w) + '時'; lp.pos = 'n'; return;
    }
    if (aux === 'very') { parts.push({ w: 'とても' }); return; }
    if (aux === 'also') { parts.push({ w: 'も' }); return; }
    if (aux === 'and') { parts.push({ w: 'と' }); return; }
    if (aux === 'to' && u.src === '对') { parts.push({ w: 'に' }); return; }
    if (aux && u.pos === 'x' && !/[一-鿿]/.test(u.zh)) return;   // 只有英文说法的功能词，别漏进日语句子里
    if (u.how === 'miss') { parts.push({ w: '[' + u.src + ']' }); return; }
    parts.push({ w: u.zh, pos: u.pos, tag: u.feat, zh: u.src, haveNo: u.src === F.haveNo ? 1 : 0 });
  });
  // 日语是「名词＋助词」：把「で/に/を…」挪到后面那个名词（或疑问词）之后
  var POST = ['で', 'に', 'を', 'と', 'から', 'まで', 'へ', 'より'];
  for (var pi = 0; pi + 1 < parts.length; pi++) {
    var pj2 = parts[pi + 1];
    if (POST.indexOf(String(parts[pi].w)) >= 0 && pj2 &&
        (pj2.pos === 'n' || pj2.pos === 'det' || JA_WH[String(pj2.w)])) {
      var swp = parts[pi]; parts[pi] = pj2; parts[pi + 1] = swp; pi++;
    }
  }
  /* 「一緒に」：词库里 一起 是名词形（一緒），后面接动词时得补上助词。 */
  for (pi = 0; pi + 1 < parts.length; pi++) {
    if (String(parts[pi].w) === '一緒' && parts[pi + 1].pos === 'v') parts[pi] = { w: '一緒に', pos: 'd' };
  }
  /* 「喜欢／爱 + 动词」日语用连体形：「V のが好きです」，宾语跟着动词一起前置。 */
  for (var li = 0; li + 1 < parts.length; li++) {
    var lw = String(parts[li].w), nv = parts[li + 1];
    if (!/^(好む|好き)$/.test(lw) || !nv || nv.pos !== 'v') continue;
    parts.splice(li + 1, 1);
    var objw = '';
    if (parts[li + 1] && /^(n|r)$/.test(parts[li + 1].pos || '') && !isCaseJa(parts[li + 1].w)) {
      objw = String(parts[li + 1].w) + 'を';
      parts.splice(li + 1, 1);
    }
    parts[li] = { w: objw + String(nv.w) + 'のが好き', pos: 'a' };
    li--;
  }
  /* 指示代词后接名词时要变成连体形：这个 人 → この人。 */
  var JA_DEMO_ADN = { 'これ': 'この', 'それ': 'その', 'あれ': 'その', 'どれ': 'どの' };
  for (pi = 0; pi + 1 < parts.length; pi++) {
    if (JA_DEMO_ADN[String(parts[pi].w)] && /^(n|det)$/.test(parts[pi + 1].pos || '')) {
      parts[pi] = { w: JA_DEMO_ADN[String(parts[pi].w)], pos: 'det' };
    }
  }
  /* 形式动词＋サ变动词（来上班、去开会）：日语只留サ变动词自己。 */
  for (pi = 0; pi + 1 < parts.length; pi++) {
    if (/^(来|来る|きた|行く|来ます|行きます|する)$/.test(String(parts[pi].w)) && parts[pi + 1].pos === 'v') {
      parts.splice(pi, 1); pi--;
    }
  }
  // 主语后补主题助词「は」（「…に感謝します」那句的主语藏在谢的对象里，不另立主题）
  var hasWa = parts.some(function (p) { return p.w === 'は' || p.w === 'が'; });
  if (!hasWa && parts[0] && !F.thanks) {
    var wpos = /^(r|n)$/.test(String(parts[0].pos || '')) ? 1 :
      (parts[0].pos === 'det' && parts[1] && parts[1].pos === 'n' ? 2 : 0);
    if (wpos && parts[wpos] && parts[wpos].pos !== 'sym' && !isCaseJa(parts[wpos].w)) {
      parts.splice(wpos, 0, { w: 'は' });
    }
  }

  var ho = -1, vi = -1;
  for (var i = parts.length - 1; i >= 0; i--) {
    if (parts[i].haveNo && ho < 0) ho = i;
    if (vi < 0 && (parts[i].pos === 'v' || parts[i].pos === 'a')) vi = i;
  }
  /* 谓语后面还挂着宾语或数量短语：日语谓语必须在句尾，把它们挪到谓语前并补「を」。 */
  if (vi > 0 && vi < parts.length - 1 && parts[vi].pos === 'v') {
    var objs = [], rest = [];
    parts.slice(vi + 1).forEach(function (p) {
      if (p.sym || p.pos === 'd') rest.push(p); else objs.push(p);
    });
    if (objs.length) {
      var before = parts.slice(0, vi);
      var hasCase = objs.some(function (p) { return isCaseJa(p.w); });
      var pcp = JA_NI_V[String(parts[vi].zh || '')] ? 'に' : 'を';   // 适合学习 → 勉強に適する
      parts = before.concat(objs, hasCase ? [] : [{ w: pcp, pos: 'x' }], [parts[vi]], rest);
      vi = before.length + objs.length + (hasCase ? 0 : 1);
      ho = -1;
    }
  }
  /* 句尾的疑问词自己就带格位：「在哪里」的「で」不必再说一遍。 */
  var whAt = -1;
  for (i = parts.length - 1; i >= 0; i--) {
    if (!parts[i].sym && JA_WH[String(parts[i].w)]) { whAt = i; break; }
  }

  function joinP(arr) {
    return arr.map(function (p) {
      if (p.sym) return { '，': '、', '。': '', '？': '', '！': '！', '；': '；', '：': '：', '、': '、' }[p.sym] || '';
      return p.w == null ? '' : String(p.w);
    }).join('');
  }
  var body = '';
  if (ho >= 0) {
    body = joinP(parts.slice(0, ho)) + parts[ho].w + 'が' +
           (F.past ? 'ありませんでした' : 'ありません') + joinP(parts.slice(ho + 1));
  } else if (F.thanks) {
    /* 谢谢：日语把前面那件事当对象，再接「に感謝します」。 */
    var tp = parts.slice();
    for (var tj = tp.length - 1; tj >= 0; tj--) {
      if (tp[tj].pos === 'v') { tp[tj] = { w: stemJa(String(tp[tj].w), tp[tj].tag), pos: 'n' }; break; }
    }
    body = joinP(tp) + 'に感謝します';
  } else if (vi >= 0) {
    var v = String(parts[vi].w);
    var isAdj = parts[vi].pos === 'a';
    var stm = stemJa(v, parts[vi].tag);
    var politeReq = String(parts[0] && parts[0].w) === 'どうぞ' && !isAdj && !F.neg && !F.past;
    var tail;
    if (politeReq) tail = teJa(v, parts[vi].tag) + 'ください';
    else if (F.neg) tail = isAdj ? (/[い]$/.test(v) ? v + 'くないです' : v + 'じゃありません') : stm + 'ません';
    else if (F.past) tail = isAdj ? (/[い]$/.test(v) ? v + 'かったです' : v + 'でした') : stm + 'ました';
    else if (F.want) tail = stm + 'たいです';
    else if (F.can) tail = isAdj ? v + 'いです' : stm + 'ることができます';
    else if (F.must) tail = isAdj ? v + 'なければなりません' : stm + 'なければなりません';
    else if (F.sug) tail = isAdj ? v.replace(/い$/, '') + 'でしょう' : stm + 'ましょう';
    else tail = isAdj ? (/い$/.test(v) ? v.replace(/い$/, '') + 'いです' : v + 'です') : stm + 'ます';
    body = joinP(parts.slice(0, vi)) + tail + joinP(parts.slice(vi + 1));
  } else {
    var fp = whAt >= 0 ? parts.filter(function (p, k) {
      return !(k > whAt && !p.sym && isCaseJa(p.w));
    }) : parts;
    if (F.sug) body = joinP(fp) + 'でしょう';
    else body = joinP(fp) + (whAt >= 0 ? 'ですか' : (F.neg ? 'ではありません' : 'です'));
  }
  body = body.replace(/([0-9０-９一二三四五六七八九十半]+(?:時|分))(?!に)(?=[ぁ-んー㐀-鿿一-鿿])/g, '$1に');
  if (F.q && !/か$/.test(body)) body += 'か';
  body += /[！!]$/.test(sent) ? '！' : (qMark ? '？' : '。');
  return body;
}
function stemJa(v, conj) {
  // 词库中日文动词以辞书形给出；する→し、上一段/下一段去る，五段变う段
  if (conj === 'suru') return String(v) + 'し';
  if (/する$/.test(v)) return v.slice(0, -2) + 'し';
  if (conj === 'v1' && /る$/.test(v)) return v.slice(0, -1);   // JMdict 标了 ichidan：始める → 始め
  if (/る$/.test(v)) {
    var pre = v.charAt(v.length - 2);
    if (JA_GODAN_RU[v]) return v.slice(0, -1) + 'り';
    if (JA_ICHIDAN[v] || /[いえ]/.test(pre)) return v.slice(0, -1);
    return v.slice(0, -1) + 'り';
  }
  if (/す$/.test(v)) return v.slice(0, -1) + 'し';
  if (/く$/.test(v)) return v.slice(0, -1) + 'き';
  if (/ぐ$/.test(v)) return v.slice(0, -1) + 'ぎ';
  if (/む$/.test(v)) return v.slice(0, -1) + 'み';
  if (/ぶ$/.test(v)) return v.slice(0, -1) + 'び';
  if (/ぬ$/.test(v)) return v.slice(0, -1) + 'に';
  if (/つ$/.test(v)) return v.slice(0, -1) + 'ち';
  if (/う$/.test(v)) return v.slice(0, -1) + 'い';
  return v;
}

/* ==================================================== 输出清理 */
function cleanZh(s) {
  return String(s)
    .replace(/[\u3000]/g, '').replace(/\s{2,}/g, ' ')
    .replace(/([，。；：？！])\1+/g, '$1')
    .replace(/。，/g, '。').replace(/的的+/g, '的').replace(/了了+/g, '了')
    .replace(/在在+/g, '在').replace(/，？/g, '？').replace(/吗？。/g, '吗？')
    .replace(/^[，、]+/, '').replace(/(吗|呢)？?。$/, '？').trim();
}

/* ======================================================== 入口 */
E.translate = function (text, dir, opts) {
  opts = opts || {};
  var t0 = now();
  var blocks = splitBlocks(text), segs = [], trace = [], hits = {};
  ['user', 'phrase', 'dict', 'morph', 'rule', 'num', 'sym', 'miss', 'raw'].forEach(function (k) { hits[k] = 0; });
  for (var b = 0; b < blocks.length; b++) {
    var line = blocks[b];
    if (!line) { continue; }
    var prefix = '', body = line, lm = line.match(LISTHEAD);
    if (lm) { prefix = trim(lm[0]) + ' '; body = line.slice(lm[0].length); }
    var sents = splitSentences(body, dir);
    for (var s = 0; s < sents.length; s++) {
      if (!sents[s]) continue;
      var units, out;
      if (dir === 'en2zh') { units = unitsEn(sents[s]); out = zhFromEn(units, sents[s]); }
      else if (dir === 'ja2zh') { units = unitsJa(sents[s]); out = zhFromJa(units, sents[s]); }
      else { units = unitsZh(sents[s], dir); out = dir === 'zh2en' ? enFromZh(units, sents[s]) : jaFromZh(units, sents[s]); }
      units.forEach(function (u) {
        if (hits[u.how] !== undefined) hits[u.how]++;
        trace.push({ i: segs.length + 1, src: u.src, dst: u.zh || '', pos: u.pos || '', feat: u.feat || '', how: u.how });
      });
      /* 了/吗/被 这类语法标记词库里本来就不必有，引擎按 ZH_AUX 处理掉了，
         不该在「未收录」里刷存在感——只有真正没认出来的实词才值得提醒用户。 */
      var miss = units.filter(function (u) { return u.how === 'miss' && !ZH_AUX[u.src]; });
      segs.push({
        src: prefix + sents[s], dst: cleanZh(out),
        notes: miss.length ? '未收录 ' + miss.length + ' 处：' + miss.slice(0, 8).map(function (u) { return u.src; }).join('、') + (miss.length > 8 ? '…' : '') : ''
      });
    }
  }
  return {
    segs: segs, trace: trace,
    stats: { ms: Math.max(1, Math.round(now() - t0)), units: trace.length, hits: hits }
  };
};

function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

/* 供 UI 查询词条详情 */
E.explain = function (dir, word) {
  var T = D[dir];
  var k = keyOf(dir, word);
  var e = T.w.get(k) || T.p.get(k);
  if (!e && dir === 'en2zh') {
    var forms = enForms(word);
    for (var i = 0; i < forms.length; i++) { if (T.w.get(forms[i].base)) { e = T.w.get(forms[i].base); break; } }
  }
  if (!e && dir === 'ja2zh') {
    var f2 = jaForms(word);
    for (var j = 0; j < f2.length; j++) { if (T.w.get(f2[j].k)) { e = T.w.get(f2[j].k); break; } }
  }
  return e || null;
};

E.unitsEn = unitsEn; E.unitsJa = unitsJa; E.unitsZh = unitsZh;
E.tokenizeEn = tokenizeEn; E.tokenizeJa = tokenizeJa;
E.enForms = enForms; E.jaForms = jaForms; E.past = past; E.ing = ing;
E.JA_PART = JA_PART; E.PP = PP; E.splitBlocks = splitBlocks; E.splitSentences = splitSentences;

/* 重读闭音节：辅音+单元音+辅音收尾的短词要双写尾辅音（swim → swimming、stop → stopped）。
   w/x/y 不双写，visit、begin 这类非重读在后的长词也不双写，所以只认四个字母以内的。 */
var DOUBLE_END = /^[bcdfghjklmnpqrstvwxyz]{1,2}[aeiou][bcdfghjklmnpqrstvwxz]$/;
function past(w) {
  var l = String(w).toLowerCase();
  var irr = { go: 'went', come: 'came', take: 'took', make: 'made', see: 'saw', say: 'said', get: 'got', know: 'knew', think: 'thought', give: 'gave', find: 'found', tell: 'told', do: 'did', have: 'had', be: 'was', eat: 'ate', drink: 'drank', write: 'wrote', read: 'read', run: 'ran', speak: 'spoke', meet: 'met', buy: 'bought', bring: 'brought', leave: 'left', feel: 'felt', keep: 'kept', begin: 'began', lose: 'lost', pay: 'paid', sit: 'sat', stand: 'stood', win: 'won', teach: 'taught', catch: 'caught', build: 'built', draw: 'drew', drive: 'drove', fly: 'flew', grow: 'grew', ride: 'rode', rise: 'rose', wear: 'wore', study: 'studied', like: 'liked', watch: 'watched', work: 'worked', play: 'played', live: 'lived', learn: 'learned', want: 'wanted', need: 'needed', understand: 'understood' };
  if (irr[l]) return irr[l];
  if (/e$/.test(l)) return l + 'd';
  if (/[^aeiou]y$/.test(l)) return l.slice(0, -1) + 'ied';
  if (DOUBLE_END.test(l)) return l + l.slice(-1) + 'ed';
  return l + 'ed';
}
function ing(w) {
  var l = String(w).toLowerCase();
  if (/ie$/.test(l)) return l.slice(0, -2) + 'ying';
  if (/[^aeiou]e$/.test(l)) return l.slice(0, -1) + 'ing';
  if (DOUBLE_END.test(l)) return l + l.slice(-1) + 'ing';
  return l + 'ing';
}

global.TransEngine = E;
})(typeof self !== 'undefined' ? self : window);
