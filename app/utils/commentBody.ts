// Comment body is plain text plus `@[Display Name](user:123)` mention
// tokens. Parser turns the string into a sequence of text + mention
// segments for renderers to walk. Single-pass regex; tokens may be
// adjacent (`@[A](user:1)@[B](user:2)`) — the global flag with
// `lastIndex` reset handles that.
//
// Why not full markdown? Comments are short discussion threads, not
// authored content. Plain text + mentions matches Word/Google-Docs
// behavior and keeps the renderer minimal (no markdown-it, no DOMPurify
// allowlist to maintain).

export type CommentSegment
  = | { kind: 'text', text: string }
    | { kind: 'mention', userId: number, name: string }

/**
 * Hard caps on comment body length. Composer enforces visually via
 * `maxlength`; the composable also slices defensively in case a
 * keyboard-shortcut paste or programmatic insert sneaks past. Generous
 * enough to cover real discussion (a few paragraphs) but bounded so a
 * malicious paste can't bloat the doc's Y.js state.
 */
export const COMMENT_BODY_MAX = 4000
export const REPLY_BODY_MAX = 2000

const MENTION_RE = /@\[([^\]]+)\]\(user:(\d+)\)/g

export function parseCommentBody(body: string): CommentSegment[] {
  const segments: CommentSegment[] = []
  let last = 0
  MENTION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MENTION_RE.exec(body)) !== null) {
    if (match.index > last) {
      segments.push({ kind: 'text', text: body.slice(last, match.index) })
    }
    segments.push({
      kind: 'mention',
      name: match[1] ?? '',
      userId: Number(match[2])
    })
    last = match.index + match[0].length
  }
  if (last < body.length) {
    segments.push({ kind: 'text', text: body.slice(last) })
  }
  return segments
}

/**
 * Encode a mention token. Stripping `]` from the name keeps the regex
 * unambiguous; the name is for display so the substitution is safe.
 */
export function formatMentionToken(name: string, userId: number): string {
  const safeName = name.replace(/[\]\\]/g, '').slice(0, 80)
  return `@[${safeName}](user:${userId})`
}

