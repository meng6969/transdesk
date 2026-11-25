# -*- coding: utf-8 -*-
"""由 CC-CEDICT 补齐 Word Atlas 缺失的英文词条 → web/data/en2core.json。

Word Atlas（web/data/en2zh.json，CC BY 4.0）只有 7,297 个单词条目，work / thank
这类最基础的词反而没有；CC-CEDICT（CC BY-SA 4.0）里有对应中文词，反查一次即可补上。
做法是纯粹的查表拼接：CEDICT「中文词 → 英文释义」反转成「英文词 → 中文词头」，
只保留 Word Atlas 里查不到的键，不手写任何词条。

引擎按加载顺序取先到的词典（app.js 里 en2zh 在前、本文件在后），所以补充表
只填坑，不会盖掉 Word Atlas 的多义项。
用法：python build-en.py
"""
import os
import re
import sys

from dictlib import OUTDIR, dump_payload, read_atlas, read_cedict, EnZh

ATTRIBUTION = (u'补充词表由 CC-CEDICT 项目（CC BY-SA 4.0，The CC-CEDICT Community）的反向索引生成，'
               u'仅收录 Word Atlas（CC BY 4.0）里没有的英文词；中文用词按 CC-CEDICT 词频顺序选取。'
               u'本文件为衍生数据，沿用 CC BY-SA 4.0。')

# CEDICT 释义里的分类标记，不是可译内容
NOISE_KEY = re.compile(r'^(cl|meas|var|abbr|obs|esp|usu|etc|sb|sth|pred|adv)$')
# 两字母的键绝大多数是 CEDICT 里的缩写或噪声，只放行确实在词典里当实词用的
ALLOW_2 = set('an as at be by do go he if in is it me no of on or so to up us we'.split())


def main(dst=None):
    atlas = read_atlas()
    cedict = read_cedict()
    enz = EnZh(atlas, cedict)
    dst = dst or os.path.join(OUTDIR, 'en2core.json')

    words = {}
    verbs = 0
    for key, zh in enz.inv.items():
        if NOISE_KEY.match(key):
            continue
        if len(key) < 3 and key not in ALLOW_2:
            continue
        if key in atlas['w'] or key in atlas['p']:
            continue                      # Word Atlas 已有，交给它（义项更细）
        pos = enz.invpos.get(key) or ''
        if pos:
            verbs += 1
        words[key] = [zh, pos]

    size = dump_payload(dst, 'en2zh', u'英文基础补充词表（CC-CEDICT 派生）', ATTRIBUTION,
                        {'cc-cedict': 'vendor/cedict.json (cedict-json 1.3.20251213)',
                         'gap-of': 'Word Atlas web/data/en2zh.json'},
                        words, {})
    print('en2core words:', len(words), u'（其中动词', verbs, u'）')
    print('bytes        :', size)


if __name__ == '__main__':
    sys.exit(main())
