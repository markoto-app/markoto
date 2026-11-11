import { describe, it, expect } from 'vitest'
import { buildUploadKey, parseUploadKey, DOC_ID_RE } from '../../server/utils/storage/uploadKey'

describe('parseUploadKey', () => {
  const docId = 'doc-abcdefghij'
  const id = 'AbCdEfGh_-12'

  it.each(['png', 'jpg', 'gif', 'webp'])('accepts a key built for .%s', (ext) => {
    const key = buildUploadKey(docId, id, ext)
    expect(parseUploadKey(key)).toEqual({ docId, fileId: `${id}.${ext}`, ext })
  })

  it.each([
    ['backups/postgres/2026-01-01T00:00:00Z.sql.gz.gpg'],
    ['backups/postgres/x.sql.gz.gpg'],
    ['workspaces/ws12345678/knowledge/abcdefghijkl.pdf'],
    ['renders/doc-abcdefghij/1/page-1.png'],
    ['exports/1/abc.zip'],
    [`docs/${docId}/${id}.svg`],
    [`docs/${docId}/${id}.png.exe`],
    [`docs/${docId}/${id}`],
    [`docs/${docId}/short.png`],
    [`docs/${docId}/${id}x.png`],
    [`docs/short/${id}.png`],
    [`docs/${docId}/../other-doc-1234/${id}.png`],
    [`docs/${docId}/sub/${id}.png`],
    [`/docs/${docId}/${id}.png`],
    [`docs/${docId}/${id}.png\n`],
    [`docs/${docId}/${id}.PNG`],
    ['']
  ])('rejects %j', (key) => {
    expect(parseUploadKey(key)).toBeNull()
  })

  it.each([undefined, null, 42, {}, ['docs/a']])('rejects non-string %j', (key) => {
    expect(parseUploadKey(key)).toBeNull()
  })

  it('shares the docId rule with the request route', () => {
    expect(DOC_ID_RE.test(docId)).toBe(true)
    expect(DOC_ID_RE.test('../x')).toBe(false)
  })
})
