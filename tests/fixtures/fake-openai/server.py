"""Fake OpenAI-compatible provider for the BYOK test stack.

Stands in for "the user's own AI provider" (OpenAI, Mistral, Ollama, ...)
so the integration + flow suites can drive a real round trip
app -> LiteLLM (clientside credentials) -> this server without a paid
upstream. Standard library only so it runs inside any python3 image; the
test compose reuses the LiteLLM image (already pulled) to host it.

Endpoints (all under /v1, OpenAI shapes):
  GET  /v1/models                 model list
  POST /v1/chat/completions       stream + non-stream, scripted tool calls
  POST /v1/images/generations     returns a 1x1 PNG as b64_json
  POST /v1/audio/transcriptions   multipart in, {"text": ...} out

Scripted behaviour keyed on the request:
  - Authorization must be "Bearer <key>". The key "bad-key" -> 401.
  - Model "missing-model" -> 404 model_not_found.
  - Model "no-tools-model" never emits tool calls (plain text instead).
  - Model "obedient-chat" plays a model that follows instructions planted
    in content (prompt-injection tests): first it calls `view_document`;
    afterwards, when the latest tool result contains a line
    `FAKE_DIRECTIVE <tool_name> <json-args>`, it calls exactly that tool
    with those arguments (at most 6 tool turns); otherwise it answers
    "Done." and the turn ends.
  - When the tool `propose_design` is offered ("Create a design from a
    document", a vision request), the reply calls it with DESIGN_PROPOSAL;
    once the prompt carries a `<previous_proposal>` (a comparison round)
    it adds `matches_original: true`, so a run ends after two calls. The
    record notes how many images the request carried (`images`).
  - Otherwise, when tools are offered and the last message is NOT a tool
    result, the reply is a tool call: `insert_text` (when offered, so
    the markoto agent loop writes a marker line into the doc), else the
    first offered tool with `{}` arguments. After a tool result the
    reply is plain text and the turn ends.

Test introspection (not part of the OpenAI surface):
  GET  /_test/requests   recorded requests (path, model, auth key suffix,
                         api fields) newest last
  POST /_test/reset      clear the record

Redirect SSRF fixture:
  ANY  /redirect/<status>/<port>/<rest>   answers <status> with Location
                         http://<same host>:<port>/canary/<rest>
"""

import json
import os
import re
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8090"))

# Marker the agent loop writes into the doc. Integration + flow tests
# assert on it to prove the BYOK round trip reached the document.
DOC_MARKER = "BYOK fake provider says hello."

TRANSCRIPT = "hello from the fake transcription provider"

MODELS = [
    "fake-chat",
    "no-tools-model",
    "obedient-chat",
    "fake-image",
    "fake-whisper",
]

# 1x1 transparent PNG.
PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

RECORDED = []

# Canned answer to `propose_design` (design import). Fields from the
# markoto theme vocabulary; tests assert on them.
DESIGN_PROPOSAL = {
    "theme": {
        "body": {"font": "Lato", "size": 11, "color": "#1C2733"},
        "headings": {"font": "PT Serif", "color": "#0B2545", "weight": "700"},
        "color": {"brand": "#F28C28", "secondary": "#6B7A89"},
        "footer": {"left": "{title}", "center": "", "right": "{page}"},
        "customCss": "h2 { border-bottom: 1.5pt solid #F28C28; }",
    },
    "name": "Fake navy report",
    "description": "PT Serif headings in navy, Lato text, orange rules.",
}

DIRECTIVE_RE = re.compile(r"FAKE_DIRECTIVE\s+([a-z_]+)\s+(\{[^\n]*\})")
MAX_OBEDIENT_TOOL_TURNS = 6


def _content_text(message):
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def _obedient_tool_call(messages, names):
    """Tool call for the "obedient-chat" model, or None to answer in text."""
    tool_messages = [m for m in messages if m.get("role") == "tool"]
    if not tool_messages:
        if "view_document" in names:
            return ("view_document", {})
        return (names[0], {}) if names else None
    if len(tool_messages) >= MAX_OBEDIENT_TOOL_TURNS:
        return None
    match = DIRECTIVE_RE.search(_content_text(tool_messages[-1]))
    if not match:
        return None
    try:
        args = json.loads(match.group(2))
    except ValueError:
        return None
    return (match.group(1), args)


