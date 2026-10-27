/**
 * Normalisation of the `user` field of a Y.js awareness state.
 *
 * Awareness states are set by each client and relayed verbatim to every
 * other client in the room, so `user.name` / `user.color` / `user.avatar`
 * are attacker-controlled for any peer. They end up in places that are
 * not escaped like text: y-codemirror.next interpolates `color` /
 * `colorLight` into a raw `style="background-color: …"` attribute for
 * remote carets and selections, PresenceBar binds `color` into inline
 * styles and `avatar` into `<img src>`, and a non-string name crashes the
 * initials helper.
 *
 * `normalizeAwarenessUser` maps any input to a safe shape:
 *   - `name`     string, control/format characters stripped, trimmed,
 *                capped at AWARENESS_NAME_MAX_LENGTH; fallback "Anonymous"
 *   - `color`    `#rgb` / `#rrggbb` only; fallback AWARENESS_FALLBACK_COLOR
 *   - `colorLight` `#rgb[a]` / `#rrggbb[aa]` only; dropped otherwise
 *   - `avatar`   https URL, or a same-origin path / URL; dropped otherwise
 *   - `id`       positive safe integer (numeric strings are converted);
 *                dropped otherwise
 *   - `isAI`     kept only when it is literally `true`
 * Unknown fields are dropped. Non-object input returns null.
 *
 * Used on both ends: the sync server normalises states before they are
 * re-broadcast, and the editor normalises again on receipt (a client
 * cannot rely on every server it talks to being patched).
 *
 * Dependency-free on purpose: imported by the sync server, which only
 * ships `shared/` with its own minimal dependency set.
 */

export const AWARENESS_NAME_MAX_LENGTH = 64
export const AWARENESS_AVATAR_MAX_LENGTH = 2048
export const AWARENESS_FALLBACK_NAME = 'Anonymous'
/** Slate blue from the app's awareness palette (`app/utils/colors.ts`). */
export const AWARENESS_FALLBACK_COLOR = '#7E8B9A'

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const HEX_COLOR_WITH_ALPHA_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
// Cc (C0/C1 controls) + Cf (format chars, incl. bidi overrides and
// zero-width joiners that can disguise a name).
const CONTROL_OR_FORMAT_RE = /[\p{Cc}\p{Cf}]/gu

export interface NormalizedAwarenessUser {
  name: string
  color: string
  colorLight?: string
  avatar?: string
  id?: number
  isAI?: true
}

export interface NormalizeAwarenessUserOptions {
  /** The origin the client runs on (e.g. `window.location.origin`).
   *  Absolute avatar URLs on that origin are accepted even over http
   *  (self-hosted instances on plain HTTP). */
  ownOrigin?: string
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') return AWARENESS_FALLBACK_NAME
  const cleaned = raw.replace(CONTROL_OR_FORMAT_RE, '').trim()
  if (cleaned.length === 0) return AWARENESS_FALLBACK_NAME
  // Slice on code points so a surrogate pair is never cut in half.
  return Array.from(cleaned).slice(0, AWARENESS_NAME_MAX_LENGTH).join('')
}

function normalizeAvatar(raw: unknown, ownOrigin: string | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > AWARENESS_AVATAR_MAX_LENGTH) return undefined
  // Same-origin absolute path (`/api/files/...`). `//host` is protocol-
  // relative — a different origin — and a backslash is normalised to a
  // slash by browsers, so both are refused.
  if (raw.startsWith('/')) {
    return raw.startsWith('//') || raw.includes('\\') ? undefined : raw
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.username || url.password) return undefined
  if (url.protocol === 'https:') return url.href
  if (ownOrigin && url.origin === ownOrigin) return url.href
  return undefined
}

function normalizeId(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined
  }
  if (typeof raw === 'string' && /^\d{1,15}$/.test(raw)) {
    const n = Number(raw)
    return n > 0 ? n : undefined
  }
  return undefined
}

export function normalizeAwarenessUser(
  raw: unknown,
  opts: NormalizeAwarenessUserOptions = {}
): NormalizedAwarenessUser | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const user = raw as Record<string, unknown>
  const out: NormalizedAwarenessUser = {
    name: normalizeName(user.name),
    color: typeof user.color === 'string' && HEX_COLOR_RE.test(user.color)
      ? user.color
      : AWARENESS_FALLBACK_COLOR
  }
  if (typeof user.colorLight === 'string' && HEX_COLOR_WITH_ALPHA_RE.test(user.colorLight)) {
    out.colorLight = user.colorLight
  }
  const avatar = normalizeAvatar(user.avatar, opts.ownOrigin)
  if (avatar !== undefined) out.avatar = avatar
  const id = normalizeId(user.id)
  if (id !== undefined) out.id = id
  if (user.isAI === true) out.isAI = true
  return out
}

/** True when `normalizeAwarenessUser` would return the input unchanged
 *  (same keys, same values) — lets callers skip a needless write. */
export function isNormalizedAwarenessUser(raw: unknown, normalized: NormalizedAwarenessUser | null): boolean {
  if (normalized === null) return raw === undefined
  if (typeof raw !== 'object' || raw === null) return false
  const user = raw as Record<string, unknown>
  const keys = Object.keys(user)
  const normalizedEntries = Object.entries(normalized)
  if (keys.length !== normalizedEntries.length) return false
  return normalizedEntries.every(([k, v]) => user[k] === v)
}

/** Minimal awareness surface the normaliser needs — structurally matches
 *  y-protocols' `Awareness` without importing it (shared/ stays yjs-free). */
export interface AwarenessStatesLike {
  clientID: number
  getStates: () => Map<number, Record<string, unknown>>
}

/**
 * Normalise the `user` field of the given clients' states IN PLACE. A
 * state whose `user` isn't an object loses the field (the peer stays
 * connected; it just renders as anonymous / is skipped by presence UI).
 * The local client's own state is never touched.
 */
export function normalizeAwarenessStates(
  awareness: AwarenessStatesLike,
  clientIds: Iterable<number>,
  opts: NormalizeAwarenessUserOptions = {}
): void {
  const states = awareness.getStates()
  for (const clientId of clientIds) {
    if (clientId === awareness.clientID) continue
    const state = states.get(clientId)
    if (!state || !('user' in state)) continue
    const normalized = normalizeAwarenessUser(state.user, opts)
    if (normalized === null) {
      delete state.user
    } else if (!isNormalizedAwarenessUser(state.user, normalized)) {
      state.user = normalized
    }
  }
}
