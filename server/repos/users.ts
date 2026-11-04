import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm'
import { users } from '../db/schema'
import { useDatabase } from '../utils/database'
import { ConflictError } from './errors'

// Users repository. The OAuth handlers do an "upsert by provider id",
// so the write path is a single `upsertOAuthUser` that replaces the
// `select → if existing update else insert → re-select id` dance
// github.get.ts / google.get.ts used to open-code.

export type Provider = 'github' | 'google' | 'oidc'

export interface UserRow {
  id: number
  githubId: string | null
  googleId: string | null
  oidcIssuer: string | null
  oidcSubject: string | null
  login: string | null
  name: string
  email: string | null
  stripeCustomerId: string | null
  isAdmin: boolean
  createdAt: Date
  /** Onboarding / policy acceptance — read by the server-side onboarding gate. */
  ageConfirmedAt: Date | null
  privacyVersionAccepted: number | null
  tosVersionAccepted: number | null
  /** Preferred locale (NULL = never chosen). */
  locale: string | null
  /** Session revocation counter — see `server/utils/sessionPolicy.ts`. */
  sessionEpoch: number
}

interface OAuthProfileFields {
  login?: string | null
  name: string
  email: string | null
  /**
   * Whether the email returned by the OAuth provider is verified.
   * Gates the email-based account merge path: we only merge a new
   * login into an existing row if BOTH sides present the same
   * verified email. Otherwise an attacker who can claim an
   * arbitrary email at one provider could take over someone else's
   * account at another.
   *
   * - GitHub: the userinfo endpoint only returns the primary email
   *   when `emailRequired: true` is set, and GitHub only lists an
   *   email as primary after it's been verified. So for our
   *   GitHub flow, `email != null` => verified.
   * - Google: OIDC userinfo returns `email_verified: boolean`
   *   directly. Pipe that through.
   * - Generic OIDC: `email_verified === true` from the IdP. The OIDC
   *   handler additionally drops an unverified email entirely (passes
   *   `email: null`), see `server/utils/oidc/profile.ts`.
   */
  emailVerified: boolean
}

/**
 * Identity at the provider. GitHub / Google ids are globally unique per
 * provider; an OIDC `sub` is only unique per issuer, so OIDC identities
 * are keyed by the (issuer, subject) pair.
 */
export type OAuthUpsertInput = OAuthProfileFields & (
  | { provider: 'github' | 'google', providerUserId: string }
  | { provider: 'oidc', providerUserId: string, oidcIssuer: string }
)

/**
 * Outcome returned from `upsertOAuthUser` so callers can show a
 * flash message like "linked your Google login to your existing
 * account". Pure diagnostic — the user id is what drives the
 * session cookie either way.
 */
export type OAuthUpsertOutcome = 'inserted' | 'updated' | 'merged'

export interface OAuthUpsertResult {
  userId: number
  outcome: OAuthUpsertOutcome
}

export async function findUserById(id: number): Promise<UserRow | null> {
  const db = useDatabase()
  const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  return row ?? null
}

/** The user's current session epoch (0 for a missing user). */
export async function getSessionEpoch(userId: number): Promise<number> {
  const db = useDatabase()
  const row = (await db
    .select({ sessionEpoch: users.sessionEpoch })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0]
  return row?.sessionEpoch ?? 0
}

/**
 * Increment the session epoch, invalidating every session cookie sealed
 * before this call. Returns the new epoch (null when the user is gone).
 */
export async function bumpSessionEpoch(userId: number): Promise<number | null> {
  const db = useDatabase()
  const row = (await db
    .update(users)
    .set({ sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(eq(users.id, userId))
    .returning({ sessionEpoch: users.sessionEpoch }))[0]
  return row?.sessionEpoch ?? null
}

export async function findUserNameById(id: number): Promise<string | null> {
  const db = useDatabase()
  const row = (await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, id))
    .limit(1))[0]
  return row?.name ?? null
}

