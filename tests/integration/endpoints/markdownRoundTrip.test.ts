import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createDoc, createUser } from '../setup/fixtures'
import { TEST_BASE_URL } from '../setup/env'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { buildMarkdownExport } from '~~/shared/utils/markdownFrontmatter'
import type { DocTheme } from '~~/shared/types/theme'

// "Download Markdown" → File › Import round trip (staging feedback B/12).
// The export is built with the same function the editor uses
// (`buildMarkdownExport`); the import goes through POST /api/import with
// a `.md` file, which validates the frontmatter with the same rules as
// PUT /api/docs/:id/meta and returns the properties for the editor to
// apply. Applying = PUT /meta here (what the owner's editor persists).

const BODY = '# Field notes\n\nThree sentences about the quarter.\n\n## Numbers\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'

interface MetaBody {
  title: string
  description: string
  audience: string
  language: string
  templateId: string
  theme: DocTheme
}

interface ImportBody {
  markdown: string
  source: string
  properties?: {
    title?: string
    description?: string
    audience?: string
    language?: string
    templateId?: string
    theme?: DocTheme
  }
  ignored?: string[]
  droppedCustomCssRules?: number
}

async function importMarkdown(text: string | Uint8Array, docId: string | null, filename = 'notes.md'): Promise<Response> {
  const form = new FormData()
  form.append('file', new File([text], filename, { type: 'text/markdown' }))
  if (docId) form.append('docId', docId)
  return fetch(`${TEST_BASE_URL}/api/import`, { method: 'POST', body: form })
}

function academicTheme(docId: string): DocTheme {
  const base = structuredClone(THEME_PRESETS.find(p => p.id === 'academic')!.theme)
  return {
    ...base,
    color: { ...base.color, brand: '#3355AA' },
    customCss: `.paged-doc h2 {\n  border-bottom: 2px solid var(--doc-brand);\n}\n.paged-doc .hero {\n  background: url(/api/files/${docId}/abcdefghijkl.png);\n}\n`
  }
}

describe('Markdown export → import round trip', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('restores title, description, audience, language, template id and the full theme', async () => {
    const owner = await createUser()
    const client = await loggedInClient(owner.id)
    const source = await createDoc({ ownerId: owner.id })
    const theme = academicTheme(source.docId)
    const put = await client.put(`/api/docs/${source.docId}/meta`, {
      title: 'Field notes Q3',
      description: 'What we learned this quarter',
      audience: 'business',
      language: 'de',
      templateId: 'meeting-notes',
      theme
    })
    expect(put.status).toBe(200)

    const meta = await (await client.get(`/api/docs/${source.docId}/meta`)).json() as MetaBody
    const file = buildMarkdownExport(BODY, meta)
    expect(file.startsWith('---\nmarkoto: 1\n')).toBe(true)

    // Into a fresh document: everything but the other doc's image rule.
    const target = await createDoc({ ownerId: owner.id })
    const res = await importMarkdown(file, target.docId)
    expect(res.status).toBe(200)
    const imported = await res.json() as ImportBody
    expect(imported.markdown).toBe(BODY)
    expect(imported.source).toBe('md')
    const props = imported.properties!
    expect(props.title).toBe('Field notes Q3')
    expect(props.description).toBe('What we learned this quarter')
    expect(props.audience).toBe('business')
    expect(props.language).toBe('de')
    expect(props.templateId).toBe('meeting-notes')
    expect(props.theme?.layout.columns).toBe(2)
    expect(props.theme?.color.brand).toBe('#3355AA')
    expect(props.theme?.customCss).toContain('border-bottom')
    expect(props.theme?.customCss).not.toContain(source.docId)
    expect(imported.droppedCustomCssRules).toBeGreaterThan(0)

    const apply = await client.put(`/api/docs/${target.docId}/meta`, props)
    expect(apply.status).toBe(200)
    const after = await (await client.get(`/api/docs/${target.docId}/meta`)).json() as typeof meta
    expect(after.title).toBe('Field notes Q3')
    expect(after.audience).toBe('business')
    expect(after.language).toBe('de')
    expect(after.templateId).toBe('meeting-notes')
    expect(after.theme).toEqual(props.theme)

    // Back into the source document: the theme comes back unchanged.
    const again = await (await importMarkdown(file, source.docId)).json() as ImportBody
    expect(again.properties?.theme).toEqual(meta.theme)
    expect(again.droppedCustomCssRules).toBeUndefined()
  })

  it('leaves a plain Markdown file untouched', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const res = await importMarkdown(BODY, doc.docId)
    expect(res.status).toBe(200)
    const body = await res.json() as ImportBody
    expect(body.markdown).toBe(BODY)
    expect(body.properties).toBeUndefined()
  })

  it('keeps someone else\'s frontmatter (Jekyll / Hugo) in the text', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const jekyll = '---\nlayout: post\ntitle: "Hello"\ntags: [a, b]\n---\n\n' + BODY
    const body = await (await importMarkdown(jekyll, doc.docId)).json() as ImportBody
    expect(body.markdown).toBe(jekyll)
    expect(body.properties).toBeUndefined()
  })

  it('applies only what validates from hostile frontmatter', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const hostile = [
      '---',
      'markoto: 1',
      `title: "${'x'.repeat(300)}"`,
      'description: Fine description',
      'audience: overlords',
      'language: fr',
      'templateId: ../../etc/passwd',
      'isAdmin: true',
      'theme:',
      '  body:',
      '    color: "#112233"',
      '  customCss: |',
      '    @import url(https://evil.example/x.css);',
      '    .paged-doc p { color: red; }',
      '    .paged-doc .x { background: url(https://evil.example/t.png); }',
      '---',
      '',
      BODY
    ].join('\n')
    const res = await importMarkdown(hostile, doc.docId)
    expect(res.status).toBe(200)
    const body = await res.json() as ImportBody
    expect(body.markdown).toBe(BODY)
    expect(body.properties?.title).toBeUndefined()
    expect(body.properties?.audience).toBeUndefined()
    expect(body.properties?.templateId).toBeUndefined()
    expect(body.properties?.description).toBe('Fine description')
    expect(body.properties?.language).toBe('fr')
    expect(body.ignored).toEqual(expect.arrayContaining(['title', 'audience', 'templateId']))
    expect(body.properties).not.toHaveProperty('isAdmin')
    // Older / partial theme: filled up with defaults, then validated.
    expect(body.properties?.theme?.body.color).toBe('#112233')
    const css = body.properties?.theme?.customCss ?? ''
    expect(css).toContain('.paged-doc p{color:red}')
    expect(css).not.toContain('evil.example')
    expect(css).not.toContain('@import')
    // What comes back is accepted by the real write path.
    const client = await loggedInClient(owner.id)
    expect((await client.put(`/api/docs/${doc.docId}/meta`, body.properties)).status).toBe(200)
  })

  it('refuses YAML aliases (no expansion bombs) by treating the block as foreign', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const bomb = '---\nmarkoto: 1\na: &a [x, x, x]\nb: [*a, *a, *a]\n---\n\n' + BODY
    const body = await (await importMarkdown(bomb, doc.docId)).json() as ImportBody
    expect(body.properties).toBeUndefined()
    expect(body.markdown).toBe(bomb)
  })

  it('rejects a .md file that is not UTF-8', async () => {
    const res = await importMarkdown(new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x41]), null)
    expect(res.status).toBe(422)
    expect((await res.json() as { data?: { code?: string } }).data?.code).toBe('import/not-utf8')
  })
})
