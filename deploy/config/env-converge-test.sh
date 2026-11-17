#!/usr/bin/env bash
# Tests env-converge.sh against a fake compose + engine: a container whose
# environment matches the rendered one is left alone, one that lacks a
# rendered value (a rotated secret) is recreated, and only that one. A
# literal $ (rendered as $$ by `compose config`) is no difference.
#
#   deploy/config/env-converge-test.sh   (run by scripts/selfhost-check.sh)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/env-converge.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# The rendered configuration: app with a secret, sync, and a one-shot
# db-init without a running container.
cat > "$tmp/config.json" <<'EOF'
{"services": {
  "app": {"environment": {"SECRET": "new", "PRICE": "a$$b", "EMPTY": "", "PASS": null}},
  "sync": {"environment": {"SECRET": "new"}},
  "db-init": {"environment": {"X": "1"}}
}}
EOF

# Fake compose: `config` prints the file, `ps -q <svc>` the running
# container (none for db-init), `up` records the recreated services and
# "recreates" them with the rendered environment.
cat > "$tmp/compose" <<EOF
#!/usr/bin/env bash
set -eu
case "\$1" in
  config) cat "$tmp/config.json" ;;
  ps) [ "\$3" = db-init ] || echo "cid-\$3" ;;
  up) shift; echo "\$*" >> "$tmp/up.log"
      for a in "\$@"; do case "\$a" in -*) ;; *) cp "$tmp/env-good-\$a.json" "$tmp/env-cid-\$a.json" ;; esac; done ;;
  *) exit 2 ;;
esac
EOF
# Fake engine: `inspect --format ... <cid>` prints that container's env.
cat > "$tmp/engine" <<EOF
#!/usr/bin/env bash
cat "$tmp/env-\$4.json"
EOF
chmod +x "$tmp/compose" "$tmp/engine"

# shellcheck disable=SC2016 # a literal $ in the container's environment
good_app='["PATH=/usr/bin","SECRET=new","PRICE=a$b","EMPTY="]'
good_sync='["SECRET=new"]'
echo "$good_app" > "$tmp/env-good-app.json"
echo "$good_sync" > "$tmp/env-good-sync.json"

run() { COMPOSE="$tmp/compose" ENGINE="$tmp/engine" sh "$script" "$@"; }
fail() { echo "FAIL: env-converge: $*" >&2; exit 1; }

# 1. Everything current: nothing is recreated.
echo "$good_app" > "$tmp/env-cid-app.json"
echo "$good_sync" > "$tmp/env-cid-sync.json"
rm -f "$tmp/up.log"
out="$(run)" || fail "a current stack must pass ($out)"
[ ! -e "$tmp/up.log" ] || fail "a current stack must not recreate anything ($(cat "$tmp/up.log"))"

# 2. app still has the old secret: check reports it (exit 4) without values.
# shellcheck disable=SC2016
echo '["PATH=/usr/bin","SECRET=old","PRICE=a$b","EMPTY="]' > "$tmp/env-cid-app.json"
rc=0; out="$(run check)" || rc=$?
[ "$rc" -eq 4 ] || fail "check must exit 4 on drift (got $rc)"
grep -q 'app: .*(SECRET)' <<< "$out" || fail "check must name the drifted variable ($out)"
if grep -q 'old\|new' <<< "$out"; then fail "values must never be printed ($out)"; fi
[ ! -e "$tmp/up.log" ] || fail "check must not recreate"

# 3. Converge: only app is force-recreated, and afterwards it matches.
out="$(run)" || fail "converge must succeed ($out)"
[ "$(cat "$tmp/up.log")" = "-d --no-deps --force-recreate app" ] \
  || fail "only app must be recreated (got: $(cat "$tmp/up.log"))"

# 4. A container that still differs after recreation fails the run.
echo '["SECRET=old"]' > "$tmp/env-cid-sync.json"
echo '["SECRET=old"]' > "$tmp/env-good-sync.json"
if out="$(run 2>&1)"; then fail "a drift that survives recreation must fail ($out)"; fi

echo "ok: env-converge recreates exactly the services whose environment changed"
