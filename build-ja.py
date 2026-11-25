# -*- coding: utf-8 -*-
"""由公开词库生成 web/data/ja2zh.json。

来源（全部为开放授权，见 vendor/README.md）：
  1. JMdict 派生词表 vendor/kotobako.json（CC BY-SA 4.0）：日文词 + 英文释义 + 词性
  2. Word Atlas web/data/en2zh.json（CC BY 4.0）与 CC-CEDICT（CC BY-SA 4.0）：英文释义 → 中文

生成方式只是「日文 → 英文 → 中文」两级查表；查不通的条目直接丢弃，不手工补词。
用法：python build-ja.py
"""
import os
import re
import sys

from dictlib import (CJK, OUTDIR, dump_payload, en_keys, pos_of, read_atlas,
                     read_cedict, read_vocab, EnZh)

HIRAGANA = re.compile(u'^[぀-ゟ]+$')
FUNC_POS = re.compile(u'particle|conjunction|auxiliary|interjection|prefix|suffix|counter|numeric',
                      re.I)
MAX_KEY = 9

ATTRIBUTION = (u'日文词条来自 JMdict/EDRDG 项目（The Electronic Dictionary Research and '
               u'Development Group，CC BY-SA 4.0）经 kotobako 分发的 JSON 词表；'
               u'中文释义由 Word Atlas（CC BY 4.0）与 CC-CEDICT（CC BY-SA 4.0）查表得到。'
               u'本文件为衍生数据，沿用 CC BY-SA 4.0。')


def term_keys(entry):
    """一个 JMdict 条目可用的检索键：写法、异体写法、假名读法。"""
    out = []
    # 假名单写的词条（なる・おいしい・たまご）：助词类的一律不建键，交给引擎规则表。
    kana_word = not FUNC_POS.search(entry.get('pos') or u'')
    for raw in (entry.get('word'), entry.get('altWord')):
        t = (raw or '').strip()
        if not (t and len(t) <= MAX_KEY and CJK.search(t)):
            continue
        if HIRAGANA.match(t) and not (kana_word and len(t) > 1):
            continue
        out.append(t)
    reading = (entry.get('reading') or '').strip()
    word = (entry.get('word') or '').strip()
    has_kanji = any(u'一' <= ch <= u'鿿' for ch in word)
    if (reading and len(reading) <= MAX_KEY and reading not in out
            and (has_kanji or kana_word)):
        # 纯假名读法只在写法含汉字、或条目本身就是假名词条时补充；
        # 单字假名（多为助词）交给规则表。
        if len(reading) > 1 or not HIRAGANA.match(reading):
            out.append(reading)
    return out


def main(dst=None):
    vocab, jmdict_ver = read_vocab()
    atlas = read_atlas()
    cedict = read_cedict()
    enz = EnZh(atlas, cedict)
    dst = dst or os.path.join(OUTDIR, 'ja2zh.json')

    words, phrases = {}, {}
    rank = {}                     # key -> 优先级（越小越保留）
    n_no_gloss = 0

    def put(key, value, prio):
        table = phrases if u' ' in key else words
        if key in table and rank.get(key, 99) <= prio:
            return
        table[key] = value
        rank[key] = prio

    for entry in vocab:
        keys = term_keys(entry)
        if not keys:
            continue
        # 词性以 JMdict 自带的 pos 为准（「多い」是 i-adjective，不该被英文释义里的
        # a lot 带偏成限定词），查不到时才用 Word Atlas 给中文释义标的词性。
        jpos = pos_of(entry.get('pos'))
        senses = []                 # (词性是否对得上, 中文, 英文释义自带的词性)
        for meaning in entry.get('meanings') or []:
            hit = enz.resolve(meaning)
            if not hit:
                continue
            zh, pos, _alt = hit
            if zh in [s[1] for s in senses]:
                continue
            # present 在中文词表里有「在场的」（形容词）和「礼物」（名词）两种解释，
            # JMdict 给プレゼント 标的是名词，就取对得上词性的那一个。
            senses.append((0 if (jpos and pos == jpos) else 1, zh, pos))
            if len(senses) >= 4:
                break
        if not senses:
            n_no_gloss += 1
            continue
        # 稳定排序：词性对得上的排前面，其余仍按 JMdict 的义项顺序。
        senses.sort(key=lambda s: s[0])
        zh, pos = senses[0][1], jpos or senses[0][2] or 'n'
        alt = ''
        if len(senses) > 1:
            alt = ';'.join(u'%s:%s' % (jpos or p or 'x', g) for _m, g, p in senses[:3])
        value = [zh, pos, u'', alt] if alt else [zh, pos]
        prio = 0 if entry.get('jlpt') else 1
        for key in keys:
            put(key, value, prio)

    size = dump_payload(dst, 'ja2zh', u'日语基础词库（JMdict 派生）', ATTRIBUTION,
                        {'jmdict': jmdict_ver, 'chained': 'Word Atlas + CC-CEDICT'},
                        words, phrases)
    print('ja2zh words  :', len(words))
    print('ja2zh phrases:', len(phrases))
    print('未解析条目   :', n_no_gloss, '/', len(vocab))
    print('bytes        :', size)


if __name__ == '__main__':
    sys.exit(main())
