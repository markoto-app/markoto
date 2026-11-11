import { describe, expect, it } from 'vitest'
import {
  documentLocale,
  documentTexts,
  formatDocumentDate,
  isIsoDate,
  todayIso,
  tocTitleFor
} from '../../../shared/utils/documents/documentLocale'

describe('documentLocale', () => {
  it('maps codes, regional codes and language names to BCP-47 tags', () => {
    expect(documentLocale('de')).toBe('de')
    expect(documentLocale('de-CH')).toBe('de-CH')
    expect(documentLocale('Deutsch')).toBe('de')
    expect(documentLocale('english')).toBe('en')
    expect(documentLocale('Schwiizerdütsch')).toBe('de-CH')
    expect(documentLocale('日本語')).toBe('ja')
  })

  it('falls back to en for empty, unknown or malformed input', () => {
    for (const v of ['', '   ', null, undefined, 'Klingon dialect', 'en_US!!', 'x'.repeat(50)]) {
      expect(documentLocale(v), String(v)).toBe('en')
    }
  })
})

describe('tocTitleFor', () => {
  it('is sentence case in the document language', () => {
    expect(tocTitleFor('en')).toBe('Contents')
    expect(tocTitleFor('de-CH')).toBe('Inhalt')
    expect(tocTitleFor('fr')).toBe('Sommaire')
    expect(tocTitleFor('ja')).toBe('目次')
    expect(tocTitleFor('xx')).toBe('Contents')
  })
})

describe('formatDocumentDate', () => {
  it('writes the date out in the document language', () => {
    expect(formatDocumentDate('2026-10-29', 'en')).toBe('29 October 2026')
    expect(formatDocumentDate('2026-10-29', 'en-US')).toBe('October 29, 2026')
    expect(formatDocumentDate('2026-10-29', 'de')).toBe('29. Oktober 2026')
    expect(formatDocumentDate('2026-10-29', 'fr')).toBe('29 octobre 2026')
  })

  it('does not shift the day with the time zone', () => {
    expect(formatDocumentDate('2026-01-01', 'en')).toBe('1 January 2026')
    expect(formatDocumentDate('2026-12-31', 'en')).toBe('31 December 2026')
  })

  it('returns invalid input unchanged', () => {
    expect(formatDocumentDate('not a date', 'en')).toBe('not a date')
  })
})

describe('isIsoDate', () => {
  it('accepts real calendar dates only', () => {
    expect(isIsoDate('2026-10-29')).toBe(true)
    expect(isIsoDate('2028-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('2026-1-01')).toBe(false)
    expect(isIsoDate('29.10.2026')).toBe(false)
    expect(isIsoDate('')).toBe(false)
  })
})

describe('documentTexts', () => {
  const cover = (date?: string) => ({ cover: { ...base, ...(date === undefined ? {} : { date }) } })
  const base = {
    enabled: true, layout: 'editorial' as const, align: 'left' as const, showTitle: true, showSubtitle: false,
    subtitle: '', showDate: true, showAuthors: false, authors: [], showLogo: false, titleSize: 2.4, subtitleSize: 1.2
  }
  const now = new Date(2026, 10, 2, 9, 30)

  it('uses the picked publication date', () => {
    expect(documentTexts(cover('2026-10-29'), 'de', now)).toEqual({
      locale: 'de', dateIso: '2026-10-29', date: '29. Oktober 2026', tocTitle: 'Inhalt',
      captionLabels: { table: 'Tabelle', figure: 'Abbildung', separator: ': ', chapter: { before: 'Kapitel ', after: '' } }
    })
  })

  // cover.dateFormat (APA: US dates whatever the language; ISO for specs).
  it('writes the date in the picked format', () => {
    const withFormat = (dateFormat: 'locale' | 'us' | 'iso') => ({ cover: { ...cover('2026-11-02').cover, dateFormat } })
    expect(documentTexts(withFormat('us'), 'en', now).date).toBe('November 2, 2026')
    expect(documentTexts(withFormat('us'), 'de', now).date).toBe('November 2, 2026')
    expect(documentTexts(withFormat('iso'), 'de', now).date).toBe('2026-11-02')
    expect(documentTexts(withFormat('locale'), 'de', now).date).toBe('2. November 2026')
    expect(formatDocumentDate('2026-11-02', 'fr', 'us')).toBe('November 2, 2026')
    expect(formatDocumentDate('not a date', 'en', 'iso')).toBe('not a date')
  })

  it('falls back to today when no (valid) date is set', () => {
    expect(documentTexts(cover(), 'en', now).dateIso).toBe(todayIso(now))
    expect(documentTexts(cover(''), 'en', now).date).toBe('2 November 2026')
    expect(documentTexts(cover('2026-02-30'), 'en', now).dateIso).toBe('2026-11-02')
  })
})
