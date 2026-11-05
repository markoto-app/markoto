import { describe, expect, it } from 'vitest'
import { stripChunkHints } from '../../shared/utils/leanResourceHints'

// The marketing pages' HTML drops Nuxt's chunk hints and nothing else
// (shared/utils/leanResourceHints.ts).
describe('stripChunkHints', () => {
  it('removes every modulepreload and prefetch link, whatever the attribute order or quoting', () => {
    const head = '<link rel="modulepreload" as="script" crossorigin href="/_nuxt/a.js">'
      + '<link href="/_nuxt/b.js" rel="modulepreload" crossorigin>'
      + '<link rel=modulepreload href=/_nuxt/c.js>'
      + '<link rel="prefetch" as="script" crossorigin href="/_nuxt/later.js">'
      + '<link rel="prefetch" as="style" crossorigin href="/_nuxt/later.css">'
    expect(stripChunkHints(head)).toBe('')
  })

  it('keeps the entry script, the import map, stylesheets and other preloads', () => {
    const keep = '<script nonce="n" type="module" src="/_nuxt/entry.js" crossorigin></script>'
      + '<link rel="stylesheet" href="/_nuxt/entry.css" crossorigin>'
      + '<link rel="preload" as="image" href="/tour/poster.webp" fetchpriority="high">'
      + '<link rel="icon" href="/favicon.svg" type="image/svg+xml">'
      + '<script type="importmap">{"imports":{"#entry":"/_nuxt/entry.js"}}</script>'
    expect(stripChunkHints(`${keep}<link rel="modulepreload" href="/_nuxt/x.js">`)).toBe(keep)
  })
})
