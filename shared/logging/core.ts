// The logger every backend process shares: the Nuxt server, the sync server
// and the renderer.
//
// Dependency-free on purpose: no package imports (only the sibling
// redaction core), no process.env. Each process hands
// in its level and format through `createLogging` (see
// server/utils/platform/logger.ts, sync-server/src/logger.ts,
// renderer/src/logger.ts).
//
// One record per line. Production: JSON (`time`, `level`, `component`, `msg`,
// then the structured fields), so `docker logs` output is machine-readable.
// Development: one readable line. Tests: silent unless a test captures.
//
// The redaction lives here (rules in ./redaction.ts, shared with the Sentry
// scrubber), not in the call sites: a field named like a secret is masked,
// an email address is masked to `a***@domain`, URL query strings (render
// tokens, presigned S3 signatures) are cut, long strings are truncated, and
// request bodies are never written. Logging never throws.

import { maskEmail, redactEntries, redactText, type RedactionPolicy } from './redaction'

export { maskEmail }

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
const RESERVED = new Set(['time', 'level', 'component', 'msg'])

// ---------------------------------------------------------------------------
// Redaction

// Narrower than the Sentry policy on purpose: ids that merely contain "key"
// or "session" (`s3Key`, `keyId`, `sessionId`, `tokenHash`) stay readable in
// our own logs, while anything that names a credential is masked.
const LOG_POLICY: RedactionPolicy = {
  keys: {
    omit: /^(body|rawbody|requestbody|responsebody|headers|payload)$/,
    secret: /password|passwd|secret|authorization|cookie|apikey|privatekey|accesskey|signingkey|credential|jwt|bearer|(?:token$)/,
    email: /email$/
  },
  maxString: MAX_STRING,
  maxStack: 2000,
  maxDepth: 4,
  maxItems: 20,
  maxKeys: 40
}

/** Redacts secrets, emails and URL queries inside free text, and bounds its length. */
export function scrubText(text: string, max = MAX_STRING): string {
  return redactText(text, max)
}

/** The redaction applied to every record's fields (exported for tests). */
export function sanitiseFields(fields: LogFields): LogFields {
  return redactEntries(fields, LOG_POLICY, 0, k => (RESERVED.has(k) ? `field_${k}` : k))
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
