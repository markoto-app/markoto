// Document-password policy shared by the Share modal and
// `POST /api/docs/:id/password`. Passwords set before the minimum was
// raised keep working — the length is only checked when one is set.
export const DOC_PASSWORD_MIN_LENGTH = 8
