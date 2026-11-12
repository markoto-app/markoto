// What may leave the process in a Sentry event, transaction or breadcrumb.
// One implementation for the app server and the sync server; the renderer
// image is built from `renderer/` alone and carries a byte-identical copy at
// `renderer/src/shared/utils/security/sentryScrub.ts` (pinned by
// tests/unit/platform/sentryScrub.test.ts), so this file imports nothing but
// the redaction core it shares with the logger (shared/logging/redaction.ts).
//
// The threat: Sentry is a third party that keeps events for months. Our
// URLs carry credentials in their query strings (presigned S3 URLs with
// SigV4 signatures, render tokens `?t=`, invite and unsubscribe tokens),
// request bodies carry documents and provider keys, headers carry cookies,
// bearer tokens, the internal secret and the Stripe signature, and error
// messages sometimes quote an email address or a key. Everything is
// therefore reduced to an allowlist (headers, user fields) or redacted by
// shape (queries, tokens, emails), and every string is length-capped.

import { redactText, redactUrl, redactValue, type RedactionPolicy } from '../../logging/redaction'

type Json = Record<string, unknown>

const MAX_STRING = 2_000
const MAX_STACK_STRING = 8_000

// Request headers worth keeping for triage; everything else is dropped.
const HEADER_ALLOWLIST = new Set([
  'accept', 'accept-encoding', 'accept-language', 'content-length', 'content-type',
  'host', 'origin', 'referer', 'user-agent', 'x-request-id', 'sec-fetch-site', 'sec-fetch-mode'
])

// Broader than the log policy: a third party keeps these events for months,
// so anything that might be a credential or a session handle is masked.
// Keys are compared lower-cased with separators (but not dots) removed.
const SENTRY_POLICY: RedactionPolicy = {
  keys: {
    keepDots: true,
    drop: /(^|\.)(query|querystring|fragment|search)$/,
    secret: /token|secret|passw|authoriz|cookie|signature|credential|session|apikey|privatekey|accesskey|signingkey|bearer|jwt|dsn|^key$|key$/,
    email: /email|^user\.?name$|username/,
    url: /(^|\.)url$|^url\.full$|^http\.target$|^from$|^to$/
  },
  maxString: MAX_STRING,
  dropUserinfo: true,
  maxStack: MAX_STACK_STRING,
  maxDepth: 6,
  maxItems: 50,
  maxKeys: 50
}

/** A URL without credentials, query string or fragment. */
export function scrubUrl(url: string): string {
  return redactUrl(url, MAX_STRING)
}

/** Free text with tokens, keys, URL queries and email addresses redacted, length-capped. */
export function scrubText(text: string, max = MAX_STRING): string {
  return redactText(text, max, true)
}

/** Deep copy with secrets redacted by key and by shape. */
export function scrubValue(value: unknown, key?: string, depth = 0): unknown {
  return redactValue(value, SENTRY_POLICY, depth, key)
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

function scrubLogEntry(e: Json): void {
  if (!e.logentry || typeof e.logentry !== 'object') return
  const le = e.logentry as Json
  if (typeof le.message === 'string') le.message = scrubText(le.message)
  if (le.params !== undefined) le.params = scrubValue(le.params, undefined, 1)
}

function scrubExceptions(e: Json): void {
  const exceptions = (e.exception as { values?: Json[] } | undefined)?.values
  if (Array.isArray(exceptions)) {
    for (const ex of exceptions) {
      if (typeof ex.value === 'string') ex.value = scrubText(ex.value, MAX_STACK_STRING)
      scrubStackFrames(ex.stacktrace)
    }
  }
  const threads = (e.threads as { values?: Json[] } | undefined)?.values
  if (Array.isArray(threads)) for (const t of threads) scrubStackFrames(t.stacktrace)
}

function scrubSpans(spans: unknown): void {
  if (!Array.isArray(spans)) return
  for (const span of spans as Json[]) {
    if (typeof span.description === 'string') span.description = scrubText(span.description)
    if (span.data !== undefined) span.data = scrubValue(span.data, undefined, 1)
    if (span.tags !== undefined) span.tags = scrubValue(span.tags, undefined, 1)
  }
}

function scrubEventFields(e: Json): void {
  if (typeof e.message === 'string') e.message = scrubText(e.message)
  scrubLogEntry(e)
  if (typeof e.transaction === 'string') e.transaction = scrubUrl(e.transaction)
  if ('request' in e) e.request = scrubRequest(e.request)
  if ('user' in e) e.user = scrubUser(e.user)
  for (const field of ['extra', 'contexts', 'tags'] as const) {
    if (e[field] !== undefined) e[field] = scrubValue(e[field], undefined, 1)
  }
  delete e.server_name
  scrubExceptions(e)
  if (Array.isArray(e.breadcrumbs)) e.breadcrumbs = (e.breadcrumbs as unknown[]).map(b => scrubBreadcrumb(b))
  scrubSpans(e.spans)
}

/**
 * Error events and transactions (spans included), scrubbed in place and
 * returned. Never throws: a scrubber failure drops the event instead of
 * sending it unscrubbed.
 */
export function scrubEvent<E>(event: E): E | null {
  try {
    if (!event || typeof event !== 'object') return event
    scrubEventFields(event as Json)
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
