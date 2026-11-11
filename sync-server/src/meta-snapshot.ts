import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import {
  isBoundedJsonValue,
  META_THEME_MAX_DEPTH,
  META_THEME_MAX_NODES
} from '../../shared/utils/documents/ymetaValidation'
import type { PreviousMeta } from './sync-state'

/** Stand-in hash for a theme value that can't (or mustn't) be serialised.
 *  Still a stable string, so a later repair to a valid theme registers
 *  as a `theme.changed`. */
export const UNREADABLE_THEME_HASH = 'unreadable'

/**
 * Hash of the `ymeta.theme` value for `theme.changed` detection.
 *
 * Must never throw: it runs inside `onLoadDocument`, where an exception
 * rejects every connection to the document. A theme written before the
 * WebSocket path validated ymeta can be a deeply nested Y type or JSON
 * structure — `JSON.stringify` on that overflowed the stack and made the
 * document permanently unloadable. Such values hash to
 * UNREADABLE_THEME_HASH instead.
 */
export function hashMetaTheme(theme: unknown): string | null {
  if (theme === null || typeof theme !== 'object') return null
  if (theme instanceof Y.AbstractType) return UNREADABLE_THEME_HASH
  if (!isBoundedJsonValue(theme, { maxDepth: META_THEME_MAX_DEPTH, maxNodes: META_THEME_MAX_NODES })) {
    return UNREADABLE_THEME_HASH
  }
  try {
    return createHash('sha256').update(JSON.stringify(theme)).digest('hex')
  } catch {
    return UNREADABLE_THEME_HASH
  }
}

export function readMetaSnapshot(doc: Y.Doc): PreviousMeta {
  const ymeta = doc.getMap('meta')
  const t = ymeta.get('title')
  return {
    title: typeof t === 'string' ? t : null,
    themeHash: hashMetaTheme(ymeta.get('theme'))
  }
}
