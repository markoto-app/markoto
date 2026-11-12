// Document-password policy shared by the Share modal and
// `POST /api/docs/:id/password`. Passwords set before the minimum was
// raised keep working — the length is only checked when one is set.
export const DOC_PASSWORD_MIN_LENGTH = 8
// Upper bound before scrypt sees it, for set AND verify: verify is open to
// anyone with the link, and a multi-megabyte "password" would burn a scrypt
// run's worth of CPU per request on input length alone.
export const DOC_PASSWORD_MAX_LENGTH = 1024
