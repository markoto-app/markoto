"""
Minimal HTTP wrapper around Pandoc for file conversion.

Endpoints:
  POST /convert
    Query params: from, to, standalone (optional)
    Body: raw file content (Content-Type should match input format)
    Returns: converted file content

  GET /health
    Returns 200 OK
"""

import subprocess
import tempfile
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

MAX_SIZE = 50 * 1024 * 1024  # 50 MB


class PandocHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_error(404)

    def do_POST(self):
        if not self.path.startswith("/convert"):
            self.send_error(404)
            return

        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        from_fmt = params.get("from", [""])[0]
        to_fmt = params.get("to", ["gfm"])[0]
        standalone = "standalone" in params

        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > MAX_SIZE:
            self.send_error(413, "File too large")
            return
        if content_length == 0:
            self.send_error(400, "Empty body")
            return

        body = self.rfile.read(content_length)

        with tempfile.TemporaryDirectory() as tmpdir:
            # Determine input extension from format
            ext_map = {
                "docx": ".docx",
                "pdf": ".pdf",
                "html": ".html",
                "markdown": ".md",
                "gfm": ".md",
                "latex": ".tex",
                "": ".bin",
            }
            in_ext = ext_map.get(from_fmt, ".bin")
            out_ext = ext_map.get(to_fmt, ".bin")

            in_path = os.path.join(tmpdir, f"input{in_ext}")
            out_path = os.path.join(tmpdir, f"output{out_ext}")

            with open(in_path, "wb") as f:
                f.write(body)

            cmd = ["pandoc", in_path, "-t", to_fmt, "-o", out_path, "--wrap=none"]
            if from_fmt:
                cmd.extend(["-f", from_fmt])
            if standalone:
                cmd.append("-s")
            # Use XeLaTeX for PDF to support Unicode/emoji
            if to_fmt == "pdf":
                cmd.extend(["--pdf-engine=xelatex"])
            if from_fmt == "docx":
                media_dir = os.path.join(tmpdir, "media")
                cmd.extend(["--extract-media", media_dir])

            try:
                result = subprocess.run(
                    cmd, capture_output=True, text=True, timeout=120
                )
            except subprocess.TimeoutExpired:
                self.send_error(504, "Pandoc timed out")
                return

            if result.returncode != 0:
                self.send_response(422)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(result.stderr.encode())
                return

            if not os.path.exists(out_path):
                self.send_error(500, "Pandoc produced no output")
                return

            with open(out_path, "rb") as f:
                output = f.read()

            content_type = {
                ".md": "text/markdown",
                ".html": "text/html",
                ".pdf": "application/pdf",
                ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ".tex": "text/x-latex",
            }.get(out_ext, "application/octet-stream")

            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(output)))
            self.end_headers()
            self.wfile.write(output)

    def log_message(self, format, *args):
        print(f"[pandoc-server] {args[0]}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    server = HTTPServer(("0.0.0.0", port), PandocHandler)
    print(f"Pandoc server listening on :{port}")
    server.serve_forever()
