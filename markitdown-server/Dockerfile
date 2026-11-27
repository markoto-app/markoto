# Slim Python image: markitdown[all] pulls in pdf/docx/pptx/xlsx/xls
# converters that are pure-Python or ship manylinux wheels, so no apt-get
# of system libs is needed for the build. Compare against the prior
# pandoc/extra image (~3 GB with TeXLive + fonts): markitdown lands at
# ~250 MB, faster cold start, fewer CVEs to track.
#
# Pinned to python:3.14-slim by tag + digest so the base layer is reproducible.
# To bump: resolve the new tag's multi-arch index digest, update below, rebuild,
# run the Python unit tests in the image (ci.yml) and verify a docx + pdf import
# smoke-converts end-to-end via /api/import.
FROM python:3.14.10-slim@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f

# Debian security fixes that landed after the base image was built (the
# CI image scan flags fixable HIGH CVEs in base packages such as zlib1g).
RUN apt-get update \
 && apt-get -y --no-install-recommends upgrade \
 && rm -rf /var/lib/apt/lists/*

# Unprivileged user: markitdown only ever reads from a BytesIO so it
# doesn't need filesystem write, but defense in depth is cheap.
RUN groupadd -r app -g 1000 && useradd -r -u 1000 -g app -m -d /home/app app

WORKDIR /app

# Pinned versions for reproducibility. markitdown's API stabilized around
# 0.1: `convert_stream(stream, stream_info=...)` and `result.markdown`
# both date from there. Bump together with a smoke test.
# `--only-binary=:all:` forces wheels: blocks setup.py / pyproject build
# script execution from a compromised sdist (docker:S8541). markitdown's
# transitive deps all ship manylinux wheels for python:3.14.
# `--chown=root:root --chmod=755` makes server.py immutable to the
# runtime `app` user (docker:S6504).
# pip is removed once the deps are in: nothing at runtime installs
# packages, and pip (plus the ensurepip wheel bundled with the base
# image) vendors urllib3/msgpack/setuptools copies carrying fixable HIGH
# CVEs that the CI image scan flags even though they never execute here.
# lxml stays below 6.2: with lxml 6.2.0 every DOCX fails ("Could not find
# the body element"), checked against tests/repos/importWorker.test.ts.
# Lift the cap once a newer lxml (or mammoth) converts DOCX again.
RUN pip install --no-cache-dir --only-binary=:all: \
    'fastapi==0.162.0' \
    'markitdown[all]==0.1.9' \
    'lxml==6.1.3' \
    'uvicorn[standard]==0.54.0' \
 && pip uninstall -y pip \
 && rm -rf /usr/local/lib/python3.14/ensurepip/_bundled

COPY --chown=root:root --chmod=755 server.py design_extract.py /app/

USER app
EXPOSE 8080

# /health is in server.py: cheap probe (no markitdown invocation) so the
# healthcheck can prove the HTTP loop is alive without spending a worker.
# Uses python3 (always present): the slim base has no wget or curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3).status==200 else 1)" || exit 1

# 2 workers gives a small amount of concurrency without piling up RAM,
# imports are short-lived (most under 5 s) and the rate limit upstream
# is 10/min/IP so we don't need a wide pool.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]
