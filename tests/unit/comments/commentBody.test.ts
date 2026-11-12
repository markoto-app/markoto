import { describe, it, expect } from 'vitest'
import {
  parseCommentBody,
  formatMentionToken,
  hasAiMention,
  COMMENT_BODY_MAX,
  REPLY_BODY_MAX
} from '../../../app/utils/comments/commentBody'

// Comment body parser: turns `@[Display Name](user:N)` mention tokens into
// segments while leaving everything else as plain text.
//
// Behaviour we want to lock in:
//   - Plain text passes through unchanged.
//   - Valid mentions are extracted with the correct name + numeric id.
//   - Malformed tokens (non-numeric id, unbalanced brackets, empty name)
//     stay in the text segment instead of producing a broken mention.
//   - Adjacent mentions both parse without losing characters between them.
//   - Round-trip: format + parse = original logical content.

describe('parseCommentBody', () => {
  it('returns an empty array for an empty body', () => {
    // Empty string has no segments at all, callers can rely on
    // `.length === 0` to render an empty-state placeholder.
    expect(parseCommentBody('')).toEqual([])
  })

  it('returns a single text segment when there are no mentions', () => {
    expect(parseCommentBody('hello world')).toEqual([
      { kind: 'text', text: 'hello world' }
    ])
  })

  it('preserves whitespace-only bodies as a text segment', () => {
    // Whitespace is meaningful in a comment (line breaks between
    // paragraphs); we don't collapse or trim it at parse time.
    expect(parseCommentBody('  \n  ')).toEqual([
      { kind: 'text', text: '  \n  ' }
    ])
  })

  it('extracts a single mention from a body', () => {
    expect(parseCommentBody('@[Alice](user:5)')).toEqual([
      { kind: 'mention', userId: 5, name: 'Alice' }
    ])
  })

  it('splits text + mention + text', () => {
    expect(parseCommentBody('hi @[Alice](user:5) there')).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'mention', userId: 5, name: 'Alice' },
      { kind: 'text', text: ' there' }
    ])
  })

  it('handles mentions adjacent to each other with no text between them', () => {
    // The regex's `lastIndex` advance must place both mentions in the
    // output. A bug where one mention swallows the other would produce
    // a single segment.
    expect(parseCommentBody('@[Alice](user:1)@[Bob](user:2)')).toEqual([
      { kind: 'mention', userId: 1, name: 'Alice' },
      { kind: 'mention', userId: 2, name: 'Bob' }
    ])
  })

  it('keeps a malformed token as text when the user id is not numeric', () => {
    // `user:abc` doesn't match `\d+`, the whole thing should fall
    // through to plain text instead of producing a `mention` segment
    // with a NaN id.
    expect(parseCommentBody('@[Alice](user:abc)')).toEqual([
      { kind: 'text', text: '@[Alice](user:abc)' }
    ])
  })

  it('keeps a malformed token as text when the name is empty', () => {
    // `[^\]]+` requires at least one character, empty `[]` shouldn't
    // produce a mention.
    expect(parseCommentBody('@[](user:5)')).toEqual([
      { kind: 'text', text: '@[](user:5)' }
    ])
  })

  it('does NOT match when there are stray brackets between name and id', () => {
    // `@[A]B](user:5)`: a malicious crafted body shouldn't sneak past
    // the parser. Either it parses as a clean mention with name "A" or
    // not at all; landing in the text segment is the safe choice.
    expect(parseCommentBody('@[A]B](user:5)')).toEqual([
      { kind: 'text', text: '@[A]B](user:5)' }
    ])
  })

  it('extracts the first valid mention even when followed by a malformed one', () => {
    expect(parseCommentBody('@[A](user:1) and @[B](user:?)')).toEqual([
      { kind: 'mention', userId: 1, name: 'A' },
      { kind: 'text', text: ' and @[B](user:?)' }
    ])
  })

  it('preserves a trailing text run after the last mention', () => {
    expect(parseCommentBody('@[A](user:1) trailing')).toEqual([
      { kind: 'mention', userId: 1, name: 'A' },
      { kind: 'text', text: ' trailing' }
    ])
  })

  it('preserves a leading text run before the first mention', () => {
    expect(parseCommentBody('leading @[A](user:1)')).toEqual([
      { kind: 'text', text: 'leading ' },
      { kind: 'mention', userId: 1, name: 'A' }
    ])
  })

  it('round-trips through formatMentionToken for normal display names', () => {
    const token = formatMentionToken('Alice', 5)
    expect(token).toBe('@[Alice](user:5)')
    expect(parseCommentBody(token)).toEqual([
      { kind: 'mention', userId: 5, name: 'Alice' }
    ])
  })

  it('formatMentionToken strips closing brackets so the parser stays unambiguous', () => {
    // A user with `]` in their display name would break our regex
    // (the `[^\]]+` group stops at the bracket). Sanitising at
    // format-time means the round-trip works for arbitrary names.
    const token = formatMentionToken('Bad]Name', 7)
    expect(token).toBe('@[BadName](user:7)')
    const parsed = parseCommentBody(token)
    expect(parsed).toEqual([
      { kind: 'mention', userId: 7, name: 'BadName' }
    ])
  })

  it('formatMentionToken caps long names at 80 characters', () => {
    // Defensive: a name longer than the user-input cap shouldn't ship
    // a 1MB token. 80 chars covers any realistic display name.
    const longName = 'A'.repeat(120)
    const token = formatMentionToken(longName, 1)
    expect(token).toBe(`@[${'A'.repeat(80)}](user:1)`)
  })
})

