#!/usr/bin/env bash
# `docker compose` for the test stack (docker-compose.test.yml), on Docker
# or rootless Podman. Arguments pass through:
#
#   scripts/test-compose.sh up -d --wait
#   scripts/test-compose.sh --profile flows down -v
#
# On Podman it adds docker-compose.test.podman.yml (renderer seccomp, see
# that file) and checks that TEST_FAKE_OPENAI_HOST is set: rootless Podman
# has no host-side bridge gateway to publish the fake AI provider on.
# Override detection with TEST_CONTAINER_ENGINE=docker|podman.
# See docs/contributing/CONTAINER-ENGINES.md.
set -euo pipefail
cd "$(dirname "$0")/.."

engine="${TEST_CONTAINER_ENGINE:-}"
if [ -z "$engine" ]; then
  # Podman's Docker-compatible API names itself as a server component.
  components=$(docker version --format '{{range .Server.Components}}{{.Name}};{{end}}' 2>/dev/null || true)
  case "$components" in *[Pp]odman*) engine=podman ;; *) engine=docker ;; esac
fi

files=(-f docker-compose.test.yml)
if [ "$engine" = podman ]; then
  files+=(-f docker-compose.test.podman.yml)
  if [ -z "${TEST_FAKE_OPENAI_HOST:-}" ]; then
    # Suggest the first private IPv4 address of a physical network card.
    suggestion=""
    for dev in /sys/class/net/*; do
      [ -e "$dev/device" ] || continue
      addr=$(ip -4 -o addr show dev "$(basename "$dev")" scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)
      case "$addr" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) suggestion="$addr"; break ;; esac
    done
    echo "test-compose: Podman detected, but TEST_FAKE_OPENAI_HOST is not set." >&2
    echo "  Set it (in .env) to a private address of this machine${suggestion:+, e.g. TEST_FAKE_OPENAI_HOST=$suggestion}." >&2
    echo "  See docs/contributing/CONTAINER-ENGINES.md." >&2
    exit 2
  fi
fi

exec docker compose "${files[@]}" "$@"
