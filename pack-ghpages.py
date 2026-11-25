#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包 GitHub Pages 部署目录：web/ + 可选神经模型（mt/）。

用法：python pack-ghpages.py [输出目录，默认 .ghpages]

模型二进制不进 git 主分支：先用 mt/fetch-models.py 下载到本地 mt/，
本脚本再把 web/ 与 mt/registry.json、mt/runtime/、mt/<pair>/ 组装成
Pages 站点根（模型落在 mt/models/<pair>/，与 registry.json 的相对路径一致）。
mt/registry.json 不存在时只打包 web/，站点自动运行词典引擎模式。
"""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '.ghpages'))
WEB = os.path.join(ROOT, 'web')
MT = os.path.join(ROOT, 'mt')


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    shutil.copytree(WEB, OUT, ignore=shutil.ignore_patterns('__pycache__'))

    reg = os.path.join(MT, 'registry.json')
    if os.path.exists(reg):
        mtdst = os.path.join(OUT, 'mt')
        os.makedirs(mtdst, exist_ok=True)
        shutil.copy2(reg, os.path.join(mtdst, 'registry.json'))
        sums = os.path.join(MT, 'SHA256SUMS.txt')
        if os.path.exists(sums):
            shutil.copy2(sums, os.path.join(mtdst, 'SHA256SUMS.txt'))
        shutil.copytree(os.path.join(MT, 'runtime'), os.path.join(mtdst, 'runtime'))
        pairs = []
        for name in sorted(os.listdir(MT)):
            d = os.path.join(MT, name)
            if os.path.isdir(d) and name != 'runtime' and '-' in name:
                shutil.copytree(d, os.path.join(mtdst, 'models', name))
                pairs.append(name)
        print('神经模型方向:', ', '.join(pairs) if pairs else '（无）')
    else:
        print('未找到 mt/registry.json：Pages 版将运行词典引擎（先跑 mt/fetch-models.py）')

    total = 0
    for dp, _dn, fns in os.walk(OUT):
        for fn in fns:
            total += os.path.getsize(os.path.join(dp, fn))
    print('输出目录:', OUT)
    print('总大小: %.1f MB' % (total / 1e6))


if __name__ == '__main__':
    main()
