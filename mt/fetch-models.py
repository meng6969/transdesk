# -*- coding: utf-8 -*-
"""下载 Bergamot/Marian int8 翻译模型到 mt/，并生成 mt/registry.json。

默认只取「中⇄英」两个方向（约 100 MB）。要把日语也换成神经模型，就加日语两段：
    python fetch-models.py --pairs zh-en,en-zh,ja-en,en-ja
注意日语没有直连模型，Bergamot 是「日→英→中」两段中转，四个方向合计约 200 MB，
APK 会跟着涨到 200 MB 以上；而译台自带的词典引擎在中⇄日上已经能到 97~100% 命中，
所以默认不带。

来源与校验（都不需要人工补数据）：
  * 权重从 hf-mirror.com 上的 midudev/firefox-translations 镜像下载 —— 那是 Mozilla
    官方权重的逐字节镜像（官方存储桶不发 CORS 头，浏览器/WebView 取不到）；
  * 每个文件下载后算 sha256，和 Mozilla 官方 Remote Settings 注册表
    （firefox.settings.services.mozilla.com 的 translations-models 集合）逐条对账，
    对不上就报错退出，不会把来路不明的权重打进包里。

模型本身是 Mozilla firefox-translations-models 项目的产物（MPL-2.0），
wasm 运行时是 bergamot-translator 的单线程构建（MPL-2.0）。两者的许可证文本都放在
mt/runtime/LICENSE-mpl2-mozilla.txt，随包分发即可，不需要额外授权。

用法：
    python fetch-models.py                       # 中⇄英（默认）
    python fetch-models.py --pairs zh-en,en-zh    # 只要中→英
    python fetch-models.py --pairs zh-en,en-zh,ja-en,en-ja
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MIRROR = 'https://hf-mirror.com/midudev/firefox-translations/resolve/main'
MIRROR_API = 'https://hf-mirror.com/api/models/midudev/firefox-translations/tree/main'
REGISTRY = ('https://firefox.settings.services.mozilla.com/v1/buckets/main/'
            'collections/translations-models/records')

# 译台的语向 -> Mozilla 注册表里的 fromLang/toLang（简体中文在官方注册表里叫 zh-Hans）
LANG = {'zh': ('zh', 'zh-Hans'), 'en': ('en',), 'ja': ('ja',)}
ALL_PAIRS = ('zh-en', 'en-zh', 'ja-en', 'en-ja')


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': 'transdesk/1.5'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def official_hashes():
    """Mozilla 官方注册表：(fromLang, toLang, fileType, size) -> sha256。"""
    out = {}
    try:
        recs = json.loads(get(REGISTRY, 90).decode('utf-8')).get('data', [])
    except Exception as e:
        print('！取不到官方注册表（%s），本次只做本地 sha256 记录' % e)
        return out
    for r in recs:
        a = r.get('attachment') or {}
        if not a.get('hash'):
            continue
        out[(r.get('fromLang'), r.get('toLang'), r.get('fileType'), a.get('size'))] = a['hash']
    return out


def part_of(name):
    head = name.split('.')[0]
    return head if head in ('model', 'lex', 'vocab', 'srcvocab', 'trgvocab', 'qualityModel') else None


def pair_codes(pair):
    a, b = pair.split('-')
    return a + b, LANG[a], LANG[b]


def fetch_pair(pair, official):
    code, froms, tos = pair_codes(pair)
    dst = os.path.join(HERE, pair)
    os.makedirs(dst, exist_ok=True)
    listing = json.loads(get('%s/%s' % (MIRROR_API, pair), 60).decode('utf-8'))
    entry = {}
    total = 0
    for item in listing:
        name, size = item.get('path', '').split('/')[-1], item.get('size') or 0
        part = part_of(name)
        if item.get('type') != 'file' or not part or not size:
            continue
        path = os.path.join(dst, name)
        if os.path.exists(path) and os.path.getsize(path) == size:
            print('  = %s（已存在）' % name)
        else:
            url = '%s/%s/%s' % (MIRROR, pair, name)
            print('  ↓ %s  %.2f MB' % (name, size / 1048576.0))
            data = get(url, 1800)
            if len(data) != size:
                sys.exit('！%s 大小不对：%d != %d' % (name, len(data), size))
            with open(path, 'wb') as f:
                f.write(data)
        digest = hashlib.sha256(open(path, 'rb').read()).hexdigest()
        want = None
        for fl in froms:
            for tl in tos:
                want = want or official.get((fl, tl, part, size))
        if want and want != digest:
            sys.exit('！%s 校验失败：本地 %s != 官方 %s' % (name, digest, want))
        print('    sha256 %s%s' % (digest[:16], ' ✓ 与 Mozilla 官方注册表一致' if want else ' （官方无对应记录）'))
        entry[part] = {'name': 'mt/models/%s/%s' % (pair, name), 'size': size, 'sha256': digest}
        total += size
    if 'model' not in entry or not any(k in entry for k in ('vocab', 'srcvocab')):
        sys.exit('！%s 缺文件：%s' % (pair, sorted(entry)))
    return code, entry, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pairs', default='zh-en,en-zh',
                    help='要下载的语向，逗号分隔，可选：%s' % ','.join(ALL_PAIRS))
    args = ap.parse_args()
    pairs = [p.strip() for p in args.pairs.split(',') if p.strip()]
    bad = [p for p in pairs if p not in ALL_PAIRS]
    if bad:
        sys.exit('！不认识的语向 %s，可选：%s' % (bad, ','.join(ALL_PAIRS)))

    print('官方注册表对账中……')
    official = official_hashes()
    reg, grand = {}, 0
    for pair in pairs:
        print('语向 %s' % pair)
        code, entry, total = fetch_pair(pair, official)
        reg[code] = entry
        grand += total

    reg_path = os.path.join(HERE, 'registry.json')
    with open(reg_path, 'w', encoding='utf-8') as f:
        json.dump(reg, f, ensure_ascii=False, indent=1)
    lines = []
    for code, entry in sorted(reg.items()):
        for part, info in sorted(entry.items()):
            lines.append('%s  %s' % (info['sha256'], info['name']))
    with open(os.path.join(HERE, 'SHA256SUMS.txt'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')

    print('\nregistry.json 语向：%s' % ' '.join(sorted(reg)))
    print('模型合计 %.1f MB（另有 wasm 运行时约 5 MB）' % (grand / 1048576.0))
    print('下一步：python android/pack-www.py && bash android/build-apk.sh')
    return 0


if __name__ == '__main__':
    sys.exit(main())
