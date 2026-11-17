#!/usr/bin/env bash
# Tests acme-ec-migrate.sh against stores built from real keys: ECDSA in the
# SEC1 form ("BEGIN EC PRIVATE KEY"), ECDSA in the PKCS#8 form Traefik 3.7
# writes ("BEGIN PRIVATE KEY"), and RSA in PKCS#8. A store with only ECDSA
# keys must never be rotated: rotating it on every deploy requests new
# certificates each time and runs into Let's Encrypt's weekly limit.
#
#   deploy/config/traefik/acme-ec-migrate-test.sh   (run by scripts/selfhost-check.sh)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/acme-ec-migrate.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

b64() { base64 -w0 2>/dev/null < "$1" || base64 < "$1" | tr -d '\n'; }

openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/ec-sec1.pem" 2> /dev/null
openssl pkcs8 -topk8 -nocrypt -in "$tmp/ec-sec1.pem" -out "$tmp/ec-pkcs8.pem"
openssl ecparam -name secp384r1 -genkey -noout 2> /dev/null \
  | openssl pkcs8 -topk8 -nocrypt -out "$tmp/ec384-pkcs8.pem"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$tmp/rsa-pkcs8.pem" 2> /dev/null

# A store in Traefik's layout: one indented `"key": "<base64 PEM>"` line per
# certificate.
store() {
  local out="$1"; shift
  {
    echo '{'
    echo '  "le": {'
    echo '    "Certificates": ['
    local first=1 k
    for k in "$@"; do
      [[ $first -eq 1 ]] || echo '      ,'
      first=0
      echo '      {'
      echo "        \"certificate\": \"Y2VydA==\","
      echo "        \"key\": \"$(b64 "$tmp/$k.pem")\","
      echo '        "Store": "default"'
      echo '      }'
    done
    echo '    ]'
    echo '  }'
    echo '}'
  } > "$out"
}

fails=0
expect() { # expect <name> <expected exit> <keys...>
  local name="$1" want="$2"; shift 2
  store "$tmp/acme.json" "$@"
  local got=0
  sh "$script" check "$tmp/acme.json" > /dev/null || got=$?
  if [[ $got -ne $want ]]; then
    echo "FAIL: $name: check exited $got, expected $want" >&2
    fails=$((fails + 1))
  else
    echo "ok: $name"
  fi
}

expect "SEC1 ECDSA keys only" 0 ec-sec1 ec-sec1
expect "PKCS#8 ECDSA keys only (Traefik 3.7)" 0 ec-pkcs8 ec384-pkcs8 ec-pkcs8
expect "mixed SEC1 and PKCS#8 ECDSA" 0 ec-sec1 ec-pkcs8
expect "one RSA key among ECDSA" 10 ec-pkcs8 rsa-pkcs8
expect "RSA keys only" 10 rsa-pkcs8 rsa-pkcs8

# rotate leaves an ECDSA-only store in place.
store "$tmp/acme.json" ec-pkcs8 ec-pkcs8
sh "$script" rotate "$tmp/acme.json" > /dev/null
if [[ -s "$tmp/acme.json" ]] && ! ls "$tmp"/acme.json.rsa-* > /dev/null 2>&1; then
  echo "ok: rotate keeps an ECDSA-only store"
else
  echo "FAIL: rotate moved an ECDSA-only store" >&2
  fails=$((fails + 1))
fi

# rotate sets an RSA store aside and leaves an empty 0600 store.
store "$tmp/acme.json" rsa-pkcs8
sh "$script" rotate "$tmp/acme.json" > /dev/null
if [[ ! -s "$tmp/acme.json" ]] && ls "$tmp"/acme.json.rsa-* > /dev/null 2>&1 \
  && [[ "$(stat -c %a "$tmp/acme.json" 2> /dev/null || stat -f %Lp "$tmp/acme.json")" == "600" ]]; then
  echo "ok: rotate sets an RSA store aside"
else
  echo "FAIL: rotate did not set the RSA store aside" >&2
  fails=$((fails + 1))
fi

# An empty or missing store needs nothing.
: > "$tmp/empty.json"
if sh "$script" check "$tmp/empty.json" > /dev/null; then
  echo "ok: empty store"
else
  echo "FAIL: empty store reported non-ECDSA keys" >&2
  fails=$((fails + 1))
fi

if [[ $fails -gt 0 ]]; then
  echo "$fails acme-ec-migrate test(s) failed" >&2
  exit 1
fi
echo "acme-ec-migrate: all tests passed"
