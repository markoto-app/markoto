import { setAdminFlag } from '../../repos/users'
import { appendAuditEvent } from '../../repos/audit'
import { AUDIT_ADMIN_GRANTED } from '../../legal/auditActions'
import { isAdminEmail } from './adminAccess'

// One-shot bootstrap: when a user logs in via OAuth and their
// email is on the `NUXT_ADMIN_USER_EMAILS` allowlist, flip their
// `users.is_admin` column to true (if not already) and audit the
// promotion. Called from the OAuth callbacks (github, google, oidc)
// after the upsert completes.
//
// Idempotent: `setAdminFlag` short-circuits when the flag is
// already at the requested value, so running this on every login
// of an already-admin user costs one SELECT.
//
// Audit: the row carries `actor_user_id = null` (this is a
// system-bootstrap action, not an action a human took) and
// `metadata.via = 'env-allowlist'` so a future "who promoted
// whom" query can distinguish bootstrap from UI grants.

export async function bootstrapAdminFromEnv(args: {
  userId: number
  email: string | null
}): Promise<void> {
  if (!isAdminEmail(args.email)) return

  const result = await setAdminFlag(args.userId, true)
  if (!result) return // user not found — should be unreachable here
  if (result.previous === true) return // already admin; no-op

  // Newly promoted — audit.
  await appendAuditEvent({
    actorUserId: null,
    actorIp: null,
    scope: 'user',
    scopeId: String(args.userId),
    action: AUDIT_ADMIN_GRANTED,
    after: { isAdmin: true },
    metadata: {
      via: 'env-allowlist',
      email: args.email
    }
  })
}
