#!/bin/sh
# Make every running container see the environment the stack renders now.
#
# `compose up -d` recreates a container when its configuration hash (which
# covers the interpolated `environment:`) differs from the one stamped on
# it. This script does not trust that diff alone: after `up -d` it compares
# what each running container actually has (`inspect .Config.Env`) with what
# `compose config` renders from the current .env, and force-recreates only
# the services whose environment differs. A rotated secret (a changed
# GitHub Environment secret, a hand-edited .env) is therefore live after the
# next deploy, and every other container keeps running.
#
# Values are never printed: a drifted service is reported with the names of
# the variables that differ.
#
# Usage: env-converge.sh          check and recreate drifted services
#        env-converge.sh check    report only; exit 4 when a service drifted
#
# Env:
#   COMPOSE  the compose command for this stack, word-split by `eval`
#            (default: docker compose). E.g. markoto-compose on the hosted
#            stack.
#   ENGINE   docker | podman, used for `inspect` (default: docker when
#            present, else podman).
#
# Needs jq. Without it the script says so and exits 0 (the hosted base role
# installs it; a self-host without jq keeps relying on `up -d` alone).
set -eu
# deploy.yml feeds its remote script over stdin: never read it.
exec < /dev/null

MODE="${1:-converge}"
if [ -z "${ENGINE:-}" ]; then
  if command -v docker > /dev/null 2>&1; then ENGINE=docker; else ENGINE=podman; fi
fi

log() { printf '[env-converge] %s\n' "$*"; }
die() { printf '[env-converge] error: %s\n' "$*" >&2; exit 1; }
compose() { (eval "${COMPOSE:-docker compose}" '"$@"'); }

if ! command -v jq > /dev/null 2>&1; then
  log "jq not found: skipping the environment check"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
chmod 700 "$tmp"

# drifted_services: prints "<service> <VAR> <VAR>..." for every running
# container whose environment lacks one of the rendered NAME=value pairs.
drifted_services() {
  compose config --format json > "$tmp/config.json" || die "compose config failed"
  for svc in $(jq -r '.services | keys[]' "$tmp/config.json"); do
    # Running containers only: one-shots (db-init) and stopped services are
    # created fresh by the next `up`.
    for cid in $(compose ps -q "$svc" 2> /dev/null); do
      "$ENGINE" inspect --format '{{json .Config.Env}}' "$cid" > "$tmp/env.json" 2> /dev/null || continue
      vars="$(jq -r --arg svc "$svc" --slurpfile have "$tmp/env.json" '
        ($have[0] // []) as $env
        | (.services[$svc].environment // {})
        | to_entries
        | map(select(.value != null))
        # `compose config` re-escapes a literal $ as $$; the container got $.
        | map(select("\(.key)=\(.value | gsub("\\$\\$"; "$"))" as $kv | $env | any(. == $kv) | not))
        | map(.key) | join(" ")
      ' "$tmp/config.json")"
      if [ -n "$vars" ]; then
        printf '%s %s\n' "$svc" "$vars"
        break
      fi
    done
  done
}

drift="$(drifted_services)"
if [ -z "$drift" ]; then
  log "every running container has the rendered environment"
  exit 0
fi
printf '%s\n' "$drift" | while read -r svc vars; do
  log "$svc: environment differs from the rendered one ($vars)"
done
[ "$MODE" = check ] && exit 4

services="$(printf '%s\n' "$drift" | cut -d' ' -f1 | tr '\n' ' ')"
log "recreating: $services"
# shellcheck disable=SC2086 # one argument per service name
compose up -d --no-deps --force-recreate $services

drift="$(drifted_services)"
if [ -n "$drift" ]; then
  printf '%s\n' "$drift" | while read -r svc vars; do
    log "$svc: still differs after recreation ($vars)"
  done
  die "containers do not run with the rendered environment"
fi
log "recreated services now have the rendered environment"
