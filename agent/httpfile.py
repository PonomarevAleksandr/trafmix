#!/usr/bin/env python3
"""Tiny HTTP file source for HTTP-shaped traffic — serves a generated stream of random
bytes of a requested size, so no real file is needed on the node.

    python3 httpfile.py 8745 200        # listen on :8745, cap any download at 200 MB

    GET /file          -> default size
    GET /file?mb=50    -> 50 MB of random bytes (clamped to the cap)
    GET /health        -> ok

Random (incompressible) bytes keep the download from being a repeating pattern.
"""
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8745
CAP_MB = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
DEFAULT_MB = 100
CHUNK = 256 * 1024


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/health":
            self.send_response(200); self.send_header("Content-Length", "2"); self.end_headers()
            self.wfile.write(b"ok"); return
        if u.path != "/file":
            self.send_response(404); self.end_headers(); return
        mb = int((parse_qs(u.query).get("mb", [str(DEFAULT_MB)])[0]) or DEFAULT_MB)
        total = max(1, min(mb, CAP_MB)) * 1024 * 1024
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(total))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        left = total
        try:
            while left > 0:
                n = min(CHUNK, left)
                self.wfile.write(os.urandom(n))
                left -= n
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client (its rate limit) hung up early; fine


if __name__ == "__main__":
    print(f"httpfile on :{PORT} (cap {CAP_MB} MB)")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
