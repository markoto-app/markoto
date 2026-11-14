import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { workspaceRoleKey } from '../../../app/utils/workspace/roleLabel'

const LOCALES = ['en', 'de', 'fr', 'es', 'ja', 'zh'] as const
const ROLES = ['admin', 'editor', 'viewer', 'guest'] as const

function message(locale: string, key: string): unknown {
  const messages: unknown = JSON.parse(readFileSync(resolve(__dirname, `../../../i18n/locales/${locale}.json`), 'utf8'))
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)
}

describe('workspaceRoleKey', () => {
  it('maps every role to its own locale key', () => {
    expect(ROLES.map(workspaceRoleKey)).toEqual([
      'workspace.roles.admin',
      'workspace.roles.editor',
      'workspace.roles.viewer',
      'workspace.roles.guest'
    ])
  })

  it('reads an unknown role as a viewer', () => {
    expect(workspaceRoleKey('owner')).toBe('workspace.roles.viewer')
    expect(workspaceRoleKey(null)).toBe('workspace.roles.viewer')
  })

  it.each(LOCALES)('%s names every role, capitalised where the script has case', (locale) => {
    for (const role of ROLES) {
      const label = message(locale, workspaceRoleKey(role))
      expect(typeof label).toBe('string')
      const text = label as string
      expect(text.length).toBeGreaterThan(0)
      expect(text.charAt(0)).toBe(text.charAt(0).toUpperCase())
    }
  })
})
