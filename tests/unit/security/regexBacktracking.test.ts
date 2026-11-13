import { describe, expect, it } from 'vitest'
import { compactFontName } from '../../../shared/utils/theme/fontSubstitution'
import { plainCommentText } from '../../../server/utils/agentic/commentTriggerPrompt'
import { extractTypedUrls, normalizeUrlForCompare } from '../../../server/utils/agentic/crossBoundary'
import { markdownImageUrls } from '../../../server/utils/agentic/imageProvenance'
import { scrubText as scrubLogText } from '../../../shared/logging/core'
import { scrubText as scrubSentryText } from '../../../shared/utils/security/sentryScrub'
import { isPlainEmail } from '../../../shared/utils/plainEmail'
import { normalizeCustomHostname } from '../../../shared/config/customDomains'
import { slugFromTitle } from '../../../shared/config/publish'
import { legalSlugify } from '../../../server/utils/privacy/legalMarkdown'
import { isInternalHostname } from '../../../server/utils/aiProviders/urlPolicy'
import { trimChars, trimEndChars } from '../../../shared/utils/trimChars'

// Inputs that made the old patterns backtrack super-linearly (font names
// from uploaded files, comment bodies, text the AI reads, log messages,
// IdP / SCIM emails, user-typed hostnames and titles). Each call must stay
// fast on a pathological input and keep its result on ordinary ones.

// Generous on purpose: a coverage-instrumented run on a shared CI runner is
// many times slower than a laptop, while a pattern that backtracks on these
// inputs takes several seconds or does not finish at all.
const BUDGET_MS = 1500

function timed<T>(fn: () => T): { value: T, ms: number } {
  const start = performance.now()
  const value = fn()
  return { value, ms: performance.now() - start }
}

describe('font names from uploaded files', () => {
  it('strips glued-on style words', () => {
    expect(compactFontName('TimesNewRomanPSMT')).toBe('timesnew')
    expect(compactFontName('HelveticaNeueLight')).toBe('helveticaneue')
    expect(compactFontName('ABCDEF+Arial-BoldMT')).toBe('arial')
  })

  it('stays linear on a run of ambiguous style words (exponential before)', () => {
    const { ms } = timed(() => compactFontName(`Arial${'psmt'.repeat(500)}x9`))
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})

describe('comment text', () => {
  it('unwraps tight bold / underline pairs only', () => {
    expect(plainCommentText('a **read** b __this__ c')).toBe('a read b this c')
    expect(plainCommentText('a ** spaced ** b')).toBe('a ** spaced ** b')
    expect(plainCommentText('***bold***')).toBe('*bold*')
  })

  it('stays linear on many unclosed markers', () => {
    const { ms } = timed(() => plainCommentText(`**a${' a'.repeat(20_000)}`.repeat(4)))
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})

describe('URLs in text the AI reads', () => {
  it('finds bare domains and links', () => {
    expect([...extractTypedUrls('see example.com/x and https://a.example.org/p')]).toEqual(['https://example.com/x', 'https://a.example.org/p'])
    expect(normalizeUrlForCompare('example.com/page).,')).toBe('https://example.com/page')
  })

  it('stays linear on a long dotted run without a TLD and on trailing punctuation', () => {
    expect(timed(() => extractTypedUrls(`${'a.'.repeat(50_000)}1`)).ms).toBeLessThan(BUDGET_MS)
    expect(timed(() => normalizeUrlForCompare(`${'.'.repeat(50_000)}x`)).ms).toBeLessThan(BUDGET_MS)
  })

  it('finds Markdown images and stays linear on unclosed ones', () => {
    expect(markdownImageUrls('![a](/api/files/d/x.png "t") ![b](<https://e.org/y.png>)')).toEqual(['/api/files/d/x.png', 'https://e.org/y.png'])
    expect(timed(() => markdownImageUrls('![x'.repeat(30_000))).ms).toBeLessThan(BUDGET_MS)
    expect(timed(() => markdownImageUrls(`![](x${' '.repeat(50_000)}y`)).ms).toBeLessThan(BUDGET_MS)
  })
})

describe('log and Sentry scrubbing', () => {
  it('still masks emails and URL credentials', () => {
    expect(scrubLogText('mail jane.doe@example.org now')).toBe('mail j***@example.org now')
    expect(scrubSentryText('https://user:pw@host.example/p?q=1')).toBe('https://host.example/p?[query]')
  })

  it('stays fast on a long run of address characters without an @', () => {
    const text = 'a'.repeat(8_000)
    expect(timed(() => scrubLogText(text)).ms).toBeLessThan(BUDGET_MS)
    expect(timed(() => scrubSentryText(text)).ms).toBeLessThan(BUDGET_MS)
  })
})

describe('emails, hostnames and slugs from users and IdPs', () => {
  it('keeps the plain email shape', () => {
    expect(isPlainEmail('a@b.co')).toBe(true)
    expect(isPlainEmail('a@b.')).toBe(false)
    expect(isPlainEmail('a@@b.co')).toBe(false)
    expect(isPlainEmail('a b@c.de')).toBe(false)
    expect(timed(() => isPlainEmail(`a@${'.'.repeat(100_000)}`)).ms).toBeLessThan(BUDGET_MS)
  })

  it('normalises hostnames, slugs and internal names linearly', () => {
    expect(normalizeCustomHostname('https://Docs.Example.com/path?x')).toBe('docs.example.com')
    expect(timed(() => normalizeCustomHostname(`${'/'.repeat(50_000)}\n`)).ms).toBeLessThan(BUDGET_MS)
    expect(slugFromTitle('--Hello, World--', 'ab12')).toBe('hello-world-ab12')
    expect(timed(() => slugFromTitle(`${'-'.repeat(50_000)}x`, 'ab12')).ms).toBeLessThan(BUDGET_MS)
    expect(legalSlugify('5. Storage location')).toBe('5-storage-location')
    expect(timed(() => isInternalHostname(`${'.'.repeat(50_000)}x`)).ms).toBeLessThan(BUDGET_MS)
  })

  it('trims character sets from the ends', () => {
    expect(trimChars('--a-b--', '-')).toBe('a-b')
    expect(trimEndChars('x).,', '.,)')).toBe('x')
  })
})
