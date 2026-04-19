"""
HTTP wrapper around Microsoft markitdown for file → markdown conversion.

Replaces the prior pandoc/extra container. Markitdown ships pure-Python
converters for the common office formats (docx, pdf, pptx, xlsx, html,
epub, …) and is a fraction of the image size — no TeX, no fonts, no
shell-out to pandoc subprocess. Per AGENTS.md §16, the import endpoint
only converts TO markdown (export is client-side via paged.js), so we
don't need pandoc's wide output coverage.

Endpoints:
  POST /convert?ext={extension}
    Body:    raw file bytes (Content-Type ignored — we trust the ext hint
             passed by the caller, since markitdown's converter routing
             is extension-driven and our /api/import already validates
             the upload's filename extension)
    Returns: text/markdown

  GET /health
    Returns: 200 "ok" — used by Docker HEALTHCHECK and Traefik
"""

import io
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import PlainTextResponse
from markitdown import MarkItDown, StreamInfo
from markitdown._exceptions import (
    UnsupportedFormatException,
    MissingDependencyException
)

# Matches the cap in server/api/import.post.ts. Defense in depth — Nuxt
# already rejects oversize bodies before they reach us, but the FastAPI
# layer is the last line if someone calls this service directly inside
# the docker network.
MAX_SIZE = 50 * 1024 * 1024  # 50 MB

# MarkItDown is stateless and converter-routing is per-call. Building
# once at module load avoids repeating the optional-converter discovery
# on every request.
md = MarkItDown()

# disable docs/redoc — not a public API.
app = FastAPI(title="markitdown-server", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> PlainTextResponse:
    return PlainTextResponse("ok")


@app.post("/convert")
async def convert(request: Request) -> PlainTextResponse:
    body = await request.body()
    if not body:
        raise HTTPException(400, "Empty body")
    if len(body) > MAX_SIZE:
        raise HTTPException(413, "File too large")

    raw_ext = request.query_params.get("ext", "").strip().lower().lstrip(".")
    if not raw_ext:
        raise HTTPException(400, "Missing 'ext' query parameter")

    # Markitdown reads StreamInfo to route to the right converter — extension
    # alone is enough for the formats we accept; mimetype is left to the
    # converter to sniff if needed.
    stream_info = StreamInfo(
        extension=f".{raw_ext}",
        filename=f"input.{raw_ext}"
    )

    try:
        result = md.convert_stream(io.BytesIO(body), stream_info=stream_info)
    except UnsupportedFormatException as e:
        raise HTTPException(415, f"Unsupported format: {str(e)[:200]}")
    except MissingDependencyException as e:
        raise HTTPException(501, f"Format requires extra dependency: {str(e)[:200]}")
    except Exception as e:
        # Catch-all so a converter raising e.g. PdfReadError doesn't 500
        # the whole service. Slice to keep the error message bounded —
        # converters love to dump full stack traces in their messages.
        raise HTTPException(422, f"Conversion failed: {str(e)[:500]}")

    return PlainTextResponse(result.markdown, media_type="text/markdown; charset=utf-8")
