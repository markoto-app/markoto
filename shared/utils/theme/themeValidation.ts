import type { DocTheme } from '../../types/theme'
import { DocThemeSchema } from '../../types/theme'

/**
 * Structural validator for DocTheme payloads coming from the client (PUT
 * /meta) or being applied from `ymeta.theme`. The schema itself (every
 * field, range bound, enum, regex) lives in `shared/types/theme.ts` as
 * `DocThemeSchema`: single source of truth shared with the AI
 * `update_theme` tool and the `DocTheme` TypeScript type.
 *
 * This module is the thin "does it validate?" boundary callers use when
 * they only need a yes/no. Callers that want the failure path (richer
 * 400s with field-level errors) call `DocThemeSchema.safeParse(t)`
 * directly and inspect `.error.issues`.
 *
 * Boundary guarantees (enforced by the Zod schema):
 *   - Strict shape: unknown fields fail via `.strict()`, a malformed
 *     client can't smuggle extra keys into `ymeta.theme`.
 *   - Numeric ranges: no `bodySize: 1e9` to crash paged.js.
 *   - Hex colors are regex-checked, `themeToCss` interpolates them
 *     directly into CSS, so arbitrary strings would be an injection
 *     vector (`red; } body { display: none`).
 *   - Font names are ASCII-only, length-capped, they become quoted
 *     CSS `font-family` values. A stray quote would escape the string.
 *   - Header/footer templates strip `{title}/{page}/{pages}/{date}`
 *     tokens before checking for CSS-escape characters.
 */
export function isValidTheme(t: unknown): t is DocTheme {
  return DocThemeSchema.safeParse(t).success
}
