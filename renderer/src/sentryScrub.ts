// What may leave the process in a Sentry event, transaction or breadcrumb.
// One implementation for the app server and the sync server; the renderer
// image is built from `renderer/` alone and carries a byte-identical copy at
// `renderer/src/sentryScrub.ts` (pinned by tests/unit/platform/sentryScrub.test.ts),
// so this file has no imports.
//
// The threat: Sentry is a third party that keeps events for months. Our
// URLs carry credentials in their query strings (presigned S3 URLs with
// SigV4 signatures, render tokens `?t=`, invite and unsubscribe tokens),
// request bodies carry documents and provider keys, headers carry cookies,
// bearer tokens, the internal secret and the Stripe signature, and error
// messages sometimes quote an email address or a key. Everything is
// therefore reduced to an allowlist (headers, user fields) or redacted by
// shape (queries, tokens, emails), and every string is length-capped.

type Json = Record<string, unknown>

const MASK = '[redacted]'
const MAX_STRING = 2_000
const MAX_STACK_STRING = 8_000
const MAX_DEPTH = 6
const MAX_ITEMS = 50

// Request headers worth keeping for triage; everything else is dropped.
const HEADER_ALLOWLIST = new Set([
  'accept', 'accept-encoding', 'accept-language', 'content-length', 'content-type',
  'host', 'origin', 'referer', 'user-agent', 'x-request-id', 'sec-fetch-site', 'sec-fetch-mode'
])

// Keys whose VALUE is a secret wherever they appear (extra, contexts, tags,
// span / breadcrumb data). Compared lower-cased with separators removed.
const SECRET_KEY = /token|secret|passw|authoriz|cookie|signature|credential|session|apikey|privatekey|accesskey|signingkey|bearer|jwt|dsn|^key$|key$/
const EMAIL_KEY = /email|^user\.?name$|username/
const QUERY_KEY = /(^|\.)(query|querystring|fragment|search)$/

