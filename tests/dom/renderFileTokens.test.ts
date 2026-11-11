import { describe, it, expect } from 'vitest'
import { attachRenderFileTokens, withRenderFileToken, type RenderFileAccess } from '../../app/utils/preview/renderFileTokens'

// The server render page holds a file-access token for the document's own
// uploads. It must reach exactly those image URLs and nothing else the
// document content can name.

const DOC = 'docA1234'
const OWN = `/api/files/${DOC}/AbCdEfGhIjKl.png`
const access: RenderFileAccess = {
  docId: DOC,
  fileIds: new Set(['AbCdEfGhIjKl.png', 'ZyXwVuTsRqPo.webp']),
  token: 'hdr.payload.sig'
}

function srcs(html: string): string[] {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  return Array.from(tpl.content.querySelectorAll('img'), img => img.getAttribute('src') ?? '')
}

describe('withRenderFileToken', () => {
  it('adds the token to a confirmed upload of this document', () => {
    expect(withRenderFileToken(OWN, access)).toBe(`${OWN}?token=hdr.payload.sig`)
  })

  it('URL-encodes the token', () => {
    expect(withRenderFileToken(OWN, { ...access, token: 'a+b/c=' })).toBe(`${OWN}?token=a%2Bb%2Fc%3D`)
  })

  it('leaves every other URL alone', () => {
    for (const url of [
      `/api/files/${DOC}/NotUploaded1.png`, // right shape, no confirmed upload
      '/api/files/docB5678/AbCdEfGhIjKl.png', // another document
      `https://evil.example/api/files/${DOC}/AbCdEfGhIjKl.png`, // only contains the path
      `//evil.example/api/files/${DOC}/AbCdEfGhIjKl.png`,
      `${OWN}?x=1`,
      `${OWN}#frag`,
      `/x${OWN}`,
      '/markoto-logos/seal.svg',
      'data:image/png;base64,AAAA'
    ]) {
      expect(withRenderFileToken(url, access)).toBe(url)
    }
  })
})

describe('attachRenderFileTokens', () => {
  it('tokenises own upload images (body + cover logo) only', () => {
    const html = [
      '<section class="markoto-cover"><img class="markoto-cover-logo" src="/api/files/docA1234/ZyXwVuTsRqPo.webp" alt=""></section>',
      `<p><img src="${OWN}" alt="own"></p>`,
      `<p><img src="https://evil.example/api/files/${DOC}/AbCdEfGhIjKl.png" alt="ext"></p>`,
      '<p><img src="/api/files/docB5678/AbCdEfGhIjKl.png" alt="other"></p>'
    ].join('')
    expect(srcs(attachRenderFileTokens(html, access))).toEqual([
      '/api/files/docA1234/ZyXwVuTsRqPo.webp?token=hdr.payload.sig',
      `${OWN}?token=hdr.payload.sig`,
      `https://evil.example/api/files/${DOC}/AbCdEfGhIjKl.png`,
      '/api/files/docB5678/AbCdEfGhIjKl.png'
    ])
  })

  it('never puts the token into links or text', () => {
    const html = `<p><a href="${OWN}">${OWN}</a> see https://x.example/?u=${OWN}</p>`
    const out = attachRenderFileTokens(html, access)
    expect(out).not.toContain('token=')
  })

  it('returns the input unchanged when there is nothing to tokenise', () => {
    const html = '<p>plain <strong>text</strong></p>'
    expect(attachRenderFileTokens(html, access)).toBe(html)
  })
})
