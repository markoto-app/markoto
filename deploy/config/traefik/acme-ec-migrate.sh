#!/bin/sh
# Traefik's ACME store (acme.json): find certificates whose private key is not
# ECDSA, and set such a store aside so Traefik issues ECDSA certificates.
#
#   acme-ec-migrate.sh check  <acme.json>   exit 0: nothing to do, 10: non-ECDSA keys
#   acme-ec-migrate.sh rotate <acme.json>   move the store to <acme.json>.rsa-<UTC time>
#                                           and leave an empty 0600 store behind
#
# Why: the resolvers request EC256 keys (`acme.keytype`), but Traefik renews a
# stored certificate with the key it already has (lego reuses it), so a store
# written with the old RSA-4096 default would stay RSA for ever. An RSA-4096
# handshake costs about 40 ms of host CPU; ECDSA P-256 a small fraction.
#
# Run `rotate` only while Traefik is stopped (it rewrites the store whenever a
# certificate changes). On its next start Traefik registers a new ACME account
# and requests every certificate again (TLS-ALPN challenge, seconds per name);
# until then it answers with its default certificate. The old store is kept
# next to it (mode 0600, it holds private keys): delete it once the new
# certificates are in place, or move it back to undo.
#
# POSIX sh + grep only: it also runs inside the Traefik image (busybox) for the
# self-host volume (install.sh). Traefik writes indented JSON, one
# `"key": "<base64 PEM>"` line per certificate. An ECDSA key comes either as
# a SEC1 PEM ("EC PRIVATE KEY" header, whose base64 starts with the prefix
# below) or, since Traefik 3.7, as a PKCS#8 PEM ("PRIVATE KEY" header) whose
# body names the EC algorithm (EC_PKCS8_OID). Each key is decoded and checked: a
# PKCS#8 key without that OID (RSA) is the only thing counted as non-ECDSA.
set -eu

mode="${1:-}"
store="${2:-}"
if [ -z "$mode" ] || [ -z "$store" ]; then
  echo "usage: $0 check|rotate <acme.json>" >&2
  exit 2
fi

EC_PREFIX='LS0tLS1CRUdJTiBFQyBQUklWQVRFIEtFWS0tLS0t'

# The id-ecPublicKey AlgorithmIdentifier (OID 1.2.840.10045.2.1) as it
# appears in the base64 body of a PKCS#8 EC key (P-256 and P-384 alike).
EC_PKCS8_OID='ByqGSM49Ag'

# Number of certificate keys in the store that are not ECDSA.
non_ec_keys() {
  [ -s "$store" ] || { echo 0; return; }
  # One output line per non-ECDSA key, counted at the end (the loop runs in
  # a pipeline subshell, so it can't keep a counter of its own).
  sed -nE 's/^[[:space:]]*"key": *"([A-Za-z0-9+\/=]+)".*/\1/p' "$store" \
    | while IFS= read -r k; do
        case "$k" in
          "$EC_PREFIX"*) continue ;;
        esac
        pem="$(printf '%s' "$k" | base64 -d 2>/dev/null || true)"
        case "$pem" in
          *"-----BEGIN PRIVATE KEY-----"*)
            if printf '%s\n' "$pem" | grep -q "$EC_PKCS8_OID"; then continue; fi
            ;;
        esac
        echo non-ec
      done \
    | wc -l | tr -d ' '
}

case "$mode" in
  check)
    n="$(non_ec_keys)"
    if [ "$n" -gt 0 ]; then
      echo "acme: $n certificate(s) with a non-ECDSA key in $store"
      exit 10
    fi
    echo "acme: every certificate in $store has an ECDSA key"
    ;;
  rotate)
    n="$(non_ec_keys)"
    if [ "$n" -eq 0 ]; then
      echo "acme: nothing to rotate in $store"
      exit 0
    fi
    backup="$store.rsa-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$store" "$backup"
    (umask 077 && : > "$store")
    chmod 600 "$store"
    echo "acme: $n non-ECDSA certificate(s); store moved to $backup, Traefik requests ECDSA certificates on its next start"
    ;;
  *)
    echo "usage: $0 check|rotate <acme.json>" >&2
    exit 2
    ;;
esac
