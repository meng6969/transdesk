# -*- coding: utf-8 -*-
"""公开词库转换器的公共部分。

只做机械清洗与联动查表，不在此生成任何“自创词条”：
  * JMdict 派生词表（vendor/kotobako.json，CC BY-SA 4.0）给出「日文词 → 英文释义」
  * CC-CEDICT（vendor/cedict.json，CC BY-SA 4.0）给出「中文词 → 英文释义」
  * Word Atlas（web/data/en2zh.json，CC BY 4.0）给出「英文词 → 中文 + 词性」

日文/中文词库都由这两步查表拼出来，词性取自 Word Atlas 或数据集自带的 pos 字段。
"""
import io
import json
import math
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(ROOT, 'vendor')
OUTDIR = os.path.join(ROOT, 'web', 'data')

CJK = re.compile(u'[㐀-䶿一-鿿぀-ヿ]')
ASCII_WORD = re.compile(r"^[a-z][a-z'\- ]{0,24}$")

# 释义里这些片段是“参照条目”，不是可译内容。变体限定词必须与
# variant/form/spelling of 一起匹配，不能误伤 invariant、see-saw 等实词。
VARIANT_QUAL = (r'(?:erroneous|erhua|old|unofficial|ancient|archaic|classical|japanese|taiwan|'
                r'obscure|emphatic|alternative|variant|literary|dialectal|dated|colloquial|'
                r'simplified|traditional|a|short|contracted|nonstandard|respectful|causative|polite)')
SKIP_SEGMENT = re.compile(
    r'^(?:' + VARIANT_QUAL + r' )?(?:variant|spelling)'
    r'(?: (?:chinese )?(?:character|pronunciation))?(?: of\b|$)|'
    r'^(?:' + VARIANT_QUAL + r' )form(?: (?:chinese )?(?:character|pronunciation))? of\b|'
    r'^(?:' + VARIANT_QUAL + r' )?form(?: (?:chinese )?(?:character|pronunciation))?$|'
    r'^see (?:the )?(?:entry|article|sense|above|below)\b|^参见(?:某|该|此|上|下)?条|'
    r'^used |^classifier|^abbr\.|^Taiwan pr|^literary|^coll\.|^polite|'
    r'^euphemistic|^derogatory|^honorific|^military|^religion|^bound form|^surname')


def load_json(path):
    with io.open(path, encoding='utf-8') as f:
        return json.load(f)


_B36 = '0123456789abcdefghijklmnopqrstuvwxyz'
FREQ_STEPS = 1295      # 36 * 36 - 1：每个词头两个字符
FLOOR_LOG = -18.0      # log(1/总词频) 的下限，比这更罕见的一律按最罕见算


