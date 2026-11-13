// Building blocks of the error registry (`./index.ts`). A code is `<namespace>/<slug>`;
// its spec fixes the HTTP status and the `data` fields (`params`) it carries next to
// `code`. The user-facing text is not here but in i18n/locales/errors/<locale>.json,
// so the server (English `message`) and the client (`t()`) read the same catalog.
import { z } from 'zod'

export type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 429 | 500 | 502 | 503 | 504

export interface ErrorSpec {
  readonly status: ErrorStatus
  /** Further statuses a code is already sent with today; pass one with `apiError(code, params, { status })`. */
  readonly statuses?: readonly ErrorStatus[]
  /** Fields of `data` besides `code`. A message `{placeholder}` must name a required one. */
  readonly params?: z.ZodObject
  /** `developer`: only a broken client sees it; one generic text is enough. */
  readonly audience?: 'user' | 'developer'
}

/** Upgrade / contact hint the client renders as an action (`server/utils/billing/billingMode.ts#limitRecovery`). */
export const recoveryParam = z.object({
  kind: z.enum(['link', 'retry', 'contact']),
  href: z.string().optional(),
  labelKey: z.string().optional()
})

/** One failed field of a validation error (`request/invalid` or a route's `invalidCode`). */
export const fieldIssue = z.object({
  path: z.string(),
  issue: z.string(),
  minimum: z.union([z.number(), z.bigint(), z.string()]).optional(),
  maximum: z.union([z.number(), z.bigint(), z.string()]).optional(),
  format: z.string().optional(),
  expected: z.string().optional()
})
export type FieldIssue = z.infer<typeof fieldIssue>

/** Codes of one namespace: `defineErrors('share', { invalid: … })` registers `share/invalid`. */
export function defineErrors<const NS extends string, const S extends Record<string, ErrorSpec>>(
  ns: NS,
  specs: S
): { readonly [K in keyof S & string as `${NS}/${K}`]: S[K] } {
  return Object.fromEntries(Object.entries(specs).map(([slug, spec]) => [`${ns}/${slug}`, spec])) as { readonly [K in keyof S & string as `${NS}/${K}`]: S[K] }
}

/** Codes spelled out in full (the cross-cutting `common` set). */
export function defineErrorCodes<const S extends Record<string, ErrorSpec>>(specs: S): S {
  return specs
}