/**
 * Case-insensitive email lookup. Used by the workspace-invite endpoint.
 * Users sign up via GitHub/Google and the provider's casing may differ
 * from what the inviter types.
 */
export async function findUserByEmail(email: string): Promise<Pick<UserRow, 'id' | 'name' | 'email' | 'login'> | null> {
  const db = useDatabase()
  const row = (await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      login: users.login
    })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1))[0]
  return row ?? null
}

/**
 * Upsert a user by OAuth provider id.
 *
 * Three outcomes:
 *
 *   1. **updated** — the provider id matches an existing row. Refresh
 *      the profile fields (name, email, login-for-github)
 *      in case the user changed them on the provider.
 *
 *   2. **merged** — the provider id is new, BUT the verified email
 *      matches a row with the OTHER provider id set. Add our
 *      provider id to that existing row so the user can sign in
 *      with either provider going forward. This is what keeps a
 *      "I signed up with GitHub; now let me try Google" second
 *      login from creating a ghost account. Gated on
 *      `emailVerified=true` so an attacker who can't prove the
 *      email is theirs (e.g. a provider that doesn't verify) can't
 *      take over someone else's account.
 *
 *   3. **inserted** — genuinely new user. No provider-id match, no
 *      mergeable email hit.
 *
 * Ordering rules for case #2 (the merge):
 *   - Only merge if the candidate row has NULL for OUR provider id.
 *     If both provider ids are already set on that row, insert a
 *     new row instead — merging would clobber an existing binding.
 *   - `SELECT FOR UPDATE` locks the candidate row for the tx so
 *     two concurrent logins of the same email can't both merge
 *     (which would corrupt "only one of us wins" into "both append
 *     our provider id to different rows with the same provider
 *     now set").
 */
export async function upsertOAuthUser(input: OAuthUpsertInput): Promise<OAuthUpsertResult> {
  const db = useDatabase()
  const whereByProviderId = providerIdentityWhere(input)

  return db.transaction(async (tx): Promise<OAuthUpsertResult> => {
    const updated = await tryUpdateExistingByProvider(tx, input, whereByProviderId)
    if (updated) return updated
    const merged = await tryMergeByVerifiedEmail(tx, input)
    if (merged) return merged
    return insertNewUser(tx, input)
  })
}

/** WHERE clause matching the row that already holds this provider identity. */
function providerIdentityWhere(input: OAuthUpsertInput): SQL | undefined {
  switch (input.provider) {
    case 'github': return eq(users.githubId, input.providerUserId)
    case 'google': return eq(users.googleId, input.providerUserId)
    case 'oidc': return and(eq(users.oidcIssuer, input.oidcIssuer), eq(users.oidcSubject, input.providerUserId))
  }
}

/** Column values that bind this provider identity to a user row. */
function providerIdentityColumns(input: OAuthUpsertInput): Pick<typeof users.$inferInsert, 'githubId' | 'googleId' | 'oidcIssuer' | 'oidcSubject'> {
  switch (input.provider) {
    case 'github': return { githubId: input.providerUserId }
    case 'google': return { googleId: input.providerUserId }
    case 'oidc': return { oidcIssuer: input.oidcIssuer, oidcSubject: input.providerUserId }
  }
}

type Tx = Parameters<Parameters<ReturnType<typeof useDatabase>['transaction']>[0]>[0]

/**
 * Branch 1: provider id is already on file. Update the mutable fields
 * (name, email, plus login on GitHub) and return. Provider avatars are
 * never stored — avatars are generated locally from the user id.
 */
async function tryUpdateExistingByProvider(
  tx: Tx,
  input: OAuthUpsertInput,
  whereByProviderId: SQL | undefined
): Promise<OAuthUpsertResult | null> {
  const existing = (await tx
    .select({ id: users.id })
    .from(users)
    .where(whereByProviderId)
    .limit(1))[0]
  if (!existing) return null
  await tx.update(users)
    .set({
      name: input.name,
      email: input.email,
      ...(input.provider === 'github' ? { login: input.login } : {})
    })
    .where(whereByProviderId)
  return { userId: existing.id, outcome: 'updated' }
}

