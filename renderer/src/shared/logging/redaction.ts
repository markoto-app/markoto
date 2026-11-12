// The redaction rules shared by the logger (`shared/logging/core.ts`) and the
// Sentry scrubber (`shared/utils/security/sentryScrub.ts`): what a secret,
// an email address or a credential-bearing URL looks like, and how a value
// is walked and bounded. Both consumers differ only in their policy (which
// keys count as secret, how much is kept), so a new token shape added here
// protects logs and telemetry alike.
//
// Dependency-free on purpose: the renderer image is built from `renderer/`
// alone and carries byte-identical copies of this file and both consumers
// under `renderer/src/shared/` (pinned by tests/unit/logging/core.test.ts and
// tests/unit/platform/sentryScrub.test.ts).

const MASK = '[redacted]'
const OMITTED = '[omitted]'

/** Which object keys redact their value, checked in this order. */
export interface KeyRules {
  /** Replaced by `[omitted]` whatever the value (bodies, headers). */
  omit?: RegExp
  /** Dropped from the output entirely. */
  drop?: RegExp
  /** Value replaced by `[redacted]` (null / undefined kept). */
  secret: RegExp
  /** String value masked to `a***@domain`. */
  email: RegExp
  /** String value reduced to a URL without credentials, query or fragment. */
  url?: RegExp
  /** Keep `.` when normalising (dotted attribute names like `url.query`). */
  keepDots?: boolean
}

export interface RedactionPolicy {
  keys: KeyRules
  /** Length cap of every string. */
  maxString: number
  /** Drop URL credentials from text instead of marking them `[redacted]@`. */
  dropUserinfo?: boolean
  /** Length cap of an Error's stack. */
  maxStack: number
  /** Nesting below this depth becomes `[nested]`. */
  maxDepth: number
  /** Array items kept. */
  maxItems: number
  /** Object keys kept. */
  maxKeys: number
}

/** Lower-cased, separators removed: `api_key`, `apiKey` and `API-KEY` all become `apikey`. */
function normaliseKey(key: string, keepDots = false): string {
  return key.toLowerCase().replace(keepDots ? /[^a-z0-9.]/g : /[^a-z0-9]/g, '')
}

