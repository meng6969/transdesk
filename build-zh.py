# -*- coding: utf-8 -*-
"""由公开词库生成 web/data/zh2en.json 与 web/data/zh2ja.json。

来源（开放授权，见 vendor/README.md）：
  1. CC-CEDICT vendor/cedict.json（CC BY-SA 4.0）：中文词 → 英文释义
  2. JMdict 派生词表 vendor/kotobako.json（CC BY-SA 4.0）：反转成「英文词 → 日文词」
  3. Word Atlas web/data/en2zh.json（CC BY 4.0）：给英文释义标注词性，供引擎组句使用

中→英直接取 CEDICT 释义；中→日走「中文 → 英文 → 日文」两级查表。
查不通、或释义是“参见某条”这类参照项的一律丢弃，不手工补词。
用法：python build-zh.py
"""
import os
import re
import sys

from dictlib import (ASCII_WORD, CJK, OUTDIR, SKIP_SEGMENT, TABLE_RANK, _segments, be_forms,
                     closed_class, closed_pairs, dump_payload, en_keys, en_pairs,
                     known_pos, pos_of, read_atlas, read_cedict, read_freq,
                     read_vocab, zh_aux, zh_pos, EnZh)

MAX_ZH = 8
ATTR_EN = (u'中文词条来自 CC-CEDICT 项目（CC BY-SA 4.0，The CC-CEDICT Community），'
           u'释义按 CEDICT 原义项机械清洗；词性标注取自 Word Atlas（CC BY 4.0）'
           u'与引擎虚词表。本文件为衍生数据，沿用 CC BY-SA 4.0。')
ATTR_JA = (u'中文词条来自 CC-CEDICT（CC BY-SA 4.0），日文对应词取自 JMdict/EDRDG 项目'
           u'（CC BY-SA 4.0）经 kotobako 分发的词表反转索引，属两级查表的衍生数据，'
           u'沿用 CC BY-SA 4.0。')

NOISE = re.compile(r'\b(sb|sth|etc|done|used)\b|^'
                   r'(cl|ml|dl|kl|km|kg|cm|mm|mg|mr|mrs|ms|dr|jr|sr|esp|viz|approx|'
                   r'no\s\d|cf|ibid|loc|gen|lit|fig|pl|sg)\b')

# kotobako 的词表顺序是按日文写法排的，不代表常用度；能代表常用度的只有 JLPT 分级。
JLPT_RANK = {'N5': 0, 'N4': 1, 'N3': 2, 'N2': 3, 'N1': 4}
# 义项越靠后越不像「这个英文词的对应说法」；分级差一档的代价小一档。
# 两组代价相加后：电话 → 電話（第 3 义项，N5）仍胜过 テレホン（本义，无分级），
# 谢谢 → ありがとう（本义的第 2 说法，N3）胜过 どうも（第 2 义项，N5）。
JLPT_COST = {0: 0, 1: 1, 2: 3, 3: 6, 4: 10, 5: 30}
SENSE_COST = (0, 1, 5, 9)


def jlpt_rank(entry):
    return JLPT_RANK.get(str(entry.get('jlpt')), 5)


def usable(key):
    return bool(key) and not NOISE.search(key) and not SKIP_SEGMENT.match(key)


PHRASE_STOP = set('a an the to of in on at for with and or one some it is'.split())


def stemtok(w):
    """英文词形粗归一：只用于比较释义用词，不参与查表。
    getting/get、teeth 这种差异不该让「起床 → 起きる」的同形判定落空。"""
    for suf in ('ings', 'ing', 'edly', 'es', 'ed', 's'):
        if len(w) > len(suf) + 2 and w.endswith(suf):
            w = w[:-len(suf)]
            break
    if len(w) > 2 and w[-1] == w[-2] and w[-1] not in 'aeiou':
        w = w[:-1]
    return w


def tokset(key):
    return set(stemtok(w) for w in re.split(r'[^a-z]+', (key or '').lower())
               if len(w) > 2 and w not in PHRASE_STOP)


def entry_pairs(entry, with_sense=False):
    """一条 CEDICT 条目 → 按原顺序排列的 (输出原文, 查表键)。

    with_sense 时多返回一项原始义项文本：「to rain」这种写法是动词信号，
    拆成 (disp, key) 之后就看不到了。
    """
    for sense in entry.get('english') or []:
        for disp, key in en_pairs(sense):
            if usable(key):
                yield (sense, disp, key) if with_sense else (disp, key)


def back_text(key, enz):
    """该英文词翻回中文时的「主译注」和「全部义项」，用于回查一致性打分。"""
    hit = enz.p.get(key) or enz.w.get(key)
    if hit:
        return str(hit[0]), (str(hit[3]) if len(hit) > 3 and hit[3] else u'')
    zh = enz.inv.get(key) or u''
    return zh, u''


INFL = re.compile(r'(?:ed|ing|es)$')

# 一眼就是形容词的词尾（enjoyable、useful、creative）；-ic/-ed/-ing 名词也常用，
# 不在这里猜。
ADJ_END = re.compile(r'(?:able|ible|ful|ous|ive|less|ish|ary)$')


def has_verb_sense(key, enz):
    """该英文词在 Word Atlas 的义项串里有没有动词用法（help 有 v:，busy 没有）。
    用来判断「动词槽位上选出的形容词」是不是其实也能当动词用。"""
    row = enz.p.get(key.lower()) or enz.w.get(key.lower())
    if not row or len(row) < 4 or not row[3]:
        return False
    return u'v:' in row[3]


