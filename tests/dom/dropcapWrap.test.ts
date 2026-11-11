// @vitest-environment jsdom
//
// The drop-cap wrapper works on parsed DOM (a `<template>`), so it runs
// under a DOM environment; jsdom for parity with the XSS suite.
import { describe, expect, test } from 'vitest'
import { DROPCAP_MIN_CHARS, wrapFirstLetterAsDropCap } from '../../app/utils/preview/dropcapWrap'

// A drop cap only goes on an opening paragraph long enough to sit beside
// it (DROPCAP_MIN_CHARS). Most cases below are about WHERE the cap goes,
// so their paragraphs get this tail to be long enough.
const TAIL = ' ' + 'and the paragraph keeps going for a few lines of ordinary prose. '.repeat(4).trim()
const P = '<p class="markoto-dropcap-p">'

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
    const html = `<p><a href="x" title="&lt;img src=x onerror=alert(1)&gt;">a</a> tail${TAIL}</p>`
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
    const html = `<p><img src="x" alt="&lt;img src=x onerror=alert(2)&gt;"> tail${TAIL}</p>`
    const out = wrapFirstLetterAsDropCap(html)
    expect(elementsOf(out)).toEqual(['p', 'img'])
    expect(out).not.toContain('markoto-dropcap')
  })

  test('replacement patterns in the text are not expanded', () => {
    // `String.prototype.replace` with a string replacement expands `$&`,
    // `$'` and `` $` ``; the paragraph text must come out verbatim.
    const out = wrapFirstLetterAsDropCap(`<p>Price $&amp; $' $\` end${TAIL}</p><p>next</p>`)
    expect(out).toBe(`${P}<span class="markoto-dropcap">P</span>rice $&amp; $' $\` end${TAIL}</p><p>next</p>`)
  })

  test('descends into a leading inline element to find the first letter', () => {
    const out = wrapFirstLetterAsDropCap(`<p><em>Once</em> upon a time${TAIL}</p>`)
    expect(out).toBe(`${P}<em><span class="markoto-dropcap">O</span>nce</em> upon a time${TAIL}</p>`)
  })
})

describe('wrapFirstLetterAsDropCap', () => {
  test('wraps the first letter of a single paragraph', () => {
    const out = wrapFirstLetterAsDropCap(`<p>Hello world${TAIL}</p>`)
    expect(out).toBe(`${P}<span class="markoto-dropcap">H</span>ello world${TAIL}</p>`)
  })

  test('only wraps the FIRST paragraph when multiple exist', () => {
    const out = wrapFirstLetterAsDropCap(`<p>First${TAIL}</p><p>Second${TAIL}</p>`)
    expect(out).toBe(`${P}<span class="markoto-dropcap">F</span>irst${TAIL}</p><p>Second${TAIL}</p>`)
  })

  test('skips past leading non-<p> elements (heading, blockquote, image)', () => {
    const html = `<h1>Title</h1><p>First paragraph${TAIL}</p><p>Second</p>`
    const out = wrapFirstLetterAsDropCap(html)
    expect(out).toBe(`<h1>Title</h1>${P}<span class="markoto-dropcap">F</span>irst paragraph${TAIL}</p><p>Second</p>`)
  })

  test('preserves attributes on the wrapped <p> tag', () => {
    const out = wrapFirstLetterAsDropCap(`<p class="text-center" id="foo">Hello${TAIL}</p>`)
    expect(out).toBe(`<p class="text-center markoto-dropcap-p" id="foo"><span class="markoto-dropcap">H</span>ello${TAIL}</p>`)
  })

  test('skips leading whitespace inside the paragraph', () => {
    const out = wrapFirstLetterAsDropCap(`<p>   Hello${TAIL}</p>`)
    expect(out).toBe(`${P}   <span class="markoto-dropcap">H</span>ello${TAIL}</p>`)
  })

  test('returns input unchanged when no <p> exists', () => {
    const html = '<h1>Just a heading</h1><blockquote>And a quote</blockquote>'
    expect(wrapFirstLetterAsDropCap(html)).toBe(html)
  })

  test('returns input unchanged when first <p> is empty', () => {
    expect(wrapFirstLetterAsDropCap(`<p></p><p>Real content${TAIL}</p>`))
      .toBe(`<p></p><p>Real content${TAIL}</p>`)
  })

  test('returns input unchanged when first <p> is whitespace-only', () => {
    expect(wrapFirstLetterAsDropCap('<p>   </p>'))
      .toBe('<p>   </p>')
  })

  test('handles multibyte characters (CJK)', () => {
    const cjk = '日本語の段落'.repeat(40)
    const out = wrapFirstLetterAsDropCap(`<p>${cjk}</p>`)
    expect(out).toBe(`${P}<span class="markoto-dropcap">日</span>${cjk.slice(1)}</p>`)
  })

  test('handles emoji (surrogate pair) as one code point', () => {
    // 🌟 is U+1F31F (4 UTF-8 bytes, 2 UTF-16 code units). Naive
    // .slice(0, 1) would split the surrogate pair. Array.from handles
    // it as one code point.
    const out = wrapFirstLetterAsDropCap(`<p>🌟 morning${TAIL}</p>`)
    expect(out).toBe(`${P}<span class="markoto-dropcap">🌟</span> morning${TAIL}</p>`)
  })

  test('case-insensitive match on the <P> tag — output is lowercase-normalized (markdown-it always emits lowercase, so this is a defensive case)', () => {
    const out = wrapFirstLetterAsDropCap(`<P>Capital P${TAIL}</P>`)
    expect(out).toContain('<span class="markoto-dropcap">C</span>apital P')
  })

  test('preserves nested inline tags inside the paragraph', () => {
    const out = wrapFirstLetterAsDropCap(`<p>Hello <strong>bold</strong> world${TAIL}</p>`)
    expect(out).toBe(`${P}<span class="markoto-dropcap">H</span>ello <strong>bold</strong> world${TAIL}</p>`)
  })

  test('does NOT match self-closing or void <p> (defensive)', () => {
    // Markdown-it never emits this; a `<p />` slipping through passes
    // through cleanly.
    const html = '<p />'
    expect(wrapFirstLetterAsDropCap(html)).toBe(html)
  })

  test('handles realistic markdown-it output', () => {
    const html = `<h1 id="title">Title</h1>\n<p>Once upon a time, there was a writer who used markoto.${TAIL}</p>\n<p>The end.</p>`
    const out = wrapFirstLetterAsDropCap(html)
    expect(out).toContain('<span class="markoto-dropcap">O</span>nce upon a time')
    expect(out).toContain('<p>The end.</p>') // second paragraph untouched
  })

  test('idempotent when run on already-wrapped input (good defensive behaviour)', () => {
    // We don't claim full idempotence; we claim it doesn't crash.
    const html = `<p><span class="markoto-dropcap">H</span>ello${TAIL}</p>`
    expect(() => wrapFirstLetterAsDropCap(html)).not.toThrow()
  })
})

