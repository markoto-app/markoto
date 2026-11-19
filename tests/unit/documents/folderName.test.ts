import { describe, it, expect } from 'vitest'
import { folderNameFromSegment, folderNameProblem } from '../../../shared/utils/documents/folderName'
import { FOLDER_NAME_MAX_LENGTH } from '../../../shared/config/imports'

describe('folderNameProblem', () => {
  it('accepts an ordinary name, judged after trimming', () => {
    expect(folderNameProblem('  Reports 2026  ')).toBeNull()
    expect(folderNameProblem('Ünïcode & émoji 📁')).toBeNull()
  })

  it('refuses empty and whitespace-only names', () => {
    expect(folderNameProblem('')).toBe('empty')
    expect(folderNameProblem('   \t ')).toBe('empty')
  })

  it('refuses names over the limit, counting the trimmed text', () => {
    expect(folderNameProblem('a'.repeat(FOLDER_NAME_MAX_LENGTH))).toBeNull()
    expect(folderNameProblem(`  ${'a'.repeat(FOLDER_NAME_MAX_LENGTH)}  `)).toBeNull()
    expect(folderNameProblem('a'.repeat(FOLDER_NAME_MAX_LENGTH + 1))).toBe('too-long')
  })

  it('refuses path separators, control characters and dot names', () => {
    for (const bad of ['a/b', 'a\\b', 'a\u0000b', 'tab\u0007', 'del\u007F', '.', '..', ' .. ']) {
      expect(folderNameProblem(bad), JSON.stringify(bad)).toBe('invalid')
    }
    // Only the bare relative-path names are refused, not dots inside a name.
    expect(folderNameProblem('...')).toBeNull()
    expect(folderNameProblem('v1.2')).toBeNull()
  })
})

describe('folderNameFromSegment', () => {
  it('keeps a clean segment as it is', () => {
    expect(folderNameFromSegment('docs')).toBe('docs')
  })

  it('turns forbidden characters into spaces and collapses whitespace', () => {
    expect(folderNameFromSegment('a\\b\u0001c   d')).toBe('a b c d')
    expect(folderNameFromSegment('  spaced\tout  ')).toBe('spaced out')
  })

  it('cuts to the limit and trims what the cut leaves', () => {
    const name = folderNameFromSegment(`${'a'.repeat(FOLDER_NAME_MAX_LENGTH - 1)} tail`)
    expect(name).toBe('a'.repeat(FOLDER_NAME_MAX_LENGTH - 1))
    expect(folderNameProblem(name)).toBeNull()
  })

  it('falls back for unusable segments', () => {
    expect(folderNameFromSegment('')).toBe('Folder')
    expect(folderNameFromSegment('.')).toBe('Folder')
    expect(folderNameFromSegment('..')).toBe('Folder')
    expect(folderNameFromSegment('\u0000\u0001')).toBe('Folder')
    expect(folderNameFromSegment('..', 'Other')).toBe('Other')
  })

  it('always yields a valid folder name', () => {
    for (const seg of ['', '.', '..', 'a/b', '\\\\', ' x ', 'y'.repeat(500), '\u0000..']) {
      expect(folderNameProblem(folderNameFromSegment(seg)), JSON.stringify(seg)).toBeNull()
    }
  })
})