def is_inflection(key, enz):
    """drowned / learning 这类变形：去掉词尾后原形也在词表里，说明它是屈折形式。
    词典收原形更好（引擎本身带词形还原，翻回去时变形照样认得）。"""
    if not INFL.search(key) or len(key) < 5:
        return False
    for stem in (key[:-2], key[:-3], key[:-1]):
        if len(stem) > 2 and (stem in enz.w or stem in enz.p or stem in enz.inv):
            return True
    return False


def cefr_of(key, enz):
    """英文词的 CEFR 分级（Word Atlas 自带）；查不到按最未学过的算。"""
    hit = enz.p.get(key) or enz.w.get(key)
    if hit and len(hit) > 2:
        return CEFR.get(str(hit[2]), 6)
    return 6


def vo_head(head):
    """跑步、唱歌、洗澡这类动宾式离合词：jieba 按整体标成名词，句子里却当谓语用
    （我每天跑步）。判据是字面的——第一个字自己是动词、第二个字是名词。"""
    if len(head) != 2 or zh_pos(head) in ('v', 'a', 'd', 'r'):
        return False
    return zh_pos(head[0]) == 'v' and zh_pos(head[1]) == 'n'


def best_for(entries, enz, atlas_inv=None, disp_of=None, char_inv=None):
    """一个中文词头 → 最合适的英文说法。候选来自两处，统一按同一标准打分：
    CEDICT 自己的英文释义，以及 Word Atlas 反向索引（中文段 = 该词头）。

    判据（全部来自词表本身）：
      1. 回查一致性 —— 该英文词的**主译注**里有没有这个词头
         （没 → no → 「不；没有」命中；没 → die → 「死亡」不命中；
           很 → very 命中主译注，far 只在「far better」的义项里出现）；
      2. 词性是否与 jieba 给该中文词的词性一致；
      3. 屈折形式让位给原形（drowned → drown）、单词优先于短语；
      4. CEFR 分级（A1 优先）——词性只是从中文猜的，分级是英文词自带的，
         更可信：请 → please（A1）该赢 invite（A2），哪怕 Atlas 给 please
         标的是叹词。最后才是原顺序。

    返回 (译注, 查表键, 词性, 备选义项)，备选义项见 alts_by_pos。
    """
    head = (entries[0].get('simplified') or u'').strip()
    want = zh_pos(head)
    if vo_head(head):
        want = 'v'          # 跑步：jieba 标名词，句子里干的却是谓语的活
    # 专有名词（中国 → China）保留大写；苹果 → Apple 那种是品牌义项，
    # 同一个键小写形式在 Atlas 里另有其词时，说明中文要的是普通名词。
    htag0 = read_freq().get(head, (0, ''))[1]
    is_proper = htag0.startswith(PROPER_HEAD)
    cands = []
    seq = 0

    def consider(disp, key, pos, cefr, phrase, alt=0, cd=0):
        nonlocal seq
        if not key:
            return
        primary, senses = back_text(key, enz)
        if head and head in primary:
            # 单字头光看「释义里有没有这个字」不够：请 出现在「邀请」里，
            # 但 invite 并不是 请 的说法。要它自己自成一个义项才算本义。
            # 「新的」「安静的」这种带 的 的写法就是中文形容词本身，算命中。
            rt = 0 if len(head) > 1 or head in _segments(primary) or (head + u'的') in _segments(primary) else 1
        elif head and (head in senses or any(ch in primary for ch in head)):
            rt = 1
        else:
            rt = 2
        if cd:
            # CEDICT 自己给这个词头写的义项（下雨 → to rain、起床 → to get out of bed）
            # 本来就是译文，不必再拿 Atlas 回查一遍：查表键是个短语、或者 Atlas 的主
            # 译注换了写法，都不代表这个说法不可信。回查在这里只会把 忙、贵 这类
            # 常用义项挤到生僻词后面去。
            rt = 0
        pos = pos or known_pos(key, enz)
        # Atlas 把形容词一律标成 'd'，光看词性分不清形容词还是副词；译注的写法分得清：
        # 「忙碌的」是形容词，「快速地」是副词。形容词在中文的谓语槽位上是要的
        # （忙 → busy，英文说 He is busy），先按 a 记，词性才不会被 jieba 的 v 顶掉。
        if pos == u'd' and primary.endswith(u'的'):
            pos = u'a'
        ctag = closed_class().get(key)
        if ctag and ctag == want:
            rt = 0          # 引擎虚词表认得的功能词（I/be/of）不必再回查
        cap = 0
        look = disp or key
        if look[:1].isupper() and not is_proper and known_pos(look.lower(), enz):
            cap = 1         # 苹果 → Apple 是品牌义项：写法小写在 Atlas 里另有其词
                            # 看的是要输出的写法（disp），不是查表用的小写键
        pm = 0 if (pos and pos == want) else (1 if (pos and pos != 'v') else (2 if pos else 3))
        # -ing/-ed 在动词位置上是屈折形式（跑步 → running 该收 run），
        # 在形容词位置上却是另一个词（有趣 → interesting 不是 interest 的变形）。
        infl = 1 if (want != u'a' and is_inflection(key, enz)) else 0
        lvl = min(cefr, cefr_of(key, enz))
        seq += 1
        # 中文动词/形容词要的是能当谓语的英文词：屈折形式（running）、介词（借 挂在
        # with 的译注「和；跟；借」下面）、名词（热 → heat）都当不了谓语，
        # 得挡在回查一致性前面。
        if want == 'v':
            # 中文的形容词本来就能直接当谓语（他很忙、她很高兴），所以英文的形容词
            # （busy、glad）在动词槽位上是合法候选，词性稍后统一折成 a。
            # 名词（热 → heat）、介词才真当不了谓语。
            bad_role = 1 if (pos and pos not in ('v', 'x', 'a')) else 0
        elif want == 'a':
            # Atlas 把形容词一律标成 'd'，'d' 和查不到词性（CEDICT 自己的释义）都得放行，
            # 否则 贵 → expensive 会输给 Atlas 里标着形容词的 dark 一类。
            bad_role = 1 if pos in ('n', 'v') else 0
        elif want == 'n':
            bad_role = 1 if pos == 'v' else 0     # 作业 要 homework，不要 "to operate"
        else:
            bad_role = 0
        if want in ('v', 'a'):
            hard, soft = max(infl, bad_role, cap), rt
        elif want == 'n':
            hard, soft = max(rt, cap), max(infl, bad_role)  # 名词的词形（复数、动名词）只算轻罚
        else:
            hard, soft = rt, max(infl, cap)
        # alt（靠单字凑上来的候选）排在 CEFR 之前：快 挂在「痛快 → plainspoken」
        # 这种复合词译注下，A1 也救不回它，本义的 quick 才是答案。
        # cd：这个写法是不是 CEDICT 给该词头自己的释义。是的话优先——它是词典为这个
        # 词头写的译文；Atlas 反查来的（深 → dark）只是「某个英文词的译注里也有这个
        # 中文词」，本义不如前者可靠。排序是升序，所以 CEDICT 自己给 0。
        cands.append((hard, soft, 0 if cd else 1, phrase, alt, lvl, pm, seq, disp, key, pos))

    for entry in entries:
        for sense, disp, key in entry_pairs(entry, with_sense=True):
            # CEDICT 把动词义项写成 "to rain"，这比事后查表猜词性可靠：
            # 下雨 光看 Atlas 只剩 rainy（形容词），「明天下雨」就没谓语了。
            hint = u'v' if re.match(u'(?i)^\\s*to [a-z]', sense or u'') else u''
            consider(disp, key, hint, 6, 1 if u' ' in key else 0, 0, 1)
    for _cefr, _phrase, _len, key, pos in (atlas_inv or {}).get(head, ()):
        consider((disp_of or {}).get(key, key), key, pos, _cefr, _phrase)
    # 单字头再查一遍「字 → 英文词」索引：Atlas 的译词多是双字（hot → 炎热），
    # 按整段匹配不到 热，冷、快、忙 这类常用字因此一个候选都凑不齐。
    if len(head) == 1:
        for _cefr, _phrase, _len, key, pos in (char_inv or {}).get(head, ()):
            consider((disp_of or {}).get(key, key), key, pos, _cefr, _phrase, 1)
    if not cands:
        return None, None, '', {}
    cands.sort()
    _t = cands[0]
    return _t[8], _t[9], _t[10], alts_by_pos(cands, _t[9], _t[10], head)


