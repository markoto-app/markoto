// Per-document awareness hardening, attached in `afterLoadDocument`.
//
// 1. Normalise every client's `user` field before it is re-broadcast.
//    y-protocols emits `change` before `update`, and Hocuspocus
//    broadcasts on `update` by re-encoding the CURRENT states — so
//    rewriting the states in a `change` listener means peers only ever
//    receive the normalised shape (hex colour, capped name, avatar seed token,
//    numeric id). See `shared/utils/awarenessUser.ts`.
//
// 2. Remember which authenticated connection each awareness client id
//    arrived on, so the activity-log fallback attribution can name the
//    JWT identity of that connection instead of trusting the
//    client-chosen `user.name`. Read-only connections are not recorded —
//    they can't have written anything.
//
// 3. For anonymous writers, remember the random avatar token
//    (`user.avatarSeed`) their awareness carries, per awareness client
//    AND per connection, so activity rows can show the same face as the
//    presence bar. The token is random per browser tab and is already
//    broadcast to every peer; it is only ever taken from an anonymous
//    writer connection (a signed-in user's avatar is seeded by id).

import { normalizeAwarenessStates, normalizeAvatarSeed, type AwarenessStatesLike } from '../../shared/utils/awarenessUser'
import type { VerifiedIdentity } from './activity-logger'

interface AwarenessChange {
  added: number[]
  updated: number[]
  removed: number[]
}

interface AwarenessLike extends AwarenessStatesLike {
  on: (event: 'change' | 'update', listener: (change: AwarenessChange, origin: unknown) => void) => void
}

interface ConnectionLike {
  webSocket: unknown
  context: unknown
}

export interface GuardedDocument {
  awareness: AwarenessLike
  getConnections: () => ConnectionLike[]
}

/** A writer identity plus the order in which its awareness last arrived. */
export interface TrackedIdentity extends VerifiedIdentity {
  /** Monotonic per-process counter, bumped on every awareness update.
   *  Orders updates exactly, unlike wall-clock ms (two updates in the
   *  same millisecond would tie). */
  seq: number
}

const identitiesByDoc = new WeakMap<object, Map<number, TrackedIdentity>>()
const anonSeedsByDoc = new WeakMap<object, WeakMap<object, string>>()
let awarenessSeq = 0

/** JWT userId of an anonymous (signed-out) connection. */
export const ANONYMOUS_USER_ID = 'anonymous'

/** Verified identities of this document's awareness clients (writers only). */
export function awarenessIdentities(doc: object): ReadonlyMap<number, TrackedIdentity> | undefined {
  return identitiesByDoc.get(doc)
}

/**
 * The anonymous avatar token last announced over `webSocket` (the raw
 * socket of a Hocuspocus connection), or null. Only recorded for
 * anonymous writer connections.
 */
export function anonAvatarSeedForSocket(doc: object, webSocket: unknown): string | null {
  if (typeof webSocket !== 'object' || webSocket === null) return null
  return anonSeedsByDoc.get(doc)?.get(webSocket) ?? null
}

/** The anonymous avatar token in an awareness state, if any. */
function avatarSeedOfState(state: Record<string, unknown> | undefined): string | null {
  const user = state?.user
  if (typeof user !== 'object' || user === null) return null
  return normalizeAvatarSeed((user as Record<string, unknown>).avatarSeed)
}

/** The writer identity carried by a connection's auth context, if any. */
export function writerIdentityFromContext(context: unknown): VerifiedIdentity | null {
  if (typeof context !== 'object' || context === null) return null
  const ctx = context as Record<string, unknown>
  if (ctx.readOnly !== false) return null
  const rawId = ctx.userId
  let userId: string | null = null
  if (typeof rawId === 'string' && rawId.length > 0) userId = rawId
  else if (typeof rawId === 'number' && Number.isFinite(rawId)) userId = String(rawId)
  if (userId === null) return null
  return { userId, userName: typeof ctx.userName === 'string' ? ctx.userName : null }
}

export function attachAwarenessGuard(doc: GuardedDocument): void {
  const identities = new Map<number, TrackedIdentity>()
  identitiesByDoc.set(doc, identities)
  const anonSeeds = new WeakMap<object, string>()
  anonSeedsByDoc.set(doc, anonSeeds)

  doc.awareness.on('change', ({ added, updated }) => {
    normalizeAwarenessStates(doc.awareness, [...added, ...updated])
  })

  doc.awareness.on('update', ({ added, updated, removed }, origin) => {
    for (const id of removed) identities.delete(id)
    // Hocuspocus applies a client's awareness update with that client's
    // raw WebSocket as the origin.
    const connection = origin ? doc.getConnections().find(c => c.webSocket === origin) : undefined
    const identity = connection ? writerIdentityFromContext(connection.context) : null
    const seq = ++awarenessSeq
    const anonymous = identity?.userId === ANONYMOUS_USER_ID
    const states = doc.awareness.getStates()
    for (const id of [...added, ...updated]) {
      if (!identity) {
        identities.delete(id)
        continue
      }
      const seed = anonymous ? avatarSeedOfState(states.get(id)) : null
      identities.set(id, seed ? { ...identity, avatarSeed: seed, seq } : { ...identity, seq })
      if (seed && typeof origin === 'object' && origin !== null) anonSeeds.set(origin, seed)
    }
  })
}
