# Pinned to a digest rather than :latest so pandoc/TeX/font versions are
# reproducible — an ingestion or export bug won't change under us on the next
# `docker compose pull`. To bump: `docker pull pandoc/extra:latest`, read the
# new digest from `docker image inspect`, update this line, and confirm a PDF
# export smoke-renders end-to-end.
FROM pandoc/extra@sha256:dfae5cf73a0e0ad40acf23d2d2c4adf5715e560aeea3324aa87e68faaa2e70c9

# python3 is already in the base image — no need to apk-add it.
# Create an unprivileged user so the HTTP server and any pandoc subprocess
# don't run as root. addgroup/adduser are busybox-provided on Alpine.
RUN addgroup -S -g 1000 pandoc \
  && adduser -S -u 1000 -G pandoc -h /home/pandoc pandoc

COPY --chown=pandoc:pandoc server.py /server.py

USER pandoc
EXPOSE 8080

# /health is implemented in server.py (GET /health → 200 "ok"). No auth, no
# pandoc invocation — cheap probe that proves the HTTP loop is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=3 http://127.0.0.1:8080/health || exit 1

ENTRYPOINT []
CMD ["python3", "/server.py"]