# 备选义项只给常用词带上：一是「做作业」和「作业三天」确实是两种说法，
# 二是词库体积——175k 词头每个都挂备选会胖 1MB 以上，而冷僻词根本用不到。
ALT_MIN_FREQ = 300
SPLIT_MIN_FREQ = 300   # 拆词桥接（go to work → work）只给常用词头
ALT_CLASSES = ('n', 'v', 'a', 'd')      # 引擎会按槽位要的四种词性
ALT_MAX = 2


def alts_by_pos(cands, key, pos, head):
    """同一个中文词头，别的词性里最好的那个英文说法。

    best_for 按 jieba 标的词性只留了一个（作业 → operate），可「做作业」里
    它要的是名词 homework。cands 已经排过序，同类里取第一个即可；
    靠单字凑上来的候选（快 挂在「痛快 → plainspoken」下）和虚词一律不要。
    单字词头整个不收备选：水 的动词义项是 swim、本 的名词义项是 capital，
    一个字的义项太散，按槽位换只会换错。
    """
    if len(head or u'') < 2:
        return {}
    out = {}
    for c in cands:
        cls, alt_key = c[10], c[9]
        if cls not in ALT_CLASSES or cls == pos or cls in out or alt_key in out.values():
            # cls in out：同类只取排最前的那个，否则循环会把 assistance 覆盖成 minister。
            continue
        if c[1] > 1 or c[4]:
            continue                      # 回查不一致 / 单字拼出来的候选
        if closed_class().get((alt_key or '').lower()):
            continue                      # 功能词由引擎表管，不当实义备选
        if not alt_key or len(alt_key) > 20:
            continue
        if alt_key.lower() == (key or '').lower():
            continue
        out[cls] = alt_key
        if len(out) >= ALT_MAX:
            break
    return {c: out[c] for c in ALT_CLASSES if c in out}


# 引擎表里的中文对照 → 词库条目。同一中文词头被多个英文功能词认领时，
# 先比来源（ZH_AUX > 封闭词类表），再比译注里的位置，最后按表序、字母序保稳定。
CLOSED_MIN_FREQ = 20000      # 第二、三义项只有在 jieba 里足够常用才认
RISKY_MIN_FREQ = 60000       # 介词/副词表的中文对照：不够常用就不认领（借、本）

# ZH_AUX 里这些值是引擎的内部标记（时态、语态、语气），不是英文词
AUX_FLAGS = {'past', 'exp', 'prog', 'pass', 'q', 'q2', 'sug', 'neg', 'de', 'ba', 'onlythen'}

