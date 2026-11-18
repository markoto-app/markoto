"""
HTTP wrapper around Microsoft markitdown for file → markdown conversion.

Replaces the prior pandoc/extra container. Markitdown ships pure-Python
converters for the common office formats (docx, pdf, pptx, xlsx, html,
epub, …) and is a fraction of the image size, no TeX, no fonts, no
shell-out to pandoc subprocess. The import endpoint
only converts TO markdown (export is client-side via paged.js), so we
don't need pandoc's wide output coverage.

Endpoints:
  POST /convert?ext={extension}
    Body:    raw file bytes (Content-Type ignored, we trust the ext hint
             passed by the caller, since markitdown's converter routing
             is extension-driven and our /api/import already validates
             the upload's filename extension)
    Returns: text/markdown

  GET /health
    Returns: 200 "ok": used by the Docker / compose healthcheck

Authentication: every endpoint except /health needs the
X-Markitdown-Secret header to equal MARKITDOWN_API_SECRET (the app's
NUXT_MARKITDOWN_API_SECRET). The service is also only reachable from the
app's network; the secret keeps any other container that ends up on that
network from feeding it files. The service refuses to start without it.

Resource guards (anonymous users can reach /convert through /api/import):
  - Archive pre-flight: zip-based formats (docx/pptx/xlsx/epub/odt/…, and
    anything that starts with the zip magic) are inspected before any
    converter sees them. Too many entries, too much uncompressed data
    (measured by actually inflating, not by trusting the headers) or an
    extreme compression ratio → 413, as soon as the running total crosses
    the limit (a bomb costs ~ratio x upload size of work, not 200 MB). A 300 KB DOCX that inflates to
    300 MB used to OOM-kill the worker.
  - Isolation: each conversion runs in a forked child process with an
    address-space limit and a wall-clock timeout. A converter that blows
    up only kills its own child (→ 413 / 504), never the worker serving
    other users.
  - One conversion at a time per worker, so the memory budget holds.
"""

import asyncio
import contextlib
import hashlib
import hmac
import io
import multiprocessing
import os
import resource
import threading
import time
import zipfile
import zlib

import design_extract
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from markitdown import MarkItDown, StreamInfo
from markitdown._exceptions import MissingDependencyException, UnsupportedFormatException

# Matches the cap in server/api/import.post.ts. Defense in depth: Nuxt
# already rejects oversize bodies before they reach us, but the FastAPI
# layer is the last line if someone calls this service directly inside
# the docker network.
MAX_SIZE = 50 * 1024 * 1024  # 50 MB


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
        return value if value > 0 else default
    except ValueError:
        return default


# Archive limits. Real office documents stay far below these: a 300-page
# DOCX with images inflates to a few tens of MB and has < 1000 entries.
MAX_ARCHIVE_UNCOMPRESSED_BYTES = _env_int("MARKITDOWN_MAX_UNCOMPRESSED_MB", 200) * 1024 * 1024
MAX_ARCHIVE_ENTRIES = _env_int("MARKITDOWN_MAX_ARCHIVE_ENTRIES", 10_000)
MAX_ARCHIVE_RATIO = _env_int("MARKITDOWN_MAX_COMPRESSION_RATIO", 100)
# Ratios are only meaningful once there is something to expand: tiny
# archives (a few KB of XML compress very well) are always fine.
RATIO_FLOOR_BYTES = 10 * 1024 * 1024
# Wall-clock budget for the inflate pass. The ratio check keeps the work
# bounded by the upload size; this guarantees a deterministic 504 (never a
# silent hang) if the host is too starved to finish it.
ARCHIVE_CHECK_TIMEOUT_SECONDS = _env_int("MARKITDOWN_ARCHIVE_CHECK_TIMEOUT_SECONDS", 20)

# Per-conversion child limits.
CONVERT_TIMEOUT_SECONDS = _env_int("MARKITDOWN_TIMEOUT_SECONDS", 60)
CHILD_MEMORY_BYTES = _env_int("MARKITDOWN_CHILD_MEMORY_MB", 384) * 1024 * 1024

