"""Finish cold Safari startup before the real, uniquely labelled checkout."""
import http.server
import json
import secrets
import subprocess
import sys
import threading
import time
from pathlib import Path


def warm(phone, output):
    ready = threading.Event()
    path = "/ci-readiness-" + secrets.token_hex(12)
    hits = []
    class Readiness(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != path:
                self.send_error(404)
                return
            body = b"<!doctype html><title>CI readiness</title><p>Safari is ready.</p>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            hits.append({"seconds": round(time.monotonic() - start, 3), "agent": self.headers.get("User-Agent")})
            ready.set()

    start, attempts = time.monotonic(), []
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Readiness) as server:
        url = f"http://127.0.0.1:{server.server_port}{path}"
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            for _ in range(3):
                if ready.is_set():
                    break
                attempts.append(round(time.monotonic() - start, 3))
                # Only retry this inert page. The feature recorder runs once.
                subprocess.run(["xcrun", "simctl", "openurl", phone, url], timeout=60, check=True)
                if ready.wait(20):
                    break
            if not ready.is_set():
                subprocess.run(["xcrun", "simctl", "io", phone, "screenshot", str(output / "safari-readiness.png")], timeout=30)
                raise RuntimeError("Cold Safari never requested the CI readiness fixture.")
        finally:
            server.shutdown()
            (output / "safari-readiness.json").write_text(json.dumps({"attemptsSeconds": attempts, "requests": hits}, indent=2) + "\n")


if __name__ == "__main__":
    warm(sys.argv[1], Path(sys.argv[2]))
