import {
  cancelAccountDeletion as repoCancel,
  findUserById,
  getAccountDeletionStatus,
  requestAccountDeletion as repoRequest,
  type AccountDeletionStatus
} from '../../repos/users'
import { appendAuditEvent } from '../../repos/audit'
import {
  AUDIT_ACCOUNT_DELETE_CANCELLED,
  AUDIT_ACCOUNT_DELETE_REQUESTED
} from '../../legal/auditActions'
import { safeSendTransactionalEmail } from '../email/sendEmail'

// GDPR Article 17 orchestrator. Two flows: schedule a deletion (with
// 30-day grace), or cancel one in flight.
//
// **Scope:** This file ONLY touches the `users` row's two timestamp
// columns + writes audit + fires a courtesy email. The actual
// cascading purge (docs / S3 / comments / Stripe / etc.) lives in
// `accountDeletionSweep.ts`. Splitting these is
// deliberate: the request flow is a hot path the user touches
// directly and must stay fast and reversible; the purge is offline,
// idempotent, and runs from a sweeper.
//
// **Reversibility window.** 30 days is our default. Longer than the
// EU industry norm (typically 14d, sometimes 30d) because we'd rather
// err on the side of "the user changed their mind on day 28" than
// "we burned someone's only copy of a 5-year writing project". A
// shorter window can be set per-request by passing `graceDays` on
// `requestAccountDeletionByUser`.
//
// **Audit trail.** Both request and cancel land an `audit_log` row
// with the actor's truncated IP. We don't propagate audit-write
// failures — the row update has already committed and a wedged audit
// table must not flip a successful action into an error. (See
// `appendAuditEvent` semantics.)
//
// **Email.** Best-effort. `safeSendTransactionalEmail` swallows any
// provider error. The in-product "scheduled for deletion" banner is
// the load-bearing UX, not the email.

const DEFAULT_DELETION_GRACE_DAYS = 30

export interface RequestAccountDeletionArgs {
  userId: number
  // Truncated by `appendAuditEvent`'s call site; pass the raw IP and
  // the audit helper handles /24 + /48 truncation.
  actorIp: string | null
  // Override the default 30-day grace. Range-checked at the repo
  // boundary (1..365). Used by tests + the eventual "request faster
  // deletion" admin tool.
  graceDays?: number
}

export interface RequestAccountDeletionResult {
  status: AccountDeletionStatus
  // True if an email was attempted (regardless of whether delivery
  // succeeded). False when the user has no email on file. Useful for
  // the response body so the UI can show "we sent a confirmation to
  // your email" or "your account is scheduled".
  emailAttempted: boolean
}

/**
 * Schedule the user's account for deletion. The user remains usable
 * during the grace period; a UI banner alerts them to the pending
 * deletion and offers a one-click cancel. The cascading purge runs
 * in `accountDeletionSweep.ts` once the grace window elapses.
 *
 * Throws `ConflictError` from the repo layer if a deletion is already
 * scheduled — the endpoint translates this to 409.
 */
export async function requestAccountDeletionByUser(args: RequestAccountDeletionArgs): Promise<RequestAccountDeletionResult> {
  const graceDays = args.graceDays ?? DEFAULT_DELETION_GRACE_DAYS
  const status = await repoRequest(args.userId, graceDays)

  // Audit + email AFTER the row update committed. If either of the
  // following throws / rejects, the deletion is still scheduled — the
  // user's UI shows the banner regardless.
  await appendAuditEvent({
    actorUserId: args.userId,
    actorIp: args.actorIp,
    scope: 'user',
    scopeId: String(args.userId),
    action: AUDIT_ACCOUNT_DELETE_REQUESTED,
    after: {
      deletionRequestedAt: status.deletionRequestedAt?.toISOString() ?? null,
      deletionGraceUntil: status.deletionGraceUntil?.toISOString() ?? null,
      graceDays
    }
  })

  // Best-effort email. Pull email + locale from the user row; if
  // either is missing we still scheduled the deletion (the in-product
  // banner is the primary surface).
  const user = await findUserById(args.userId)
  const userEmail = user?.email
  const emailAttempted = !!userEmail
  if (userEmail) {
    void safeSendTransactionalEmail({
      kind: 'account.delete_requested',
      to: userEmail,
      locale: null, // user.locale not on the projection — read separately if needed
      subject: 'Your markoto account is scheduled for deletion',
      body: 'Your account will be permanently deleted on '
        + (status.deletionGraceUntil?.toISOString().slice(0, 10) ?? 'the scheduled date')
        + '. If you did not request this, sign in and cancel from /settings/profile.',
      metadata: {
        userId: args.userId,
        graceUntil: status.deletionGraceUntil?.toISOString() ?? ''
      }
    })
  }

  return { status, emailAttempted }
}

export interface CancelAccountDeletionArgs {
  userId: number
  actorIp: string | null
}

export interface CancelAccountDeletionResult {
  // Always { deletionRequestedAt: null, deletionGraceUntil: null } on
  // success — included for symmetry with the request result so the
  // endpoint response shape matches.
  status: AccountDeletionStatus
  emailAttempted: boolean
}

/**
 * Cancel a scheduled deletion. Throws `ConflictError` from the repo
 * if nothing is scheduled.
 */
export async function cancelAccountDeletionByUser(args: CancelAccountDeletionArgs): Promise<CancelAccountDeletionResult> {
  // Read pre-state for the audit log. We could also read it in the
  // same transaction as the cancel, but the cancel is itself a single
  // UPDATE … WHERE clause that won't race a concurrent re-request
  // (the repo gates on `IS NOT NULL`), so this read is safe.
  const before = await getAccountDeletionStatus(args.userId)
  await repoCancel(args.userId)

  await appendAuditEvent({
    actorUserId: args.userId,
    actorIp: args.actorIp,
    scope: 'user',
    scopeId: String(args.userId),
    action: AUDIT_ACCOUNT_DELETE_CANCELLED,
    before: before
      ? {
          deletionRequestedAt: before.deletionRequestedAt?.toISOString() ?? null,
          deletionGraceUntil: before.deletionGraceUntil?.toISOString() ?? null
        }
      : null
  })

  const user = await findUserById(args.userId)
  const userEmail = user?.email
  const emailAttempted = !!userEmail
  if (userEmail) {
    void safeSendTransactionalEmail({
      kind: 'account.delete_cancelled',
      to: userEmail,
      locale: null,
      subject: 'Your markoto account deletion was cancelled',
      body: 'Your scheduled account deletion has been cancelled. Your account is active again.',
      metadata: { userId: args.userId }
    })
  }

  return {
    status: { deletionRequestedAt: null, deletionGraceUntil: null },
    emailAttempted
  }
}
