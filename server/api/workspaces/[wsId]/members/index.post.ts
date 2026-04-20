import { eq, sql } from 'drizzle-orm'
import { users, workspaceMembers } from '../../../../db/schema'

// Add a collaborator to a workspace by email. Admin-only.
//
// Lookup is **exact-email-only**: no substring/typeahead endpoint exists,
// because returning partial matches on email would let any logged-in user
// enumerate the registered user base. Caller types the full address; we
// resolve server-side and 404 if there's no account. This matches Slack /
// Notion / GitHub invite flows.
//
// Email comparison is case-insensitive (users may have signed up with a
// capitalized email via GitHub but type lowercase when inviting).
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const body = await readBody<{ email?: unknown, role?: unknown }>(event)
  const db = useDatabase()

  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can add members' })
  }

  const rawEmail = typeof body?.email === 'string' ? body.email.trim() : ''
  if (!rawEmail) throw createError({ statusCode: 400, message: 'Email is required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    throw createError({ statusCode: 400, message: 'Invalid email address' })
  }

  // Default role for new invites is 'editor' — the most common case. Admin
  // picks viewer or admin from the UI dropdown if they want to override.
  const newRole = typeof body?.role === 'string' ? body.role : 'editor'
  if (newRole !== 'admin' && newRole !== 'editor' && newRole !== 'viewer') {
    throw createError({ statusCode: 400, message: 'Invalid role' })
  }

  const userRow = (await db.select({ id: users.id, name: users.name, email: users.email, avatarUrl: users.avatarUrl, login: users.login })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${rawEmail})`)
    .limit(1))[0]
  if (!userRow) {
    // 404 rather than 400 so the client can distinguish "no such account"
    // from a shape error. No PII-enumeration concern here — the caller
    // already knows the email (they typed it).
    throw createError({ statusCode: 404, message: 'No user with that email' })
  }

  // Prevent duplicate rows. Also catches the admin-adding-themselves case
  // (they're already in the table with role='admin').
  const existing = (await db.select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(sql`${workspaceMembers.workspaceId} = ${wsId} AND ${workspaceMembers.userId} = ${userRow.id}`)
    .limit(1))[0]
  if (existing) {
    throw createError({ statusCode: 409, message: 'Already a member of this workspace' })
  }

  await db.insert(workspaceMembers).values({
    workspaceId: wsId,
    userId: userRow.id,
    role: newRole
  })

  return {
    userId: userRow.id,
    name: userRow.name,
    email: userRow.email,
    login: userRow.login,
    avatarUrl: userRow.avatarUrl,
    role: newRole
  }
})
