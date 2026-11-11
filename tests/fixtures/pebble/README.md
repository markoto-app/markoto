# Pebble fixtures (custom domains)

`docker-compose.test.yml` runs Let's Encrypt's test CA (`pebble-test`), its
DNS test server (`challtestsrv-test`) and a Traefik (`traefik-test`) that
polls the app's provider endpoint. `tests/integration/endpoints/customDomains.test.ts`
verifies a domain against challtestsrv's records and has Traefik obtain a real
certificate from pebble over TLS-ALPN-01.

- `pebble.minica.pem` — pebble's public test root (copied from the pinned
  image, `/test/certs/pebble.minica.pem`); Traefik trusts it for pebble's
  ACME directory (`acme.cacertificates`). A test certificate, not a secret.
- `pebble-config.json` — pebble's own test config with the validation
  ports moved to 80 / 443, where traefik-test listens.
