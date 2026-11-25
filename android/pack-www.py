# -*- coding: utf-8 -*-
"""把 web/ 与 mt/ 组装成安卓 APP 的 assets/www。

APP 版和网页版跑的是同一套前端，只有两处不同：
  1. 多了 mt/（Bergamot wasm 运行时 + 模型权重 + 清单），词典引擎之上多一层神经翻译；
  2. 少了 sw.js —— ServiceWorker 在 WebView 里会把 100 MB 模型再缓存一份，纯属浪费，
     assets 本来就是本地文件，不需要离线缓存。

用法：python pack-www.py [--no-models]
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, 'web')
MT = os.path.join(ROOT, 'mt')
DST = os.path.join(HERE, 'app', 'src', 'main', 'assets', 'www')

PAIRS = ('zh-en', 'en-zh', 'ja-en', 'en-ja')   # 有哪个语向的权重就带哪个


def mb(path):
    total = 0
    for base, _dirs, files in os.walk(path):
        for f in files:
            total += os.path.getsize(os.path.join(base, f))
    return total / 1048576.0


def main():
    with_models = '--no-models' not in sys.argv
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    shutil.copytree(WEB, DST)

    # APP 里不需要 ServiceWorker：删掉文件，前端的注册会自然失败并安静跳过。
    for skip in ('sw.js',):
        p = os.path.join(DST, skip)
        if os.path.exists(p):
            os.remove(p)

    pairs = []
    if with_models:
        runtime_src = os.path.join(MT, 'runtime')
        reg = os.path.join(MT, 'registry.json')
        if not os.path.exists(reg):
            sys.exit('找不到 %s：先跑 mt/fetch.sh 下载模型' % reg)
        mtdst = os.path.join(DST, 'mt')
        os.makedirs(os.path.join(mtdst, 'models'))
        shutil.copy2(reg, mtdst)
        for extra in ('SHA256SUMS.txt',):
            p = os.path.join(MT, extra)
            if os.path.exists(p):
                shutil.copy2(p, mtdst)
        shutil.copytree(runtime_src, os.path.join(mtdst, 'runtime'))
        for pair in PAIRS:
            src = os.path.join(MT, pair)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(mtdst, 'models', pair))
                pairs.append(pair)

    print('assets/www      : %.1f MB' % mb(DST))
    if with_models:
        print('  其中 神经模型  : %.1f MB（语向 %s）'
              % (mb(os.path.join(DST, 'mt', 'models')), ' '.join(pairs) or '无'))
        print('  其中 wasm 运行时: %.1f MB' % mb(os.path.join(DST, 'mt', 'runtime')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
