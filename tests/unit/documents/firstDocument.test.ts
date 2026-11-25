import { describe, it, expect, afterEach, vi } from 'vitest'
import { browserHasCreatedDoc, firstDocumentBody, rememberBrowserCreatedDoc } from '../../../app/utils/documents/firstDocument'
import { DEFAULT_TEMPLATE_ID, getTemplate } from '../../../shared/templates'

describe('firstDocumentBody', () => {
  it('asks for the Demo template in its design, in the language the visitor reads', () => {
    expect(firstDocumentBody('de')).toEqual({
      templateId: DEFAULT_TEMPLATE_ID,
      themePreset: getTemplate(DEFAULT_TEMPLATE_ID)?.design ?? 'markoto',
      audience: 'casual',
      language: 'de'
    })
    expect(firstDocumentBody('pt').language).toBe('en')
  })
})

describe('first document in this browser', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is remembered in local storage', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) })
    expect(browserHasCreatedDoc()).toBe(false)
    rememberBrowserCreatedDoc()
    expect(browserHasCreatedDoc()).toBe(true)
  })

  it('treats blocked storage as "not yet"', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    })
    expect(browserHasCreatedDoc()).toBe(false)
    expect(() => rememberBrowserCreatedDoc()).not.toThrow()
  })
})