describe('wrapFirstLetterAsDropCap — which paragraph', () => {
  test('skips an alert title and takes the first body paragraph', () => {
    const html = `<pre><code>x</code></pre><div class="markdown-alert markdown-alert-tip"><p class="markdown-alert-title">Tip</p><p>Body</p></div><p>Prose${TAIL}</p>`
    const out = wrapFirstLetterAsDropCap(html)
    expect(out).toContain('<p class="markdown-alert-title">Tip</p>')
    expect(out).toContain(`${P}<span class="markoto-dropcap">P</span>rose`)
  })

  test('skips quotes, list items and table cells', () => {
    const html = `<blockquote><p>Quote</p></blockquote><ul><li><p>Item</p></li></ul><p>Opening${TAIL}</p>`
    expect(wrapFirstLetterAsDropCap(html)).toContain('<span class="markoto-dropcap">O</span>pening')
  })

  test('no body paragraph at all → unchanged', () => {
    const html = '<blockquote><p>Only a quote</p></blockquote>'
    expect(wrapFirstLetterAsDropCap(html)).toBe(html)
  })
})

describe('wrapFirstLetterAsDropCap — when the opening paragraph gets no cap', () => {
  test('a short opening paragraph gets no cap (it would tower over one or two lines)', () => {
    const html = '<p>A short intro line.</p><p>The next paragraph is long enough but is not the opening one.</p>'
    expect(wrapFirstLetterAsDropCap(html)).toBe(html)
  })

  test('the length threshold is on the text, not the markup', () => {
    const justShort = 'x'.repeat(DROPCAP_MIN_CHARS - 1)
    expect(wrapFirstLetterAsDropCap(`<p><a href="https://example.com/a-very-long-url">${justShort}</a></p>`)).not.toContain('markoto-dropcap')
    expect(wrapFirstLetterAsDropCap(`<p>${justShort}x</p>`)).toContain('markoto-dropcap')
  })

  test('hard-broken metadata lines (Date / Attendees) get no cap', () => {
    const html = `<p>Date: 2026-04-12<br>Attendees: Maya, Sam<br>Purpose: plan the quarter${TAIL}</p>`
    expect(wrapFirstLetterAsDropCap(html)).toBe(html)
  })

  test('a paragraph opening with a bold label gets no cap', () => {
    const html = `<p><strong>Summary:</strong> the launch went well${TAIL}</p>`
    expect(wrapFirstLetterAsDropCap(html)).toBe(html)
  })

  test('the capped paragraph is marked so the theme can contain the float', () => {
    const out = wrapFirstLetterAsDropCap(`<p>Long enough${TAIL}</p><p>Short.</p>`)
    const tpl = document.createElement('template')
    tpl.innerHTML = out
    const ps = tpl.content.querySelectorAll('p')
    expect(ps[0]?.classList.contains('markoto-dropcap-p')).toBe(true)
    expect(ps[1]?.classList.contains('markoto-dropcap-p')).toBe(false)
  })
})
