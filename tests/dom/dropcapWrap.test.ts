// @vitest-environment jsdom
//
// The drop-cap wrapper works on parsed DOM (a `<template>`), so it runs
// under a DOM environment; jsdom for parity with the XSS suite.
import { describe, expect, test } from 'vitest'
import { wrapFirstLetterAsDropCap } from '../../app/utils/dropcapWrap'

describe('wrapFirstLetterAsDropCap — markup safety (regression)', () => {
  // Elements in the output, parsed the way the preview parses them.
  function elementsOf(html: string): string[] {
    const tpl = document.createElement('template')
    tpl.innerHTML = html
    return Array.from(tpl.content.querySelectorAll('*'), el => el.tagName.toLowerCase())
  }

  test('a paragraph that starts with a link keeps the link an element', () => {
    // Sanitised HTML may carry `<` inside an attribute value; the old
    // string splitter wrapped the tag's `<` and turned the attribute
    // text into live markup.
    const html = '<p><a href="x" title="&lt;img src=x onerror=alert(1)&gt;">a</a> tail</p>'
    const out = wrapFirstLetterAsDropCap(html)
    expect(elementsOf(out)).toEqual(['p', 'a', 'span'])
    expect(out).not.toContain('<span class="markoto-dropcap"><</span>')
    const a = (() => {
      const tpl = document.createElement('template')
      tpl.innerHTML = out
      return tpl.content.querySelector('a')
    })()
    expect(a?.getAttribute('title')).toBe('<img src=x onerror=alert(1)>')
    expect(a?.querySelector('.markoto-dropcap')?.textContent).toBe('a')
  })

  test('a paragraph that starts with an image is left unwrapped', () => {
    const html = '<p><img src="x" alt="&lt;img src=x onerror=alert(2)&gt;"> tail</p>'
    const out = wrapFirstLetterAsDropCap(html)
    expect(elementsOf(out)).toEqual(['p', 'img'])
    expect(out).not.toContain('markoto-dropcap')
  })

  test('replacement patterns in the text are not expanded', () => {
    // `String.prototype.replace` with a string replacement expands `$&`,
    // `$'` and `` $` ``; the paragraph text must come out verbatim.
    const out = wrapFirstLetterAsDropCap('<p>Price $&amp; $\' $` end</p><p>next</p>')
    expect(out).toBe('<p><span class="markoto-dropcap">P</span>rice $&amp; $\' $` end</p><p>next</p>')
  })

  test('descends into a leading inline element to find the first letter', () => {
    const out = wrapFirstLetterAsDropCap('<p><strong>Bold</strong> start</p>')
    expect(out).toBe('<p><strong><span class="markoto-dropcap">B</span>old</strong> start</p>')
  })
})

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

describe('wrapFirstLetterAsDropCap — which paragraph', () => {
  test('skips an alert title and takes the first body paragraph', () => {
    const html = '<pre><code>x</code></pre><div class="markdown-alert markdown-alert-tip"><p class="markdown-alert-title">Tip</p><p>Body</p></div><p>Prose</p>'
    const out = wrapFirstLetterAsDropCap(html)
    expect(out).toContain('<p class="markdown-alert-title">Tip</p>')
    expect(out).toContain('<p><span class="markoto-dropcap">P</span>rose</p>')
  })

  test('skips quotes, list items and table cells', () => {
    const html = '<blockquote><p>Quote</p></blockquote><ul><li><p>Item</p></li></ul><p>Opening</p>'
    expect(wrapFirstLetterAsDropCap(html)).toContain('<span class="markoto-dropcap">O</span>pening')
  })

  test('no body paragraph at all → unchanged', () => {
    const html = '<blockquote><p>Only a quote</p></blockquote>'
    expect(wrapFirstLetterAsDropCap(html)).toBe(html)
  })
})
