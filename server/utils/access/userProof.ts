import { mintAdminActor, mintUserScope } from '../../repos/proofs/mint'
import type { AdminActor, UserScope } from '../../repos/proofs'

// User-level proofs. Only called after the session (or another credential:
// an MCP token, a verified invite) has established who the user is.

/** The authenticated user acting on their own data. */
export function proveSelf(userId: number): UserScope {
  return mintUserScope(userId)
}

/** An instance admin; only after `requireAdminUser` admitted the caller. */
export function proveAdmin(userId: number): AdminActor {
  return mintAdminActor(userId)
}