ZIP_EXTENSIONS = {
    "docx",
    "docm",
    "dotx",
    "pptx",
    "pptm",
    "xlsx",
    "xlsm",
    "epub",
    "odt",
    "ods",
    "odp",
    "zip",
}
ZIP_MAGIC = b"PK\x03\x04"
_INFLATE_CHUNK = 64 * 1024

# MarkItDown is stateless and converter-routing is per-call. Building
# once at module load avoids repeating the optional-converter discovery
# on every request; forked children inherit the instance.
md = MarkItDown()

# One child at a time per worker process (2 uvicorn workers → at most 2
# children), so the memory budget is predictable.
_convert_slot = threading.Semaphore(1)
_fork = multiprocessing.get_context("fork")

SECRET_HEADER = "x-markitdown-secret"  # noqa: S105 -- a header name, not a secret
UNAUTHENTICATED_PATHS = {"/health"}


def configured_secret() -> str:
    return os.environ.get("MARKITDOWN_API_SECRET", "").strip()


def secret_matches(provided: str | None, expected: str) -> bool:
    """Constant-time comparison; an empty secret on either side never matches."""
    if not provided or not expected:
        return False
    return hmac.compare_digest(
        hashlib.sha256(provided.encode("utf-8")).digest(),
        hashlib.sha256(expected.encode("utf-8")).digest(),
    )


@contextlib.asynccontextmanager
async def lifespan(_app):
    # Fail loudly at boot: a converter without a secret would either be
    # open to every container on its network or reject every import.
    if not configured_secret():
        raise RuntimeError("MARKITDOWN_API_SECRET environment variable is required")
    yield


# disable docs/redoc: not a public API.
app = FastAPI(title="markitdown-server", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.middleware("http")
async def require_secret(request: Request, call_next):
    # Runs before the route reads the body, so an unauthenticated caller
    # can't make us buffer or parse anything.
    if request.url.path not in UNAUTHENTICATED_PATHS and not secret_matches(
        request.headers.get(SECRET_HEADER), configured_secret()
    ):
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)


class ArchiveRejected(Exception):
    """The archive exceeds a limit. `inflated` = bytes inflated before giving up."""

    def __init__(self, message: str, inflated: int = 0):
        super().__init__(message)
        self.inflated = inflated


class ArchiveCheckTimeout(Exception):
    pass


def archive_inflate_limit(body_length: int) -> int:
    """How many bytes the archive may inflate to before it is refused.

    The ratio allowance (never below the floor, so tiny archives are
    always fine) capped by the absolute limit. Enforced WHILE inflating,
    so a bomb is refused after ~ratio x upload size of work instead of
    after inflating everything up to the absolute cap.
    """
    return min(
        MAX_ARCHIVE_UNCOMPRESSED_BYTES,
        max(RATIO_FLOOR_BYTES, MAX_ARCHIVE_RATIO * max(body_length, 1)),
    )


