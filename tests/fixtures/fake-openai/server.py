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
  - Otherwise, when tools are offered and the last message is NOT a tool
    result, the reply is a tool call: `insert_text` (when offered, so
    the markoto agent loop writes a marker line into the doc), else the
    first offered tool with `{}` arguments. After a tool result the
    reply is plain text and the turn ends.

Test introspection (not part of the OpenAI surface):
  GET  /_test/requests   recorded requests (path, model, auth key suffix,
                         api fields) newest last
  POST /_test/reset      clear the record
"""

import json
import os
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
    "fake-image",
    "fake-whisper",
]

# 1x1 transparent PNG.
PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

RECORDED = []


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

    # ── helpers ──────────────────────────────────────────────────────
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

    # ── routes ───────────────────────────────────────────────────────
    def do_GET(self):
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

    def do_POST(self):
        if self.path == "/_test/reset":
            RECORDED.clear()
            self._read_body()
            self._send_json(200, {"ok": True})
            return
        raw = self._read_body()
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
        self._record(model, {"tools": [t.get("function", {}).get("name") for t in tools]})
        if not self._check_auth():
            return
        if model == "missing-model":
            self._error(404, "The model `missing-model` does not exist", "model_not_found")
            return
        messages = req.get("messages") or []
        last_role = messages[-1].get("role") if messages else "user"

        tool_call = None
        if tools and model != "no-tools-model" and last_role != "tool":
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
