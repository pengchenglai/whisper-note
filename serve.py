"""在电脑上本地预览 Whisper Note。

用法：python serve.py   然后用浏览器打开 http://localhost:8377
（localhost 上浏览器允许使用麦克风；手机要用的话需要部署到 https 网址，见 README）
"""
import http.server
import socketserver
import os
import sys

PORT = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8377))
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows 的注册表有时会把 .js 标成 text/plain，导致模块脚本加载失败，这里写死
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".webmanifest": "application/manifest+json",
        ".png": "image/png",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        # 只用英文输出：部分 Windows 终端的编码打印不了中文
        print(f"Whisper Note is running at http://localhost:{PORT}", flush=True)
        httpd.serve_forever()
