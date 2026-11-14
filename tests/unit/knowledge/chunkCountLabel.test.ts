import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const

function message(locale: string, key: string): unknown {
  const messages: unknown = JSON.parse(readFileSync(resolve(__dirname, `../../../i18n/locales/${locale}.json`), 'utf8'))
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)
}

describe('knowledge.chunks', () => {
  it.each(LOCALES)('%s counts chunks with the number in the message', (locale) => {
    const text = message(locale, 'knowledge.chunks') as string
    for (const form of text.split('|')) expect(form).toContain('{n}')
  })

  it('has a singular and a plural form in the languages that distinguish them', () => {
    expect(message('en', 'knowledge.chunks')).toBe('{n} chunk | {n} chunks')
    expect(message('de', 'knowledge.chunks')).toBe('{n} Abschnitt | {n} Abschnitte')
  })
})
