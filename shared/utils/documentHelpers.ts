import type * as Y from 'yjs'
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { isValidTheme } from '~~/shared/utils/themeValidation'

/**
 * Small pure helpers lifted out of `useDocument.ts` so they're testable
 * in isolation (no Vue reactivity, no Nuxt auto-imports). Each one
 * pins a single derivation the orchestrator makes:
 *
 *   - `readThemeFromYmeta` — "what theme does the Y.Map currently
 *     advertise, and is it valid enough to render?"
 *   - `canEditTheme` — "given the access-mode state, may this user
 *     write the theme at all?"
 *   - `docSizeWarning` — "translate raw Y.js state byte count into
 *     the banner severity shown in the status bar."
 *
 * Extracting these keeps the orchestrator's surface thin and lets the
 * unit suite cover the invariants without spinning up Nuxt.
 */

/**
 * Read the theme off a Y.Map (the `meta` map in our case). Returns the
 * default theme if the field is missing, corrupted, or fails schema
 * validation — the caller never has to handle bad data.
 */
export function readThemeFromYmeta(ymeta: Y.Map<unknown>): DocTheme {
  const raw = ymeta.get('theme')
  return isValidTheme(raw) ? raw : defaultTheme
}

/**
 * Theme write access mirrors content write access:
 *   - read-only? no.
 *   - has an owner and you're not them? no.
 *   - no owner (anonymous-created doc)? yes — `open-edit` means
 *     "anyone can change anything", which includes the theme.
 *
 * The DB-write path (PUT /meta) has its own ownership guard for owned
 * docs. For ownerless docs the caller skips the persist hop and lets
 * Y.js sync be the source of truth.
 */
export function canEditTheme(state: {
  isReadOnly: boolean
  isOwner: boolean
  hasOwner: boolean
}): boolean {
  if (state.isReadOnly) return false
  if (state.isOwner) return true
  return !state.hasOwner
}

/**
 * Translate Y.js-encoded state size into a UI banner severity. The
 * thresholds match the AGENTS.md "doc compaction" TODO — above 8 MB
 * is a hard "do something" signal; 5–8 MB is a soft warning. Below
 * 5 MB, no banner.
 */
export function docSizeWarning(bytes: number): 'warning' | 'critical' | null {
  const mb = bytes / (1024 * 1024)
  if (mb > 8) return 'critical'
  if (mb > 5) return 'warning'
  return null
}
