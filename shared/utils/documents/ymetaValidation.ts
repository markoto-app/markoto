import { isValidTheme } from '../theme/themeValidation'
import { isAudienceKind } from '../../audiences'
import { LANGUAGE_MAX_LENGTH } from '../../languages'

/**
 * Validation of the values clients write into the shared `meta` Y.Map
 * (`ymeta`). The HTTP `PUT /api/docs/:id/meta` endpoint validates title /
 * theme / description / audience / language, but every editor can also
 * write those keys straight through the Y.js WebSocket — the sync server
 * applies this module to that path, so both routes share one contract.
 *
 * Without it, any writer (including an anonymous editor of an open-edit
 * doc) could set `ymeta.theme` to an arbitrarily deep structure. The sync
 * server hashes the theme on every store and on every document load, so
 * a deep enough value overflowed the stack on load and made the document
 * permanently unloadable.
 *
 * yjs-free on purpose: shared/ is imported by the sync server, which
 * resolves its own `yjs`. Callers turn Y types into a rejection
 * themselves (a nested Y type is never a valid meta value).
 */

export const META_TITLE_MAX_LENGTH = 255
export const META_DESCRIPTION_MAX_LENGTH = 500
const META_LANGUAGE_MAX_LENGTH = LANGUAGE_MAX_LENGTH
const META_TEMPLATE_ID_MAX_LENGTH = 64

/** Structural bounds for JSON values. A DocTheme is three levels deep
 *  with a few hundred leaves; anything far beyond that is not a theme. */
export const META_THEME_MAX_DEPTH = 8
export const META_THEME_MAX_NODES = 2000
/** Bounds for keys this version doesn't know (forward compatibility with
 *  newer clients — see the ymeta migration playbook in sync-server/AGENTS.md). */
const META_UNKNOWN_MAX_DEPTH = 4
const META_UNKNOWN_MAX_NODES = 64
const META_UNKNOWN_MAX_STRING_LENGTH = 4096

interface JsonBounds {
  maxDepth: number
  maxNodes: number
  maxStringLength?: number
}

/**
 * True when `value` is plain JSON (null / boolean / finite number /
 * string / array / plain object) within the given depth and node count.
 * Iterative — never recurses, so a hostile depth can't blow the stack.
 */
export function isBoundedJsonValue(value: unknown, bounds: JsonBounds): boolean {
  const stack: Array<{ v: unknown, depth: number }> = [{ v: value, depth: 0 }]
  let nodes = 0
  while (stack.length > 0) {
    const next = stack.pop()
    if (!next) break
    const { v, depth } = next
    nodes++
    if (nodes > bounds.maxNodes || depth > bounds.maxDepth) return false
    if (v === null || typeof v === 'boolean') continue
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return false
      continue
    }
    if (typeof v === 'string') {
      if (bounds.maxStringLength !== undefined && v.length > bounds.maxStringLength) return false
      continue
    }
    if (Array.isArray(v)) {
      for (const item of v) stack.push({ v: item, depth: depth + 1 })
      continue
    }
    if (typeof v === 'object') {
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) return false
      for (const item of Object.values(v)) stack.push({ v: item, depth: depth + 1 })
      continue
    }
    return false
  }
  return true
}

function isBoundedString(v: unknown, max: number): boolean {
  return typeof v === 'string' && v.length <= max
}

/**
 * Is `value` an acceptable value for `ymeta[key]`? Mirrors the HTTP
 * meta endpoint's checks; `_deleted` is the server-set deletion flag.
 */
export function isValidMetaValue(key: string, value: unknown): boolean {
  switch (key) {
    case 'title':
      return isBoundedString(value, META_TITLE_MAX_LENGTH)
    case 'description':
      return isBoundedString(value, META_DESCRIPTION_MAX_LENGTH)
    case 'language':
      return isBoundedString(value, META_LANGUAGE_MAX_LENGTH)
    case 'templateId':
      return isBoundedString(value, META_TEMPLATE_ID_MAX_LENGTH)
    case 'audience':
      return isAudienceKind(value)
    case '_deleted':
      return typeof value === 'boolean'
    case 'theme':
      // Bounds first: they are cheap and iterative, and keep the schema
      // parse away from pathological input.
      return isBoundedJsonValue(value, { maxDepth: META_THEME_MAX_DEPTH, maxNodes: META_THEME_MAX_NODES })
        && isValidTheme(value)
    default:
      return isBoundedJsonValue(value, {
        maxDepth: META_UNKNOWN_MAX_DEPTH,
        maxNodes: META_UNKNOWN_MAX_NODES,
        maxStringLength: META_UNKNOWN_MAX_STRING_LENGTH
      })
  }
}

const STRING_LIMITS = {
  title: META_TITLE_MAX_LENGTH,
  description: META_DESCRIPTION_MAX_LENGTH,
  language: META_LANGUAGE_MAX_LENGTH
} as const

/** Clamp a user-typed string to the bound the sync server enforces for
 *  that key, so a legitimate client never writes a value that gets its
 *  connection closed. */
export function clampMetaString(key: keyof typeof STRING_LIMITS, value: string): string {
  return value.length > STRING_LIMITS[key] ? value.slice(0, STRING_LIMITS[key]) : value
}