/**
 * Branch 2: email-based merge. Locked with `FOR UPDATE` so a
 * concurrent second-provider login for the same email serialises
 * (second tx sees either our merged row or — if we haven't
 * committed — waits + then sees the merged state). Returns null when
 * the verified-email gate doesn't apply, no candidate exists, or the
 * candidate already has OUR provider bound to a different value
 * (caller falls through to insert).
 */
async function tryMergeByVerifiedEmail(
  tx: Tx,
  input: OAuthUpsertInput
): Promise<OAuthUpsertResult | null> {
  if (!input.emailVerified || !input.email) return null
  const mergeCandidate = (await tx.execute<{ id: number, github_id: string | null, google_id: string | null, oidc_subject: string | null }>(sql`
    SELECT id, github_id, google_id, oidc_subject FROM ${users}
    WHERE lower(email) = lower(${input.email})
    LIMIT 1
    FOR UPDATE
  `)).rows?.[0]
  if (!mergeCandidate) return null

  // Candidate already has our provider id bound to a DIFFERENT value
  // (otherwise branch 1 would have matched). Overwriting would
  // clobber the existing binding — caller falls through to insert.
  // For OIDC that includes an identity from a different issuer: a
  // user row holds at most one OIDC identity, and re-pointing it to a
  // new issuer is not something a login should do silently.
  if (candidateHasProvider(mergeCandidate, input.provider)) return null

  // Merge: add our provider id to the existing row. Email casing
  // normalises to the second provider's. Login only updates on
  // GitHub (the other providers have no equivalent).
  const setClause: Partial<typeof users.$inferInsert> = {
    ...providerIdentityColumns(input),
    email: input.email
  }
  if (input.provider === 'github') setClause.login = input.login ?? null
  await tx.update(users)
    .set(setClause)
    .where(eq(users.id, mergeCandidate.id))
  return { userId: mergeCandidate.id, outcome: 'merged' }
}

function candidateHasProvider(
  row: { github_id: string | null, google_id: string | null, oidc_subject: string | null },
  provider: Provider
): boolean {
  switch (provider) {
    case 'github': return row.github_id !== null
    case 'google': return row.google_id !== null
    case 'oidc': return row.oidc_subject !== null
  }
}

/** Branch 3: genuinely new user. */
async function insertNewUser(tx: Tx, input: OAuthUpsertInput): Promise<OAuthUpsertResult> {
  const inserted = await tx.insert(users).values({
    ...providerIdentityColumns(input),
    login: input.login ?? null,
    name: input.name,
    email: input.email
  }).returning({ id: users.id })
  return { userId: inserted[0]!.id, outcome: 'inserted' }
}

// ────────────────────────────────────────────────────────────────────
// GDPR Article 17: account-deletion request lifecycle
// ────────────────────────────────────────────────────────────────────
//
// Three repo functions:
//   - `requestAccountDeletion` marks the user with a 30-day grace
//     window. Idempotent at the contract level: calling it on an
//     already-scheduled account throws `ConflictError` (the orchestrator
//     translates this to a 409). The reason it's not silently
//     idempotent: re-requesting would reset the grace clock, which is
//     a user-hostile behaviour (an attacker who phished session tokens
//     could keep extending the window).
//   - `cancelAccountDeletion` clears the marks. Throws `ConflictError`
//     if no deletion is scheduled (so the orchestrator knows to
//     surface a clear "nothing to cancel" error).
//   - `getAccountDeletionStatus` reads the current state for the
//     user; null fields mean no deletion is scheduled.
//
// **No actual purge happens here.** The cascading delete lives in
// `accountDeletionSweep.ts` (Workstream B-2). These functions only
// touch the two timestamp columns on `users`.

export interface AccountDeletionStatus {
  deletionRequestedAt: Date | null
  deletionGraceUntil: Date | null
}

