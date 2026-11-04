/**
 * Normalisation of the `user` field of a Y.js awareness state.
 *
 * Awareness states are set by each client and relayed verbatim to every
 * other client in the room, so `user.name` / `user.color` / `user.avatarSeed`
 * are attacker-controlled for any peer. They end up in places that are
 * not escaped like text: y-codemirror.next interpolates `color` /
 * `colorLight` into a raw `style="background-color: …"` attribute for
 * remote carets and selections, PresenceBar binds `color` into inline
 * styles, `avatarSeed` seeds the locally generated avatar, and a
 * non-string name crashes the initials helper.
 *
 * `normalizeAwarenessUser` maps any input to a safe shape:
 *   - `name`     string, control/format characters stripped, trimmed,
 *                capped at AWARENESS_NAME_MAX_LENGTH; fallback "Anonymous"
 *   - `color`    `#rgb` / `#rrggbb` only; fallback AWARENESS_FALLBACK_COLOR
 *   - `colorLight` `#rgb[a]` / `#rrggbb[aa]` only; dropped otherwise
 *   - `avatarSeed` an anonymous visitor's random avatar token,
 *                `[A-Za-z0-9]{1,32}`; dropped otherwise. (There is no
 *                avatar URL any more: avatars are generated locally, so a
 *                peer can't make every viewer load an image from a host
 *                of its choosing.)
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
  avatarSeed?: string
  id?: number
  isAI?: true
}

const AVATAR_SEED_RE = /^[A-Za-z0-9]{1,32}$/

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') return AWARENESS_FALLBACK_NAME
  const cleaned = raw.replace(CONTROL_OR_FORMAT_RE, '').trim()
  if (cleaned.length === 0) return AWARENESS_FALLBACK_NAME
  // Slice on code points so a surrogate pair is never cut in half.
  return Array.from(cleaned).slice(0, AWARENESS_NAME_MAX_LENGTH).join('')
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

export function normalizeAwarenessUser(raw: unknown): NormalizedAwarenessUser | null {
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
  if (typeof user.avatarSeed === 'string' && AVATAR_SEED_RE.test(user.avatarSeed)) {
    out.avatarSeed = user.avatarSeed
  }
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
  clientIds: Iterable<number>
): void {
  const states = awareness.getStates()
  for (const clientId of clientIds) {
    if (clientId === awareness.clientID) continue
    const state = states.get(clientId)
    if (!state || !('user' in state)) continue
    const normalized = normalizeAwarenessUser(state.user)
    if (normalized === null) {
      delete state.user
    } else if (!isNormalizedAwarenessUser(state.user, normalized)) {
      state.user = normalized
    }
  }
}