function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max}]` : text
}

/** `jane.doe@example.org` → `j***@example.org`. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@')
  return at < 1 ? MASK : `${address[0]}***${address.slice(at)}`
}

// Bounded runs (RFC 5321 lengths): with `+` a long run of address characters
// without an `@` is rescanned from every start position (quadratic).
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}\.[A-Za-z0-9.-]{1,253}/g
const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#@]{0,256}@|)([^\s?#"'<>)\]]*)([?#][^\s"'<>)\]]*|)/gi
const BEARER = /\b(Bearer|Basic)\s+[A-Z0-9._~+/=-]{8,}/gi
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g
const PROVIDER_KEY = /\b(?:sk|pk|rk|whsec|xox[bp])[-_][A-Za-z0-9_-]{16,}/g
const AWS_SIGNATURE = /\b(X-Amz-(?:Signature|Credential|Security-Token))=[^&\s"']+/gi
const KEY_VALUE_SECRET = /\b(token|secret|password|api[_-]?key|signature|t)=([^&\s"']+)/gi

/**
 * Free text with URL credentials and queries, bearer tokens, JWTs, provider
 * keys, `secret=` pairs and email addresses redacted, length-capped. URL
 * credentials become `[redacted]@` (the reader still sees that the URL had
 * some), or vanish with `dropUserinfo`.
 */
export function redactText(text: string, max: number, dropUserinfo = false): string {
  const out = (text.length > max * 4 ? text.slice(0, max * 4) : text)
    // URLs first: the masks below contain `]`, which would end a URL match early.
    .replace(URL_IN_TEXT, (_m, scheme: string, userinfo: string | undefined, rest: string, tail: string | undefined) =>
      `${scheme}${userinfo && !dropUserinfo ? `${MASK}@` : ''}${rest}${tail ? '?[query]' : ''}`)
    .replace(BEARER, `$1 ${MASK}`)
    .replace(JWT, MASK)
    .replace(PROVIDER_KEY, MASK)
    .replace(AWS_SIGNATURE, `$1=${MASK}`)
    .replace(KEY_VALUE_SECRET, `$1=${MASK}`)
    .replace(EMAIL_IN_TEXT, maskEmail)
  return capText(out, max)
}

/** A URL without credentials, query string or fragment. */
export function redactUrl(url: string, max: number): string {
  const q = url.search(/[?#]/)
  const base = q === -1 ? url : url.slice(0, q)
  return capText(base.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1'), max)
}

// ---------------------------------------------------------------------------
// Deep walk

/** Returned by a step that has no opinion on the value. */
const UNDECIDED: unique symbol = Symbol('undecided')
type Step = unknown | typeof UNDECIDED

function byKey(key: string, value: unknown, policy: RedactionPolicy): Step {
  const rules = policy.keys
  const k = normaliseKey(key, rules.keepDots)
  if (rules.omit?.test(k)) return OMITTED
  if (rules.drop?.test(k)) return undefined
  if (rules.secret.test(k)) return value === undefined || value === null ? value : MASK
  if (typeof value !== 'string') return UNDECIDED
  if (rules.email.test(k)) return maskEmail(value)
  if (rules.url?.test(k)) return redactUrl(value, policy.maxString)
  return UNDECIDED
}

function primitive(value: unknown, policy: RedactionPolicy): Step {
  switch (typeof value) {
    case 'string': return redactText(value, policy.maxString, policy.dropUserinfo)
    case 'number': return Number.isFinite(value) ? value : String(value)
    case 'boolean': return value
    case 'bigint': return value.toString()
    case 'function': case 'symbol': return undefined
    case 'object': case 'undefined': return UNDECIDED
  }
}

function errorFields(err: Error, policy: RedactionPolicy, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: err.name,
    message: redactText(err.message, policy.maxString, policy.dropUserinfo),
    stack: err.stack ? redactText(err.stack, policy.maxStack, policy.dropUserinfo) : undefined
  }
  const extra = err as Error & { code?: unknown, status?: unknown, statusCode?: unknown }
  if (typeof extra.code === 'string' || typeof extra.code === 'number') out.code = extra.code
  const status = extra.status ?? extra.statusCode
  if (typeof status === 'number') out.status = status
  if (err.cause !== undefined && depth < policy.maxDepth - 1) out.cause = redactValue(err.cause, policy, depth + 1)
  return out
}

function knownObject(value: object, policy: RedactionPolicy, depth: number): Step {
  if (value instanceof Error) return errorFields(value, policy, depth)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  if (value instanceof URL) return redactText(`${value.origin}${value.pathname}${value.search ? '?[query]' : ''}`, policy.maxString)
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[bytes ${value.byteLength}]`
  return UNDECIDED
}

function redactArray(value: unknown[], policy: RedactionPolicy, depth: number): unknown[] {
  const items = value.slice(0, policy.maxItems).map(v => redactValue(v, policy, depth + 1))
  if (value.length > policy.maxItems) items.push(`[+${value.length - policy.maxItems} more]`)
  return items
}

/**
 * Redacts each entry of a plain object by key and value; entries that
 * redact to `undefined` are left out, `rename` can move a key aside.
 */
export function redactEntries(value: object, policy: RedactionPolicy, depth: number, rename?: (key: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let count = 0
  for (const [k, v] of Object.entries(value)) {
    if (++count > policy.maxKeys) {
      out['…'] = 'truncated'
      break
    }
    const clean = redactValue(v, policy, depth, k)
    if (clean !== undefined) out[rename ? rename(k) : k] = clean
  }
  return out
}

/** A deep copy of `value` with secrets redacted by key and by shape, bounded in size. */
export function redactValue(value: unknown, policy: RedactionPolicy, depth = 0, key?: string): unknown {
  if (key !== undefined) {
    const keyed = byKey(key, value, policy)
    if (keyed !== UNDECIDED) return keyed
  }
  if (value === null || value === undefined) return value
  const simple = primitive(value, policy)
  if (simple !== UNDECIDED) return simple
  if (typeof value !== 'object') return undefined
  const known = knownObject(value, policy, depth)
  if (known !== UNDECIDED) return known
  if (depth >= policy.maxDepth) return '[nested]'
  return Array.isArray(value) ? redactArray(value, policy, depth) : redactEntries(value, policy, depth + 1)
}
