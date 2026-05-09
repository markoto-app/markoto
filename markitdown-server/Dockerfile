# Slim Python image — markitdown[all] pulls in pdf/docx/pptx/xlsx/xls
# converters that are pure-Python or ship manylinux wheels, so no apt-get
# of system libs is needed for the build. Compare against the prior
# pandoc/extra image (~3 GB with TeXLive + fonts) — markitdown lands at
# ~250 MB, faster cold start, fewer CVEs to track.
#
# Pin to a python:3.13 digest so the base layer is reproducible. To bump:
# `docker pull python:3.13-slim`, read the digest, update below, rebuild,
# verify a docx + pdf import smoke-converts end-to-end via /api/import.
FROM python:3.13-slim@sha256:d168b8d9eb761f4d3fe305ebd04aeb7e7f2de0297cec5fb2f8f6403244621664

# Unprivileged user — markitdown only ever reads from a BytesIO so it
# doesn't need filesystem write, but defense in depth is cheap.
RUN groupadd -r app -g 1000 && useradd -r -u 1000 -g app -m -d /home/app app

WORKDIR /app

# Pinned versions for reproducibility. markitdown's API stabilized around
# 0.1 — `convert_stream(stream, stream_info=...)` and `result.markdown`
# both date from there. Bump together with a smoke test.
# `--only-binary=:all:` forces wheels — blocks setup.py / pyproject build
# script execution from a compromised sdist (docker:S8541). markitdown's
# transitive deps all ship manylinux wheels for python:3.13.
# `--chown=root:root --chmod=755` makes server.py immutable to the
# runtime `app` user (docker:S6504).
RUN pip install --no-cache-dir --only-binary=:all: \
    'markitdown[all]==0.1.5' \
    'fastapi==0.136.0' \
    'uvicorn[standard]==0.44.0'

COPY --chown=root:root --chmod=755 server.py /app/server.py

USER app
EXPOSE 8080

# /health is in server.py — cheap probe (no markitdown invocation) so the
# healthcheck can prove the HTTP loop is alive without spending a worker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=3 http://127.0.0.1:8080/health || exit 1

# 2 workers gives a small amount of concurrency without piling up RAM —
# imports are short-lived (most under 5 s) and the rate limit upstream
# is 10/min/IP so we don't need a wide pool.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]
