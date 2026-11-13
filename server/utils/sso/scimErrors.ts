import { createError } from 'h3'
import type { ErrorFormat } from '../api/policyTypes'
import { useLogger } from '../platform/logger'

const log = useLogger('scim')

// The SCIM Error object (RFC 7644 §3.12) and the error format `allow.scim()`
// carries. Kept apart from scim.ts (database, membership) so the policy and
// its tests load it without the provisioning code.

const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'
export const SCIM_CONTENT_TYPE = 'application/scim+json; charset=utf-8'

/** A SCIM error response (RFC 7644 §3.12). */
export function scimError(status: number, detail: string, scimType?: string): Error {
  return createError({ statusCode: status, message: detail, data: { schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) } })
}

/**
 * How SCIM routes refuse: the SCIM Error object, not the API envelope,
 * because IdP clients (Okta, Entra ID) parse it; anything that isn't a SCIM
 * error is a generic 500 (details only in the server log).
 */
export const scimErrorFormat: ErrorFormat = {
  invalid: (part) => {
    // The only path parameter is a User id: one that isn't a positive integer names no user.
    if (part === 'params') return scimError(404, 'User not found.')
    if (part === 'body') return scimError(400, 'The request body must be a JSON object.', 'invalidSyntax')
    return scimError(400, 'The query parameters are invalid.', 'invalidValue')
  },
  respond: (e) => {
    const data = (e as { data?: { schemas?: unknown, status?: unknown } } | null)?.data
    if (Array.isArray(data?.schemas) && data.schemas.includes(SCIM_ERROR_SCHEMA)) {
      return { status: Number(data.status), body: data, contentType: SCIM_CONTENT_TYPE }
    }
    log.error('request failed', { err: e })
    return { status: 500, body: { schemas: [SCIM_ERROR_SCHEMA], status: '500', detail: 'Something went wrong on our side.' }, contentType: SCIM_CONTENT_TYPE }
  }
}
