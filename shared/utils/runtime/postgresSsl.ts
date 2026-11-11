import fs from 'node:fs'
import type { PoolConfig } from 'pg'

// Resolve TLS posture for the pg Pool from env. Returns the value to plug
// into `new Pool({ ssl: ... })`.
//
// Threat model: TLS-in-transit between app (and sync-server) and a managed
// Postgres provider (e.g. OVH). At-rest is provider-managed; this function
// covers the connection layer.
//
// Behaviour:
//   - Non-production (`NODE_ENV !== 'production'`): TLS off (`false`). The
//     dev/test postgres-in-docker runs without TLS; forcing rejectUnauthorized
//     would break local dev for no security gain (the connection is on a
//     bridge network nobody else can reach).
//   - Production: TLS on with `rejectUnauthorized: true`. If `PGSSLROOTCERT`
//     is set and points at a readable PEM file, that CA is loaded explicitly
//     (cert-pin verification — defends against provider DNS hijack /
//     MITM scenarios where the attacker holds a valid public CA cert for
//     the provider's hostname). When unset, falls back to the system CA
//     bundle, which works for managed providers that use a public cert
//     chain (most do today).
//   - `PGSSL=disable` is honoured as an explicit opt-out. Useful for some
//     managed-PG migration scenarios where the provider lets you disable
//     TLS at the network edge — emit a console warning so the choice
//     shows up in deploy logs.
export function resolvePostgresSsl(env: NodeJS.ProcessEnv = process.env): PoolConfig['ssl'] {
  const nodeEnv = env.NODE_ENV ?? ''
  if (env.PGSSL === 'disable') {
    console.warn('[postgres] PGSSL=disable — TLS-in-transit explicitly turned off. Verify this is intentional.')
    return false
  }
  if (nodeEnv !== 'production') {
    return false
  }
  const caPath = env.PGSSLROOTCERT
  if (caPath) {
    try {
      const ca = fs.readFileSync(caPath, 'utf-8')
      return { rejectUnauthorized: true, ca }
    } catch (e) {
      // Fail loudly: a misconfigured CA path in prod should not silently
      // fall through to the system bundle (which would weaken the
      // pinning the operator asked for). Throwing here surfaces in the
      // pool-construction stack at boot, which is exactly when the
      // operator can fix it.
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`[postgres] PGSSLROOTCERT='${caPath}' set but unreadable: ${msg}`, { cause: e })
    }
  }
  return { rejectUnauthorized: true }
}
