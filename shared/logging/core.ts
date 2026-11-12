// The logger every backend process shares: the Nuxt server, the sync server
// and (through a byte-identical copy at renderer/src/logging-core.ts, pinned
// by tests/unit/logging/core.test.ts) the renderer, whose image is built
// from renderer/ alone.
//
// Dependency-free on purpose: no imports, no process.env. Each process hands
// in its level and format through `createLogging` (see
// server/utils/platform/logger.ts, sync-server/src/logger.ts,
// renderer/src/logger.ts).
//
// One record per line. Production: JSON (`time`, `level`, `component`, `msg`,
// then the structured fields), so `docker logs` output is machine-readable.
// Development: one readable line. Tests: silent unless a test captures.
//
// The redaction lives here, not in the call sites: a field named like a
// secret is masked, an email address is masked to `a***@domain`, URL query
// strings (render tokens, presigned S3 signatures) are cut, long strings are
// truncated, and request bodies are never written. Logging never throws.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFormat = 'json' | 'pretty' | 'silent'
export type LogFields = Record<string, unknown>

export interface LogRecord {
  time: string
  level: LogLevel
  component: string
  msg: string
  [field: string]: unknown
}

export interface Logger {
  debug: (msg: string, fields?: LogFields) => void
  info: (msg: string, fields?: LogFields) => void
  warn: (msg: string, fields?: LogFields) => void
  error: (msg: string, fields?: LogFields) => void
  /** A logger that adds `fields` to every record it writes (a doc id, a session id). */
  with: (fields: LogFields) => Logger
}

