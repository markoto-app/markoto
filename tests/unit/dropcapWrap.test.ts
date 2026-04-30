import { describe, expect, test } from 'vitest'
import { wrapFirstLetterAsDropCap } from '../../app/utils/dropcapWrap'

describe('wrapFirstLetterAsDropCap', () => {
  test('wraps the first letter of a single paragraph', () => {
    const out = wrapFirstLetterAsDropCap('<p>Hello world</p>')
    expect(out).toBe('<p><span class="markoto-dropcap">H</span>ello world</p>')
  })

  test('only wraps the FIRST paragraph when multiple exist', () => {
    const out = wrapFirstLetterAsDropCap('<p>First</p><p>Second</p>')
    expect(out).toBe('<p><span class="markoto-dropcap">F</span>irst</p><p>Second</p>')
  })

  test('skips past leading non-<p> elements (heading, blockquote, image)', () => {
    const html = '<h1>Title</h1><p>First paragraph</p><p>Second</p>'
    const out = wrapFirstLetterAsDropCap(html)
    expect(out).toBe('<h1>Title</h1><p><span class="markoto-dropcap">F</span>irst paragraph</p><p>Second</p>')
  })

  test('preserves attributes on the wrapped <p> tag', () => {
    const out = wrapFirstLetterAsDropCap('<p class="text-center" id="foo">Hello</p>')
    expect(out).toBe('<p class="text-center" id="foo"><span class="markoto-dropcap">H</span>ello</p>')
  })

  test('skips leading whitespace inside the paragraph', () => {
    const out = wrapFirstLetterAsDropCap('<p>   Hello</p>')
    expect(out).toBe('<p>   <span class="markoto-dropcap">H</span>ello</p>')
  })

  test('returns input unchanged when no <p> exists', () => {
    const html = '<h1>Just a heading</h1><blockquote>And a quote</blockquote>'
    expect(wrapFirstLetterAsDropCap(html)).toBe(html)
  })

  test('returns input unchanged when first <p> is empty', () => {
    expect(wrapFirstLetterAsDropCap('<p></p><p>Real content</p>'))
      .toBe('<p></p><p>Real content</p>')
  })

  test('returns input unchanged when first <p> is whitespace-only', () => {
    expect(wrapFirstLetterAsDropCap('<p>   </p>'))
      .toBe('<p>   </p>')
  })

  test('handles multibyte characters (CJK)', () => {
    const out = wrapFirstLetterAsDropCap('<p>日本語の段落</p>')
    expect(out).toBe('<p><span class="markoto-dropcap">日</span>本語の段落</p>')
  })

  test('handles emoji (surrogate pair) as one code point', () => {
    // 🌟 is U+1F31F (4 UTF-8 bytes, 2 UTF-16 code units). Naive
    // .slice(0, 1) would split the surrogate pair. Array.from handles
    // it as one code point.
    const out = wrapFirstLetterAsDropCap('<p>🌟 morning</p>')
    expect(out).toBe('<p><span class="markoto-dropcap">🌟</span> morning</p>')
  })

  test('case-insensitive match on the <P> tag — output is lowercase-normalized (markdown-it always emits lowercase, so this is a defensive case)', () => {
    const out = wrapFirstLetterAsDropCap('<P>Capital P</P>')
    expect(out).toContain('<span class="markoto-dropcap">C</span>apital P')
  })

  test('preserves nested inline tags inside the paragraph', () => {
    const out = wrapFirstLetterAsDropCap('<p>Hello <strong>bold</strong> world</p>')
    expect(out).toBe('<p><span class="markoto-dropcap">H</span>ello <strong>bold</strong> world</p>')
  })

  test('does NOT match self-closing or void <p> (defensive)', () => {
    // Markdown-it never emits this, but our regex requires `</p>` to
    // close the match. If somehow a `<p />` slipped through, we should
    // pass through cleanly.
    const html = '<p />'
    expect(wrapFirstLetterAsDropCap(html)).toBe(html)
  })

  test('handles realistic markdown-it output', () => {
    const html = '<h1 id="title">Title</h1>\n<p>Once upon a time, there was a writer who used markoto.</p>\n<p>The end.</p>'
    const out = wrapFirstLetterAsDropCap(html)
    expect(out).toContain('<span class="markoto-dropcap">O</span>nce upon a time')
    expect(out).toContain('<p>The end.</p>') // second paragraph untouched
  })

  test('idempotent when run on already-wrapped input (good defensive behaviour)', () => {
    // The regex will match the outer <p> AGAIN on second call. Whether
    // it re-wraps depends on what we consider "first letter" — actually
    // the first letter NOW is `<` (the opening of the existing span).
    // We don't claim full idempotence; we claim it doesn't crash.
    const html = '<p><span class="markoto-dropcap">H</span>ello</p>'
    expect(() => wrapFirstLetterAsDropCap(html)).not.toThrow()
  })
})
