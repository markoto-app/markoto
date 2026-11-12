// Comment body is plain text plus `@[Display Name](user:123)` mention
// tokens. Parser turns the string into a sequence of text + mention
// segments for renderers to walk. Single-pass regex; tokens may be
// adjacent (`@[A](user:1)@[B](user:2)`): the global flag with
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
     * `@markoto` (or the older `@ai`) mention: summons the AI assistant
     * to act on the comment thread. Detected case-insensitively at word
     * boundaries (so `email@ai.example.com` does NOT match) and rendered
     * as a distinct badge so users see that the comment triggers the AI.
     */
    | { kind: 'ai-mention', raw: string }

/**
 * Hard caps on comment body length. The composer enforces them with
 * `maxlength`; the composable also slices in case a paste or programmatic
 * insert gets past it. They bound how much a paste can add to the doc's
 * Y.js state.
 */
export const COMMENT_BODY_MAX = 4000
export const REPLY_BODY_MAX = 2000

const MENTION_RE = /@\[([^\]]+)\]\(user:(\d+)\)/g
// `@markoto` at a word boundary, case-insensitive. The leading guard
// keeps it from matching inside emails or URLs; the trailing lookahead
// keeps `@markoto-something` out. `@ai` is still recognised so existing
// comments keep their chip, both forms render as the markoto pill.
const AI_MENTION_RE = /(^|[^\w@])@(markoto|ai)(?=[^\w]|$)/gi

interface SegmentMatch {
  index: number
  end: number
  segment: CommentSegment
}

export function parseCommentBody(body: string): CommentSegment[] {
  const matches: SegmentMatch[] = []

  MENTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MENTION_RE.exec(body)) !== null) {
    matches.push({
      index: m.index,
      end: m.index + m[0].length,
      segment: { kind: 'mention', name: m[1] ?? '', userId: Number(m[2]) }
    })
  }

  AI_MENTION_RE.lastIndex = 0
  let am: RegExpExecArray | null
  while ((am = AI_MENTION_RE.exec(body)) !== null) {
    // Group 1 (the char before the `@`) stays text, outside the chip.
    const lead = am[1] ?? ''
    const tag = am[2] ?? 'markoto'
    const chipStart = am.index + lead.length
    const chipEnd = chipStart + 1 + tag.length // '@' + tag
    matches.push({
      index: chipStart,
      end: chipEnd,
      segment: { kind: 'ai-mention', raw: body.slice(chipStart, chipEnd) }
    })
  }

  matches.sort((a, b) => a.index - b.index)

  const segments: CommentSegment[] = []
  let last = 0
  for (const match of matches) {
    if (match.index < last) continue // overlapping match, skip
    if (match.index > last) {
      segments.push({ kind: 'text', text: body.slice(last, match.index) })
    }
    segments.push(match.segment)
    last = match.end
  }
  if (last < body.length) {
    segments.push({ kind: 'text', text: body.slice(last) })
  }
  return segments
}

/**
 * Whether a comment body contains the AI mention. The client uses it to
 * decide whether to call the trigger-ai endpoint after the Y.js commit.
 */
export function hasAiMention(body: string): boolean {
  AI_MENTION_RE.lastIndex = 0
  const has = AI_MENTION_RE.test(body)
  AI_MENTION_RE.lastIndex = 0
  return has
}

/**
 * Encode a mention token. Stripping `]` from the name keeps the regex
 * unambiguous; the name is for display so the substitution is safe.
 */
export function formatMentionToken(name: string, userId: number): string {
  const safeName = name.replace(/[\]\\]/g, '').slice(0, 80)
  return `@[${safeName}](user:${userId})`
}
