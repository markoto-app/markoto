import type { ZodType } from 'zod'

// Conservative repair of tool-call arguments before Zod validation.
//
// Models (Mistral, GLM, small BYOK models) regularly send a number as a
// string (`"insert_line": "12"`), `null` for an optional field they mean to
// leave out, or a nested object / array serialised as a JSON string. Each of
// these costs a turn: the validation error goes back, the model resends.
// This walks the tool's Zod schema and fixes exactly those three shapes
// (plus `"true"` / `"false"` for a boolean); everything else is left for
// `safeParse` to accept or reject. A value is only ever replaced by one of
// the type the schema asks for at that spot, so coercion cannot make an
// invalid call pass a check it would otherwise fail on its merits.

interface ZodDefLike {
  type?: string
  innerType?: ZodType
  in?: ZodType
  shape?: Record<string, ZodType>
  element?: ZodType
}

function defOf(schema: ZodType | undefined): ZodDefLike {
  const def = (schema as { _zod?: { def?: ZodDefLike } } | undefined)?._zod?.def
  return def ?? {}
}

interface Unwrapped {
  /** The schema under optional / nullable / default / pipe wrappers. */
  base: ZodType | undefined
  optional: boolean
  nullable: boolean
}

const MAX_UNWRAP = 8

function unwrap(schema: ZodType | undefined): Unwrapped {
  let current = schema
  let optional = false
  let nullable = false
  for (let i = 0; i < MAX_UNWRAP; i++) {
    const def = defOf(current)
    if (def.type === 'optional' || def.type === 'default' || def.type === 'prefault') {
      optional = true
      current = def.innerType
    } else if (def.type === 'nullable') {
      nullable = true
      current = def.innerType
    } else if (def.type === 'readonly' || def.type === 'catch' || def.type === 'nonoptional') {
      current = def.innerType
    } else if (def.type === 'pipe') {
      // `.transform(...)`: the input side is what the model sends.
      current = def.in
    } else {
      break
    }
  }
  return { base: current, optional, nullable }
}

// Digits with an optional sign and dots; `Number()` rejects "1.2.3" below.
const NUMERIC = /^-?[\d.]+$/

function parseJsonContainer(value: string, kind: 'object' | 'array'): unknown {
  const trimmed = value.trim()
  const opens = kind === 'object' ? '{' : '['
  if (!trimmed.startsWith(opens)) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const isArray = Array.isArray(parsed)
    if (kind === 'array' ? isArray : (typeof parsed === 'object' && parsed !== null && !isArray)) return parsed
  } catch {
    // Not JSON: leave it to the validator.
  }
  return undefined
}

const NO_CHANGE = Symbol('no-change')
const DROP = Symbol('drop')

function coerceNumber(value: unknown): unknown {
  if (typeof value !== 'string' || !NUMERIC.test(value.trim())) return NO_CHANGE
  const n = Number(value.trim())
  return Number.isFinite(n) ? n : NO_CHANGE
}

function coerceBoolean(value: unknown): unknown {
  if (typeof value !== 'string') return NO_CHANGE
  const v = value.trim().toLowerCase()
  if (v === 'true') return true
  if (v === 'false') return false
  return NO_CHANGE
}

function coerceNestedObject(base: ZodType | undefined, value: unknown, depth: number): unknown {
  const obj = typeof value === 'string' ? parseJsonContainer(value, 'object') : value
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return NO_CHANGE
  const coerced = coerceObject(base, obj as Record<string, unknown>, depth + 1)
  return coerced === obj && typeof value !== 'string' ? NO_CHANGE : coerced
}

function coerceArray(base: ZodType | undefined, value: unknown, depth: number): unknown {
  const arr = typeof value === 'string' ? parseJsonContainer(value, 'array') : value
  if (!Array.isArray(arr)) return NO_CHANGE
  const element = defOf(base).element
  let changed = typeof value === 'string'
  const out = arr.map((item: unknown) => {
    const c = coerceValue(element, item, depth + 1)
    if (c === NO_CHANGE || c === DROP) return item
    changed = true
    return c
  })
  return changed ? out : NO_CHANGE
}

function coerceValue(schema: ZodType | undefined, value: unknown, depth: number): unknown {
  if (depth > 6) return NO_CHANGE
  const { base, optional, nullable } = unwrap(schema)
  if (value === null) return optional && !nullable ? DROP : NO_CHANGE
  const type = defOf(base).type
  if (type === 'number') return coerceNumber(value)
  if (type === 'boolean') return coerceBoolean(value)
  if (type === 'object') return coerceNestedObject(base, value, depth)
  if (type === 'array') return coerceArray(base, value, depth)
  return NO_CHANGE
}

/** Returns `obj` itself when nothing changed, else a coerced copy. */
function coerceObject(schema: ZodType | undefined, obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const shape = defOf(schema).shape
  if (!shape) return obj
  let changed = false
  const entries: Array<[string, unknown]> = []
  for (const [key, value] of Object.entries(obj)) {
    const c = Object.hasOwn(shape, key) ? coerceValue(shape[key], value, depth) : NO_CHANGE
    if (c === NO_CHANGE) {
      entries.push([key, value])
      continue
    }
    changed = true
    if (c !== DROP) entries.push([key, c])
  }
  return changed ? Object.fromEntries(entries) : obj
}

/**
 * Repair the common argument mistakes for `schema` (see the module
 * comment). Returns the input unchanged when nothing applies; never throws.
 */
export function coerceToolArgs(schema: ZodType, args: unknown): unknown {
  try {
    const { base } = unwrap(schema)
    if (defOf(base).type !== 'object') return args
    const obj = typeof args === 'string' ? parseJsonContainer(args, 'object') : args
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return args
    return coerceObject(base, obj as Record<string, unknown>, 0)
  } catch {
    return args
  }
}