// Bounded runs (RFC 5321 lengths): with `+` a long run of address characters
// without an `@` is rescanned from every start position (quadratic).
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}\.[A-Za-z0-9.-]{1,253}/g
const URL_WITH_PARTS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#@]{0,256}@|)([^\s?#"'<>)\]]*)([?#][^\s"'<>)\]]*|)/gi
const BEARER = /\b(Bearer|Basic)\s+[A-Z0-9._~+/=-]{8,}/gi
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g
const PROVIDER_KEY = /\b(?:sk|pk|rk|whsec|xox[bp])[-_][A-Za-z0-9_-]{16,}/g
const AWS_SIGNATURE = /\b(X-Amz-(?:Signature|Credential|Security-Token))=[^&\s"']+/gi
const KEY_VALUE_SECRET = /\b(token|secret|password|api[_-]?key|signature|t)=([^&\s"']+)/gi

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9.]/g, '')
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max}]` : text
}

/** `jane.doe@example.org` → `j***@example.org`. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@')
  return at < 1 ? MASK : `${address[0]}***${address.slice(at)}`
}

/** A URL without credentials, query string or fragment. Non-URLs go through `scrubText`. */
export function scrubUrl(url: string): string {
  const q = url.search(/[?#]/)
  const base = q === -1 ? url : url.slice(0, q)
  return cap(base.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1'), MAX_STRING)
}

/** Free text with tokens, keys, URL queries and email addresses redacted, length-capped. */
export function scrubText(text: string, max = MAX_STRING): string {
  let out = text.length > max * 4 ? text.slice(0, max * 4) : text
  // URLs first: the masks below contain `]`, which would end a URL match early.
  out = out
    .replace(URL_WITH_PARTS, (_m, scheme: string, _userinfo: string | undefined, rest: string, tail: string | undefined) =>
      `${scheme}${rest}${tail ? '?[query]' : ''}`)
    .replace(BEARER, '$1 [redacted]')
    .replace(JWT, MASK)
    .replace(PROVIDER_KEY, MASK)
    .replace(AWS_SIGNATURE, `$1=${MASK}`)
    .replace(KEY_VALUE_SECRET, `$1=${MASK}`)
    .replace(EMAIL, maskEmail)
  return cap(out, max)
}

/** Deep copy with secrets redacted by key and by shape. */
export function scrubValue(value: unknown, key?: string, depth = 0): unknown {
  if (key !== undefined) {
    const k = normaliseKey(key)
    if (QUERY_KEY.test(k)) return undefined
    if (SECRET_KEY.test(k)) return value === null || value === undefined ? value : MASK
    if (EMAIL_KEY.test(k) && typeof value === 'string') return maskEmail(value)
    if (/(^|\.)url$|^url\.full$|^http\.target$|^from$|^to$/.test(k) && typeof value === 'string') return scrubUrl(value)
  }
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return scrubText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return undefined
  if (depth >= MAX_DEPTH) return '[nested]'
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(v => scrubValue(v, undefined, depth + 1))
  const out: Json = {}
  let n = 0
  for (const [k, v] of Object.entries(value as Json)) {
    if (++n > MAX_ITEMS) break
    const clean = scrubValue(v, k, depth + 1)
    if (clean !== undefined) out[k] = clean
  }
  return out
}

function scrubHeaders(headers: unknown): Json | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const out: Json = {}
  for (const [name, value] of Object.entries(headers as Json)) {
    const lower = name.toLowerCase()
    if (!HEADER_ALLOWLIST.has(lower) || typeof value !== 'string') continue
    out[lower] = lower === 'referer' || lower === 'origin' ? scrubUrl(value) : scrubText(value, 500)
  }
  return out
}

function scrubRequest(request: unknown): Json | undefined {
  if (!request || typeof request !== 'object') return undefined
  const req = request as Json
  const out: Json = {}
  if (typeof req.method === 'string') out.method = req.method
  if (typeof req.url === 'string') out.url = scrubUrl(req.url)
  const headers = scrubHeaders(req.headers)
  if (headers) out.headers = headers
  // Nothing else: bodies (`data`), cookies, `query_string` and `env` never leave.
  return out
}

function scrubUser(user: unknown): Json | undefined {
  if (!user || typeof user !== 'object') return undefined
  const id = (user as Json).id
  // The numeric user id is enough to join with our database; no email,
  // username or IP address (sendDefaultPii is off as well).
  return id === undefined || id === null ? undefined : { id: typeof id === 'number' ? id : scrubText(String(id), 64) }
}

function scrubStackFrames(stacktrace: unknown): void {
  const frames = (stacktrace as { frames?: Json[] } | undefined)?.frames
  if (!Array.isArray(frames)) return
  for (const frame of frames) {
    // Local variables can hold anything (keys, documents).
    delete frame.vars
    if (typeof frame.context_line === 'string') frame.context_line = scrubText(frame.context_line, 500)
    delete frame.pre_context
    delete frame.post_context
    if (typeof frame.abs_path === 'string') frame.abs_path = scrubUrl(frame.abs_path)
  }
}

/** A breadcrumb with URLs reduced to origin + path and data redacted. */
export function scrubBreadcrumb<B>(crumb: B): B {
  if (!crumb || typeof crumb !== 'object') return crumb
  const c = crumb as Json
  if (typeof c.message === 'string') c.message = scrubText(c.message)
  if (c.data && typeof c.data === 'object') c.data = scrubValue(c.data, undefined, 1)
  return crumb
}

/**
 * Error events and transactions (spans included), scrubbed in place and
 * returned. Never throws: a scrubber failure drops the event instead of
 * sending it unscrubbed.
 */
export function scrubEvent<E>(event: E): E | null {
  try {
    if (!event || typeof event !== 'object') return event
    const e = event as Json
    if (typeof e.message === 'string') e.message = scrubText(e.message)
    if (e.logentry && typeof e.logentry === 'object') {
      const le = e.logentry as Json
      if (typeof le.message === 'string') le.message = scrubText(le.message)
      if (le.params !== undefined) le.params = scrubValue(le.params, undefined, 1)
    }
    if (typeof e.transaction === 'string') e.transaction = scrubUrl(e.transaction)
    if ('request' in e) e.request = scrubRequest(e.request)
    if ('user' in e) e.user = scrubUser(e.user)
    if (e.extra !== undefined) e.extra = scrubValue(e.extra, undefined, 1)
    if (e.contexts !== undefined) e.contexts = scrubValue(e.contexts, undefined, 1)
    if (e.tags !== undefined) e.tags = scrubValue(e.tags, undefined, 1)
    delete e.server_name
    const exceptions = (e.exception as { values?: Json[] } | undefined)?.values
    if (Array.isArray(exceptions)) {
      for (const ex of exceptions) {
        if (typeof ex.value === 'string') ex.value = scrubText(ex.value, MAX_STACK_STRING)
        scrubStackFrames(ex.stacktrace)
      }
    }
    const threads = (e.threads as { values?: Json[] } | undefined)?.values
    if (Array.isArray(threads)) for (const t of threads) scrubStackFrames(t.stacktrace)
    if (Array.isArray(e.breadcrumbs)) e.breadcrumbs = (e.breadcrumbs as unknown[]).map(b => scrubBreadcrumb(b))
    if (Array.isArray(e.spans)) {
      for (const span of e.spans as Json[]) {
        if (typeof span.description === 'string') span.description = scrubText(span.description)
        if (span.data !== undefined) span.data = scrubValue(span.data, undefined, 1)
        if (span.tags !== undefined) span.tags = scrubValue(span.tags, undefined, 1)
      }
    }
    return event
  } catch {
    return null
  }
}

/** Options every Sentry.init in the stack spreads in. */
export const sentryScrubOptions = {
  sendDefaultPii: false,
  beforeSend: <E>(event: E): E | null => scrubEvent(event),
  beforeSendTransaction: <E>(event: E): E | null => scrubEvent(event),
  beforeBreadcrumb: <B>(crumb: B): B => scrubBreadcrumb(crumb)
}