# 其中只有否定会在中→日时用上一个真实英文词（引擎在中→英里自己补 not），
# 其余（了/过/被/吗…）两种语言都靠句法处理，不进词库。
AUX_FLAG_EN = {'neg': ('not', 'd')}


def aux_pos(en, head, enz):
    """引擎中文虚词表给的说法 → 词库词性：先查 Word Atlas，查不到再按
    词形猜（带 to 的是动词），最后才用引擎的封闭词类表——have/can 这类词
    在 Atlas 里是实义动词，标成助动词引擎就找不到谓语了。"""
    p = known_pos(en, enz)
    if p:
        return p
    if en.endswith(' to') or en in ('do', 'have'):
        return 'v'
    if ' ' in en:
        return 'd'
    return closed_class().get(en) or zh_pos(head) or 'n'


PROPER_HEAD = ('ns', 'nr', 'nt')
CAP_PREFIX = re.compile(r'^((?:[A-Z][A-Za-z\'\-]*)(?: [A-Z][A-Za-z\'\-]*)*)')


def proper_disp(head, disp):
    """地名、人名只取释义里大写的专名部分。

    CEDICT 习惯在专名后补一句普通名词说明（北京 → "Beijing municipality"），
    当译注读没问题，直接进句子就成了「Beijing municipality is…」。
    """
    tag = read_freq().get(head, (0, ''))[1]
    if not tag.startswith(PROPER_HEAD):
        return disp
    m = CAP_PREFIX.match(disp or '')
    return m.group(1) if m and m.group(1) else disp


def closed_overrides(enz, groups):
    """中文功能词的英文对应，以引擎的两张表为准。

    CEDICT 的释义是给人读的，同一个词头常把「我[my]」「是[right]」这类
    从句子里挑出来的形式当第一条；引擎要的却是主格 I 和系动词 be。
    engine.js 的 ZH_AUX（中文 → 英文）和封闭词类表（英文 → 中文）本来就是
    组句时真正用到的表，词库跟它们对齐，两边就不会各说各话。
    """
    cand = {}

    def claim(head, disp, tag, score, real=True):
        if not CJK.search(head) or len(head) > MAX_ZH:
            return
        if real and head not in groups:
            return          # 只覆盖词典里确实存在的词头
        cur = cand.get(head)
        if cur is None or score < cur[0]:
            cand[head] = (score, disp, tag)

    # 1) ZH_AUX：引擎先查这张表，它的值直接就是词库值（大小写照抄，我 → I）。
    #    表里的词头即便 CEDICT 没收也要补上，否则引擎切不到这个词。
    for head, val in zh_aux().items():
        en = val.lower().strip()
        if en in AUX_FLAGS:
            if en not in AUX_FLAG_EN:
                continue
            en, tag = AUX_FLAG_EN[en]
            claim(head, en, tag, (0, en), real=False)
            continue
        if not usable(en):
            continue
        claim(head, val, aux_pos(en, head, enz), (0, en), real=False)
    # 2) 封闭词类表反查：表里写了中文对照的用对照，没写的（be/can/in/of）走查表链
    for en, gloss, tag, order in closed_pairs():
        if not en or not usable(en):
            continue
        segs = _segments(gloss) if gloss else []
        if not segs:
            hit = enz.p.get(en) or enz.w.get(en)
            if hit:
                segs = _segments(hit[0])
            elif enz.inv.get(en):
                segs = [enz.inv[en]]
        disp = 'I' if en == 'i' else en
        # 介词/副词/形容词前缀这几张表的译注里混着实词（with → 「和；借」是文言
        # 用法，initially → 「本来；本」），照抄就让 借 变成介词。功能词的中文
        # 对照在 jieba 里都是十万级频次的字，够不上门槛的一律不认领。
        risky = order in (TABLE_RANK['ADJ_PRE'], TABLE_RANK['ADV'], TABLE_RANK['PP'])
        for i, seg in enumerate(segs):
            freq = read_freq().get(seg, (0, ''))[0]
            if risky and freq < RISKY_MIN_FREQ:
                break
            # 译注按常用度排，第二个之后只有在 jieba 里高频的短词才认
            if i and (len(seg) > 2 or freq < CLOSED_MIN_FREQ):
                break
            claim(seg, disp, tag, (1, 0 if i == 0 else 1, order, en))
    return dict((head, (v[1], v[2])) for head, v in cand.items())


def group_cedict(cedict):
    """按简体词头聚合，繁体词头另建一组；参照条目（variant of 之类）不参与。"""
    groups = {}
    for entry in cedict:
        # 一条记录可能同时有有效义项和参照义项：只要还有任何可译义项就保留，
        # 义项级过滤由 en_keys/en_pairs 完成；全是参照项的词头才整条排除。
        if not any(en_keys(sense) for sense in (entry.get('english') or [])):
            continue
        for head in (entry.get('simplified'), entry.get('traditional')):
            head = (head or '').strip()
            if not head or len(head) > MAX_ZH or not CJK.search(head):
                continue
            groups.setdefault(head, []).append(entry)
    return groups


