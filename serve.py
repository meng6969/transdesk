#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""译台 TransDesk —— 本地预览服务器（仅本机使用，不外发任何数据）。

用法：
    python serve.py            # 默认 http://127.0.0.1:8765
    python serve.py 9000       # 换端口
    python serve.py --open     # 启动时顺便打开浏览器

为什么要它：Service Worker、IndexedDB 与 fetch() 词库在 file:// 下会被浏览器限制，
必须用 http:// 打开本机目录。这个脚本只把 web/ 目录当静态文件提供服务，
绑定 127.0.0.1，不监听局域网，不写日志文件，响应一律 no-store 以免改完代码看不到新版。
"""
import http.server
import os
import socketserver
import sys
import webbrowser

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')
argv = [a for a in sys.argv[1:] if a != '--open']
OPEN = '--open' in sys.argv[1:]
PORT = int(argv[0]) if argv and argv[0].isdigit() else 8765

TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.traineddata': 'application/octet-stream',
    '.wasm': 'application/wasm',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in TYPES:
            return TYPES[ext]
        return super().guess_type(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        # 本地图片 OCR 需要读取本机文件；同源 http:// 下 canvas 不会被污染
        self.send_header('Service-Worker-Allowed', '/')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stdout.write('  %s\n' % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    if not os.path.isdir(ROOT):
        print('找不到站点目录：', ROOT)
        return 1
    with Server(('127.0.0.1', PORT), Handler) as httpd:
        url = 'http://127.0.0.1:%d/' % PORT
        print('译台 TransDesk 本地预览：', url)
        print('文件根目录：', ROOT)
        print('Ctrl+C 停止。只监听 127.0.0.1，不对外网开放。')
        try:
            if OPEN:
                webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
