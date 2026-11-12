// Parsers that turn one raw environment string into a typed value. Every
// variable in the registry (shared/env/vars/*) is declared with one of
// them, so the same spelling means the same thing in every process.
//
// Conventions shared by all coercers:
//   - the loader trims the raw value and treats an empty string as
//     "unset" before a coercer sees it (a coercer never gets '');
//   - an invalid value throws `EnvValueError` whose message says what
//     was expected, never what was received (the value may be a secret).
//
// This file has no imports on purpose: it is the leaf the rest of shared/env builds on.

export class EnvValueError extends Error {}

export interface Coercer<T> {
  /** Short type label for the generated reference (`boolean`, `integer ≥ 0`, …). */
  readonly label: string
  /** TypeScript type of the parsed value (for generated code). */
  readonly tsType: string
  /** Expression that rebuilds this coercer from this file's exports (for generated code). */
  readonly expr: string
  /** Parse a trimmed, non-empty raw value; throws `EnvValueError`. */
  parse(raw: string): T
}

function fail(expected: string): never {
  throw new EnvValueError(`expected ${expected}`)
}

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on'])
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off'])

/** One boolean dialect for every flag: 1/true/yes/on and 0/false/no/off, any case. */
export const bool: Coercer<boolean> = {
  label: 'boolean',
  tsType: 'boolean',
  expr: 'bool',
  parse(raw) {
    const v = raw.toLowerCase()
    if (TRUE_WORDS.has(v)) return true
    if (FALSE_WORDS.has(v)) return false
    return fail('a boolean (true/false, 1/0, yes/no, on/off)')
  }
}

/** Free text. */
export const string: Coercer<string> = {
  label: 'string',
  tsType: 'string',
  expr: 'string',
  parse: raw => raw
}

interface RangeOptions {
  min?: number
  max?: number
}

function rangeLabel(base: string, opts: RangeOptions): string {
  if (opts.min !== undefined && opts.max !== undefined) return `${base} ${opts.min}–${opts.max}`
  if (opts.min !== undefined) return `${base} ≥ ${opts.min}`
  if (opts.max !== undefined) return `${base} ≤ ${opts.max}`
  return base
}

function checkRange(n: number, label: string, opts: RangeOptions): number {
  if (opts.min !== undefined && n < opts.min) fail(label)
  if (opts.max !== undefined && n > opts.max) fail(label)
  return n
}

/** A whole number (decimal digits, optional leading minus). */
export function int(opts: RangeOptions = {}): Coercer<number> {
  const label = rangeLabel('integer', opts)
  return {
    label,
    tsType: 'number',
    expr: `int(${JSON.stringify(opts)})`,
    parse(raw) {
      if (!/^-?\d+$/.test(raw)) fail(`an ${label}`)
      const n = Number(raw)
      if (!Number.isSafeInteger(n)) fail(`an ${label}`)
      return checkRange(n, `an ${label}`, opts)
    }
  }
}

/** An integer ≥ 1. */
export const positiveInt: Coercer<number> = { ...int({ min: 1 }), expr: 'positiveInt' }

/** An integer ≥ 0. */
export const nonNegativeInt: Coercer<number> = { ...int({ min: 0 }), expr: 'nonNegativeInt' }

/** A TCP port. */
export const port: Coercer<number> = { ...int({ min: 1, max: 65535 }), expr: 'port' }

/** A finite decimal number. */
export function number(opts: RangeOptions = {}): Coercer<number> {
  const label = rangeLabel('number', opts)
  return {
    label,
    tsType: 'number',
    expr: `number(${JSON.stringify(opts)})`,
    parse(raw) {
      if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) fail(`a ${label}`)
      return checkRange(Number(raw), `a ${label}`, opts)
    }
  }
}

/** A finite number > 0 (prices, budgets, plan caps). */
export const positiveNumber: Coercer<number> = {
  label: 'number > 0',
  tsType: 'number',
  expr: 'positiveNumber',
  parse(raw) {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) fail('a number > 0')
    const n = Number(raw)
    if (n <= 0) fail('a number > 0')
    return n
  }
}

/** `base` under another label, which its error message uses too. */
function relabel<T>(base: Coercer<T>, label: string, expr: string): Coercer<T> {
  return {
    label,
    tsType: base.tsType,
    expr,
    parse(raw) {
      try {
        return base.parse(raw)
      } catch (e) {
        if (e instanceof EnvValueError) fail(label)
        throw e
      }
    }
  }
}

/** A byte count (integer ≥ 1). Plain digits: `16777216`, not `16MiB`. */
export const bytes: Coercer<number> = relabel(int({ min: 1 }), 'bytes (integer ≥ 1)', 'bytes')