def invert_jmdict(vocab):
    """JMdict → 「英文词 → 日文词」反转索引。

    排序依据全部来自数据本身：义项越靠后越不像「这个英文词的说法」，
    JLPT 分级越高分级代价越小一档（N5 常用词优先），最后比写法长短与词表位置。
    同时建一个「日文写法 → 条目」索引，中→日时能直接命中同形词（电话 → 電話）。

    括注在这里不降权：JMdict 的括注基本都是说明性的（水 → "water (esp. cool or
    cold)"、学生 → "student (esp. a university student)"），一降权最常用那个写法
    反而输给冷僻同义词。
    另建 inv_tail：英文说法常带限定词（駅 → "railway station"），中→英给的桥接词
    只有一个单词（station），尾词索引用来补上这一档差异。
    """
    inv = {}
    inv_pos = {}                   # (英文词, 日文词性) -> 同义项里词性对得上的那个
    inv_tail = {}                  # 多词释义的尾词 -> 日文词（station → 駅）
    by_word = {}
    pos_word = {}
    jlpt_word = {}                   # 日文写法 -> JLPT 档位（同形词定价用）
    conj_word = {}                 # 动词变位类别（v1 一段 / v5 五段 / suru）：引擎去ます词干要用
    for order, entry in enumerate(vocab):
        word = (entry.get('word') or '').strip()
        if not word or u' ' in word or len(word) > MAX_ZH or not CJK.search(word):
            continue
        keys = set()
        for meaning in entry.get('meanings') or []:
            for _disp, key in en_pairs(meaning):
                if usable(key) and len(key) <= 24:
                    keys.add(key)
        by_word.setdefault(word, keys)
        jlpt_word.setdefault(word, jlpt_rank(entry))
        pos = pos_of(entry.get('pos')) or 'n'
        pos_word.setdefault(word, pos)
        raw = (entry.get('pos') or u'').lower()
        conj = (u'v1' if u'ichidan' in raw else u'suru' if u'suru' in raw
                else u'v5' if u'godan' in raw else u'')
        if conj:
            conj_word.setdefault(word, conj)
        for i, meaning in enumerate(entry.get('meanings') or []):
            for j, (disp, key) in enumerate(en_pairs(meaning)):
                if key not in keys:
                    continue
                tier = SENSE_COST[min(i, 3)] + (0 if j == 0 else 1)
                # 常用度排在「写法带不带汉字」前面：桌子 → table 在词库里既有
                # テーブル（N5）也有 膳（N3），先比汉字写法就会挑出「膳」。
                score = (tier, jlpt_rank(entry), 0 if entry.get('containsKanji') else 1,
                         len(word), order)
                for table, k in ((inv, key), (inv_pos, (key, pos))):
                    cur = table.get(k)
                    if cur is None or score < cur[0]:
                        table[k] = (score, pos, word)
                if u' ' in key:
                    tail = key.split()[-1]
                    if len(tail) > 2:
                        tscore = (tier + 2, jlpt_rank(entry),
                                  0 if entry.get('containsKanji') else 1, len(word), order)
                        cur = inv_tail.get(tail)
                        if cur is None or tscore < cur[0]:
                            inv_tail[tail] = (tscore, pos, word)
    return inv, inv_pos, inv_tail, by_word, pos_word, conj_word, jlpt_word


CEFR = {'A1': 0, 'A2': 1, 'B1': 2, 'B2': 3, 'C1': 4, 'C2': 5}
ADJ_HEADS = set()      # Atlas 写成「热的」这类带 的 的译词，剥掉 的 之后是能当谓语的形容词


def invert_atlas(atlas, disp_of):
    """把 Word Atlas 的「英文 → 中文」翻成「中文 → 英文」，作为中→英的首选来源。

    Atlas 的英文词本身就带 CEFR 分级和词性，且都是给中国学习者用的常用说法，
    比 CEDICT 的释义更贴近「这个中文词最自然的英文说法」（例如 没 → no 而非 die）。
    """
    inv = {}

    def add(zh, key, pos, cefr, is_word):
        if not zh or not CJK.search(zh) or len(zh) > MAX_ZH:
            return
        if not key or not ASCII_WORD.match(key) or not usable(key):
            return
        item = (CEFR.get(cefr, 6), 0 if is_word else 1, len(key), key, pos)
        inv.setdefault(zh, []).append(item)
        if 1 < len(zh) <= 4:               # 双字译词里的每个单字也认一遍
            for ch in set(zh):
                if CJK.match(ch):
                    chars.setdefault(ch, []).append(item)
        # Atlas 把形容词标成 'd'，译词又常写成「热的」「安静的」这种带 的 的形式。
        # 去掉 的 才是中文里真正当谓语用的那个形容词，按形容词另建一条索引，
        # 这样 热 → hot 而不是 热 → heat（名词）。
        if pos in ('d', 'a') and 2 <= len(zh) <= 4 and zh.endswith(u'的') and CJK.search(zh[:-1]):
            ADJ_HEADS.add(zh[:-1])
            inv.setdefault(zh[:-1], []).append((CEFR.get(cefr, 6), 0, len(key), key, 'a'))

    chars = {}
    for table, is_word in ((atlas['w'], 1), (atlas['p'], 0)):
        for key, v in table.items():
            if not isinstance(v, (list, tuple)) or not v:
                continue
            pos = v[1] if len(v) > 1 else ''
            cefr = v[2] if len(v) > 2 else ''
            for seg in _segments(v[0]):
                add(seg, key, pos, cefr, is_word)
            if len(v) > 3 and v[3]:
                for kv in str(v[3]).split(';'):
                    i = kv.find(':')
                    if i <= 0:
                        continue
                    p2 = kv[:i]
                    for seg in _segments(kv[i + 1:]):
                        add(seg, key, pos or p2, cefr, is_word)
    for lst in list(inv.values()) + list(chars.values()):
        lst.sort()
    for zh, lst in inv.items():
        disp_of.setdefault(lst[0][3], lst[0][3])
    return inv, chars


