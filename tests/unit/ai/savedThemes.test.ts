import { describe, expect, test } from 'vitest'
import {
  SAVED_THEME_DESCRIPTION_MAX,
  SAVED_THEME_NAME_MAX,
  checkSavedThemeDescription,
  checkSavedThemeName
} from '../../../shared/config/savedThemes'
import { SaveThemeAsPresetArgs } from '../../../server/utils/ai/tools/themeTools'

describe('saved theme name / description checks (shared by API, AI tool and dialog)', () => {
  test('name: trimmed, required, at most 80', () => {
    expect(checkSavedThemeName('  Paper ')).toEqual({ ok: true, value: 'Paper' })
    expect(checkSavedThemeName('   ')).toEqual({ ok: false, issue: 'required' })
    expect(checkSavedThemeName(5)).toEqual({ ok: false, issue: 'not-a-string' })
    expect(checkSavedThemeName('n'.repeat(SAVED_THEME_NAME_MAX)).ok).toBe(true)
    expect(checkSavedThemeName('n'.repeat(SAVED_THEME_NAME_MAX + 1))).toEqual({ ok: false, issue: 'too-long' })
  })

  test('description: optional, trimmed, at most 200', () => {
    expect(checkSavedThemeDescription(undefined)).toEqual({ ok: true, value: '' })
    expect(checkSavedThemeDescription(null)).toEqual({ ok: true, value: '' })
    expect(checkSavedThemeDescription('  For papers  ')).toEqual({ ok: true, value: 'For papers' })
    expect(checkSavedThemeDescription(['x'])).toEqual({ ok: false, issue: 'not-a-string' })
    expect(checkSavedThemeDescription('d'.repeat(SAVED_THEME_DESCRIPTION_MAX)).ok).toBe(true)
    expect(checkSavedThemeDescription('d'.repeat(SAVED_THEME_DESCRIPTION_MAX + 1))).toEqual({ ok: false, issue: 'too-long' })
  })

  test('the AI save tool accepts an optional description within the same limit', () => {
    expect(SaveThemeAsPresetArgs.safeParse({ name: 'A' }).success).toBe(true)
    expect(SaveThemeAsPresetArgs.safeParse({ name: 'A', description: 'For papers' }).success).toBe(true)
    expect(SaveThemeAsPresetArgs.safeParse({ name: 'A', description: 'd'.repeat(SAVED_THEME_DESCRIPTION_MAX + 1) }).success).toBe(false)
  })
})
