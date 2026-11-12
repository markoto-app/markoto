// Per-workspace single sign-on: connections, verified domains, linked identities, grants.

import { pgTable, serial, integer, text, timestamp, primaryKey, index, uniqueIndex, boolean } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { workspaces } from './workspaces'

// Per-workspace single sign-on. A Business workspace connects its own identity provider (OIDC or SAML).
// See `server/utils/sso/AGENTS.md` for the flow; the rules in short:
//
//   - One connection per workspace. `draft` until an admin completed a
//     test sign-in through it, then `active`. An active connection is
//     ALWAYS enforced: members reach the workspace only with a current
//     `sso_grants` row (written by a sign-in through it, 12 h).
//   - Domains: the workspace proves ownership with a DNS TXT record. A
//     verified domain is unique across workspaces; only addresses in a
//     verified domain link to an existing account or join by JIT.
//   - Identities: (connection, subject) → user. Separate from the
//     instance-wide OIDC columns on `users`, which are for the operator's IdP.
export const ssoConnections = pgTable('sso_connections', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().unique().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  protocol: text('protocol', { enum: ['oidc', 'saml'] }).notNull(),
  status: text('status', { enum: ['draft', 'active'] }).notNull().default('draft'),
  // OIDC: issuer (https), client id, client secret (AES-256-GCM, never
  // returned to the client).
  oidcIssuer: text('oidc_issuer'),
  oidcClientId: text('oidc_client_id'),
  oidcClientSecret: text('oidc_client_secret'),
  // SAML: the IdP's entity id, its SSO (redirect-binding) URL and its
  // signing certificate (PEM, pasted — never fetched).
  samlIdpEntityId: text('saml_idp_entity_id'),
  samlSsoUrl: text('saml_sso_url'),
  samlIdpCert: text('saml_idp_cert'),
  // Role of a member who joins by signing in (JIT) or by SCIM.
  defaultRole: text('default_role', { enum: ['editor', 'viewer'] }).notNull().default('editor'),
  // SCIM bearer token, SHA-256 (the raw token is shown once).
  scimTokenHash: text('scim_token_hash').unique(),
  createdByUserId: integer('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const ssoDomains = pgTable('sso_domains', {
  id: serial('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  // Lower-case, no trailing dot.
  domain: text('domain').notNull(),
  // Value of the `markoto-verification=<token>` TXT record.
  verificationToken: text('verification_token').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('uq_sso_domains_ws_domain').on(table.workspaceId, table.domain),
  // A domain can be VERIFIED by one workspace only.
  uniqueIndex('uq_sso_domains_verified').on(table.domain).where(sql`${table.verifiedAt} is not null`)
])

export const userIdentities = pgTable('user_identities', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull().references(() => ssoConnections.id, { onDelete: 'cascade' }),
  // OIDC `sub` / SAML NameID (persistent) — never the email.
  subject: text('subject').notNull(),
  // SCIM `externalId` / `id` mapping: SCIM-created identities carry it.
  scimExternalId: text('scim_external_id'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true })
}, table => [
  uniqueIndex('uq_user_identities_conn_subject').on(table.connectionId, table.subject),
  index('idx_user_identities_user').on(table.userId)
])

// A sign-in through a workspace's IdP: lets the user into that workspace
// while SSO is enforced. Valid until `expires_at` (12 h) and only for the
// session epoch it was written in ("log out everywhere" voids it).
export const ssoGrants = pgTable('sso_grants', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  sessionEpoch: integer('session_epoch').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
}, table => [
  primaryKey({ columns: [table.userId, table.workspaceId] })
])
