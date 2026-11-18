import { describe, it, expect } from 'vitest'
import {
  importBaseName,
  importDirName,
  importFolderChain,
  isIgnoredImportPath,
  linkFragment,
  normalizeImportPath,
  resolveImportLink
} from '../../../shared/utils/documents/importPaths'
import { FOLDER_MAX_DEPTH } from '../../../shared/config/imports'

describe('normalizeImportPath', () => {
  it('drops empty and `.` segments and leading slashes', () => {
    expect(normalizeImportPath('docs/guide.md')).toBe('docs/guide.md')
    expect(normalizeImportPath('./a//b/./c.md')).toBe('a/b/c.md')
    expect(normalizeImportPath('/etc/passwd')).toBe('etc/passwd')
  })

  it('treats backslashes as separators and strips a drive letter', () => {
    expect(normalizeImportPath('C:\\Users\\me\\notes.md')).toBe('Users/me/notes.md')
    expect(normalizeImportPath('dir\\file.md')).toBe('dir/file.md')
  })

  it('refuses any `..` segment, even one that would stay inside', () => {
    for (const raw of ['../x.md', 'a/../../x.md', 'a/../b.md', '..\\win.md', 'a/..']) {
      expect(normalizeImportPath(raw), raw).toBeNull()
    }
  })

  it('refuses empty, control characters and over-long paths', () => {
    expect(normalizeImportPath('')).toBeNull()
    expect(normalizeImportPath('/')).toBeNull()
    expect(normalizeImportPath('./.')).toBeNull()
    expect(normalizeImportPath('a\u0000b.md')).toBeNull()
    expect(normalizeImportPath('a\nb.md')).toBeNull()
    expect(normalizeImportPath('a'.repeat(1025))).toBeNull()
    expect(normalizeImportPath('a'.repeat(1024))).toBe('a'.repeat(1024))
  })
})

describe('isIgnoredImportPath', () => {
  it('skips hidden and OS metadata files anywhere in the path', () => {
    for (const p of ['.git/config', 'a/.DS_Store', '__MACOSX/a/._x.md', 'pics/Thumbs.db', 'x/desktop.ini', 'a/.hidden/b.md']) {
      expect(isIgnoredImportPath(p), p).toBe(true)
    }
    expect(isIgnoredImportPath('docs/readme.md')).toBe(false)
  })
})

describe('importFolderChain / importBaseName / importDirName', () => {
  it('lists the directories of a path as folder names', () => {
    expect(importFolderChain('readme.md')).toEqual([])
    expect(importFolderChain('a/b/c.md')).toEqual(['a', 'b'])
  })

  it('folds levels below the depth limit into the last one', () => {
    const dirs = Array.from({ length: FOLDER_MAX_DEPTH + 2 }, (_, i) => `d${i}`)
    const chain = importFolderChain(`${dirs.join('/')}/f.md`)
    expect(chain).toHaveLength(FOLDER_MAX_DEPTH)
    expect(chain.at(-1)).toBe(dirs.slice(FOLDER_MAX_DEPTH - 1).join(' - '))
    expect(importFolderChain('a/b/c/f.md', 2)).toEqual(['a', 'b - c'])
  })

  it('names and directories', () => {
    expect(importBaseName('a/b/Report.final.md')).toBe('Report.final')
    expect(importBaseName('.env')).toBe('.env')
    expect(importBaseName('noext')).toBe('noext')
    expect(importDirName('a/b/c.md')).toBe('a/b')
    expect(importDirName('c.md')).toBe('')
  })
})

describe('resolveImportLink', () => {
  it('resolves relative targets against the file folder', () => {
    expect(resolveImportLink('docs/a.md', 'b.md')).toBe('docs/b.md')
    expect(resolveImportLink('docs/a.md', './img/x.png')).toBe('docs/img/x.png')
    expect(resolveImportLink('docs/sub/a.md', '../b.md')).toBe('docs/b.md')
    expect(resolveImportLink('a.md', 'b.md')).toBe('b.md')
  })

  it('resolves a leading slash against the import root', () => {
    expect(resolveImportLink('docs/deep/a.md', '/assets/logo.png')).toBe('assets/logo.png')
  })

  it('decodes percent-encoding and strips angle brackets, query and fragment', () => {
    expect(resolveImportLink('a.md', 'My%20Notes.md')).toBe('My Notes.md')
    expect(resolveImportLink('a.md', '<My Notes.md>')).toBe('My Notes.md')
    expect(resolveImportLink('a.md', 'b.md#section-2')).toBe('b.md')
    expect(resolveImportLink('a.md', 'img.png?raw=1')).toBe('img.png')
    // A broken escape stays as written rather than failing the import.
    expect(resolveImportLink('a.md', '100%.md')).toBe('100%.md')
  })

  it('refuses targets that climb above the root', () => {
    expect(resolveImportLink('a.md', '../outside.md')).toBeNull()
    expect(resolveImportLink('docs/a.md', '../../outside.md')).toBeNull()
    expect(resolveImportLink('docs/a.md', '/../x.md')).toBeNull()
    expect(resolveImportLink('docs/a.md', '%2e%2e/%2e%2e/x.md')).toBeNull()
  })

  it('ignores anchors and absolute URLs of any scheme', () => {
    for (const t of ['#heading', '', '   ', 'https://example.com/a.md', 'http://x/y.png', 'mailto:a@b.c', 'data:image/png;base64,AAAA', '//cdn.example.com/x.png', 'C:/x.md', 'javascript:alert(1)']) {
      expect(resolveImportLink('docs/a.md', t), t).toBeNull()
    }
  })

  it('refuses a target that resolves to the root itself', () => {
    expect(resolveImportLink('docs/a.md', '..')).toBeNull()
    expect(resolveImportLink('a.md', './')).toBeNull()
  })
})

describe('linkFragment', () => {
  it('returns the fragment with its hash', () => {
    expect(linkFragment('b.md#part')).toBe('#part')
    expect(linkFragment('b.md')).toBe('')
  })
})
