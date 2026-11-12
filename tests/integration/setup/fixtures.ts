import { nanoid } from 'nanoid'
import { testDb } from './db'
import { DPA_VERSION, PRIVACY_VERSION, TOS_VERSION } from '../../../shared/legal/versions'
import { first } from '../../helpers/assert'

// Factory helpers. Each one writes a minimal row and returns enough shape
// for the test to use in assertions. Intended to be cheap, no validation
// beyond what Postgres enforces, so tests can produce odd combinations
// (e.g. a workspace doc with no members) to stress the authz layer.

export interface TestUser {
  id: number
  name: string
  email: string
}

export interface CreateUserOpts {
  name?: string
  email?: string
  /**
   * Whether to seed the privacy / ToS / DPA acceptance + age confirmation
   * to current versions. Default `true` because most integration tests
   * exercise post-onboarding behaviour and the workspace endpoint (and
   * other endpoints to come) refuse to operate on an un-accepted user.
   *
   * Pass `freshOnboarding: true` for tests that explicitly cover the
   * onboarding gate (e.g. asserting a 409 before DPA acceptance).
   */
  freshOnboarding?: boolean
}

export async function createUser(overrides: CreateUserOpts = {}): Promise<TestUser> {
  const db = testDb()
  const name = overrides.name ?? `User ${nanoid(6)}`
  const email = overrides.email ?? `${nanoid(8)}@test.local`
  const fresh = overrides.freshOnboarding === true
  // github_id is optional per schema, but we set a unique one anyway so tests that log in via OAuth-style paths
  // have a plausible shape. Default behaviour mirrors a post-onboarding user: privacy + ToS + DPA accepted at
  // current versions, age confirmed. The DPA gate on `POST /api/workspaces` refuses workspace creation
  // otherwise; tests that care about that gate opt out via `freshOnboarding: true`.
  const result = await db.query<{ id: number }>(
    fresh
      ? `INSERT INTO users (name, email, github_id)
         VALUES ($1, $2, $3)
         RETURNING id`
      : `INSERT INTO users (
           name, email, github_id,
           age_confirmed_at,
           privacy_version_accepted, privacy_version_accepted_locale,
           tos_version_accepted, tos_version_accepted_locale,
           dpa_version_accepted, dpa_version_accepted_locale
         ) VALUES ($1, $2, $3, NOW(), $4, $5, $6, $5, $7, $5)
         RETURNING id`,
    fresh
      ? [name, email, `gh-${nanoid(10)}`]
      : [name, email, `gh-${nanoid(10)}`, PRIVACY_VERSION, 'en', TOS_VERSION, DPA_VERSION]
  )
  return { id: first(result.rows).id, name, email }
}

export type AccessMode = 'private' | 'open-edit' | 'open-view' | 'password-protected'

export interface TestDoc {
  docId: string
  ownerId: number | null
  workspaceId: string | null
  accessMode: AccessMode
}

export interface CreateDocExtras {
  passwordHash?: string | null
  /** Doc context fields. Omitted ones inherit the schema defaults. */
  title?: string
  description?: string
  audience?: 'technical' | 'marketing' | 'academic' | 'casual' | 'business' | 'creative'
  language?: string
  templateId?: string
  /** Stored theme (documents.theme JSONB). */
  theme?: unknown
}

export async function createDoc(overrides: Partial<TestDoc> & CreateDocExtras = {}): Promise<TestDoc> {
  const db = testDb()
  const docId = overrides.docId ?? `doc-${nanoid(10)}`
  const ownerId = overrides.ownerId ?? null
  const workspaceId = overrides.workspaceId ?? null
  // Anonymous docs default to open-edit, matches docs.post.ts behaviour.
  const accessMode: AccessMode = overrides.accessMode
    ?? (ownerId === null ? 'open-edit' : 'private')
  const passwordHash = overrides.passwordHash ?? null
  const title = overrides.title ?? 'Test Doc'

  // Build the column list dynamically so omitted context fields inherit
  // the schema defaults (description='', audience='casual', language='en',
  // template_id='blank'): same shape as the real POST handler.
  const cols: string[] = ['doc_id', 'owner_id', 'workspace_id', 'access_mode', 'password_hash', 'title']
  const vals: unknown[] = [docId, ownerId, workspaceId, accessMode, passwordHash, title]
  if (overrides.theme !== undefined) {
    cols.push('theme')
    vals.push(JSON.stringify(overrides.theme))
  }
  if (overrides.description !== undefined) {
    cols.push('description')
    vals.push(overrides.description)
  }
  if (overrides.audience !== undefined) {
    cols.push('audience')
    vals.push(overrides.audience)
  }
  if (overrides.language !== undefined) {
    cols.push('language')
    vals.push(overrides.language)
  }
  if (overrides.templateId !== undefined) {
    cols.push('template_id')
    vals.push(overrides.templateId)
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ')
  await db.query(
    `INSERT INTO documents (${cols.join(', ')}) VALUES (${placeholders})`,
    vals
  )
  return { docId, ownerId, workspaceId, accessMode }
}

export interface TestWorkspace {
  workspaceId: string
  ownerId: number
  name: string
}

export async function createWorkspace(ownerId: number, overrides: Partial<TestWorkspace> = {}): Promise<TestWorkspace> {
  const db = testDb()
  const workspaceId = overrides.workspaceId ?? `ws-${nanoid(8)}`
  const name = overrides.name ?? `Workspace ${nanoid(4)}`
  await db.query(
    `INSERT INTO workspaces (workspace_id, owner_id, name) VALUES ($1, $2, $3)`,
    [workspaceId, ownerId, name]
  )
  // Creator is always an admin of their own workspace (matches prod path).
  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [workspaceId, ownerId]
  )
  return { workspaceId, ownerId, name }
}

export type WorkspaceRole = 'admin' | 'editor' | 'viewer' | 'guest'

export async function setMemberRole(workspaceId: string, userId: number, role: WorkspaceRole): Promise<void> {
  const db = testDb()
  // Upsert: this helper doubles as "add member with role" and "change
  // role". Matches what the PATCH endpoint does in the app layer minus
  // the last-admin invariant check.
  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [workspaceId, userId, role]
  )
}

export async function removeMember(workspaceId: string, userId: number): Promise<void> {
  const db = testDb()
  await db.query(
    `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId]
  )
}

/**
 * Set or clear the password hash on an existing doc. Uses nuxt-auth-utils'
 * scrypt: same path the real /password endpoint writes through. Tests
 * verifying password-gated access call this after createDoc().
 */
export async function setDocPasswordHash(docId: string, hash: string | null): Promise<void> {
  const db = testDb()
  await db.query(
    `UPDATE documents SET password_hash = $1 WHERE doc_id = $2`,
    [hash, docId]
  )
}
