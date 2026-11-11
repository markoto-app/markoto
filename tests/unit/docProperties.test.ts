import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { resolveDocProperties, type DocPropertiesRow } from '../../server/utils/documents/docProperties'
import { THEME_PRESETS } from '../../shared/utils/themePresets'
import { defaultTheme } from '../../shared/utils/defaultTheme'

// Server-side readers (render bootstrap → server PDF, the Markdown export
// tool) must see the properties the editor shows: ymeta first, the
// documents row as fallback. Regression: an anonymous doc's theme lives in
// ymeta only (the row's theme stays NULL — only the owner persists it), so
// its server-rendered PDF came out with the default theme.

const arxiv = THEME_PRESETS.find(p => p.id === 'arxiv')?.theme
if (!arxiv) throw new Error('arxiv preset missing')

const anonRow: DocPropertiesRow = {
  title: 'Row title',
  description: 'Row description',
  audience: 'casual',
  language: 'en',
  templateId: 'blank',
  theme: null
}

function metaWith(entries: Record<string, unknown>): Y.Map<unknown> {
  const ydoc = new Y.Doc()
  const ymeta = ydoc.getMap<unknown>('meta')
  for (const [k, v] of Object.entries(entries)) ymeta.set(k, v)
  return ymeta
}

describe('resolveDocProperties', () => {
  it('anonymous doc: theme set only in ymeta is used (row theme NULL)', () => {
    const props = resolveDocProperties(metaWith({ theme: arxiv }), anonRow)
    expect(props.theme).toEqual(arxiv)
  })

  it('ymeta wins over the row for every property', () => {
    const props = resolveDocProperties(metaWith({
      theme: arxiv,
      title: 'Live title',
      description: '',
      audience: 'technical',
      language: 'de',
      templateId: 'meeting-notes'
    }), { ...anonRow, theme: defaultTheme })
    expect(props).toEqual({
      title: 'Live title',
      description: '',
      audience: 'technical',
      language: 'de',
      templateId: 'meeting-notes',
      theme: arxiv
    })
  })

  it('falls back to the row when ymeta has nothing', () => {
    const props = resolveDocProperties(metaWith({}), { ...anonRow, theme: arxiv })
    expect(props).toEqual({ ...anonRow, theme: arxiv })
  })

  it('no theme anywhere → null (renderer uses the default)', () => {
    expect(resolveDocProperties(metaWith({}), anonRow).theme).toBeNull()
  })

  it('invalid ymeta values fall back to the row', () => {
    const props = resolveDocProperties(metaWith({
      theme: { page: 'nope' },
      title: '',
      audience: 'pirate',
      language: 42,
      description: 'x'.repeat(10_000)
    }), { ...anonRow, theme: arxiv })
    expect(props).toEqual({ ...anonRow, theme: arxiv })
  })
})
