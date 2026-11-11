/** Smallest Team / Business subscription (seats). */
export const MIN_WORKSPACE_SEATS = 3
/** Upper bound on one seat change, a typo guard (Stripe allows more). */
export const MAX_WORKSPACE_SEATS = 1000

/**
 * Guests take no seat; a paid Team / Business workspace may have
 * up to this many per paid seat (against using guests as free members).
 * Workspaces without a subscription (self-hosted) have no guest cap.
 */
export const GUESTS_PER_SEAT = 5
