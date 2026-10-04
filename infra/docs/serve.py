"""Render the architecture section of README.md at http://localhost:5280."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

DOCS = Path(__file__).resolve().parent
ROOT = DOCS.parents[1]
CACHE = ROOT / '.local-data/docs-assets'
ASSETS = {
    'marked.js': 'https://cdn.jsdelivr.net/npm/marked@15.0.12/lib/marked.umd.js',
    'mermaid.js': 'https://cdn.jsdelivr.net/npm/mermaid@10.9.3/dist/mermaid.min.js',
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.respond(True)

    def do_HEAD(self):
        self.respond(False)

    def respond(self, send_body):
        route = urlsplit(self.path).path
        try:
            if route == '/':
                body = (DOCS / 'index.html').read_bytes()
                mime = 'text/html; charset=utf-8'
            elif route in ('/architecture.md', '/README.md'):
                source = (ROOT / 'README.md').read_text(encoding='utf-8')
                if route == '/architecture.md':
                    source = '## Platform architecture and request walkthroughs' + source.split('## Platform architecture and request walkthroughs', 1)[1].split('## Run the platform', 1)[0]
                body = source.encode('utf-8')
                mime = 'text/plain; charset=utf-8'
            elif route.removeprefix('/assets/') in ASSETS and route.startswith('/assets/'):
                body = (CACHE / route.removeprefix('/assets/')).read_bytes()
                mime = 'text/javascript; charset=utf-8'
            else:
                self.send_error(404)
                return
        except (OSError, IndexError):
            self.send_error(503, 'Documentation unavailable')
            return
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        if send_body:
            self.wfile.write(body)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=5280)
    parser.add_argument('--prepare-assets', action='store_true', help='Download pinned renderers once, then exit.')
    args = parser.parse_args()
    if args.prepare_assets:
        CACHE.mkdir(parents=True, exist_ok=True)
        for name, url in ASSETS.items():
            destination = CACHE / name
            if not destination.exists():
                with urlopen(url, timeout=60) as response:
                    content = response.read()
                destination.write_bytes(content)
            print('Ready:', name)
    else:
        if not all((CACHE / name).is_file() for name in ASSETS):
            parser.error('Run python infra/docs/serve.py --prepare-assets first.')
        with ThreadingHTTPServer(('127.0.0.1', args.port), Handler) as server:
            print(f'README.md architecture: http://localhost:{args.port}', flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
