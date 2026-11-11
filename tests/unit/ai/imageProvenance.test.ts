import { describe, expect, it } from 'vitest'
import { ImageUrlProvenance, markdownImageUrls, unseenImageError } from '../../../server/utils/agentic/imageProvenance'

describe('markdownImageUrls', () => {
  it('finds plain, angle-bracketed and titled image targets, once each', () => {
    const md = '![a](https://x.test/a.png) text ![b](<https://x.test/b.png>) ![c](/api/files/D/c.png "C"){width=40%} ![a again](https://x.test/a.png)'
    expect(markdownImageUrls(md)).toEqual(['https://x.test/a.png', 'https://x.test/b.png', '/api/files/D/c.png'])
  })

  it('ignores ordinary links', () => {
    expect(markdownImageUrls('[source](https://x.test/page)')).toEqual([])
  })
})

describe('ImageUrlProvenance', () => {
  it('flags only URLs neither seen nor already in the document', () => {
    const p = new ImageUrlProvenance('doc has ![x](https://x.test/in-doc.png)', 'use https://x.test/user.png')
    p.note('tool result: ![g](/api/files/D/gen.png)')
    const added = '![1](https://x.test/user.png) ![2](/api/files/D/gen.png) ![3](https://x.test/made-up.png) ![4](https://x.test/in-doc.png)'
    expect(p.unseenImageUrls(added, 'doc has ![x](https://x.test/in-doc.png)')).toEqual(['https://x.test/made-up.png'])
  })

  it('treats empty seen text as nothing seen', () => {
    const p = new ImageUrlProvenance(null, undefined, '')
    expect(p.unseenImageUrls('![x](/api/files/D/x.png)', null)).toEqual(['/api/files/D/x.png'])
  })
})

describe('unseenImageError', () => {
  it('suggests generate_image only when the session offers it', () => {
    expect(unseenImageError(['https://x.test/a.png'], true)).toContain('call generate_image')
    expect(unseenImageError(['https://x.test/a.png'], false)).toContain('No image tool is available')
  })
})
