// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { CollabActivityRowAiTool as ActivityRowAiTool } from '#components'

// The AI-tool activity row binds URLs from the row's metadata (search
// result links, fetched page images, the image the AI looked at). Those
// values come from tool inputs and fetched pages, so only http(s) and
// relative URLs may become an href / src (regression).

const BAD = 'javascript:alert(1)'

function hrefsAndSrcs(html: string): string[] {
  return Array.from(html.matchAll(/\s(?:href|src)="([^"]*)"/g), m => m[1] ?? '')
}

describe('ActivityRowAiTool: URL binding', () => {
  it('web_search: drops a non-http source link, keeps the good one', async () => {
    const wrapper = await mountSuspended(ActivityRowAiTool, {
      props: {
        metadata: {
          kind: 'ai.tool',
          tool: 'web_search',
          query: 'q',
          sources: [{ title: 'Bad', uri: BAD }, { title: 'Good', uri: 'https://example.com/a' }]
        }
      }
    })
    const urls = hrefsAndSrcs(wrapper.html())
    expect(urls).toEqual(['https://example.com/a'])
  })

  it('fetch_url: drops non-http page and image URLs', async () => {
    const wrapper = await mountSuspended(ActivityRowAiTool, {
      props: {
        metadata: {
          kind: 'ai.tool',
          tool: 'fetch_url',
          url: BAD,
          images: [{ url: BAD }, { url: 'https://example.com/i.png' }]
        }
      }
    })
    const urls = hrefsAndSrcs(wrapper.html())
    expect(urls).not.toContain(BAD)
    expect(urls).toContain('https://example.com/i.png')
  })

  it('view_image: renders nothing clickable for a non-http src', async () => {
    const wrapper = await mountSuspended(ActivityRowAiTool, {
      props: { metadata: { kind: 'ai.tool', tool: 'view_image', src: BAD } }
    })
    expect(hrefsAndSrcs(wrapper.html())).toEqual([])
  })

  it('view_image: keeps an own-upload src', async () => {
    const wrapper = await mountSuspended(ActivityRowAiTool, {
      props: { metadata: { kind: 'ai.tool', tool: 'view_image', src: '/api/files/doc1/a.png' } }
    })
    expect(hrefsAndSrcs(wrapper.html())).toEqual(['/api/files/doc1/a.png', '/api/files/doc1/a.png'])
  })
})