export interface LogRuntime {
  /** Minimum level, read on every call so a test or a reload can change it. */
  level: () => LogLevel
  format: () => LogFormat
  /** Fields attached to every record of the current execution (the request id). */
  context?: () => LogFields | undefined
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']
/** `info` for anything that is not a level (the env parser already refused those at boot). */
export function asLogLevel(value: unknown): LogLevel {
  return LOG_LEVELS.find(l => l === value) ?? 'info'
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const MAX_STRING = 500
const MAX_STACK = 2000
const MAX_DEPTH = 4
const MAX_ITEMS = 20
const MAX_KEYS = 40
const MASKED = '[redacted]'
const OMITTED = '[omitted]'

const RESERVED = new Set(['time', 'level', 'component', 'msg'])

// ---------------------------------------------------------------------------
// Redaction

/** Lower-cased, separators removed: `api_key`, `apiKey` and `API-KEY` all become `apikey`. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const SECRET_KEY = /password|passwd|secret|authorization|cookie|apikey|privatekey|accesskey|signingkey|credential|jwt|bearer|token$/
const EMAIL_KEY = /email$/
const BODY_KEY = /^(body|rawbody|requestbody|responsebody|headers|payload)$/

/** `jane.doe@example.org` → `j***@example.org`. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 1) return MASKED
  return `${address[0]}***${address.slice(at)}`
}

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]*@)?([^\s?#"'<>)\]]*)(\?[^\s"'<>)\]]*)?/gi
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g
const PROVIDER_KEY = /\b(?:sk|pk|rk|whsec|xox[bp])[-_][A-Za-z0-9_-]{16,}/g

/** Redacts secrets, emails and URL queries inside free text, and bounds its length. */
export function scrubText(text: string, max = MAX_STRING): string {
  let out = text
  if (out.length > max * 4) out = out.slice(0, max * 4)
  out = out
    .replace(URL_IN_TEXT, (_m, scheme: string, userinfo: string | undefined, rest: string, query: string | undefined) =>
      `${scheme}${userinfo ? '[redacted]@' : ''}${rest}${query ? '?[query]' : ''}`)
    .replace(BEARER, '$1 [redacted]')
    .replace(JWT, MASKED)
    .replace(PROVIDER_KEY, MASKED)
    .replace(EMAIL_IN_TEXT, maskEmail)
  return out.length > max ? `${out.slice(0, max)}…[+${out.length - max}]` : out
}

function errorFields(err: Error, depth: number): LogFields {
  const out: LogFields = {
    name: err.name,
    message: scrubText(err.message),
    stack: err.stack ? scrubText(err.stack, MAX_STACK) : undefined
  }
  const extra = err as Error & { code?: unknown, status?: unknown, statusCode?: unknown }
  if (typeof extra.code === 'string' || typeof extra.code === 'number') out.code = extra.code
  const status = extra.status ?? extra.statusCode
  if (typeof status === 'number') out.status = status
  if (err.cause !== undefined && depth < MAX_DEPTH - 1) out.cause = sanitise(err.cause, depth + 1)
  return out
}

function sanitise(value: unknown, depth: number, key?: string): unknown {
  if (key !== undefined) {
    const k = normaliseKey(key)
    if (BODY_KEY.test(k)) return OMITTED
    if (SECRET_KEY.test(k)) return value === undefined || value === null ? value : MASKED
    if (EMAIL_KEY.test(k) && typeof value === 'string') return maskEmail(value)
  }
  if (value === null || value === undefined) return value
  switch (typeof value) {
    case 'string': return scrubText(value)
    case 'number': return Number.isFinite(value) ? value : String(value)
    case 'boolean': return value
    case 'bigint': return value.toString()
    case 'function': case 'symbol': return undefined
  }
  if (value instanceof Error) return errorFields(value, depth)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  if (value instanceof URL) return scrubText(`${value.origin}${value.pathname}${value.search ? '?[query]' : ''}`)
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[bytes ${value.byteLength}]`
  if (depth >= MAX_DEPTH) return '[nested]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map(v => sanitise(v, depth + 1))
    if (value.length > MAX_ITEMS) items.push(`[+${value.length - MAX_ITEMS} more]`)
    return items
  }
  const out: LogFields = {}
  let count = 0
  for (const [k, v] of Object.entries(value as object)) {
    if (++count > MAX_KEYS) {
      out['…'] = 'truncated'
      break
    }
    const clean = sanitise(v, depth + 1, k)
    if (clean !== undefined) out[k] = clean
  }
  return out
}

/** The redaction applied to every record's fields (exported for tests). */
export function sanitiseFields(fields: LogFields): LogFields {
  const out: LogFields = {}
  let count = 0
  for (const [k, v] of Object.entries(fields)) {
    if (++count > MAX_KEYS) {
      out['…'] = 'truncated'
      break
    }
    const clean = sanitise(v, 0, k)
    if (clean !== undefined) out[RESERVED.has(k) ? `field_${k}` : k] = clean
  }
  return out
}

// ---------------------------------------------------------------------------
// Output

type Sink = (record: LogRecord) => void
let sink: Sink | null = null

/**
 * Route records to `fn` instead of the console (tests). Records still pass
 * the level check and the redaction. `null` restores the console.
 */
export function setLogSink(fn: Sink | null): void {
  sink = fn
}

function pretty(record: LogRecord): string {
  const { time, level, component, msg, ...rest } = record
  const fields = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'string' && !/\s/.test(v) ? v : JSON.stringify(v)}`)
  return `${time.slice(11, 23)} ${level.toUpperCase().padEnd(5)} [${component}] ${msg}${fields.length ? ` ${fields.join(' ')}` : ''}`
}

function emit(runtime: LogRuntime, level: LogLevel, component: string, msg: string, bound: LogFields | undefined, fields: LogFields | undefined): void {
  try {
    // Format first: under Vitest it is 'silent' and the level read (a full
    // env parse there) is skipped.
    const format = runtime.format()
    if (format === 'silent' && !sink) return
    if (RANK[level] < RANK[runtime.level()]) return
    const merged = { ...runtime.context?.(), ...bound, ...fields }
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      component,
      msg: scrubText(String(msg), 300),
      ...sanitiseFields(merged)
    }
    if (sink) {
      sink(record)
      return
    }
    const line = format === 'json' ? JSON.stringify(record) : pretty(record)
    // stdout/stderr directly: this file is the one place allowed to write them.
    if (level === 'warn' || level === 'error') process.stderr.write(`${line}\n`)
    else process.stdout.write(`${line}\n`)
  } catch {
    // A logging fault must never take a request down.
  }
}

export function createLogging(runtime: LogRuntime): (component: string) => Logger {
  const make = (component: string, bound?: LogFields): Logger => ({
    debug: (msg, fields) => emit(runtime, 'debug', component, msg, bound, fields),
    info: (msg, fields) => emit(runtime, 'info', component, msg, bound, fields),
    warn: (msg, fields) => emit(runtime, 'warn', component, msg, bound, fields),
    error: (msg, fields) => emit(runtime, 'error', component, msg, bound, fields),
    with: extra => make(component, { ...bound, ...extra })
  })
  return component => make(component)
}

/** `NODE_ENV` + level → format: JSON in production, silent under Vitest, pretty otherwise. */
export function formatFor(nodeEnv: string | undefined): LogFormat {
  if (nodeEnv === 'production') return 'json'
  if (nodeEnv === 'test') return 'silent'
  return 'pretty'
}
