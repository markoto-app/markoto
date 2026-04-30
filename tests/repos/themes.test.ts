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
import { defaultTheme } from '~~/shared/utils/defaultTheme'

// Themes repo. Covers the user-saved preset round-trips + the
// `(themeId, userId)` cross-user isolation tuple — a row owned by user
// A must be invisible (not 403) to user B even when they know the id.

describe('createTheme + getThemeById', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('round-trips a saved theme for the owner', async () => {
    const user = await createUser()
    const row = await createTheme({
      themeId: 'tA',
      userId: user.id,
      name: 'Brand red',
      theme: defaultTheme
    })
    expect(row.themeId).toBe('tA')
    expect(row.name).toBe('Brand red')
    expect(row.theme).toEqual(defaultTheme)

    const fetched = await getThemeById('tA', user.id)
    expect(fetched?.name).toBe('Brand red')
    expect(fetched?.theme).toEqual(defaultTheme)
  })

  it('returns null for another user looking up the same id', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    await createTheme({
      themeId: 'tCross',
      userId: owner.id,
      name: 'Mine',
      theme: defaultTheme
    })
    expect(await getThemeById('tCross', stranger.id)).toBeNull()
  })
})

describe('listThemesByUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns an empty list for a user with no saved themes', async () => {
    const user = await createUser()
    expect(await listThemesByUser(user.id)).toEqual([])
  })

  it('lists only themes owned by the caller', async () => {
    const a = await createUser()
    const b = await createUser()
    await createTheme({ themeId: 't1', userId: a.id, name: 'A1', theme: defaultTheme })
    await createTheme({ themeId: 't2', userId: a.id, name: 'A2', theme: defaultTheme })
    await createTheme({ themeId: 't3', userId: b.id, name: 'B1', theme: defaultTheme })

    const aRows = await listThemesByUser(a.id)
    expect(aRows.map(r => r.themeId).sort()).toEqual(['t1', 't2'])
    const bRows = await listThemesByUser(b.id)
    expect(bRows.map(r => r.themeId)).toEqual(['t3'])
  })
})

describe('countThemesByUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns 0 for a user with no saved themes', async () => {
    const user = await createUser()
    expect(await countThemesByUser(user.id)).toBe(0)
  })

  it('counts only the caller\'s saved themes', async () => {
    const a = await createUser()
    const b = await createUser()
    await createTheme({ themeId: 'c1', userId: a.id, name: 'A1', theme: defaultTheme })
    await createTheme({ themeId: 'c2', userId: a.id, name: 'A2', theme: defaultTheme })
    await createTheme({ themeId: 'c3', userId: b.id, name: 'B1', theme: defaultTheme })
    expect(await countThemesByUser(a.id)).toBe(2)
    expect(await countThemesByUser(b.id)).toBe(1)
  })
})

describe('updateTheme', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('renames a theme owned by the caller', async () => {
    const user = await createUser()
    await createTheme({ themeId: 'tU', userId: user.id, name: 'Old', theme: defaultTheme })
    await updateTheme('tU', user.id, { name: 'New' })
    const r = await getThemeById('tU', user.id)
    expect(r?.name).toBe('New')
  })

  it('throws NotFound when the theme belongs to a different user', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    await createTheme({ themeId: 'tX', userId: owner.id, name: 'Mine', theme: defaultTheme })
    await expect(updateTheme('tX', stranger.id, { name: 'Stolen' }))
      .rejects.toBeInstanceOf(NotFoundError)
    // Underlying row untouched.
    const original = await getThemeById('tX', owner.id)
    expect(original?.name).toBe('Mine')
  })

  it('is a no-op when given an empty update', async () => {
    const user = await createUser()
    await createTheme({ themeId: 'tE', userId: user.id, name: 'Same', theme: defaultTheme })
    await updateTheme('tE', user.id, {})
    const r = await getThemeById('tE', user.id)
    expect(r?.name).toBe('Same')
  })
})

describe('deleteTheme', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('removes a theme owned by the caller', async () => {
    const user = await createUser()
    await createTheme({ themeId: 'tD', userId: user.id, name: 'Bye', theme: defaultTheme })
    await deleteTheme('tD', user.id)
    expect(await getThemeById('tD', user.id)).toBeNull()
  })

  it('throws NotFound when the theme belongs to a different user', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    await createTheme({ themeId: 'tDX', userId: owner.id, name: 'Mine', theme: defaultTheme })
    await expect(deleteTheme('tDX', stranger.id))
      .rejects.toBeInstanceOf(NotFoundError)
    expect(await getThemeById('tDX', owner.id)).not.toBeNull()
  })
})
