import { describe, it, expect } from 'vitest'
import { collectMarkdownRefs, decodeImageDataUri, rewriteMarkdownRefs } from '../../../server/utils/imports/markdownRefs'

describe('collectMarkdownRefs', () => {
  it('finds inline images and links, keeping them apart', () => {
    const refs = collectMarkdownRefs('See ![logo](img/logo.png "Logo") and [the guide](guide.md#intro).')
    expect(refs.images).toEqual(['img/logo.png'])
    expect(refs.links).toEqual(['guide.md#intro'])
  })

  it('reads angle-bracket targets with spaces and nested brackets in the text', () => {
    const refs = collectMarkdownRefs('![a [nested] alt](<my pics/a b.png>) [x \\] y](z.md)')
    expect(refs.images).toEqual(['my pics/a b.png'])
    expect(refs.links).toEqual(['z.md'])
  })

  it('finds HTML <img src> with either quote, any case', () => {
    const refs = collectMarkdownRefs('<p><IMG alt="x" SRC = "a.png"></p> <img src=\'b.gif\' />')
    expect(refs.images).toEqual(['a.png', 'b.gif'])
  })

  it('offers a reference definition as both an image and a link', () => {
    const refs = collectMarkdownRefs('![pic][p]\n\n[p]: pics/p.png "title"\n   [q]: <other doc.md>')
    expect(refs.images).toEqual(['pics/p.png', 'other doc.md'])
    expect(refs.links).toEqual(['pics/p.png', 'other doc.md'])
  })

  it('leaves fenced code blocks alone, for both fence characters', () => {
    const md = [
      '![real](a.png)',
      '```md',
      '![fake](b.png)',
      '```',
      '~~~',
      '<img src="d.png">',
      '~~~',
      '[after](e.md)'
    ].join('\n')
    const refs = collectMarkdownRefs(md)
    expect(refs.images).toEqual(['a.png'])
    expect(refs.links).toEqual(['e.md'])
  })

  it('a longer closing fence ends the block', () => {
    expect(collectMarkdownRefs('```\n[in](a.md)\n`````\n[out](b.md)').links).toEqual(['b.md'])
  })

  it('does not take text in parentheses for a link target', () => {
    const md = '[x](a.md and more) [y](b.md "title") [z](c.md (paren title))'
    expect(collectMarkdownRefs(md).links).toEqual(['b.md', 'c.md'])
    expect(rewriteMarkdownRefs(md, new Map(), new Map([['a.md', 'A']]))).toBe(md)
  })

  it('a backtick fence is not closed by tildes nor by a shorter fence', () => {
    const md = '````\n~~~\n```\n![in](x.png)\n````\n![out](y.png)'
    expect(collectMarkdownRefs(md).images).toEqual(['y.png'])
  })

  it('deduplicates and ignores incomplete syntax', () => {
    const refs = collectMarkdownRefs('![a](x.png) ![b](x.png) [broken](no-close [also broken] ![](  )')
    expect(refs.images).toEqual(['x.png'])
    expect(refs.links).toEqual([])
  })

  it('stays linear on pathological input', () => {
    const md = '['.repeat(20_000) + '](x)' + '<img '.repeat(5_000)
    const started = performance.now()
    collectMarkdownRefs(md)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('rewriteMarkdownRefs', () => {
  it('replaces images and links from their maps and keeps alt text and titles', () => {
    const md = '![Logo](img/logo.png "The logo") and [Guide](guide.md) and [Away](https://x.y)'
    const out = rewriteMarkdownRefs(md, new Map([['img/logo.png', '/api/files/d1/f1.png']]), new Map([['guide.md', '/d/abc123']]))
    expect(out).toBe('![Logo](/api/files/d1/f1.png "The logo") and [Guide](/d/abc123) and [Away](https://x.y)')
  })

  it('does not use the link map for an image with the same target', () => {
    const out = rewriteMarkdownRefs('![i](same) [l](same)', new Map(), new Map([['same', '/d/x']]))
    expect(out).toBe('![i](same) [l](/d/x)')
  })

  it('rewrites several references on one line and inside angle brackets', () => {
    const out = rewriteMarkdownRefs('![a](<a b.png>) ![b](b.png) <img src="c.png">', new Map([['a b.png', 'A'], ['b.png', 'B'], ['c.png', 'C']]), new Map())
    expect(out).toBe('![a](<A>) ![b](B) <img src="C">')
  })

  it('rewrites a definition through the image map, else the link map', () => {
    const md = '[p]: pics/p.png\n[q]: other.md "t"'
    const out = rewriteMarkdownRefs(md, new Map([['pics/p.png', '/api/files/d/p.png']]), new Map([['other.md', '/d/q']]))
    expect(out).toBe('[p]: /api/files/d/p.png\n[q]: /d/q "t"')
  })

  it('leaves fenced code untouched', () => {
    const md = '```\n![x](a.png)\n```\n![x](a.png)'
    expect(rewriteMarkdownRefs(md, new Map([['a.png', 'B']]), new Map())).toBe('```\n![x](a.png)\n```\n![x](B)')
  })

  it('returns the text unchanged when there is nothing to replace', () => {
    const md = '![x](a.png)\r\nline'
    expect(rewriteMarkdownRefs(md, new Map(), new Map())).toBe(md)
  })
})

describe('decodeImageDataUri', () => {
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).toString('base64')

  it('decodes a base64 image data URI', () => {
    const r = decodeImageDataUri(`data:image/png;base64,${png}`)
    expect(r?.mediaType).toBe('image/png')
    expect([...(r?.bytes ?? [])]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  })

  it('is case-insensitive in the header and tolerates whitespace in the payload', () => {
    const spaced = `${png.slice(0, 4)}\n ${png.slice(4)}`
    expect(decodeImageDataUri(`DATA:Image/JPEG;BASE64,${spaced}`)?.mediaType).toBe('image/jpeg')
  })

  it('refuses non-images, non-base64, malformed types and empty payloads', () => {
    for (const t of [
      'data:text/html;base64,PGI+',
      'data:image/png,rawtext',
      'data:image/png;base64',
      'data:image/png;base64,',
      'data:image/sv g;base64,AAAA',
      'data:image/png;charset=x;base64,AAAA',
      'https://example.com/a.png'
    ]) {
      expect(decodeImageDataUri(t), t).toBeNull()
    }
  })
})