def main():
    cedict = read_cedict()
    vocab, jmdict_ver = read_vocab()
    atlas = read_atlas()
    enz = EnZh(atlas, cedict)
    groups = group_cedict(cedict)

    # 先扫一遍 CEDICT，记下每个英文键的原样写法，输出时保留 I / Tokyo 的大小写
    disp_of = {}
    for entry in cedict:
        for disp, key in entry_pairs(entry):
            old = disp_of.get(key)
            if old is None:
                disp_of[key] = disp
            elif old[0].islower() and disp[0].isupper():
                disp_of[key] = disp
    atlas_inv, atlas_chars = invert_atlas(atlas, disp_of)
    over = closed_overrides(enz, groups)
    for h in (u'我', u'是', u'不', u'没', u'没有', u'好', u'很', u'在', u'有', u'的',
              u'什么', u'谁', u'也', u'都', u'这', u'那'):
        print('closed  %-4s %s' % (h, over.get(h)))

    # ---------------------------------------------------------- 中 → 英
    words, phrases = {}, {}
    picked = {}                    # head -> (查表键, 词性, 备选义项)
    altkey = {}                    # head -> 虚词表之外的实义查表键（供中→日桥接）
    trads = {}                     # head -> 该词头在 CEDICT 里的繁体写法
    with_pos = 0
    with_alt = 0
    from_atlas = 0
    freq = read_freq()
    for head, entries in groups.items():
        if head in over:
            disp, pos, alts = over[head][0], over[head][1], {}
        else:
            disp, key, pos, alts = best_for(entries, enz, atlas_inv, disp_of, atlas_chars)
            if not key:
                continue
        cut = proper_disp(head, disp)
        if cut != disp:
            key = cut.lower()       # 专名裁短后，中→日的桥接键也一起换（北京 → beijing）
            disp = cut
        if head in over:
            key = disp.lower()
            if closed_class().get(key) == 'x':
                # 虚词表把 可能 认领成 may，英文组句要的就是它，可中→日是拿英文词
                # 去查 JMdict 的，may 查出来是「いくら～ても」。这类词头另存一份
                # 实义查表键给日文用（possible → 可能）。
                _d, _alt, _p, _a2 = best_for(entries, enz, atlas_inv, disp_of, atlas_chars)
                if _alt:
                    altkey[head] = _alt
                    for _c, _k in _a2.items():
                        alts.setdefault(_c, _k)
        if head in atlas_inv:
            from_atlas += 1
        if closed_class().get(key) == 'x' and (key in be_forms() or zh_pos(head) != 'v'):
            pos = 'x'      # 助动词以引擎表为准（是 → be/x）
        elif pos == 'x':
            pos = 'v'      # 有/能 在中文里单独作谓语，标成助动词引擎就找不到谓语
        # 词性说的是「这个中文词在句子里干什么」：pretty 在 Atlas 里还标着
        # 副词（漂亮地），那是另一个义项，不能顶掉 漂亮 的形容词身份。
        htag = zh_pos(head)
        # Atlas 把形容词一律标成 'd'，译词写成「热的」「安静的」这种带 的 的形式。
        # 这类词头（热、安静）在句子里干的就是谓语的活（今天很热），词性记成 a，
        # 别让 jieba 的名词标注把它顶回 n——顶回去引擎就不给句子补 is 了。
        is_adj = head in ADJ_HEADS and pos in ('d', 'a')
        if is_adj:
            pos = 'a'       # 「有趣的」「安静的」：词头在句子里就是谓语形容词
        if htag and (not pos or (pos == 'd' and htag in ('a', 'n', 'v'))) and not is_adj:
            pos = htag
        # 名词身份以中文语料为准：Atlas 记的是「library 在英文里」的词性，
        # 图书馆 被标成 a，引擎就会在「在图书馆」里补一个 are 出来。
        # 动词不抢（跑步/唱歌 在 jieba 里是名词，句子里却当谓语用）。
        if htag == 'n' and pos in ('d', 't', 'r', 'i', 'phr', 'p', 'c', 'm', 'a'):
            pos = 'a' if is_adj else 'n'
        # 词尾本身就长得像形容词的（enjoyable、useful），按形容词收，
        # 引擎才知道「这本书很有意思」要有 is。jieba 已经给出词性的词头不靠猜
        # （library 以 -ary 结尾，却是名词）。
        if pos != 'v' and htag not in ('n', 'v', 'a') and ADJ_END.search(key):
            pos = 'a'
        # 动词槽位上赢的其实是个纯形容词（忙 → busy、高兴 → glad）：中文形容词作谓语
        # 不用系动词，英文要。词性记成 a，引擎才补 is（He is busy，不是 He busys）。
        if pos == 'v' and u' ' not in key and known_pos(key, enz) == 'a' \
                and not has_verb_sense(key, enz):
            pos = 'a'
        # 量词（个/些/张/条）英文没有对应成分，标出来让引擎直接丢掉。
        # 家、书 这种 jieba 顺带标过 q 的词不算：Atlas 里 home 是名词，
        # 标成量词引擎就把「她六点到家」里的家吞了。
        if htag == 'q':
            arow = enz.w.get(key.lower()) or enz.p.get(key.lower())
            apos = arow[1] if isinstance(arow, (list, tuple)) and len(arow) > 1 else ''
            if apos not in ('n', 'v', 'a'):
                pos = 'q'
        # 备选义项只给常用词带上（词库体积），也不留和最终词性重复的那一类。
        # 值放在词条第 4 位：mk() 会把 "n:homework;a:strange" 解析成 senses，
        # 引擎按句法槽位取词（做作业 → homework，很奇怪 → strange）。
        if freq.get(head, (0, ''))[0] >= ALT_MIN_FREQ:
            keep = [u'%s:%s' % (c, alts[c]) for c in ALT_CLASSES
                    if c in alts and c != pos][:ALT_MAX]
        else:
            keep = []
        if keep:
            with_alt += 1
        picked[head] = (key, pos, alts)
        if pos:
            with_pos += 1
        trads.setdefault(head, set()).update(
            (e.get('traditional') or '').strip() for e in entries)
        table = phrases if u' ' in head else words
        table[head] = [disp, pos, u'', u';'.join(keep)] if keep else [disp, pos]
    # ZH_AUX 里 CEDICT 没收的词头补进词库——引擎切词、组句都要靠这些词头存在
    extra = 0
    for head in sorted(over):
        if head in picked:
            continue
        disp, pos = over[head]
        picked[head] = (disp.lower(), pos, {})
        trads[head] = set()
        words[head] = [disp, pos]
        extra += 1
    size_en = dump_payload(os.path.join(OUTDIR, 'zh2en.json'), 'zh2en',
                           u'汉→英基础词库（CC-CEDICT × Word Atlas）', ATTR_EN,
                           {'cc-cedict': 'vendor/cedict.json (cedict-json 1.3.20251213)',
                            'word-atlas': 'web/data/en2zh.json (CC BY 4.0)',
                            'jieba': 'vendor/jieba-dict.txt (MIT) — 切词词频'},
                           words, phrases, freq_map=freq)
    print('zh2en words  :', len(words), u'（其中', from_atlas, u'条取自 Word Atlas，',
          extra, u'条按引擎虚词表补充，带词性', with_pos, u'，带备选义项', with_alt, u'）')
    print('zh2en phrases:', len(phrases))
    print('bytes        :', size_en)

    # ---------------------------------------------------------- 中 → 日
    inv, inv_pos, inv_tail, by_word, pos_word, conj_word, jlpt_word = invert_jmdict(vocab)
    ja_words, ja_phrases = {}, {}
    hit = 0
    alt_hit = 0
    for head, (key, zpos, alts) in picked.items():
        key = altkey.get(head, key)
        # 桥接不一定用主译法：作业 的英文主键是 operate，拿去查 JMdict 只会得到操る，
        # 名词备选 homework 才桥得出宿題。主键排在最前，同分时仍然它赢。
        bridge = [key] + [alts[c] for c in ALT_CLASSES
                          if c in alts and alts[c] and alts[c] != key]
        auxv = (zh_aux().get(head) or u'').lower()
        # 是/有/会 这类助动词、了/吗/被 这类语法标记，由引擎的组句规则负责；
        # 硬查成实词只会拿到「能 → 缶（易拉罐）」「了 → 英明」这种不相干的词。
        # 判据限定在单字词头：可能 的桥接词也是 can/may，可它自己是个多字实义词，
        # 不能跟着 能 一起丢。否定（不 → ない）例外：日文的否定就是实词「ない」。
        if zpos == 'x' or closed_class().get(key) == 'x' or (
                len(head) == 1 and auxv and auxv in AUX_FLAGS and auxv != 'neg'):
            # 助动词（会/能/可能）与语法标记（了/吗/被）都归引擎管：桥接成实词只会
            # 拿到「能 → 缶（易拉罐）」「了 → 英明」。否定（不 → ない）例外——
            # 日文的否定本身就是实词「ない」。多字实义词（可能 → 也许）不在此列，
            # 除非它查出来的键本身就是助动词。
            # 词库还是得留个位置：引擎切词认的是词条存在，了/吧/是 查不到就被
            # 拆成单字，句子里刷一串方括号。值本身引擎不会用（按 ZH_AUX 组句）。
            if zh_aux().get(head):
                ja_words[head] = [key, 'x']
            continue
        # 先看日文里有没有同形词（简体写法或 CEDICT 的繁体写法），有就直接用
        cognate = None
        for form in [head] + sorted(trads.get(head, ())):
            forms = by_word.get(form, ())
            if any(k in forms for k in bridge):
                cognate = form
                break

        def put(form):
            """同形词写入：JMdict 标 vs（名詞・サ変）而中文这里当动词用的
            （起床、工作、开会），词性记成 v，引擎才好在句尾变「します」。"""
            jpos = pos_word.get(form) or 'n'
            tag = conj_word.get(form) or ''
            if tag == 'suru' and jpos == 'n' and (zpos == 'v' or zh_pos(head) == 'v'):
                jpos = 'v'
            tbl = ja_phrases if u' ' in head else ja_words
            tbl[head] = [form, jpos, tag]

        if cognate and cognate != head:
            put(cognate)
            hit += 1
            continue
        if cognate == head and read_freq().get(head, (0, ''))[1].startswith(u'ns'):
            put(head)
            hit += 1
            continue          # 中国、北京：地名在日文里同形同义，不必绕英文再查一次
            # （只认地名：jieba 把 安静 标成 nr，走捷径就把 quiet 该桥的 静か 丢了）
        # 释义写法差一个词形也算同形词：起床 的中译是 get out of bed，JMdict 里
        # 起床 自己写的是 getting out of bed —— 整串对不上，但实词全对得上。
        if cognate is None:
            best = None
            for form in [head] + sorted(trads.get(head, ())):
                fset = set()
                for fk in by_word.get(form, ()):
                    fset |= tokset(fk)
                if not fset:
                    continue
                for bk in bridge:
                    bs = tokset(bk)
                    if len(bs) < 2:
                        continue
                    inter = bs & fset
                    if len(inter) >= 2 and len(inter) >= 0.6 * len(bs):
                        cand = (-round(len(inter) / float(len(bs)), 3), len(form), form)
                        if best is None or cand < best[0]:
                            best = (cand, form)
            if best:
                put(best[1])
                hit += 1
                continue
        # 同形词（我/工作）在日文里意思偏了，仍按英文桥接词查更常用的说法。
        # 三个来源的候选（本义索引 inv、词性索引 inv_pos、尾词索引 inv_tail）统一折成
        # 一个代价：义项越靠后越不像这个英文词的说法，JLPT 分级越高分越小，词性对不上
        # 付两倍（组句要用），靠尾词凑上的（駅 ← "railway station"）付四档。
        # 谁都不单独说了算：只看词性 → 学习 输给水张的 修める；只看义项位置 → 看 输
        # 给 見張り、车站 输给 ステーション。
        cands = []
        want = (zh_pos(head), zpos)
        # 候选池：主译法 → 主译法拆出的单词（多词说法再拆成单个实词）→ 备选义项及其拆词。
        # 备选义项那档额外要求日文词性对得上，否则 起床 会靠 a:up 桥成「上」
        # （主译法 get out of bed 桥不到词时的兜底，宁缺毋滥）。
        pool = []

        def add(k, pen, split):
            if k and not any(k == x for x, _p, _s in pool):
                pool.append((k, pen, split))

        def expand(k, pen):
            """多词说法拆词：上班 的英文是 go to work，JMdict 里对得上的是 work（働く）。
            拆出来的单词只付一档代价，但只给常用词头用：成语、术语的释义里
            随便一个词都能桥出一个不相干的日文词（有话快说 → 死），不值得收。"""
            add(k, pen, 0)
            for x in en_keys(k):
                if u' ' in x:
                    add(x, pen, 0)
                    ws = x.split()
                    for wi, tk in enumerate(ws):
                        if len(tk) > 2 and tk not in PHRASE_STOP:
                            # 复合说法只有末词承载词义：bus stop 拆出 bus，
                            # 就会把 车站 的 駅（← railway station）挤掉。
                            add(tk, pen + (2 if wi == len(ws) - 1 else 5), 1)
                else:
                    add(x, pen, 0)

        expand(key, 0)
        for cls in ALT_CLASSES:
            ak = alts.get(cls)
            if ak and ak != key:
                expand(ak, 2)
        headfreq = read_freq().get(head, (0, ''))[0]
        for src, table in ((0, inv), (1, inv_pos), (2, inv_tail)):
            for i, (k, pen, split) in enumerate(pool):
                if pen >= 2 and src == 2:
                    continue          # 备选义项 + 尾词索引，两层猜测叠一起不可信
                if split and headfreq < SPLIT_MIN_FREQ:
                    continue          # 冷门词头不收拆词桥来的日文词
                for lk in ((k, want[0]), (k, want[1])) if src == 1 else (k,):
                    c = table.get(lk)
                    if not c:
                        continue
                    score, japos, jword = c
                    if pen >= 2 and japos not in want:
                        continue
                    # 靠尾词凑上的（駅 ← "railway station"）是二手匹配，代价给足：
                    # 肉 → meat 不该因为 鶏肉 的释义写着 "chicken meat" 就抢走本义。
                    cost = (score[0] + (4 if src == 2 else 0) + pen
                            + (0 if japos in want else 2) + score[1])
                    cands.append((cost, score[2], score[3], score[4], src, jword, japos, pen))
        if cognate == head:
            # 日文里本来就有这个写法（肉、時間）：同形词按常用度定价参选，而不是
            # 无条件采信 —— 安静 在日文里也是词，但它不在常用词表里，就该让给 静か。
            jpos = pos_word.get(head) or 'n'
            if conj_word.get(head) == 'suru' and jpos == 'n' and (zpos == 'v' or zh_pos(head) == 'v'):
                jpos = 'v'
            cands.append((JLPT_COST[jlpt_word.get(head, 5)] + (0 if jpos in want else 2),
                          0, len(head), -1, 3, head, jpos, 0))
        if not cands:
            # 桥不出日文词，但这句话本来就归引擎组句（谢谢 → 「に感謝します」、请 → 「どうぞ」）：
            # 词库还是得留个词头，不然 谢谢 会被拆成两个单字，句子里刷一串方括号。
            if zh_aux().get(head):
                ja_words[head] = [key, 'x']
            continue
        cands.sort()
        jword, japos = cands[0][5], cands[0][6]
        if cands[0][7] >= 2:
            alt_hit += 1         # 赢的是备选义项（主译法桥不出词或桥得更差）
        table = ja_phrases if u' ' in head else ja_words
        table[head] = [jword, japos, conj_word.get(jword) or '']
        hit += 1
    size_ja = dump_payload(os.path.join(OUTDIR, 'zh2ja.json'), 'zh2ja',
                           u'汉→日基础词库（CC-CEDICT × JMdict）', ATTR_JA,
                           {'cc-cedict': 'cedict-json 1.3.20251213', 'jmdict': jmdict_ver,
                            'jieba': 'vendor/jieba-dict.txt (MIT) — 切词词频'},
                           ja_words, ja_phrases, freq_map=freq)
    print('zh2ja words  :', len(ja_words), u'（中→英词表命中', hit, u'，其中靠备选义项',
          alt_hit, u'）')
    print('zh2ja phrases:', len(ja_phrases))
    print('bytes        :', size_ja)


if __name__ == '__main__':
    sys.exit(main())
