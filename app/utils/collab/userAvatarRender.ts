/**
 * The DiceBear renderer: the heavy half of the user avatars (see
 * `userAvatar.ts`). Lazy-loaded by `components/common/UserAvatar.vue`
 * so `@dicebear/core` (~45 KB gzip) + the Moods definition (~3 KB gzip)
 * stay out of the entry bundle.
 *
 * "Moods" by DiceBear: CC0 1.0 (public domain dedication), no
 * attribution required; `@dicebear/core`: MIT.
 */
import { Avatar, Style } from '@dicebear/core'
import moods from '@dicebear/styles/moods.json'
import { avatarOptions } from './userAvatar'

const style = new Style(moods)

// Same seed → same SVG, so one render per seed for the whole page
// (presence bar, comments and the activity feed show the same people).
// Bounded so a long session with many anonymous visitors can't grow it
// without limit; Map keeps insertion order, the oldest goes first.
const MAX_CACHED = 500
const cache = new Map<string, string>()

export function renderAvatarDataUri(seed: string): string {
  const hit = cache.get(seed)
  if (hit !== undefined) return hit
  const uri = new Avatar(style, avatarOptions(seed)).toDataUri()
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(seed, uri)
  return uri
}