/**
 * Schedule the user's account for deletion. Sets
 * `deletion_requested_at = now()` + `deletion_grace_until = now() +
 * graceDays`. Throws `ConflictError` if the row already has a
 * scheduled deletion; the caller (orchestrator → endpoint) translates
 * to 409 so the client can surface "already scheduled" without a
 * duplicated audit trail.
 */
export async function requestAccountDeletion(userId: number, graceDays: number): Promise<AccountDeletionStatus> {
  if (!Number.isInteger(graceDays) || graceDays < 1 || graceDays > 365) {
    // Repo-level shape rejection — should never trip from a controlled
    // caller (orchestrator passes the constant), but guard anyway so a
    // misconfigured config can't put a 1000-year grace into the DB.
    throw new Error(`requestAccountDeletion: graceDays out of range: ${graceDays}`)
  }

  const db = useDatabase()
  // Single UPDATE with a WHERE that excludes already-scheduled rows.
  // Using `RETURNING` lets us distinguish "row updated" (success) from
  // "row not updated" (already scheduled OR user gone). We follow up
  // with a status-read on the no-rows-updated branch to disambiguate.
  const updated = await db.update(users)
    .set({
      deletionRequestedAt: sql`now()`,
      deletionGraceUntil: sql`now() + (${graceDays}::int * interval '1 day')`
    })
    .where(and(
      eq(users.id, userId),
      // ONLY update if not already scheduled. This is the race-free
      // "first request wins" guard — concurrent duplicate requests
      // serialise via row-locking and the second one sees the
      // already-set column and matches zero rows.
      sql`${users.deletionRequestedAt} IS NULL`
    ))
    .returning({
      deletionRequestedAt: users.deletionRequestedAt,
      deletionGraceUntil: users.deletionGraceUntil
    })

  if (updated.length === 1) {
    return {
      deletionRequestedAt: updated[0]!.deletionRequestedAt,
      deletionGraceUntil: updated[0]!.deletionGraceUntil
    }
  }

  // No row updated. Distinguish "already scheduled" (409) from "user
  // doesn't exist" (404 — but `requireValidatedUserSession` should
  // have ruled this out before we get here).
  const status = await getAccountDeletionStatus(userId)
  if (status === null) {
    throw new Error(`requestAccountDeletion: user ${userId} not found`)
  }
  if (status.deletionRequestedAt !== null) {
    throw new ConflictError('account deletion already scheduled')
  }
  // Should be unreachable — same row both unscheduled AND not updated
  // means a bug. Surface loudly.
  throw new Error('requestAccountDeletion: unexpected row state')
}

/**
 * Cancel a scheduled deletion. Clears both timestamp columns. Throws
 * `ConflictError` if no deletion is scheduled.
 */
export async function cancelAccountDeletion(userId: number): Promise<void> {
  const db = useDatabase()
  const updated = await db.update(users)
    .set({
      deletionRequestedAt: null,
      deletionGraceUntil: null
    })
    .where(and(
      eq(users.id, userId),
      isNotNull(users.deletionRequestedAt)
    ))
    .returning({ id: users.id })

  if (updated.length === 1) return

  // No row updated — disambiguate.
  const status = await getAccountDeletionStatus(userId)
  if (status === null) {
    throw new Error(`cancelAccountDeletion: user ${userId} not found`)
  }
  throw new ConflictError('no account deletion to cancel')
}

/**
 * Read the deletion-request state for a user. Returns null if the
 * user does not exist; the two timestamp columns are null when no
 * deletion is scheduled.
 */
