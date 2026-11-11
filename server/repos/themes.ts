import { and, desc, eq, sql } from 'drizzle-orm'
import { themes } from '../db/schema'
import type { DocTheme } from '~~/shared/types/theme'
import { useDatabase } from '../utils/platform/database'
import { NotFoundError } from './errors'

// User-saved theme presets. Per-user, never shared. A user lists,
// creates, renames, and deletes through this repo; the per-user cap
// (20) is enforced in the create endpoint so list/get/delete don't
// pay the cost of a count query.

export interface ThemeRow {
  themeId: string
  userId: number
  name: string
  description: string
  theme: DocTheme
  createdAt: Date
  updatedAt: Date
}

export async function listThemesByUser(userId: number): Promise<ThemeRow[]> {
  const db = useDatabase()
  const rows = await db
    .select({
      themeId: themes.themeId,
      userId: themes.userId,
      name: themes.name,
      description: themes.description,
      theme: themes.theme,
      createdAt: themes.createdAt,
      updatedAt: themes.updatedAt
    })
    .from(themes)
    .where(eq(themes.userId, userId))
    .orderBy(desc(themes.updatedAt))
  return rows
}

export async function getThemeById(themeId: string, userId: number): Promise<ThemeRow | null> {
  const db = useDatabase()
  // The `(themeId, userId)` tuple guards against cross-user access
  // even when an attacker guesses a valid id — same shape as the
  // (activityId, docId) tuple in the activity repo.
  const row = (await db
    .select({
      themeId: themes.themeId,
      userId: themes.userId,
      name: themes.name,
      description: themes.description,
      theme: themes.theme,
      createdAt: themes.createdAt,
      updatedAt: themes.updatedAt
    })
    .from(themes)
    .where(and(eq(themes.themeId, themeId), eq(themes.userId, userId)))
    .limit(1))[0]
  return row ?? null
}

export async function countThemesByUser(userId: number): Promise<number> {
  const db = useDatabase()
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(themes)
    .where(eq(themes.userId, userId))
  return rows[0]?.n ?? 0
}

export async function createTheme(input: {
  themeId: string
  userId: number
  name: string
  description?: string
  theme: DocTheme
}): Promise<ThemeRow> {
  const db = useDatabase()
  const [row] = await db
    .insert(themes)
    .values({
      themeId: input.themeId,
      userId: input.userId,
      name: input.name,
      description: input.description ?? '',
      theme: input.theme
    })
    .returning({
      themeId: themes.themeId,
      userId: themes.userId,
      name: themes.name,
      description: themes.description,
      theme: themes.theme,
      createdAt: themes.createdAt,
      updatedAt: themes.updatedAt
    })
  return row!
}

export async function updateTheme(
  themeId: string,
  userId: number,
  update: { name?: string, description?: string, theme?: DocTheme }
): Promise<void> {
  if (Object.keys(update).length === 0) return
  const db = useDatabase()
  const result = await db
    .update(themes)
    .set({ ...update, updatedAt: new Date() })
    .where(and(eq(themes.themeId, themeId), eq(themes.userId, userId)))
    .returning({ themeId: themes.themeId })
  if (result.length === 0) {
    throw new NotFoundError('Theme')
  }
}

export async function deleteTheme(themeId: string, userId: number): Promise<void> {
  const db = useDatabase()
  const result = await db
    .delete(themes)
    .where(and(eq(themes.themeId, themeId), eq(themes.userId, userId)))
    .returning({ themeId: themes.themeId })
  if (result.length === 0) {
    throw new NotFoundError('Theme')
  }
}
