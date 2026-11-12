import { and, eq, sql, type SQL } from 'drizzle-orm'
import { must } from '~~/shared/utils/must'
import { users } from '../db/schema'
import { useDatabase } from '../utils/platform/database'

// Sign-in: OAuth handlers write through the single `upsertOAuthUser`
// (upsert by provider id).

export type Provider = 'github' | 'google' | 'oidc'

interface OAuthProfileFields {
  login?: string | null
  name: string
  email: string | null
  /**
   * Whether the provider verified the email. Gates the email-based account
   * merge: a new login merges into an existing row only when BOTH sides present
   * the same verified email, otherwise someone who can claim an arbitrary email
   * at one provider could take over an account at another.
   *
   * - GitHub: the email is only returned (and only as primary) once verified,
   *   so `email != null` means verified.
   * - Google: `email_verified` from OIDC userinfo.
   * - Generic OIDC: `email_verified === true`; the handler already drops an
   *   unverified email (`email: null`), see `server/utils/oidc/profile.ts`.
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
 * Outcome of `upsertOAuthUser`, so callers can show e.g. "linked your Google
 * login to your existing account". Diagnostic only; the user id drives the
 * session.
 */
export type OAuthUpsertOutcome = 'inserted' | 'updated' | 'merged'

export interface OAuthUpsertResult {
  userId: number
  outcome: OAuthUpsertOutcome
}

/**
 * Upsert a user by OAuth provider id. Three outcomes:
 *  1. updated: the provider id matches a row; refresh name / email / GitHub login.
 *  2. merged: the provider id is new but the verified email matches a row bound
 *     to the OTHER provider; bind ours to it so either provider can sign in.
 *     Requires `emailVerified=true`, otherwise an unproven email could take
 *     over an account. Only merges when the candidate has NULL for OUR provider
 *     id (else insert, to avoid clobbering a binding). `SELECT FOR UPDATE`
 *     stops two concurrent logins of the same email merging into different rows.
 *  3. inserted: a genuinely new user.
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
  return { userId: must(inserted[0], 'inserted user row').id, outcome: 'inserted' }
}
