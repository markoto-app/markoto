import type { H3Event } from 'h3'
import { findUserById } from '../repos/users'

// Admin authorisation.
//
// **Source of truth: `users.is_admin` column.** Steady-state
// admin checks read this column. Granted via the (forthcoming)
// admin-management UI, by the env-list bootstrap on first login,
// or by direct SQL if you really need to.
//
// **Bootstrap: `NUXT_ADMIN_USER_EMAILS` env allowlist.** A
// comma-separated, case-insensitive list of emails that get
// auto-promoted to is_admin=true on their next OAuth login (see
// `upsertOAuthUser`). After that promotion, the column is the
// durable record — env-list changes only matter for new
// bootstrapping users, not for users who have already logged in.
//
//   NUXT_ADMIN_USER_EMAILS=admin@example.com,founder@example.com
//
// **No email fallback at check time.** `isAdminUser` / `requireAdminUser`
// read ONLY the column. The allowlist is applied when a user signs in
// with a VERIFIED email (`bootstrapAdminFromEnv`; GitHub / Google / OIDC
// all store NULL for unverified addresses), so a stored address is never
// trusted on its own. Adding an email to the env therefore takes effect
// at that user's next sign-in.

function parseAdminEmails(): Set<string> {
  const raw = process.env.NUXT_ADMIN_USER_EMAILS ?? ''
  return new Set(
    raw
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  )
}

/**
 * Returns true if the email is on the bootstrap allowlist. Used
 * by the sign-in path (`bootstrapAdminFromEnv`, verified emails only)
 * to decide whether to auto-promote.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return parseAdminEmails().has(email.trim().toLowerCase())
}

/**
 * Returns true if the user is an admin (`users.is_admin`). Used by the
 * account-status endpoint to surface the `isAdmin` flag the UI gates
 * the Admin nav-link on.
 */
export async function isAdminUser(userId: number): Promise<boolean> {
  const user = await findUserById(userId)
  return !!user && user.isAdmin
}

/**
 * Endpoint guard. Calls `requireValidatedUserSession`, then checks
 * the `users.is_admin` column. Throws 403 otherwise (does NOT 401 —
 * they ARE logged in, they just don't have admin rights).
 */
export async function requireAdminUser(event: H3Event): Promise<{ userId: number, name: string, email: string }> {
  const session = await requireValidatedUserSession(event)
  const user = await findUserById(session.user.id)
  if (!user?.isAdmin) {
    throw createError({
      statusCode: 403,
      message: 'Admin access required',
      data: { code: 'admin/forbidden' }
    })
  }
  return { userId: user.id, name: user.name, email: user.email ?? '' }
}