def freq_code(freq, total):
    """jieba 词频 → 两个 36 进制字符，存的是 log(词频/总词频) 的量化值。
    引擎切词要用这张词序表判断「哪种切法更像话」，整表塞进词库太大，
    对数刻度压到 1～1295 足够排出大小；0 留给「词表里根本没这个词」。
    """
    if freq <= 0 or total <= 0:
        return '00'
    lp = math.log(max(1, freq) / float(total))
    v = int(round(min(1.0, max(0.0, lp / FLOOR_LOG)) * FREQ_STEPS)) or 1
    return _B36[v // 36] + _B36[v % 36]


def freq_log(code, fmin):
    """freq_code 的逆运算：两个字符 → log 概率；'00' 返回 0，由调用方兜底。"""
    v = _B36.index(code[0]) * 36 + _B36.index(code[1])
    return fmin * v / float(FREQ_STEPS)


def dump_payload(path, kind, label, attribution, source, words, phrases, freq_map=None):
    payload = {
        'meta': {
            'kind': kind,
            'label': label,
            'attribution': attribution,
            'source': source,
            'words': len(words),
            'phrases': len(phrases),
        },
        'w': words,
        'p': phrases,
    }
    if freq_map:
        # 打分串按 w 的键序对齐（词头里没有纯数字键，JSON 的键序才不会被重排）。
        # 引擎读的时候长度对不上就退回最长匹配，词库和这个串不会各说各话。
        total = sum(f for f, _p in freq_map.values()) or 1
        payload['meta']['fmin'] = -18.0
        payload['f'] = u''.join(freq_code(freq_map.get(k, (0, ''))[0], total) for k in words)
    with io.open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    return os.path.getsize(path)


# ---------------------------------------------------------------- 英文义项清洗

def en_pairs(text):
    """一条英文释义 → [(输出用的原文, 查表用的小写键), ...]，按原义项顺序。

    去括注、去例句、去 to、去冠词；键只做小写与字符清洗，不改词形，
    保证「第一个义项」仍然排在前面（选词时要靠顺序判断哪个是本义）。
    """
    s = text or ''
    s = s.replace(u'“', '"').replace(u'”', '"').replace(u'‘', "'").replace(u'’', "'")
    s = re.sub(r'\([^)]{0,80}\)', ' ', s)          # 括注整段丢掉
    s = re.sub(r'".*?"', ' ', s)                    # 例句丢掉
    s = re.sub(r'\[[^\]]{0,60}\]', ' ', s)          # 汉字参照（CEDICT 里的 黃帝[Huang2 di4]）
    out = []
    for part in re.split(r'[;,]', s):               # 先按分号/逗号切义项，再清洗
        part = part.replace(u'～', ' ').replace('~', ' ')
        # 参照项要先按原样判一次：SKIP_SEGMENT 认的是 "abbr." 这种带点的写法，
        # 去掉标点后就成了 "abbr for Guizhou Province"，贵 因此混进了词库。
        if SKIP_SEGMENT.match(part.strip().lower()):
            continue
        part = re.sub(r'[^A-Za-z0-9\'\- ]+', ' ', part)
        part = re.sub(r'\s+', ' ', part).strip()
        if re.match(r'^to\b', part, re.I):
            part = part.split(' ', 1)[1].strip() if ' ' in part else ''
        if re.match(r'^(a|an|the)\s', part, re.I):
            alt = part.split(' ', 1)[1].strip()
            if alt and not SKIP_SEGMENT.match(alt.lower()) and ASCII_WORD.match(alt.lower()):
                out.append((alt, alt.lower()))
        if part and not SKIP_SEGMENT.match(part.lower()) and ASCII_WORD.match(part.lower()):
            out.append((part, part.lower()))
    seen, uniq = set(), []
    for disp, key in out:
        if key not in seen:
            seen.add(key)
            uniq.append((disp, key))
    return uniq


def en_keys(text):
    """只要查表键，顺序与 en_pairs 一致。"""
    return [k for _disp, k in en_pairs(text)]


# ---------------------------------------------------------------- 中文词频
#
# CC-CEDICT 本身不带使用频次（文件顺序是按字形排的），光看释义很难判断
# 「同一个英文词该选哪个中文词」。这里借 jieba 附带的现代汉语词频表
# （vendor/jieba-dict.txt，MIT，格式「词 频次 词性」）当常用度与词性依据。

_jieba = None

JIEBA_POS = [
    (r'^r', 'r'), (r'^v', 'v'), (r'^a', 'a'), (r'^n[rtsz]$', 'n'), (r'^n', 'n'),
    (r'^d', 'd'), (r'^p', 'p'), (r'^c', 'c'), (r'^m', 'm'), (r'^q', 'q'),
    (r'^f', 'f'), (r'^s', 's'), (r'^t', 't'),
]


def read_freq():
    """jieba 词频表 → {词: (频次, 词性)}，只收中文条目。"""
    global _jieba
    if _jieba is None:
        out = {}
        path = os.path.join(VENDOR, 'jieba-dict.txt')
        if os.path.exists(path):
            with io.open(path, encoding='utf-8') as f:
                for line in f:
                    p = line.split()
                    if len(p) < 3 or not CJK.search(p[0]) or len(p[0]) > 8:
                        continue
                    try:
                        freq = int(p[1])
                    except ValueError:
                        continue
                    out[p[0]] = (freq, p[2])
        _jieba = out
    return _jieba


def zh_pos(tag_or_word):
    """jieba 词性 → 引擎用的单字母标记；传中文词时取它自己的词性。"""
    t = tag_or_word
    if t not in ('r', 'v', 'a', 'd', 'p', 'c', 'm', 'n', 'q', 't', 'f', 's'):
        hit = read_freq().get(tag_or_word)
        t = hit[1] if hit else ''
    for pat, tag in JIEBA_POS:
        if re.match(pat, t):
            return tag
    return ''


def charfreq(fwords):
    """由词频表估一下每个汉字的常用度（词频按词长均摊）。"""
    out = {}
    for w, (freq, _pos) in fwords.items():
        if len(w) > 4:
            continue
        per = freq / float(len(w))
        for ch in set(w):
            out[ch] = out.get(ch, 0) + per
    return out


def qualified(meaning, disp):
    """词典里「good(-tasting)」「telephone (device)」这类带限定的释义，
    清洗掉括号后看起来像通用义，其实只在特定场合成立，选词时要降权。"""
    s = (meaning or '').lower()
    d = (disp or '').lower()
    i = s.find(d)
    return bool(i >= 0) and bool(re.match(r'^\s*\(', s[i + len(d):]))


# ---------------------------------------------------------------- 英文 → 中文

def _segments(text):
    """把中文译注串拆成候选词段（只按分隔符切，不做任何改写）。"""
    out = []
    for part in re.split(u'[；;，,、/]', text or u''):
        part = re.sub(u'[（(][^）)]*[)）]', u'', part).strip()
        if part and CJK.search(part):
            out.append(part)
    return out


class EnZh(object):
    """英文释义 → 中文，先查 Word Atlas，再查 CC-CEDICT 反查表。

    两个来源都是查表；当同一个英文词在 CC-CEDICT 里有多个可选中文词时，按
    「在参考词库里当得多不多」排序：Word Atlas 的整段译词频次 + 单字构词频次。
    """

    def __init__(self, atlas, cedict):
        self.w = atlas['w']
        self.p = atlas['p']
        self.segfreq = self._atlas_segments(atlas)
        self.freq = read_freq()
        self.charfreq = charfreq(self.freq)
        self.inv = {}
        self.invpos = {}
        self._invert(cedict)

    def _atlas_segments(self, atlas):
        freq = {}
        for table in (atlas['w'], atlas['p']):
            for v in table.values():
                if not isinstance(v, (list, tuple)):
                    continue
                for seg in _segments(v[0]):
                    freq[seg] = freq.get(seg, 0) + 1
                if len(v) > 3 and v[3]:
                    for kv in str(v[3]).split(';'):
                        i = kv.find(':')
                        if i > 0:
                            for seg in _segments(kv[i + 1:]):
                                freq[seg] = freq.get(seg, 0) + 1
        return freq

    def _rank_word(self, zh):
        """给中文候选词打分：jieba 的现代汉语词频优先（bucket 到 50 次一档，
        避免频次把「是不是本义」压过去），其次看它在 Word Atlas 里作为整段
        译词出现的次数，再取更短、用字更常见的写法。"""
        f = self.freq.get(zh, (0, ''))[0] // 50
        seg = self.segfreq.get(zh, 0)
        chars = [self.charfreq.get(ch, 0) for ch in zh if CJK.search(ch)]
        avg = (sum(chars) / len(chars)) if chars else 0
        return (-f, -seg, len(zh), -avg)

    def _invert(self, cedict):
        """CC-CEDICT 反查：英文单词 → 中文词。只收单词键，取最常见的那个译法。

        两条判据都来自数据本身：
          * 「这个英文词是不是该词条的本义」——上野的释义里也出现 Tokyo，
            但那是说明性文字，东京的第一个义项才是 Tokyo；
          * 「词性对不对得上」——to go 要动词，于（p）就该输给去（v）。
        """
        best = {}
        for rank, entry in enumerate(cedict):
            zh = entry['simplified']
            if not zh or len(zh) > 8 or not CJK.search(zh):
                continue
            score_zh = self._rank_word(zh)
            ztag = zh_pos(zh)
            pos = 0
            for i, sense in enumerate(entry['english'] or []):
                verb = bool(re.match(r'^to\b', sense or '', re.I))
                for disp, k in en_pairs(sense):
                    if ' ' in k or len(k) < 2:
                        pos += 1
                        continue
                    tier = (0 if pos == 0 else (1 if i == 0 else 2)) + (3 if qualified(sense, disp) else 0)
                    posok = 0 if (not verb or ztag in ('v', '')) else 1
                    score = (tier, posok, 0 if k in disp.lower() else 1, score_zh, rank)
                    cur = best.get(k)
                    if cur is None or score < cur[0]:
                        best[k] = (score, zh, 'v' if verb else '')
                    pos += 1
        self.inv = dict((k, v[1]) for k, v in best.items())
        self.invpos = dict((k, v[2]) for k, v in best.items())

    def resolve(self, text):
        """返回 (中文, 词性, 义项串) 或 None。全部来自查表，不做猜测。"""
        for k in en_keys(text):
            hit = self.p.get(k) or self.w.get(k)
            if hit:
                zh = (hit[0] or '').strip()
                if zh and CJK.search(zh):
                    return zh, (hit[1] or ''), (hit[3] if len(hit) > 3 else '')
        for k in en_keys(text):
            zh = self.inv.get(k)
            if zh:
                return zh, self.invpos.get(k, ''), ''
        return None


# ---------------------------------------------------------------- 词性对齐

POS_MAP = [
    (r'proper noun|surname|given name|place name|station', 'n'),
    (r'^noun', 'n'),
    (r'adjective', 'a'),
    (r'adverb|adverbial', 'd'),
    (r'verb', 'v'),
    (r'preposition', 'p'),
    (r'conjunction', 'c'),
    (r'pronoun', 'r'),
    (r'particle', 'p'),
    (r'auxiliary', 'x'),
    (r'numeric|numeral|counter', 'm'),
    (r'interjection|exclamation', 'i'),
    (r'prefix|suffix|combining form', 'x'),
    (r'prefix|suffix|combining form', 'x'),
    (r'expression|phrase', 'phr'),
]


def pos_of(raw):
    s = (raw or '').lower()
    for pat, tag in POS_MAP:
        if re.search(pat, s):
            return tag
    return ''


# 引擎里的虚词表（web/engine.js）本身就是「这个词属于哪一类」的权威来源，
# 直接复用，避免在构建脚本里另写一套功能词清单。
CLOSED_TABLES = [
    ('DET', 't'), ('DEMO', 't'), ('PRON', 'r'), ('MODAL', 'x'), ('BE', 'x'),
    ('AUXPERF', 'x'), ('ADV', 'd'), ('CONJ', 'c'), ('PP', 'p'),
    ('AUXDUMMY', None),        # do/does/did 看上下文，不当功能词处理
]

# 反查中文功能词时还要用上这几张只出现在引擎里的表。
# 优先级按表定：代词/系动词/否定的对照最确定，介词、连词一词多义最容易挑错。
CLOSED_ORDER = CLOSED_TABLES + [('NEG', 'd'), ('WH', 'r'), ('ADJ_PRE', 'a')]
TABLE_RANK = {'PRON': 0, 'BE': 1, 'NEG': 2, 'MODAL': 3, 'AUXPERF': 4, 'WH': 5,
              'DEMO': 6, 'DET': 7, 'ADJ_PRE': 8, 'ADV': 9, 'CONJ': 10, 'PP': 11}

_closed = None
_closed_pairs = None
_zh_aux = None

_PAIR_KEY = re.compile(r"(?:^|[,{])\s*([A-Za-z][A-Za-z']*)\s*:")

_PAIR_VAL = re.compile(r"\s*'([^']*)'")


def engine_src():
    path = os.path.join(ROOT, 'web', 'engine.js')
    return io.open(path, encoding='utf-8').read()


def zh_aux():
    """engine.js 的 ZH_AUX → {中文词: 英文说法}。

    这张表本来就是 enFromZh 在查词典结果之前先过一遍的中文虚词/核心词表，
    词库跟它保持一致，才不会「引擎当系动词处理、词典给的是实词释义」。
    """
    global _zh_aux
    if _zh_aux is None:
        m = re.search(r'var ZH_AUX = \{(.*?)\};', engine_src(), re.S)
        out = {}
        if m:
            for zh, en in re.findall(r"'([^']+)'\s*:\s*'([^']+)'", m.group(1)):
                out[zh.strip()] = en.strip()
        _zh_aux = out
    return _zh_aux


def closed_class():
    """读 web/engine.js 的封闭词类表 → {英文小写词: 词性}。"""
    global _closed
    if _closed is None:
        src = engine_src()
        out = {}
        for name, tag in CLOSED_TABLES:
            m = re.search(r'var %s = \{(.*?)\};' % name, src, re.S)
            if not m:
                continue
            for key in re.findall(r'(?:^|[,{])\s*([A-Za-z][A-Za-z\']*)\s*:', m.group(1)):
                if tag:
                    out.setdefault(key.lower(), tag)
        _closed = out
    return _closed


_be = None


def be_forms():
    """engine.js 里 BE 表的词形（be/am/is/are/was/were/been/being）。

    助动词里只有 be 系在中文（是）几乎总是当系动词用；have/can 对应的
    有/能在句子里多是实义谓语，词性要留成 v，否则引擎挑不出谓语。
    """
    global _be
    if _be is None:
        m = re.search(r'var BE = \{(.*?)\};', engine_src(), re.S)
        _be = set(k.lower() for k in re.findall(r'([A-Za-z]+)\s*:', m.group(1))) if m else set()
    return _be


def closed_pairs():
    """引擎虚词表逐条展开 → [(英文词, 表内中文对照或 None, 词性, 表序)]。

    PRON/DEMO/CONJ/ADV/NEG/WH/ADJ_PRE 的值就是现成的中文对照；
    DET/BE/MODAL/PP 的值是格位、时态之类的标记，取不到中文，留给查表补。
    n't 这类带撇号的写法是英文词形，不能当独立词条，跳过。
    """
    global _closed_pairs
    if _closed_pairs is None:
        src = engine_src()
        out = []
        for idx, (name, tag) in enumerate(CLOSED_ORDER):
            m = re.search(r'var %s = \{(.*?)\};' % name, src, re.S)
            if not m or not tag:
                continue
            body = m.group(1)
            for km in _PAIR_KEY.finditer(body):
                en = km.group(1).lower()
                if "'" in en:
                    continue
                vm = _PAIR_VAL.match(body, km.end())
                gloss = vm.group(1) if vm and CJK.search(vm.group(1)) else None
                out.append((en, gloss, tag, TABLE_RANK.get(name, 20)))
        _closed_pairs = out
    return _closed_pairs


_aux = None


def read_aux():
    """build-en.py 生成的 CEDICT 补充表（可能还不存在）。"""
    global _aux
    if _aux is None:
        path = os.path.join(OUTDIR, 'en2core.json')
        _aux = load_json(path) if os.path.exists(path) else {'w': {}, 'p': {}}
    return _aux


def known_pos(key, atlas):
    """英文词的词性：Word Atlas → CEDICT 补充表 → 引擎虚词表；查不到返回空。
    atlas 可以是原始 JSON 字典，也可以是 EnZh 对象。"""
    p = atlas['p'] if isinstance(atlas, dict) else atlas.p
    w = atlas['w'] if isinstance(atlas, dict) else atlas.w
    for table in (p, w, read_aux()['p'], read_aux()['w']):
        hit = table.get(key)
        if hit and isinstance(hit, (list, tuple)) and len(hit) > 1 and hit[1]:
            return hit[1]
    return closed_class().get(key, '')


# ---------------------------------------------------------------- 数据集读取

def read_vocab():
    data = load_json(os.path.join(VENDOR, 'kotobako.json'))
    return data['datasets']['vocab'], data['version']


def read_cedict():
    return load_json(os.path.join(VENDOR, 'cedict.json'))


def read_atlas():
    return load_json(os.path.join(OUTDIR, 'en2zh.json'))
