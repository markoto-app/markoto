# postgres:18-alpine gives us a pg_dump that matches the server version in
# compose (and, being newer, can still dump an older managed server). We
# override ENTRYPOINT to skip the postgres init scripts and run our backup loop.
FROM postgres:18.7-alpine@sha256:b6972e1115a4ff8eba5d7f7d19184926d1e16d7d1136ae1e1a7ebf286da0f015

# gnupg: pipes the gzipped pg_dump through `gpg --symmetric --cipher-algo
# AES256` so the S3 object is opaque to anyone without BACKUP_GPG_PASSPHRASE
# (defends against leaked S3 keys / misconfigured bucket / malicious provider
# employee: the SSE-S3 layer alone doesn't cover those).
#
# `apk upgrade` first: the base image is pinned by digest and trails Alpine's
# security fixes (krb5, expat, libxslt), which the image scan gates on.
# hadolint ignore=DL3017
RUN apk upgrade --no-cache && apk add --no-cache aws-cli gnupg

# `gosu` only serves the upstream postgres entrypoint, which we replace
# (ENTRYPOINT [] below): it never runs here. The upstream image ships it
# built with an old Go toolchain that carries fixable CRITICAL/HIGH stdlib
# CVEs, so drop the dead binary instead of shipping it.
RUN rm -f /usr/local/bin/gosu

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Run unprivileged. The base image's `postgres` user (uid 70) is enough for
# pg_dump / psql / aws / gpg; backup.sh keeps HOME and the gpg home under /tmp.
# Where Postgres TLS pins a CA (PGSSLROOTCERT) that file must be readable by
# uid 70: see roles/markoto (CA file mode) and the operator runbook, kept outside this repository.
ENV HOME=/tmp
USER postgres

ENTRYPOINT []
CMD ["/usr/local/bin/backup.sh"]
