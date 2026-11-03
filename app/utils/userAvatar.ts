/**
 * User avatars: DiceBear "Moods" faces, generated locally.
 *
 * Nobody's avatar is loaded from anywhere — no api.dicebear.com, no
 * GitHub/Google profile pictures (those would hand every viewer's IP to
 * the provider, and OAuth is for sign-in only). The SVG is rendered in
 * the browser from the bundled style definition and shown as a
 * `data:` URI (`img-src` already allows `data:`).
 *
 * This module is the small, synchronous half: seeds, colours and the
 * DiceBear options. The renderer itself (`userAvatarRender.ts`, which
 * pulls in `@dicebear/core` + the Moods definition) is lazy-loaded by
 * `components/common/UserAvatar.vue`.
 *
 * The "Moods" style is © DiceBear, released under CC0 1.0
 * (https://creativecommons.org/publicdomain/zero/1.0/) — no attribution
 * required. `@dicebear/core` is MIT.
 */
import { AWARENESS_PALETTE } from './colors'

/** Seed for a signed-in user. Stable everywhere the user appears. */
export function userAvatarSeed(userId: number): string {
  return `u-${userId}`
}

/** Seed for an anonymous visitor's random per-session token. A
 *  separate prefix so an anonymous peer can never pick a token that
 *  renders as a signed-in user's face. */
export function anonAvatarSeed(token: string): string {
  return `a-${token}`
}

/**
 * The seed for anyone the UI shows: a signed-in user (by id), an
 * anonymous visitor (by their broadcast session token), or — when
 * neither is known (old clients, anonymous history rows) — a fallback
 * such as the awareness client id or the display name.
 */
export function avatarSeedFor(who: { id?: number | null, avatarSeed?: string | null, fallback?: string | number | null }): string {
  if (typeof who.id === 'number') return userAvatarSeed(who.id)
  if (who.avatarSeed) return anonAvatarSeed(who.avatarSeed)
  return `x-${who.fallback ?? 'anonymous'}`
}

/**
 * Positive moods only. Moods 10.6 ships no mood tags, so this is a
 * curated allow-list of its eye + mouth variants; left out are the
 * angry, stern (`calm`), pained (`squint`), sad-looking (`lookDown`,
 * `sleepy`), worried (`wavy`, `teeth`, `grin`), startled (`open`,
 * `gasp`), flat (`line`) and frowning faces.
 */
export const POSITIVE_EYES = [
  'pupils', 'bigPupils', 'sparkle', 'small', 'uneven', 'tallPupils',
  'lookSide', 'lookUp', 'happy', 'closed', 'wink'
] as const

export const POSITIVE_MOUTHS = [
  'smile', 'wide', 'bigSmile', 'smileOpen', 'cat', 'smirk', 'tongue', 'laugh'
] as const

/** Blink speeds. The Moods animation wraps itself in
 *  `@media (prefers-reduced-motion: no-preference)`, which the browser
 *  evaluates inside the SVG image too — so reduced-motion viewers get a
 *  still face without any JS on our side. */
export const AVATAR_ANIMATIONS = ['fast', 'medium', 'slow'] as const

/** Dark sumi ink (sumi-950) for eyes + mouth, in both colour modes —
 *  it always sits on the light face tint. */
export const AVATAR_INK = '#14110D'
/** Paper (sumi-50) the face tint is mixed towards. */
const PAPER = '#FAF8F4'
const FACE_TINT = 0.6

// The awareness palette lists one tone twice; avatars want distinct
// entries so the hash spreads evenly.
const BACKGROUNDS = [...new Set(AWARENESS_PALETTE)]

/** FNV-1a 32-bit. Small, dependency-free, same result on server + client. */
export function hashSeed(seed: string): number {
  let h = 0x811C9DC5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mixHex(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  let out = '#'
  for (let i = 0; i < 3; i++) {
    const v = Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t)
    out += v.toString(16).padStart(2, '0')
  }
  return out
}

export interface AvatarColors {
  background: string
  face: string
}

/** Paper-pastel background (never shu — humans don't wear the AI red)
 *  plus a lighter face tint of the same tone. Picked by hash so the
 *  placeholder disc shown before the renderer loads already has the
 *  final colour. */
export function avatarColors(seed: string): AvatarColors {
  const background = BACKGROUNDS[hashSeed(seed) % BACKGROUNDS.length] ?? '#7E8B9A'
  return { background, face: mixHex(background, PAPER, FACE_TINT) }
}

/** DiceBear options for a seed. Pure data, so it is unit-testable
 *  without the renderer. */
export function avatarOptions(seed: string) {
  const { background, face } = avatarColors(seed)
  return {
    seed,
    backgroundColor: background,
    faceColor: face,
    inkColor: AVATAR_INK,
    eyesVariant: [...POSITIVE_EYES],
    mouthVariant: [...POSITIVE_MOUTHS],
    animationVariant: [...AVATAR_ANIMATIONS]
  }
}

/** Anonymous avatar seed for this browser tab, kept in sessionStorage
 *  so it survives reloads and reconnects for the rest of the session.
 *  Random, not derived from anything about the visitor. */
export const ANON_AVATAR_STORAGE_KEY = 'markoto-anon-avatar'
const ANON_TOKEN_RE = /^[A-Za-z0-9]{16}$/

function randomToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

export function getAnonAvatarToken(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSessionStorage()): string {
  try {
    const existing = storage?.getItem(ANON_AVATAR_STORAGE_KEY)
    if (existing && ANON_TOKEN_RE.test(existing)) return existing
  } catch {
    // Storage blocked (private mode, sandbox) — fall through to a fresh token.
  }
  const token = randomToken()
  try {
    storage?.setItem(ANON_AVATAR_STORAGE_KEY, token)
  } catch {
    // Not persisted; this page load still gets a stable face.
  }
  return token
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}