export async function getAccountDeletionStatus(userId: number): Promise<AccountDeletionStatus | null> {
  const db = useDatabase()
  const row = (await db
    .select({
      deletionRequestedAt: users.deletionRequestedAt,
      deletionGraceUntil: users.deletionGraceUntil
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0]
  if (!row) return null
  return {
    deletionRequestedAt: row.deletionRequestedAt,
    deletionGraceUntil: row.deletionGraceUntil
  }
}

/**
 * Convenience read for the account-status endpoint. Returns the
 * minimum the UI needs to render the privacy / settings surface
 * without a second round-trip per row.
 */
export interface AccountStatus {
  email: string | null
  locale: string | null
  ageConfirmedAt: Date | null
  deletionRequestedAt: Date | null
  deletionGraceUntil: Date | null
  privacyVersionAccepted: number | null
  privacyVersionAcceptedLocale: string | null
  tosVersionAccepted: number | null
  tosVersionAcceptedLocale: string | null
  dpaVersionAccepted: number | null
  dpaVersionAcceptedLocale: string | null
}

/**
 * One-shot onboarding mutation: confirms the user's age (if not
 * already), records acceptance of the Privacy Policy + Terms of
 * Service at the given versions, and stamps the locale the user
 * read each in. Idempotent: re-running on an already-accepted
 * row no-ops the relevant column. Used by the onboarding gate
 * modal (`/api/user/onboarding-accept`).
 *
 * DPA acceptance is NOT in this call — DPA is workspace-owner
 * only and gets prompted at workspace-creation time. A separate
 * `acceptDpa(userId, version, locale)` will handle that flow.
 */
export async function applyOnboardingAcceptance(args: {
  userId: number
  privacyVersion: number
  tosVersion: number
  locale: string
}): Promise<void> {
  const db = useDatabase()
  await db.update(users)
    .set({
      ageConfirmedAt: sql`COALESCE(${users.ageConfirmedAt}, now())`,
      privacyVersionAccepted: args.privacyVersion,
      privacyVersionAcceptedLocale: args.locale,
      tosVersionAccepted: args.tosVersion,
      tosVersionAcceptedLocale: args.locale
    })
    .where(eq(users.id, args.userId))
}

/**
 * Record a user's acceptance of the DPA at the given version + locale.
 * Used by the workspace-creation flow (forthcoming) when a user
 * who hasn't accepted yet creates their first workspace.
 */
/**
 * Set the `is_admin` flag on a user. Called by:
 *   - The OAuth-upsert path (env-allowlist bootstrap on login).
 *   - A future admin-management UI (forthcoming).
 *
 * Repo-level mutation only — the caller is responsible for the
 * audit-log entry. Returns the previous value so the caller can
 * decide whether to audit (no-op flips don't need an audit row).
 */
export async function setAdminFlag(userId: number, value: boolean): Promise<{ previous: boolean } | null> {
  const db = useDatabase()
  const before = (await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0]
  if (!before) return null
  if (before.isAdmin === value) return { previous: before.isAdmin }
  await db.update(users)
    .set({ isAdmin: value })
    .where(eq(users.id, userId))
  return { previous: before.isAdmin }
}

export async function applyDpaAcceptance(args: {
  userId: number
  dpaVersion: number
  locale: string
}): Promise<void> {
  const db = useDatabase()
  await db.update(users)
    .set({
      dpaVersionAccepted: args.dpaVersion,
      dpaVersionAcceptedLocale: args.locale
    })
    .where(eq(users.id, args.userId))
}

export async function getAccountStatus(userId: number): Promise<AccountStatus | null> {
  const db = useDatabase()
  const row = (await db
    .select({
      email: users.email,
      locale: users.locale,
      ageConfirmedAt: users.ageConfirmedAt,
      deletionRequestedAt: users.deletionRequestedAt,
      deletionGraceUntil: users.deletionGraceUntil,
      privacyVersionAccepted: users.privacyVersionAccepted,
      privacyVersionAcceptedLocale: users.privacyVersionAcceptedLocale,
      tosVersionAccepted: users.tosVersionAccepted,
      tosVersionAcceptedLocale: users.tosVersionAcceptedLocale,
      dpaVersionAccepted: users.dpaVersionAccepted,
      dpaVersionAcceptedLocale: users.dpaVersionAcceptedLocale
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0]
  return row ?? null
}
