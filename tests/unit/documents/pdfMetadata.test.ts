import { describe, expect, it } from 'vitest'
import { documentLanguageTag, pdfDocumentTitle, UNTITLED_PDF_TITLE } from '../../../shared/utils/documents/pdfMetadata'

describe('documentLanguageTag', () => {
  it('keeps ISO codes and regional tags', () => {
    expect(documentLanguageTag('de')).toBe('de')
    expect(documentLanguageTag('de-CH')).toBe('de-CH')
    expect(documentLanguageTag('pt_BR')).toBe('pt-BR')
  })

  it('maps typed language names in several languages', () => {
    expect(documentLanguageTag('Deutsch')).toBe('de')
    expect(documentLanguageTag('english')).toBe('en')
    expect(documentLanguageTag('Français')).toBe('fr')
    expect(documentLanguageTag('Italienisch')).toBe('it')
    expect(documentLanguageTag('日本語')).toBe('ja')
    expect(documentLanguageTag('Schwiizerdütsch')).toBe('de-CH')
  })

  it('defaults an empty field to English and an unknown language to und', () => {
    expect(documentLanguageTag('')).toBe('en')
    expect(documentLanguageTag(null)).toBe('en')
    expect(documentLanguageTag('  ')).toBe('en')
    expect(documentLanguageTag('Klingon')).toBe('und')
    expect(documentLanguageTag('plain business prose')).toBe('und')
  })
})

describe('pdfDocumentTitle', () => {
  it('collapses whitespace', () => {
    expect(pdfDocumentTitle('  Quarterly\n report  ')).toBe('Quarterly report')
  })

  it('never returns an empty title', () => {
    expect(pdfDocumentTitle('')).toBe(UNTITLED_PDF_TITLE)
    expect(pdfDocumentTitle('   ')).toBe(UNTITLED_PDF_TITLE)
    expect(pdfDocumentTitle(undefined)).toBe(UNTITLED_PDF_TITLE)
  })
})
