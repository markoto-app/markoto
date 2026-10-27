# postgres:16-alpine gives us a pg_dump that exactly matches the server version
# in compose. We override ENTRYPOINT to skip the postgres init scripts and run
# our backup loop instead.
FROM postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab

# gnupg: pipes the gzipped pg_dump through `gpg --symmetric --cipher-algo
# AES256` so the S3 object is opaque to anyone without BACKUP_GPG_PASSPHRASE
# (defends against leaked S3 keys / misconfigured bucket / malicious provider
# employee — the SSE-S3 layer alone doesn't cover those).
RUN apk add --no-cache aws-cli gnupg

# `gosu` only serves the upstream postgres entrypoint, which we replace
# (ENTRYPOINT [] below) — it never runs here. The upstream image ships it
# built with an old Go toolchain that carries fixable CRITICAL/HIGH stdlib
# CVEs, so drop the dead binary instead of shipping it.
RUN rm -f /usr/local/bin/gosu

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Run unprivileged. The base image's `postgres` user (uid 70) is enough for
# pg_dump / psql / aws / gpg; backup.sh keeps HOME and the gpg home under /tmp.
# Where Postgres TLS pins a CA (PGSSLROOTCERT) that file must be readable by
# uid 70 — see roles/markoto (CA file mode) and docs/LAUNCH-CHECKLIST.md.
ENV HOME=/tmp
USER postgres

ENTRYPOINT []
CMD ["/usr/local/bin/backup.sh"]
