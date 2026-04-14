# postgres:16-alpine gives us a pg_dump that exactly matches the server version
# in compose. We override ENTRYPOINT to skip the postgres init scripts and run
# our backup loop instead.
FROM postgres:16-alpine@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416

RUN apk add --no-cache aws-cli

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

ENTRYPOINT []
CMD ["/usr/local/bin/backup.sh"]
