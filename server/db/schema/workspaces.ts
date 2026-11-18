// Workspaces, their members and pending invitations.

import { pgTable, serial, integer, bigint, text, timestamp, primaryKey, index, uniqueIndex, jsonb, boolean, doublePrecision } from 'drizzle-orm/pg-core'
import type { DocTheme } from '~~/shared/types/theme'
import { users } from './users'

export const workspaces = pgTable('workspaces', {
  id: serial('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().unique(),
  // Immutable original creator. Authorization goes through
  // `workspace_members.role`; ownerId is provenance only and is not
  // changed by promoting/demoting admins.
  ownerId: integer('owner_id').notNull().references(() => users.id),
  name: text('name').notNull().default('My Workspace'),
  description: text('description'),
  // Theme applied to NEW documents in this workspace. NULL = the built-in
  // preset. Snapshotted at creation: changing it doesn't retheme existing
  // docs.
  defaultTheme: jsonb('default_theme').$type<DocTheme>(),
  // Brand kit: while true (and the plan includes `brandKit`), every
  // document in the workspace renders with `default_theme`'s design,
  // only its cover text stays its own (shared/utils/theme/brandLock.ts).
  // Enforced at render time; the documents' own themes are untouched.
  brandLocked: boolean('brand_locked').notNull().default(false),
  // Bumped by a database trigger on every change to the workspace's folders
  // and documents (create, rename, move, delete), in the same transaction:
  // open explorers poll it and refetch when it moved (migration 0009).
  explorerVersion: bigint('explorer_version', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_workspaces_owner').on(table.ownerId)
])

// Membership + role table. Single source of truth for "who can do what" in
// a workspace. The creator always has a row here with role='admin' (inserted
// on workspace creation). FK cascades keep membership in sync when the
// workspace or the user disappears.
//
// Invariant enforced at the API layer (not SQL): every workspace must have
// at least one admin. Demoting/removing the last admin is refused.
export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // `guest`: someone outside the team who sees ONLY the documents
  // shared with them (`document_shares`). Not a member for any
  // workspace-level access: `getMemberRole` returns null for guests.
  role: text('role', { enum: ['admin', 'editor', 'viewer', 'guest'] }).notNull().default('editor'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  // Team / Business: the member's monthly AI limit inside the
  // workspace's pooled budget, in USD. NULL = the default (2 × the
  // per-seat budget); `ai_unlimited` = no member limit (the team budget
  // still applies). Set by workspace admins.
  aiLimitUsd: doublePrecision('ai_limit_usd'),
  aiUnlimited: boolean('ai_unlimited').notNull().default(false),
  // The member's LiteLLM key inside the workspace's LiteLLM team, created
  // on first AI use there (`server/utils/litellm/workspaceTeams.ts`).
  // Token AES-256-GCM-encrypted like `users.litellm_key_token`.
  litellmKeyId: text('litellm_key_id'),
  litellmKeyToken: text('litellm_key_token')
}, table => [
  primaryKey({ columns: [table.workspaceId, table.userId] }),
  index('idx_workspace_members_user').on(table.userId)
])

// Pending workspace invitations. Inviting by email no longer adds a
// member: it creates one of these rows, and only the invitee accepting
// it (in-app, matched on their verified account email, or via the
// emailed link) creates the `workspace_members` row.
//
//   - `email` is the address the admin typed, normalised (trim +
//     lower-case). Matched case-insensitively against `users.email`
//     (only verified addresses are stored there) for the in-app list.
//   - `token_hash` = SHA-256 of the single-use accept token sent by
//     email; NULL when no email was sent (email not configured). The
//     raw token only exists in the email.
//   - One open invite per (workspace, email); re-inviting refreshes it.
//   - Expired rows are deleted by the `workspace-invite-sweep`; accept /
//     decline / revoke delete the row.
//   - CASCADE with the workspace; `invited_by` SET NULL when the
//     inviter's account is deleted.
export const workspaceInvites = pgTable('workspace_invites', {
  id: serial('id').primaryKey(),
  inviteId: text('invite_id').notNull().unique(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role', { enum: ['admin', 'editor', 'viewer', 'guest'] }).notNull().default('editor'),
  invitedByUserId: integer('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  tokenHash: text('token_hash').unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('uq_workspace_invites_ws_email').on(table.workspaceId, table.email),
  // Invitee lookup ("invites for my email") + account-deletion purge.
  index('idx_workspace_invites_email').on(table.email),
  // Sweeper: expired rows.
  index('idx_workspace_invites_expires').on(table.expiresAt)
])
