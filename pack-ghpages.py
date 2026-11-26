#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包静态站点部署目录：web/ + 可选的本地神经模型。

用法：
  python pack-ghpages.py [输出目录] [--pairs en-zh,zh-en]

默认输出 .ghpages 并打包全部已下载方向；例如官网只带英→中：
  python pack-ghpages.py web-mt --pairs en-zh

模型二进制不进 git 主分支：先用 mt/fetch-models.py 下载到本地 mt/。
本脚本把 web/ 与筛选后的 mt/registry.json、mt/runtime/、mt/<pair>/ 组装成
站点根（模型落在 mt/models/<pair>/，与 registry.json 的相对路径一致）。
"""
import argparse
import json
import os
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, 'web')
MT = os.path.join(ROOT, 'mt')


def total_size(root):
    return sum(os.path.getsize(os.path.join(dp, fn))
               for dp, _dn, fns in os.walk(root) for fn in fns)


def main():
    parser = argparse.ArgumentParser(description='组装 TransDesk 静态站点部署目录')
    parser.add_argument('out', nargs='?', default=os.path.join(ROOT, '.ghpages'),
                        help='输出目录（默认 .ghpages）')
    parser.add_argument('--pairs', default='',
                        help='仅打包指定方向，逗号分隔，如 en-zh；默认全部')
    args = parser.parse_args()
    out = os.path.abspath(args.out)
    if os.path.abspath(out) in (os.path.abspath(ROOT), os.path.abspath(WEB), os.path.abspath(MT)):
        parser.error('输出目录不能覆盖项目根目录、web/ 或 mt/')
    if os.path.isdir(out):
        shutil.rmtree(out)
    shutil.copytree(WEB, out, ignore=shutil.ignore_patterns('__pycache__'))

    reg_path = os.path.join(MT, 'registry.json')
    if not os.path.exists(reg_path):
        print('未找到 mt/registry.json：部署版将运行词典引擎（先跑 mt/fetch-models.py）')
    else:
        with open(reg_path, encoding='utf-8') as f:
            registry = json.load(f)
        if args.pairs:
            selected = [p.strip() for p in args.pairs.split(',') if p.strip()]
            registry = {k: v for k, v in registry.items()
                        if any(k == p.replace('-', '') for p in selected)}
            selected_names = [p for p in selected
                              if p.replace('-', '') in registry]
            missing = [p for p in selected if p not in selected_names]
            if missing:
                parser.error('模型清单中没有这些方向：' + ', '.join(missing))
        else:
            selected_names = sorted(k[:2] + '-' + k[2:] for k in registry if len(k) == 4)
        mtdst = os.path.join(out, 'mt')
        os.makedirs(mtdst, exist_ok=True)
        with open(os.path.join(mtdst, 'registry.json'), 'w', encoding='utf-8') as f:
            json.dump(registry, f, ensure_ascii=False, indent=1)
        sums = os.path.join(MT, 'SHA256SUMS.txt')
        if os.path.exists(sums):
            included = {entry['name'] for pair in registry.values()
                        for entry in pair.values() if isinstance(entry, dict)}
            with open(sums, encoding='utf-8') as src:
                lines = [line for line in src if line.strip() and line.split()[-1] in included]
            with open(os.path.join(mtdst, 'SHA256SUMS.txt'), 'w', encoding='utf-8') as dst:
                dst.writelines(lines)
        shutil.copytree(os.path.join(MT, 'runtime'), os.path.join(mtdst, 'runtime'))
        for key in sorted(registry):
            name = key[:2] + '-' + key[2:]
            src = os.path.join(MT, name)
            if not os.path.isdir(src):
                parser.error('缺少模型目录：' + src)
            shutil.copytree(src, os.path.join(mtdst, 'models', name))
        print('神经模型方向:', ', '.join(selected_names) if selected_names else '（无）')
    print('输出目录:', out)
    print('总大小: %.1f MB' % (total_size(out) / 1e6))


if __name__ == '__main__':
    main()
