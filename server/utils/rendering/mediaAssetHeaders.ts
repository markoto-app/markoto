/** Public path of the bundled media files (public/media/). */
const MEDIA_BASE = '/media/'

/** `<name>-<content hash>.<ext>`: the names scripts/demo-video/build.ts writes. */
const HASHED_NAME = /^[a-z0-9-]+-[0-9a-f]{8,}\.(mp4|webm|webp|jpg|png|vtt)$/

/**
 * Cache-Control for the bundled media under /media/ (the demo video and
 * its poster, shared/media/demoVideo.ts), or null for any other path.
 *
 * The file names carry a hash of their content, so a new cut gets a new
 * URL and a name never changes meaning: immutable for a year. Any other
 * name under /media/ revalidates (ETag) on every use.
 */
export function mediaAssetHeaders(path: string): Record<string, string> | null {
  const pathname = path.split('?')[0] ?? ''
  if (!pathname.startsWith(MEDIA_BASE)) return null
  const name = pathname.slice(MEDIA_BASE.length)
  const immutable = !name.includes('/') && HASHED_NAME.test(name)
  return { 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' }
}
