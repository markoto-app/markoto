# Slim Python image — markitdown[all] pulls in pdf/docx/pptx/xlsx/xls
# converters that are pure-Python or ship manylinux wheels, so no apt-get
# of system libs is needed for the build. Compare against the prior
# pandoc/extra image (~3 GB with TeXLive + fonts) — markitdown lands at
# ~250 MB, faster cold start, fewer CVEs to track.
#
# Pin to a python:3.13 digest so the base layer is reproducible. To bump:
# `docker pull python:3.13-slim`, read the digest, update below, rebuild,
# verify a docx + pdf import smoke-converts end-to-end via /api/import.
# Pinned digest corresponds to python:3.13-slim at the time of bump.
FROM python@sha256:d98cc29d3266e535dd9da1099688d9cb3ca4753813571e071763d17725460962

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
# pip is removed once the deps are in: nothing at runtime installs
# packages, and pip (plus the ensurepip wheel bundled with the base
# image) vendors urllib3/msgpack/setuptools copies carrying fixable HIGH
# CVEs that the CI image scan flags even though they never execute here.
RUN pip install --no-cache-dir --only-binary=:all: \
    'fastapi==0.162.0' \
    'markitdown[all]==0.1.9' \
    'uvicorn[standard]==0.54.0' \
 && pip uninstall -y pip \
 && rm -rf /usr/local/lib/python3.13/ensurepip/_bundled

COPY --chown=root:root --chmod=755 server.py /app/server.py

USER app
EXPOSE 8080

# /health is in server.py — cheap probe (no markitdown invocation) so the
# healthcheck can prove the HTTP loop is alive without spending a worker.
# Use python3 (always present in this image) — the slim base has no wget/curl,
# so the previous wget-based check reported "unhealthy" even though the
# service was answering /health fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3).status==200 else 1)" || exit 1

# 2 workers gives a small amount of concurrency without piling up RAM —
# imports are short-lived (most under 5 s) and the rate limit upstream
# is 10/min/IP so we don't need a wide pool.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]
