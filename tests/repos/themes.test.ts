import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../integration/setup/db'
import {
  listThemesByUser,
  getThemeById,
  createTheme,
  updateTheme,
  deleteTheme,
  countThemesByUser
} from '../../server/repos/themes'
import { NotFoundError } from '../../server/repos/errors'
import { createUser } from '../integration/setup/fixtures'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { asUser } from '../helpers/access'

// Themes repo. Covers the user-saved preset round-trips + the
// `(themeId, userId)` cross-user isolation tuple — a row owned by user
// A must be invisible (not 403) to user B even when they know the id.

describe('createTheme + getThemeById', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('round-trips a saved theme for the owner', async () => {
    const user = await createUser()
    const row = await createTheme(asUser(user.id), {
      themeId: 'tA',
      name: 'Brand red',
      theme: defaultTheme
    })
    expect(row.themeId).toBe('tA')
    expect(row.name).toBe('Brand red')
    expect(row.theme).toEqual(defaultTheme)

    const fetched = await getThemeById(asUser(user.id), 'tA')
    expect(fetched?.name).toBe('Brand red')
    expect(fetched?.theme).toEqual(defaultTheme)
  })

  it('returns null for another user looking up the same id', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    await createTheme(asUser(owner.id), {
      themeId: 'tCross',
      name: 'Mine',
      theme: defaultTheme
    })
    expect(await getThemeById(asUser(stranger.id), 'tCross')).toBeNull()
  })
})

describe('listThemesByUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns an empty list for a user with no saved themes', async () => {
    const user = await createUser()
    expect(await listThemesByUser(asUser(user.id))).toEqual([])
  })

  it('lists only themes owned by the caller', async () => {
    const a = await createUser()
    const b = await createUser()
    await createTheme(asUser(a.id), { themeId: 't1', name: 'A1', theme: defaultTheme })
    await createTheme(asUser(a.id), { themeId: 't2', name: 'A2', theme: defaultTheme })
    await createTheme(asUser(b.id), { themeId: 't3', name: 'B1', theme: defaultTheme })

    const aRows = await listThemesByUser(asUser(a.id))
    expect(aRows.map(r => r.themeId).sort()).toEqual(['t1', 't2'])
    const bRows = await listThemesByUser(asUser(b.id))
    expect(bRows.map(r => r.themeId)).toEqual(['t3'])
  })
})

describe('countThemesByUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns 0 for a user with no saved themes', async () => {
    const user = await createUser()
    expect(await countThemesByUser(asUser(user.id))).toBe(0)
  })

  it('counts only the caller\'s saved themes', async () => {
    const a = await createUser()
    const b = await createUser()
    await createTheme(asUser(a.id), { themeId: 'c1', name: 'A1', theme: defaultTheme })
    await createTheme(asUser(a.id), { themeId: 'c2', name: 'A2', theme: defaultTheme })
    await createTheme(asUser(b.id), { themeId: 'c3', name: 'B1', theme: defaultTheme })
    expect(await countThemesByUser(asUser(a.id))).toBe(2)
    expect(await countThemesByUser(asUser(b.id))).toBe(1)
  })
})

describe('updateTheme', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('renames a theme owned by the caller', async () => {
    const user = await createUser()
    await createTheme(asUser(user.id), { themeId: 'tU', name: 'Old', theme: defaultTheme })
    await updateTheme(asUser(user.id), 'tU', { name: 'New' })
    const r = await getThemeById(asUser(user.id), 'tU')
    expect(r?.name).toBe('New')
  })

  it('throws NotFound when the theme belongs to a different user', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    await createTheme(asUser(owner.id), { themeId: 'tX', name: 'Mine', theme: defaultTheme })
    await expect(updateTheme(asUser(stranger.id), 'tX', { name: 'Stolen' }))
      .rejects.toBeInstanceOf(NotFoundError)
    // Underlying row untouched.
    const original = await getThemeById(asUser(owner.id), 'tX')
    expect(original?.name).toBe('Mine')
  })

  it('is a no-op when given an empty update', async () => {
    const user = await createUser()
    await createTheme(asUser(user.id), { themeId: 'tE', name: 'Same', theme: defaultTheme })
    await updateTheme(asUser(user.id), 'tE', {})
    const r = await getThemeById(asUser(user.id), 'tE')
    expect(r?.name).toBe('Same')
  })
})

describe('deleteTheme', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('removes a theme owned by the caller', async () => {
    const user = await createUser()
    await createTheme(asUser(user.id), { themeId: 'tD', name: 'Bye', theme: defaultTheme })
    await deleteTheme(asUser(user.id), 'tD')
    expect(await getThemeById(asUser(user.id), 'tD')).toBeNull()
  })

  it('throws NotFound when the theme belongs to a different user', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    await createTheme(asUser(owner.id), { themeId: 'tDX', name: 'Mine', theme: defaultTheme })
    await expect(deleteTheme(asUser(stranger.id), 'tDX'))
      .rejects.toBeInstanceOf(NotFoundError)
    expect(await getThemeById(asUser(owner.id), 'tDX')).not.toBeNull()
  })
})