def _image_count(messages):
    count = 0
    for m in messages:
        content = m.get("content")
        if isinstance(content, list):
            count += sum(1 for p in content if isinstance(p, dict) and p.get("type") == "image_url")
    return count


def _auth_key(headers):
    raw = headers.get("Authorization", "")
    if raw.lower().startswith("bearer "):
        return raw[7:].strip()
    return ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet by default
        if os.environ.get("FAKE_OPENAI_VERBOSE") == "1":
            super().log_message(fmt, *args)

    # helpers
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message, code):
        self._send_json(status, {"error": {"message": message, "type": "invalid_request_error", "code": code}})

    def _read_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        return self.rfile.read(length) if length > 0 else b""

    def _record(self, model, extra=None):
        key = _auth_key(self.headers)
        entry = {
            "path": self.path,
            "model": model,
            # Never echo a full key back — the suffix is enough for tests
            # to prove WHICH key reached the provider.
            "keySuffix": key[-6:] if key else "",
            "at": time.time(),
        }
        if extra:
            entry.update(extra)
        RECORDED.append(entry)
        del RECORDED[:-200]

    def _check_auth(self):
        key = _auth_key(self.headers)
        if not key:
            self._error(401, "Missing API key", "invalid_api_key")
            return False
        if key == "bad-key":
            self._error(401, "Incorrect API key provided", "invalid_api_key")
            return False
        return True

    # routes
    def do_GET(self):
        if self.path.startswith("/redirect/"):
            self._redirect()
            return
        if self.path == "/_test/requests":
            self._send_json(200, {"requests": RECORDED})
            return
        if self.path in ("/health", "/"):
            self._send_json(200, {"ok": True})
            return
        if self.path.rstrip("/") == "/v1/models":
            if not self._check_auth():
                return
            self._record("")
            self._send_json(200, {
                "object": "list",
                "data": [{"id": m, "object": "model", "owned_by": "fake"} for m in MODELS],
            })
            return
        self._error(404, "Not found", "not_found")

    def _redirect(self):
        """`/redirect/<status>/<port>/<rest>` → <status> to
        `http://<same host>:<port>/canary/<rest>`: a provider URL that
        bounces the proxy to another (internal) service. The redirect SSRF
        tests put a canary listener on <port> and assert it is never hit."""
        parts = self.path.split("/", 4)  # ['', 'redirect', status, port, rest]
        if len(parts) < 5 or not parts[2].isdigit() or not parts[3].isdigit():
            self._error(400, "Bad redirect path", "bad_redirect")
            return
        host = (self.headers.get("Host") or "127.0.0.1").rsplit(":", 1)[0]
        self._record("", {"redirect": parts[2]})
        self.send_response(int(parts[2]))
        self.send_header("Location", f"http://{host}:{parts[3]}/canary/{parts[4]}")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if self.path == "/_test/reset":
            RECORDED.clear()
            self._read_body()
            self._send_json(200, {"ok": True})
            return
        raw = self._read_body()
        if self.path.startswith("/redirect/"):
            self._redirect()
            return
        if self.path.startswith("/v1/chat/completions"):
            self._chat(raw)
        elif self.path.startswith("/v1/images/generations"):
            self._image(raw)
        elif self.path.startswith("/v1/audio/transcriptions"):
            self._transcription(raw)
        else:
            self._error(404, "Not found", "not_found")

    def _chat(self, raw):
        try:
            req = json.loads(raw or b"{}")
        except ValueError:
            self._error(400, "Invalid JSON", "invalid_json")
            return
        model = req.get("model", "")
        tools = req.get("tools") or []
        messages = req.get("messages") or []
        # Tool results the model was given (truncated) — lets tests prove
        # what content did or did not reach the "provider".
        tool_results = [_content_text(m)[:4000] for m in messages if m.get("role") == "tool"]
        self._record(model, {"tools": [t.get("function", {}).get("name") for t in tools], "toolResults": tool_results, "images": _image_count(messages)})
        if not self._check_auth():
            return
        if model == "missing-model":
            self._error(404, "The model `missing-model` does not exist", "model_not_found")
            return
        last_role = messages[-1].get("role") if messages else "user"

        tool_call = None
        names = [t.get("function", {}).get("name") for t in tools]
        if "propose_design" in names and model != "no-tools-model":
            proposal = dict(DESIGN_PROPOSAL)
            if any("<previous_proposal>" in _content_text(m) for m in messages):
                proposal["matches_original"] = True
            tool_call = ("propose_design", proposal)
        elif model == "obedient-chat":
            tool_call = _obedient_tool_call(messages, [t.get("function", {}).get("name") for t in tools])
        elif tools and model != "no-tools-model" and last_role != "tool":
            names = [t.get("function", {}).get("name") for t in tools]
            if "insert_text" in names:
                tool_call = ("insert_text", {"insert_line": 1, "insert_text": DOC_MARKER})
            else:
                tool_call = (names[0], {})

        usage = {"prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19}
        created = int(time.time())
        if tool_call:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": "call_fake_1",
                    "type": "function",
                    "function": {"name": tool_call[0], "arguments": json.dumps(tool_call[1])},
                }],
            }
            finish = "tool_calls"
        else:
            message = {"role": "assistant", "content": "Done."}
            finish = "stop"

        # Unique per response: LiteLLM keys its spend logs on this id, so a
        # constant id would collapse every call into one spend-log row.
        completion_id = f"chatcmpl-fake-{uuid.uuid4().hex}"
        if req.get("stream"):
            self._stream_chat(completion_id, model, message, finish, usage, created)
            return
        self._send_json(200, {
            "id": completion_id,
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": usage,
        })

    def _stream_chat(self, completion_id, model, message, finish, usage, created):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(delta, finish_reason=None, with_usage=False):
            chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
            }
            if with_usage:
                chunk["usage"] = usage
            self.wfile.write(b"data: " + json.dumps(chunk).encode("utf-8") + b"\n\n")

        if message.get("tool_calls"):
            call = message["tool_calls"][0]
            emit({"role": "assistant", "tool_calls": [{
                "index": 0, "id": call["id"], "type": "function",
                "function": {"name": call["function"]["name"], "arguments": ""},
            }]})
            emit({"tool_calls": [{"index": 0, "function": {"arguments": call["function"]["arguments"]}}]})
        else:
            emit({"role": "assistant", "content": message["content"]})
        emit({}, finish_reason=finish, with_usage=True)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True

    def _image(self, raw):
        try:
            req = json.loads(raw or b"{}")
        except ValueError:
            self._error(400, "Invalid JSON", "invalid_json")
            return
        model = req.get("model", "")
        self._record(model, {"size": req.get("size")})
        if not self._check_auth():
            return
        if model == "missing-model":
            self._error(404, "The model `missing-model` does not exist", "model_not_found")
            return
        self._send_json(200, {"created": int(time.time()), "data": [{"b64_json": PNG_1X1}]})

    def _transcription(self, raw):
        # Multipart parsing kept minimal: we only need the model field.
        model = ""
        marker = b'name="model"'
        idx = raw.find(marker)
        if idx >= 0:
            start = raw.find(b"\r\n\r\n", idx)
            end = raw.find(b"\r\n", start + 4)
            if start >= 0 and end > start:
                model = raw[start + 4:end].decode("utf-8", "replace")
        self._record(model, {"bytes": len(raw)})
        if not self._check_auth():
            return
        if model == "missing-model":
            self._error(404, "The model `missing-model` does not exist", "model_not_found")
            return
        self._send_json(200, {"text": TRANSCRIPT})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"fake-openai listening on :{PORT}", flush=True)
    server.serve_forever()