/** A duration in milliseconds (integer ≥ 1). */
export const durationMs: Coercer<number> = relabel(int({ min: 1 }), 'milliseconds (integer ≥ 1)', 'durationMs')

/** An absolute URL with one of the given schemes; returned as written (trimmed). */
export function url(schemes: readonly string[] = ['http', 'https']): Coercer<string> {
  const label = `${schemes.join('/')} URL`
  return {
    label,
    tsType: 'string',
    expr: `url(${JSON.stringify(schemes)})`,
    parse(raw) {
      let parsed: URL
      try {
        parsed = new URL(raw)
      } catch {
        return fail(`an absolute ${label}`)
      }
      if (!schemes.includes(parsed.protocol.slice(0, -1))) fail(`an absolute ${label}`)
      return raw
    }
  }
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i

/** A DNS hostname (letters, digits, '-', '.'); no scheme, no port. */
export const hostname: Coercer<string> = {
  label: 'hostname',
  tsType: 'string',
  expr: 'hostname',
  parse(raw) {
    if (!HOSTNAME.test(raw)) fail('a hostname (letters, digits, "-" and "." only)')
    return raw
  }
}

/**
 * One `@`, a non-empty local part, a domain with an inner dot, no whitespace
 * or `<>"`. A scan instead of `/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/`,
 * which backtracks quadratically on a long run of dots. Self-contained: this
 * file is copied into the renderer's generated env module.
 */
function isEmailAddress(value: string): boolean {
  const at = value.indexOf('@')
  if (at < 1 || at !== value.lastIndexOf('@') || /[\s<>"]/.test(value)) return false
  const domain = value.slice(at + 1)
  const dot = domain.indexOf('.', 1)
  return dot > 0 && dot < domain.length - 1
}

/** An email address. */
export const email: Coercer<string> = {
  label: 'email address',
  tsType: 'string',
  expr: 'email',
  parse(raw) {
    if (raw.length > 254 || !isEmailAddress(raw)) fail('an email address')
    return raw
  }
}

/** Text matching `re`; `expected` describes it in the error. */
export function pattern(re: RegExp, expected: string): Coercer<string> {
  return {
    label: expected,
    tsType: 'string',
    expr: `pattern(${re.toString()}, ${JSON.stringify(expected)})`,
    parse(raw) {
      if (!re.test(raw)) fail(expected)
      return raw
    }
  }
}

/** Comma-separated list; entries trimmed, empty entries dropped. */
export function csv<T = string>(item?: Coercer<T>): Coercer<T[]> {
  return {
    label: item ? `comma-separated ${item.label} list` : 'comma-separated list',
    tsType: `${item ? item.tsType : 'string'}[]`,
    expr: `csv(${item ? item.expr : ''})`,
    parse(raw) {
      const entries = raw.split(',').map(s => s.trim()).filter(Boolean)
      if (!item) return entries as T[]
      return entries.map((entry, i) => {
        try {
          return item.parse(entry)
        } catch (e) {
          if (e instanceof EnvValueError) throw new EnvValueError(`entry ${i + 1}: ${e.message}`)
          throw e
        }
      })
    }
  }
}

/** One of a fixed set of words (case-insensitive; returned lowercase). */
export function oneOf<const T extends string>(values: readonly T[]): Coercer<T> {
  return {
    label: values.join(' | '),
    tsType: values.map(v => JSON.stringify(v)).join(' | '),
    expr: `oneOf(${JSON.stringify(values)})`,
    parse(raw) {
      const v = raw.toLowerCase()
      const hit = values.find(x => x === v)
      if (hit === undefined) fail(`one of ${values.join(', ')}`)
      return hit
    }
  }
}

/** A secret of at least `minLength` characters. */
export function secret(minLength = 1): Coercer<string> {
  return {
    label: minLength > 1 ? `secret, ≥ ${minLength} chars` : 'secret',
    tsType: 'string',
    expr: `secret(${minLength})`,
    parse(raw) {
      if (raw.length < minLength) fail(`at least ${minLength} characters (got ${raw.length})`)
      return raw
    }
  }
}

/** A positive number, or the word `unlimited` (→ null). */
export function limitOrUnlimited(base: Coercer<number>): Coercer<number | null> {
  return {
    label: `${base.label}, or unlimited`,
    tsType: `${base.tsType} | null`,
    expr: `limitOrUnlimited(${base.expr})`,
    parse(raw) {
      if (raw.toLowerCase() === 'unlimited') return null
      try {
        return base.parse(raw)
      } catch (e) {
        if (e instanceof EnvValueError) fail(`a ${base.label} or "unlimited"`)
        throw e
      }
    }
  }
}