def check_archive(body: bytes, time_budget: float = ARCHIVE_CHECK_TIMEOUT_SECONDS) -> int:
    """Return the inflated byte count; raise ArchiveRejected when a zip container would expand too far.

    Header sizes are attacker-controlled, so after the cheap header check
    every entry is inflated (in bounded chunks, output discarded) and the
    real byte count is enforced against the ratio / absolute limit as it
    grows. ArchiveCheckTimeout when inspection outlives `time_budget`.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(body))
    except zipfile.BadZipFile:
        # Not a readable zip: let the converter produce its usual error.
        return 0
    deadline = time.monotonic() + time_budget
    limit = archive_inflate_limit(len(body))
    with archive:
        entries = archive.infolist()
        if len(entries) > MAX_ARCHIVE_ENTRIES:
            raise ArchiveRejected(
                f"archive has {len(entries)} entries (limit {MAX_ARCHIVE_ENTRIES})"
            )
        declared = sum(e.file_size for e in entries)
        if declared > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
            raise ArchiveRejected("archive expands beyond the size limit")
        total = 0
        for entry in entries:
            if entry.is_dir():
                continue
            try:
                with archive.open(entry) as stream:
                    while True:
                        chunk = stream.read(_INFLATE_CHUNK)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > limit:
                            reason = (
                                "archive expands beyond the size limit"
                                if limit >= MAX_ARCHIVE_UNCOMPRESSED_BYTES
                                else "archive compression ratio is too high"
                            )
                            raise ArchiveRejected(f"{reason} (stopped after {total} bytes)", total)
                        if time.monotonic() > deadline:
                            raise ArchiveCheckTimeout()
            except ArchiveRejected, ArchiveCheckTimeout:
                raise
            except (
                zipfile.BadZipFile,
                RuntimeError,
                NotImplementedError,
                EOFError,
                OSError,
                zlib.error,
            ):
                # Corrupt (bad CRC, truncated, bad deflate stream), encrypted
                # (RuntimeError) or unsupported-compression (NotImplementedError)
                # entry: the converter reports it; we only care about expansion here.
                continue
    return total


def _cap_child_memory() -> None:
    _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    limit = _current_vm_bytes() + CHILD_MEMORY_BYTES
    if hard != resource.RLIM_INFINITY:
        limit = min(limit, hard)
    resource.setrlimit(resource.RLIMIT_AS, (limit, hard))


def _child_design(conn, body: bytes, ext: str, pages: int) -> None:
    """Runs in the forked child: cap memory, extract the design facts, send the outcome."""
    try:
        _cap_child_memory()
        conn.send(("ok", design_extract.extract_design(body, ext, pages)))
    except MemoryError:
        conn.send(("memory", ""))
    except design_extract.ExtractError as e:
        conn.send(("failed", str(e)[:200]))
    except Exception as e:
        message = str(e)
        conn.send(
            ("memory", "") if "MemoryError" in message else ("failed", "could not read the file")
        )
    finally:
        conn.close()


def _child_convert(conn, body: bytes, ext: str, keep_images: bool = False) -> None:
    """Runs in the forked child: cap memory, convert, send the outcome."""
    try:
        _cap_child_memory()
        stream_info = StreamInfo(extension=f".{ext}", filename=f"input.{ext}")
        # keep_data_uris: embedded pictures (DOCX, PPTX, EPUB, HTML) stay as
        # data: URIs, which the app stores as the document's images. Without
        # it markitdown cuts them to a placeholder.
        result = md.convert_stream(
            io.BytesIO(body), stream_info=stream_info, keep_data_uris=keep_images
        )
        conn.send(("ok", result.markdown))
    except MemoryError:
        conn.send(("memory", ""))
    except UnsupportedFormatException as e:
        conn.send(("unsupported", str(e)[:200]))
    except MissingDependencyException as e:
        conn.send(("dependency", str(e)[:200]))
    except Exception as e:  # every other converter error maps to 422
        # markitdown wraps converter exceptions (incl. a MemoryError from
        # the address-space cap) into its own FileConversionException.
        message = str(e)
        conn.send(("memory", "") if "MemoryError" in message else ("failed", message[:500]))
    finally:
        conn.close()


def _current_vm_bytes() -> int:
    """Virtual size of this process (the child inherits the parent's)."""
    try:
        with open("/proc/self/status", encoding="ascii") as status:
            for line in status:
                if line.startswith("VmSize:"):
                    return int(line.split()[1]) * 1024
    except OSError:
        pass
    return 0


def convert_isolated(body: bytes, ext: str, keep_images: bool = False) -> tuple[str, str]:
    """Convert in a child process. Returns (outcome, payload)."""
    return run_isolated(_child_convert, body, ext, keep_images)


def run_isolated(target, *args):
    """Run `target(conn, *args)` in a memory-capped child. Returns its (outcome, payload)."""
    with _convert_slot:
        parent_conn, child_conn = _fork.Pipe(duplex=False)
        child = _fork.Process(target=target, args=(child_conn, *args), daemon=True)
        child.start()
        child_conn.close()
        try:
            if parent_conn.poll(CONVERT_TIMEOUT_SECONDS):
                try:
                    return parent_conn.recv()
                except EOFError:
                    # Child died without answering (killed by the kernel /
                    # crashed in native code while over the memory cap).
                    return ("memory", "")
            return ("timeout", "")
        finally:
            parent_conn.close()
            if child.is_alive():
                child.kill()
            child.join(5)


@app.get("/health")
def health() -> PlainTextResponse:
    return PlainTextResponse("ok")


@app.post(
    "/convert",
    responses={
        400: {"description": "Empty body or missing 'ext' query param"},
        413: {
            "description": "Request body exceeds the size cap, or the archive / conversion exceeds the resource limits"
        },
        415: {"description": "Markitdown does not support the requested format"},
        422: {"description": "Conversion failed (corrupt file, malformed input, etc.)"},
        501: {"description": "Format requires an optional dependency that isn't installed"},
        504: {"description": "Archive inspection or conversion took longer than the time limit"},
    },
)
async def convert(request: Request) -> PlainTextResponse:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_SIZE:
        raise HTTPException(413, "File too large")
    body = await request.body()
    if not body:
        raise HTTPException(400, "Empty body")
    if len(body) > MAX_SIZE:
        raise HTTPException(413, "File too large")

    raw_ext = request.query_params.get("ext", "").strip().lower().lstrip(".")
    if not raw_ext:
        raise HTTPException(400, "Missing 'ext' query parameter")

    if raw_ext in ZIP_EXTENSIONS or body.startswith(ZIP_MAGIC):
        try:
            await asyncio.to_thread(check_archive, body)
        except ArchiveRejected as e:
            raise HTTPException(413, f"Archive rejected: {e}") from e
        except ArchiveCheckTimeout as e:
            raise HTTPException(504, "Archive inspection took too long") from e

    # Markitdown reads StreamInfo to route to the right converter: extension
    # alone is enough for the formats we accept; mimetype is left to the
    # converter to sniff if needed.
    keep_images = request.query_params.get("images", "") == "1"
    outcome, payload = await asyncio.to_thread(convert_isolated, body, raw_ext, keep_images)
    if outcome == "ok":
        return PlainTextResponse(payload, media_type="text/markdown; charset=utf-8")
    if outcome == "memory":
        raise HTTPException(413, "Conversion exceeded the memory limit")
    if outcome == "timeout":
        raise HTTPException(504, "Conversion took too long")
    if outcome == "unsupported":
        raise HTTPException(415, f"Unsupported format: {payload}")
    if outcome == "dependency":
        raise HTTPException(501, f"Format requires extra dependency: {payload}")
    # Catch-all so a converter raising e.g. PdfReadError doesn't 500 the
    # whole service. Bounded: converters love to dump full stack traces
    # in their messages.
    raise HTTPException(422, f"Conversion failed: {payload}")


DESIGN_EXTENSIONS = {"pdf", "docx"}


@app.post(
    "/design/extract",
    responses={
        400: {"description": "Empty body, or 'ext' is not pdf / docx"},
        413: {
            "description": "Body too large, or the archive / extraction exceeds the resource limits"
        },
        422: {"description": "The file can't be read as the claimed format"},
        504: {"description": "Archive inspection or extraction took longer than the time limit"},
    },
)
async def design_extract_endpoint(request: Request) -> JSONResponse:
    """Design facts (styles, page pictures) for "Create a design from a document". See design_extract.py."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_SIZE:
        raise HTTPException(413, "File too large")
    body = await request.body()
    if not body:
        raise HTTPException(400, "Empty body")
    if len(body) > MAX_SIZE:
        raise HTTPException(413, "File too large")
    ext = request.query_params.get("ext", "").strip().lower().lstrip(".")
    if ext not in DESIGN_EXTENSIONS:
        raise HTTPException(400, "ext must be pdf or docx")
    try:
        pages = int(request.query_params.get("pages", str(design_extract.MAX_PAGES)))
    except ValueError as e:
        raise HTTPException(400, "pages must be a number") from e

    if ext == "docx" or body.startswith(ZIP_MAGIC):
        try:
            await asyncio.to_thread(check_archive, body)
        except ArchiveRejected as e:
            raise HTTPException(413, f"Archive rejected: {e}") from e
        except ArchiveCheckTimeout as e:
            raise HTTPException(504, "Archive inspection took too long") from e

    outcome, payload = await asyncio.to_thread(run_isolated, _child_design, body, ext, pages)
    if outcome == "ok":
        return JSONResponse(payload)
    if outcome == "memory":
        raise HTTPException(413, "Extraction exceeded the memory limit")
    if outcome == "timeout":
        raise HTTPException(504, "Extraction took too long")
    raise HTTPException(422, f"Extraction failed: {payload}")
