// A document restricted by a moderation decision stays private and off
// the web until a platform admin lifts the restriction (DSA: a decision
// the owner could undo with one click would not be a restriction). Every
// path that widens who can reach a document asks here first: the access
// mode (meta, password), guest shares, moves into a workspace, and
// publishing as a web page. Copies inherit the restriction
// (`duplicateDocument`), so duplicating cannot undo it either.

export const MODERATION_RESTRICTED_CODE = 'moderation/restricted'

export function moderationRestrictedError() {
  return createError({
    statusCode: 403,
    message: 'This document was restricted after a report. It can\'t be shared, made public or published until the restriction is lifted.',
    data: { code: MODERATION_RESTRICTED_CODE, messageKey: 'error.moderationRestricted' }
  })
}

/** Throws 403 `moderation/restricted` when the document carries a moderation restriction. */
export function assertNotModerationRestricted(doc: { moderationRestrictedAt: Date | null } | null | undefined): void {
  if (doc?.moderationRestrictedAt) throw moderationRestrictedError()
}