describe('@ai mention parsing', () => {
  it('extracts a bare @ai token as an ai-mention segment', () => {
    const segments = parseCommentBody('@ai please rewrite this')
    expect(segments).toEqual([
      { kind: 'ai-mention', raw: '@ai' },
      { kind: 'text', text: ' please rewrite this' }
    ])
  })

  it('matches @AI case-insensitively', () => {
    expect(parseCommentBody('@AI summarize')).toEqual([
      { kind: 'ai-mention', raw: '@AI' },
      { kind: 'text', text: ' summarize' }
    ])
    expect(parseCommentBody('@Ai pls')).toEqual([
      { kind: 'ai-mention', raw: '@Ai' },
      { kind: 'text', text: ' pls' }
    ])
  })

  it('does NOT match inside emails', () => {
    // `joel@ai.example.com`: the `@ai` is preceded by a word char,
    // not a boundary. Should remain as a single text segment.
    const out = parseCommentBody('contact joel@ai.example.com for help')
    expect(out).toEqual([{ kind: 'text', text: 'contact joel@ai.example.com for help' }])
  })

  it('does NOT match when followed by alphanumerics (@aim)', () => {
    expect(parseCommentBody('@aim higher')).toEqual([
      { kind: 'text', text: '@aim higher' }
    ])
  })

  it('parses @ai mid-sentence with leading text', () => {
    const segments = parseCommentBody('hey @ai can you help?')
    expect(segments).toEqual([
      { kind: 'text', text: 'hey ' },
      { kind: 'ai-mention', raw: '@ai' },
      { kind: 'text', text: ' can you help?' }
    ])
  })

  it('handles @ai followed by punctuation', () => {
    const segments = parseCommentBody('@ai, please review')
    expect(segments).toEqual([
      { kind: 'ai-mention', raw: '@ai' },
      { kind: 'text', text: ', please review' }
    ])
  })

  it('keeps user mentions and @ai in order', () => {
    const segments = parseCommentBody(`@ai and @[Joel](user:1) please look`)
    expect(segments).toEqual([
      { kind: 'ai-mention', raw: '@ai' },
      { kind: 'text', text: ' and ' },
      { kind: 'mention', userId: 1, name: 'Joel' },
      { kind: 'text', text: ' please look' }
    ])
  })
})

describe('hasAiMention', () => {
  it('detects @ai at the start', () => {
    expect(hasAiMention('@ai please review')).toBe(true)
  })
  it('detects @ai mid-sentence', () => {
    expect(hasAiMention('hi @ai there')).toBe(true)
  })
  it('matches case-insensitively', () => {
    expect(hasAiMention('@AI go')).toBe(true)
    expect(hasAiMention('@Ai please')).toBe(true)
  })
  it('returns false for plain prose', () => {
    expect(hasAiMention('let me think about it')).toBe(false)
  })
  it('returns false for emails containing @ai', () => {
    expect(hasAiMention('joel@ai.test.com')).toBe(false)
  })
  it('returns false for @aim / @aiding (not a word boundary)', () => {
    expect(hasAiMention('@aim please')).toBe(false)
    expect(hasAiMention('@aiding the cause')).toBe(false)
  })
  it('repeated calls are independent (regex lastIndex reset)', () => {
    expect(hasAiMention('@ai go')).toBe(true)
    expect(hasAiMention('@ai go')).toBe(true)
    expect(hasAiMention('plain')).toBe(false)
    expect(hasAiMention('@ai go')).toBe(true)
  })
})

describe('body length constants', () => {
  it('comment cap is larger than reply cap', () => {
    // Replies are conversational; root comments are the canonical
    // discussion seed. The cap difference reflects that without
    // making the cap derivable from the reply cap (i.e. both are
    // first-class, not an inheritance).
    expect(COMMENT_BODY_MAX).toBeGreaterThan(REPLY_BODY_MAX)
  })

  it('caps are large enough for a few paragraphs but not unbounded', () => {
    // Sanity-check: caps are in the right order of magnitude. If
    // someone halves the comment cap to 200 chars, this test fires
    // before it ships to users.
    expect(COMMENT_BODY_MAX).toBeGreaterThanOrEqual(1000)
    expect(COMMENT_BODY_MAX).toBeLessThanOrEqual(20_000)
    expect(REPLY_BODY_MAX).toBeGreaterThanOrEqual(500)
    expect(REPLY_BODY_MAX).toBeLessThanOrEqual(10_000)
  })
})
