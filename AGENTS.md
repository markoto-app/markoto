# YPad — Implementation Plan (Final)

## Collaborative Markdown Editor with Full-Stack Nuxt 4, Y.js, Hocuspocus, OAuth, and AI

A collaborative markdown editor with live sync via Y.js CRDT and Hocuspocus, OAuth authentication (GitHub, Google) via `nuxt-auth-utils`, user/document data in **PostgreSQL** via Drizzle ORM, Y.js document state persisted in Postgres via `y-postgresql`, S3-compatible object storage for image uploads (SeaweedFS in dev, Infomaniak S3 in prod), multi-lingual UI via `@nuxtjs/i18n`, and AI writing assistance powered by Google Gemini. Log in to own and manage documents across devices, or skip login to edit public documents anonymously. The full-stack Nuxt app and Hocuspocus sync server run on a single Linux VPS with Docker Compose.

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         Browser                                    │
│              Nuxt 4 (SSR + SPA hydration)                         │
│                                                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────────┐  │
│  │CodeMirror│ │ Nuxt UI  │ │ Y.js     │ │ AI (Google Gemini)  │  │
│  │  6 +     │ │   v4     │ │ Hocusp.  │ │ joins doc as a      │  │
│  │  yCollab │ │   i18n   │ │ Provider │ │ Y.js client         │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────────┬──────────┘  │
│       └──────────────┴───────────┴──────────────────┘             │
│                   │ WSS              │ HTTPS                      │
└───────────────────┼──────────────────┼────────────────────────────┘
                    │                  │
           ┌────────▼──────────────────▼────────┐
           │          Traefik v3                 │  ← Let's Encrypt
           │       (reverse proxy + healthcheck) │     auto TLS
           └──┬──────────┬──────────┬───────────┘
              │          │          │
     ┌────────▼───┐ ┌────▼─────────────────┐ ┌─▼───────────────┐
     │Hocuspocus  │ │ Nuxt 4 Full-Stack    │ │ External S3     │
     │Y.js sync   │ │ (Bun + Nitro)        │ │ (Infomaniak)    │
     │server      │ │                      │ │                 │
     │            │ │ • SSR + SPA hydrate  │ │ • image uploads │
     │ • rooms    │ │ • server/api/ routes │ │ • pg backups    │
     │ • auth JWT │ │ • OAuth (GH/Google)  │ │                 │
     │ • y-pg     │ │ • Drizzle ORM + PG   │ │ (dev: SeaweedFS │
     │ • awareness│ │ • presigned S3 URLs  │ │  in compose)    │
     │ • read-only│ │ • import/export      │ └─────────────────┘
     │ • SIGTERM  │ │ • AI agent (Gemini)  │
     │   drain    │ └──────────────────────┘  ┌─────────────────┐
     └─────┬──────┘            │               │ Pandoc Server   │
           │                    │               │ (HTTP wrapper)  │
           │   ┌────────────────▼───┐           │ • pandoc/extra  │
           └──►│   PostgreSQL 16    │           │ • PDF/DOCX/md   │
               │                    │           └─────────────────┘
               │ • users, docs,     │           ┌─────────────────┐
               │   workspaces, etc. │◄──────────┤ Backup Sidecar  │
               │ • yjs_documents    │   daily   │ pg_dump → S3    │
               │   (y-postgresql)   │           │ 30-day retain   │
               │ • drizzle          │           └─────────────────┘
               │   migrations       │
               └────────────────────┘

              Linux VPS (Docker Compose)
```

**Key design principles:**

- **Full-stack Nuxt replaces both GitHub Pages and Fastify.** Nuxt serves the SPA, handles API routes via Nitro `server/api/`, and manages OAuth sessions — all in one Bun process. Zero CDN dependency.
- **OAuth is optional, not mandatory.** Public documents work without login. Anyone with the link can view (or edit, if the owner allows). Login is required to create documents, manage permissions, use workspaces, or delete.
- **Drizzle ORM + PostgreSQL for app data.** Type-safe ORM over `node-postgres`. Schema defined in `server/db/schema.ts` with full TypeScript inference. Stores users, document ownership, uploads, workspace membership, activity log, rate-limit hits, and AI sessions. Real versioned migrations via `drizzle-kit generate` applied at boot by a Nitro plugin.
- **Y.js document state lives in Postgres too.** `y-postgresql` (table `yjs_documents`) replaces the previous S3-blob-overwrite scheme. It appends granular updates and auto-merges per flush threshold — far more durable than the old single-blob overwrite.
- **S3 is for image uploads (and pg backups), nothing else.** External S3 (Infomaniak) in production; SeaweedFS only exists in `docker-compose.dev.yml` for local development.
- **Y.js CRDT for conflict-free collaboration.** Browsers maintain a local Y.Doc that merges automatically. No custom OT.
- **Hocuspocus is the sync server.** WebSocket rooms, Y.js persistence via y-postgresql, awareness (cursors/presence), auth hooks, read-only access, graceful SIGTERM drain — all out of the box or wired to Hocuspocus's own `destroy()`.
- **AI is Google Gemini, and it joins the document as a real Y.js collaborator.** The Nuxt server opens its own `HocuspocusProvider` connection as the AI user; every edit lands via `ydoc.transact(...)` and broadcasts through the existing sync infrastructure. No SSE/streaming protocol to the browser — status updates ride on Y.js awareness. See Section 15.
- **Pandoc runs as a separate HTTP service.** A lightweight Python HTTP wrapper around `pandoc/extra` Docker image. Both dev and production use the same container. Keeps the Nuxt container lightweight (no TeX/font dependencies).
- **Daily Postgres backups to S3.** A sidecar container pipes `pg_dump | gzip` to the configured S3 bucket on interval; same script, same env vars in dev (→ SeaweedFS) and prod (→ Infomaniak).

---

## 2. Technology Stack — Pinned Versions

### 2.1 Runtime

| Tool | Version | Purpose |
|---|---|---|
| **Bun** | 1.3.12 | JavaScript/TypeScript runtime, package manager, bundler |
| **Nuxt** | 4.4.2 | Full-stack Vue framework (SSR + API) |
| **Nitro** | (bundled with Nuxt) | Server engine, runs on Bun |

### 2.2 Nuxt Modules

All registered in `nuxt.config.ts` `modules` array. Auto-import composables and components.

| Module | Version | Purpose |
|---|---|---|
| `@nuxt/ui` | 4.6.1 | 125+ UI components (Reka UI + Tailwind v4) |
| `nuxt-auth-utils` | 0.5.29 | OAuth (GitHub, Google, 40+ providers), sealed cookie sessions |
| `@nuxtjs/i18n` | 10.2.1 | i18n with Vue I18n, lazy-loaded locales, 6 languages |
| `@vueuse/nuxt` | 14.2.1 | 200+ auto-imported VueUse composables |
| `@pinia/nuxt` | 0.11.3 | Pinia state management (must be listed before Colada) |
| `@pinia/colada-nuxt` | 0.3.2 | Pinia Colada data fetching (useQuery, useMutation) |
| `@vite-pwa/nuxt` | 0.10.6 | PWA with Workbox |
| `nuxt-codemirror` | 0.0.11 | CodeMirror 6 Vue component + composable |

### 2.3 Frontend Dependencies

| Package | Version | Purpose |
|---|---|---|
| `yjs` | 13.6.30 | CRDT document model |
| `y-codemirror.next` | 0.3.5 | CM6 Y.js binding with remote cursors |
| `@hocuspocus/provider` | 3.4.4 | WebSocket provider for Hocuspocus |
| `@codemirror/lang-markdown` | 6.3.2 | Markdown + GFM language support |
| `@codemirror/language-data` | 6.5.1 | Syntax highlighting for fenced code blocks |
| `markdown-it` | 14.1.0 | Preview rendering |
| `markdown-it-task-lists` | 2.1.1 | Task list checkboxes |
| `markdown-it-emoji` | 3.0.0 | Emoji shortcodes |
| `markdown-it-footnote` | 4.0.0 | Footnotes |
| `markdown-it-container` | 4.0.0 | Custom containers (warning, info, tip) |
| `highlight.js` | 11.11.1 | Code highlighting in preview |
| `dompurify` | 3.2.4 | XSS sanitization |
| `nanoid` | 5.1.5 | Document/workspace ID generation |
| `@google/genai` | ^1.50 | Google Gemini SDK — function tools, grounding via web_search sub-call |

### 2.4 Hocuspocus Sync Server Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@hocuspocus/server` | 3.4.4 | Y.js WebSocket sync server |
| `y-postgresql` | 1.0.1 | Append-only Y.js persistence to Postgres (replaces S3 blob overwrite) |
| `pg` | ^8.20 | node-postgres driver (used by y-postgresql's internal pool) |
| `yjs` | 13.6.30 | Shared with frontend |
| `jsonwebtoken` | 9.0.2 | JWT verification for protected docs |

### 2.5 Nuxt Server Dependencies

| Package | Version | Purpose |
|---|---|---|
| `drizzle-orm` | 0.45.2 | Type-safe ORM (node-postgres adapter) |
| `drizzle-kit` | 0.31.10 (dev) | Generates versioned SQL migrations in `drizzle/` |
| `pg` | ^8.20 | node-postgres driver |
| `@aws-sdk/client-s3` | 3.750.0 | S3 storage for image uploads |
| `@aws-sdk/s3-request-presigner` | 3.750.0 | Presigned URLs |
| `jsonwebtoken` | 9.0.2 | JWT for Hocuspocus auth tokens |
| `zod` | ^4 | Runtime validation of Gemini function-call args; source-of-truth for AI tool JSON schemas via `z.toJSONSchema` |

**Note:** `argon2` is no longer needed — `nuxt-auth-utils` provides built-in `hashPassword` / `verifyPassword` using scrypt (works on all JS runtimes including Bun). Document password hashing uses this instead.

---

## 3. Nuxt Configuration

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  // Dev proxy: forward S3 requests through localhost:3000 to avoid CORS.
  // WebSocket (Hocuspocus) connects directly — no same-origin restriction.
  // In production, Traefik handles routing for all subdomains.
  nitro: {
    devProxy: {
      '/_s3': {
        target: 'http://localhost:8333',
        changeOrigin: true
      }
    }
  },

  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    'nuxt-auth-utils',
    '@nuxtjs/i18n',
    '@vueuse/nuxt',
    '@pinia/nuxt',
    '@pinia/colada-nuxt',
    '@vite-pwa/nuxt',
    'nuxt-codemirror',
  ],

  // Runtime config — populated from environment variables
  runtimeConfig: {
    // Server-only (not exposed to client)
    // nuxt-auth-utils uses `runtimeConfig.session` (h3 SessionConfig shape).
    // `NUXT_SESSION_PASSWORD` populates `session.password`; `maxAge` sets the
    // cookie TTL. Bumping `SESSION_VERSION` in server/utils/validatedSession.ts
    // invalidates all existing sessions on next request.
    session: {
      password: '',                // NUXT_SESSION_PASSWORD (≥32 chars)
      maxAge: 60 * 60 * 24 * 7     // 7 days
    },
    oauth: {
      github: {
        clientId: '',              // NUXT_OAUTH_GITHUB_CLIENT_ID
        clientSecret: '',          // NUXT_OAUTH_GITHUB_CLIENT_SECRET
      },
      google: {
        clientId: '',              // NUXT_OAUTH_GOOGLE_CLIENT_ID
        clientSecret: '',          // NUXT_OAUTH_GOOGLE_CLIENT_SECRET
      },
    },
    s3: {
      endpoint: '',                // NUXT_S3_ENDPOINT — Infomaniak in prod, SeaweedFS in dev
      accessKey: '',               // NUXT_S3_ACCESS_KEY
      secretKey: '',               // NUXT_S3_SECRET_KEY
      bucket: 'ypad',              // NUXT_S3_BUCKET
    },
    google: {
      apiKey: '',                              // NUXT_GOOGLE_API_KEY (required at startup)
      model: 'gemini-3.1-flash-lite-preview',  // NUXT_GOOGLE_MODEL — agentic prompt loop
      rewriteModel: 'gemini-2.5-flash-lite',   // NUXT_GOOGLE_REWRITE_MODEL — inline selection rewrites
    },
    jwtSecret: '',                 // NUXT_JWT_SECRET (for Hocuspocus tokens)
    internalApiSecret: '',         // NUXT_INTERNAL_API_SECRET (shared secret for server↔sync-server calls)
    pandocUrl: '',                 // NUXT_PANDOC_URL (http://pandoc:8080 in Docker, http://localhost:8080 in dev)
    syncInternalUrl: 'http://localhost:4001', // NUXT_SYNC_INTERNAL_URL (internal HTTP URL of sync-server for notify-deleted etc.)
    // DATABASE_URL — node-postgres connection string. Not namespaced under
    // runtimeConfig because pg.Pool reads it directly from process.env.
    // Public (exposed to client)
    public: {
      syncUrl: '',                 // NUXT_PUBLIC_SYNC_URL (wss://sync.yourdomain.com in prod, ws://localhost:4001 in dev)
    },
  },

  i18n: {
    locales: [
      { code: 'en', language: 'en-US', name: 'English', file: 'en.json' },
      { code: 'de', language: 'de-DE', name: 'Deutsch', file: 'de.json' },
      { code: 'fr', language: 'fr-FR', name: 'Français', file: 'fr.json' },
      { code: 'es', language: 'es-ES', name: 'Español', file: 'es.json' },
      { code: 'ja', language: 'ja-JP', name: '日本語', file: 'ja.json' },
      { code: 'zh', language: 'zh-CN', name: '中文', file: 'zh.json' },
    ],
    defaultLocale: 'en',
    // `lazy` was removed in @nuxtjs/i18n v10 — lazy loading is now the default
    // whenever `locales[].file` is set (which it is for us, via langDir).
    langDir: 'locales/',
    strategy: 'no_prefix',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'ypad_locale',
      fallbackLocale: 'en',
    },
  },

  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'YPad',
      short_name: 'YPad',
      description: 'Collaborative Markdown Editor',
      theme_color: '#0f172a',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    },
    workbox: {
      navigateFallback: undefined,  // SSR mode — no SPA fallback needed
      runtimeCaching: [{
        urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
        handler: 'CacheFirst',
        options: { cacheName: 'cdn-cache', expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 3600 } },
      }],
    },
  },

  css: ['~/assets/css/main.css'],

  app: {
    head: { title: 'YPad — Collaborative Markdown' },
  },
})
```

---

## 4. Authentication

### 4.1 OAuth via `nuxt-auth-utils`

`nuxt-auth-utils` v0.5.29 handles the entire OAuth flow: authorization redirect, callback, token exchange, and session management via encrypted HTTP-only cookies. No session database needed — sessions are sealed into the cookie itself.

**GitHub login server route:**

```typescript
// server/routes/auth/github.get.ts (abbreviated — see file for full details)
import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { SESSION_VERSION } from '../../utils/validatedSession'

export default defineOAuthGitHubEventHandler({
  config: { emailRequired: true },
  async onSuccess(event, { user }) {
    const db = useDatabase()
    // Upsert user via Drizzle query builder (driver-agnostic; async)
    const existing = (await db.select().from(users).where(eq(users.githubId, user.id.toString())).limit(1))[0]
    if (existing) {
      await db.update(users).set({
        login: user.login, name: user.name || user.login,
        email: user.email, avatarUrl: user.avatar_url
      }).where(eq(users.githubId, user.id.toString()))
    } else {
      await db.insert(users).values({
        githubId: user.id.toString(), login: user.login,
        name: user.name || user.login, email: user.email, avatarUrl: user.avatar_url
      })
    }
    const dbUser = (await db.select({ id: users.id }).from(users).where(eq(users.githubId, user.id.toString())).limit(1))[0]!

    await setUserSession(event, {
      user: {
        id: dbUser.id, login: user.login, name: user.name || user.login,
        email: user.email, avatar: user.avatar_url, provider: 'github'
      },
      loggedInAt: Date.now(),
      v: SESSION_VERSION  // bump this constant to invalidate all outstanding sessions
    })
    return sendRedirect(event, '/')
  }
})
```

**Google login server route:** mirrors the GitHub handler — same upsert pattern (on `users.googleId = user.sub`) and same `v: SESSION_VERSION` tag on the session.

**Client-side usage:**

```vue
<script setup lang="ts">
const { loggedIn, user, clear, openInPopup } = useUserSession()
const { t } = useI18n()
</script>

<template>
  <div v-if="loggedIn">
    <UAvatar :src="user.avatar" :alt="user.name" />
    <span>{{ user.name }}</span>
    <UButton variant="ghost" @click="clear">{{ t('auth.logout') }}</UButton>
  </div>
  <div v-else>
    <UButton @click="openInPopup('/auth/github')">
      {{ t('auth.loginGithub') }}
    </UButton>
    <UButton @click="openInPopup('/auth/google')">
      {{ t('auth.loginGoogle') }}
    </UButton>
  </div>
</template>
```

### 4.2 Auth Model

Login is **optional**. The system supports three user states:

| State | Can do | Cannot do |
|---|---|---|
| **Anonymous** (no login) | View public docs, edit open-edit docs | Create docs, manage permissions, use workspaces, delete |
| **Logged in** | Everything above + create, own, delete, manage permissions, workspaces | — |
| **Document owner** | Everything above + change access mode, transfer ownership | — |

### 4.3 Hocuspocus Auth Integration

When a logged-in user opens a document, the Nuxt server mints a short-lived JWT for the Hocuspocus connection. This consolidated endpoint returns the token plus document metadata (accessMode, ownerId) so `useDocument` only needs one fetch on init:

```typescript
// server/api/docs/[docId]/token.get.ts (abbreviated; see file for rate-limit etc.)
export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const session = await getValidatedUserSession(event)
  const db = useDatabase()
  const config = useRuntimeConfig()
  if (!config.jwtSecret) throw createError({ statusCode: 500, message: 'JWT secret not configured' })

  // Explicit projection — passwordHash is never needed here and this is a
  // public endpoint. 404ing before minting a JWT also closes a prior
  // info-disclosure primitive (where we used to sign tokens for non-existent docs).
  const doc = (await db
    .select({ accessMode: documents.accessMode, ownerId: documents.ownerId })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]
  if (!doc) throw createError({ statusCode: 404, message: 'Document not found' })

  const userId = session?.user?.id
  const isOwner = doc.ownerId != null && typeof userId === 'number' && doc.ownerId === userId
  let readOnly = false
  let requiresPassword = false
  let forbidden = false
  if (doc.accessMode === 'private' && !isOwner) { forbidden = true; readOnly = true }
  if (doc.accessMode === 'open-view' && !isOwner) readOnly = true
  if (doc.accessMode === 'password-protected' && !isOwner) { requiresPassword = true; readOnly = true }

  // Never issue a usable token for forbidden / password-gated docs — Hocuspocus
  // rejects the connection until the client unlocks via /password verify.
  if (forbidden || requiresPassword) {
    return { token: null, readOnly, requiresPassword, forbidden, accessMode: doc.accessMode, ownerId: doc.ownerId }
  }

  const token = jwt.sign(
    { docId, userId: userId || 'anonymous', userName: session?.user?.name ?? null, readOnly },
    config.jwtSecret,
    { expiresIn: '2h' }
  )
  return { token, readOnly, requiresPassword, forbidden: false, accessMode: doc.accessMode, ownerId: doc.ownerId }
})
```

---

## 5. Database — Drizzle ORM + PostgreSQL

### 5.1 Why Drizzle ORM + PostgreSQL

- **Real migrations.** `drizzle-kit generate` produces versioned SQL files in `drizzle/` (committed to git); the `00-db-migrate.ts` Nitro plugin runs `migrate()` on boot so schema changes apply atomically. Replaces the old hand-rolled SQLite migration shim.
- **Type-safe queries** — Drizzle provides full TypeScript inference from schema to query results. No `as any` casts.
- **Multi-instance ready.** Unlike SQLite, Postgres handles concurrent writers. If we ever outgrow one Nitro container, the data layer doesn't block us.
- **Schema-as-code** — schema defined in `server/db/schema.ts`, drives the generator and the TS types.
- **Durability + backups.** Daily `pg_dump | gzip → S3` via a sidecar (see Section 12 / 17). The same Postgres instance also hosts `yjs_documents` (via `y-postgresql`), so one `pg_dump` covers both app data and Y.js state.

Driver: `pg` (node-postgres) via `drizzle-orm/node-postgres`. We use one driver across the stack (app + sync-server) because `y-postgresql` requires `pg.PoolConfig`.

### 5.2 Schema

```typescript
// server/db/schema.ts (abbreviated — see file for all 9 tables)
import { pgTable, serial, integer, text, timestamp, primaryKey, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  githubId: text('github_id').unique(),
  googleId: text('google_id').unique(),
  login: text('login'),
  name: text('name').notNull(),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().unique(),
  ownerId: integer('owner_id').references(() => users.id),
  title: text('title').notNull().default('Untitled'),
  accessMode: text('access_mode', {
    enum: ['private', 'open-edit', 'open-view', 'password-protected']
  }).notNull().default('open-edit'),
  passwordHash: text('password_hash'),
  sizeBytes: integer('size_bytes').default(0),
  wordCount: integer('word_count').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActive: timestamp('last_active', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index('idx_documents_owner').on(table.ownerId),
  index('idx_documents_last_active').on(table.lastActive)
])
// Plus: documentShares, workspaces, workspaceDocuments, uploads, aiSessions,
//       rateLimits, activityLog. y-postgresql's own `yjs_documents` is managed
//       by the library, not by Drizzle.
```

**Enum strategy.** We use Drizzle's `text('col', { enum: [...] })` (plain text columns with TS-level enum constraint), not `pgEnum`. Adding values later is a zero-migration change — no `ALTER TYPE … ADD VALUE` friction. Server-side validation is enforced in route handlers.

### 5.2.1 Database Utility + Migration Plugin

```typescript
// server/utils/database.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '../db/schema'

let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let pool: Pool | null = null

export function useDatabase() {
  if (!db) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('[database] DATABASE_URL env is required')
    pool = new Pool({ connectionString: url })
    db = drizzle(pool, { schema })
  }
  return db
}

export async function closeDatabase() {
  if (pool) { await pool.end(); pool = null; db = null }
}
```

```typescript
// server/plugins/00-db-migrate.ts
// Numeric `00-` prefix forces this to load FIRST, before any other plugin
// touches the DB. The sweeper and rate-limit-cleanup plugins would otherwise
// race against schema creation on cold start.
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { useDatabase } from '../utils/database'

export default defineNitroPlugin(async () => {
  await migrate(useDatabase(), { migrationsFolder: process.env.DRIZZLE_MIGRATIONS_DIR || './drizzle' })
  console.log('[db-migrate] Migrations applied successfully.')
})
```

```typescript
// server/plugins/99-shutdown.ts — numeric `99-` forces last-load.
// Closes the pg pool on Nitro's `close` hook so in-flight queries drain
// instead of being killed when the container receives SIGTERM.
```

### 5.2.2 Example Query (all handlers are async now)

```typescript
// server/api/docs/[docId]/meta.get.ts
import { eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const db = useDatabase()
  // Explicit projection — never ship `passwordHash` over a public endpoint.
  const doc = (await db
    .select({
      id: documents.id,
      docId: documents.docId,
      ownerId: documents.ownerId,
      title: documents.title,
      accessMode: documents.accessMode,
      sizeBytes: documents.sizeBytes,
      wordCount: documents.wordCount,
      createdAt: documents.createdAt,
      lastActive: documents.lastActive
    })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]
  if (!doc) throw createError({ statusCode: 404, message: 'Document not found' })
  return { ...doc, hasPassword: doc.accessMode === 'password-protected' }
})
```

There is no `.get()` / `.all()` / `.run()` API — `drizzle-orm/node-postgres` queries are Promise-returning. `(await db.select()...limit(1))[0]` is the standard "first row" idiom.

### 5.2.3 Migration workflow

- **Generate:** edit `server/db/schema.ts`, then `bun run db:generate`. drizzle-kit diffs against `drizzle/meta/` snapshots and emits a new `drizzle/NNNN_*.sql` plus an updated snapshot. Commit both.
- **Apply (dev):** happens automatically on the next `bun run dev` (HMR triggers plugin re-run).
- **Apply (prod):** happens automatically on container start. Also exposed as `bun run db:migrate` for manual / CI use.
- **Track:** migration history lives in `drizzle.__drizzle_migrations` (drizzle-kit's default schema).
- **No backwards compat.** Bumping `SESSION_VERSION`, adding enum values, renaming columns — we break freely while pre-launch.

### 5.3 What lives where

| Data | Storage | Why |
|---|---|---|
| Users, documents, ownership, shares, workspaces | PostgreSQL (Drizzle ORM) | Type-safe relational queries |
| Y.js document state | PostgreSQL (`yjs_documents` via y-postgresql) | Append-only updates with periodic merge |
| Uploads (image metadata, confirmed flag) | PostgreSQL (`uploads` table) | Tracks what lives in S3 and whether the PUT completed |
| Image/file blobs | S3 (`docs/{docId}/{fileId}.ext`) | Large binary, presigned URL access |
| AI sessions (per-user-per-doc cap) | PostgreSQL (`ai_sessions`) | UNIQUE index enforces cap across restarts |
| Rate-limit hits | PostgreSQL (`rate_limits`) | Sliding-window count survives restarts |
| Activity log | PostgreSQL (`activity_log`) | Capped at 500 rows per doc |
| Postgres backups | S3 (`backups/postgres/*.sql.gz`) | Daily `pg_dump | gzip` via sidecar |
| User sessions | Sealed cookies (`nuxt-auth-utils`) | No storage, versioned via `SESSION_VERSION` |

---

## 6. Nuxt Server API Routes

Nuxt's `server/` directory replaces the Fastify container entirely. All routes are Nitro event handlers running on Bun.

**Important:** Nitro maps `server/api/` to `/api/` and `server/routes/` to `/`. Files in `server/auth/` are NOT mapped to any URL — OAuth handlers must be in `server/routes/auth/` to be accessible at `/auth/github`.

### 6.1 Route Map

```
# Auth (handled by nuxt-auth-utils)
GET    /auth/github                    → OAuth redirect to GitHub
GET    /auth/google                    → OAuth redirect to Google
GET    /api/_auth/session              → Get current session (auto)

# Meta
GET    /api/health                     DB-touching health probe (used by healthchecks)
GET    /api/version                    Returns { buildId } for SPA staleness detection

# Documents
POST   /api/docs                       Create document (anonymous or owned by session user)
GET    /api/docs/:docId/meta           Get document metadata
PUT    /api/docs/:docId/meta           Update title, access mode, wordCount, sizeBytes (owner only)
DELETE /api/docs/:docId                Delete document + cascade S3 cleanup + notify sync-server (owner only)
GET    /api/docs/:docId/token          Get Hocuspocus JWT (null for password-protected until verified)
GET    /api/docs/:docId/activity       Get activity log (latest 50 entries)
POST   /api/docs/:docId/password       Set/verify/remove password

# Internal (secret-auth'd via X-Internal-Secret header; called only by sync-server)
POST   /api/internal/activity          Log an activity entry (edit/join/leave)

# User
GET    /api/user/documents             List user's documents
GET    /api/user/recent                List recently visited docs

# Files
POST   /api/upload/request             Request presigned S3 PUT URL (inserts unconfirmed uploads row)
POST   /api/upload/confirm             HEAD the S3 object; flip uploads.confirmed_at
GET    /api/files/:docId/:fileId       302 redirect to presigned S3 GET URL

# Import/Export
POST   /api/import                     PDF/DOCX → markdown via Pandoc
POST   /api/export/:docId              Markdown → PDF/DOCX via Pandoc

# Workspaces
POST   /api/workspaces                 Create workspace
GET    /api/workspaces/:wsId           Get workspace with doc list
PUT    /api/workspaces/:wsId           Update workspace name
POST   /api/workspaces/:wsId/docs      Add document to workspace
DELETE /api/workspaces/:wsId/docs/:docId  Remove doc from workspace
GET    /api/user/workspaces            List user's workspaces

# AI — see Section 15
POST   /api/ai/prompt                  Start an agentic prompt session (returns { sessionId })
POST   /api/ai/rewrite                 Inline selection rewrite (gemini-2.5-flash-lite, no tools)
POST   /api/ai/abort                   Cancel a session (initiator only; 403 otherwise)
```

### 6.2 Key Server Route Implementations

**Create document (anonymous allowed; logged-in docs default to `private`):**

```typescript
// server/api/docs.post.ts
import { nanoid } from 'nanoid'
import { documents } from '../db/schema'

export default defineEventHandler(async (event) => {
  const session = await getValidatedUserSession(event)  // null-tolerant
  const db = useDatabase()
  const docId = nanoid(10)
  const ownerId = session?.user?.id ?? null
  const accessMode = ownerId != null ? 'private' : 'open-edit'

  await db.insert(documents).values({ docId, ownerId, accessMode })
  return { docId }
})
```

**List user's documents (Drizzle query builder, driver-agnostic):**

```typescript
// server/api/user/documents.get.ts
import { eq, or, sql } from 'drizzle-orm'
import { documents, documentShares } from '../../db/schema'

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const db = useDatabase()
  const userId = session.user.id

  return await db.select({
    docId: documents.docId,
    title: documents.title,
    accessMode: documents.accessMode,
    wordCount: documents.wordCount,
    lastActive: documents.lastActive,
    sizeBytes: documents.sizeBytes,
    isOwner: sql<boolean>`${documents.ownerId} = ${userId}`
  })
    .from(documents)
    .leftJoin(documentShares, sql`${documentShares.docId} = ${documents.docId} AND ${documentShares.userId} = ${userId}`)
    .where(or(eq(documents.ownerId, userId), sql`${documentShares.userId} IS NOT NULL`))
    .orderBy(sql`${documents.lastActive} DESC`)
})
```

**Presigned upload (tracks the upload in Postgres BEFORE issuing the URL):**

The `uploads` table records every presigned URL we hand out. Rows start with
`confirmed_at = null`; the client's follow-up `/api/upload/confirm` call
(after its PUT to S3 succeeds) flips it. The orphan-cleanup plugin (Section
below) reaps rows older than 24 h that never got confirmed, along with any
S3 object they point at. This closes the "image in S3 with no DB record"
race that existed before uploads tracking.

```typescript
// server/api/upload/request.post.ts (abbreviated)
await db.insert(uploads).values({
  docId, fileId: `${fileId}.${ext}`, uploaderId: session.user.id,
  contentType, sizeBytes: size, s3Key: key
})
const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
  Bucket: config.s3.bucket, Key: key, ContentType: contentType, ContentLength: size
}), { expiresIn: 300 })
return { uploadUrl, fileId: `${fileId}.${ext}`, key, expiresIn: 300 }
```

**Document import via Pandoc HTTP service:**

```typescript
// server/api/import.post.ts
export default defineEventHandler(async (event) => {
  const formData = await readMultipartFormData(event)
  const file = formData?.find(f => f.name === 'file')
  if (!file) throw createError({ statusCode: 400, message: 'No file' })
  if (file.data.length > 50 * 1024 * 1024) throw createError({ statusCode: 413, message: 'Max 50MB' })

  const config = useRuntimeConfig()
  const ext = file.filename?.split('.').pop()?.toLowerCase()

  // Call Pandoc HTTP service (pandoc-server container)
  const response = await $fetch<string>(`${config.pandocUrl}/convert?from=${ext}&to=gfm`, {
    method: 'POST',
    body: file.data,
    headers: { 'Content-Type': 'application/octet-stream' }
  })

  const docId = nanoid(10)
  return { docId, markdown: response, source: ext }
})
```

**AI endpoints:** see Section 15 for the full architecture. The prompt endpoint returns `{ sessionId }` immediately and runs the agentic loop in a background task; edits stream to the client over Y.js (awareness + Hocuspocus), not SSE.

**Orphan cleanup (`server/plugins/orphan-cleanup.ts`)** runs 30 s after startup and hourly thereafter. Three layers:
1. Delete `uploads` rows where `confirmed_at IS NULL AND created_at < now - 24h`, and their S3 objects.
2. Delete entire `docs/{docId}/` S3 prefixes whose doc no longer exists in the `documents` table.
3. Defensive sweep: S3 objects with no matching `uploads.s3_key` AND `last_modified < now - 24h` are deleted (catches anything that slipped past tracking).

The 24 h grace window on layers 1 and 3 keeps the cleanup from racing a live upload flow.

### 6.3 Server Middleware — Auth Guard

```typescript
// server/middleware/auth.ts
export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  if (!path.startsWith('/api/')) return

  // Public routes that don't require authentication
  const publicRoutes = [
    { path: /^\/api\/health$/, methods: ['GET'] },
    { path: /^\/api\/docs$/, methods: ['POST'] },           // Anonymous doc creation
    { path: /^\/api\/docs\/[^/]+\/meta$/, methods: ['GET'] },
    { path: /^\/api\/docs\/[^/]+\/token$/, methods: ['GET'] },
    { path: /^\/api\/docs\/[^/]+\/password$/, methods: ['POST'] }, // Verify is public; set/remove check ownership inside
    { path: /^\/api\/docs\/[^/]+\/activity$/, methods: ['GET'] },
    { path: /^\/api\/export\//, methods: ['POST'] },    // Export is public (user already has content)
    { path: /^\/api\/import$/, methods: ['POST'] }      // Import is public (user uploads their own file)
  ]
  if (publicRoutes.some(r => r.path.test(path) && r.methods.includes(event.method))) return

  // All other API routes require authentication
  const protectedPrefixes = ['/api/docs/', '/api/workspaces', '/api/user', '/api/upload', '/api/import', '/api/export', '/api/ai']
  if (protectedPrefixes.some(p => path.startsWith(p))) {
    await requireUserSession(event)
  }
})
```

---

## 7. Hocuspocus Sync Server

Hocuspocus remains a separate container because it maintains long-lived WebSocket connections and in-memory Y.Doc state that shouldn't share the event loop with the Nuxt HTTP server.

### 7.1 Server Implementation

**Important:** Hocuspocus v3 uses the `Server` class (not `Hocuspocus`) for standalone servers. The `Hocuspocus` class is the config/core — `Server` wraps it with HTTP + WebSocket and provides the `.listen()` method.

```typescript
// sync-server/src/index.ts (abbreviated)
import { Server } from '@hocuspocus/server'
import { ypgPersistence } from './persistence'
import { auth } from './auth'
import { rateLimiter } from './rate-limiter'

const server = new Server({
  port: parseInt(process.env.PORT || '4001'),
  debounce: 2000,
  maxDebounce: 10000,

  async onLoadDocument(data) { return ypgPersistence.onLoadDocument(data) },
  async onStoreDocument(data) { await ypgPersistence.onStoreDocument(data) },
  async onAuthenticate(data) { return auth.onAuthenticate(data) },
  async onConnect(data) { rateLimiter.onConnect(data) },
  async onDisconnect(data) { rateLimiter.onDisconnect(data) },
  async onRequest(data) { /* health + internal-http dispatch, see 7.6 */ }
})
server.listen(server.port, () => console.log(`[hocuspocus] Sync server listening on port ${server.port}`))

// Graceful shutdown — drains WS connections and awaits pending Y.js stores via
// Hocuspocus's own destroy(), then closes the persistence pool.
async function shutdown(signal: string) {
  console.log(`[hocuspocus] Received ${signal}, draining…`)
  const killTimer = setTimeout(() => process.exit(1), 25_000)
  try {
    await server.destroy()
    await ypgPersistence.destroy()
    clearTimeout(killTimer)
    process.exit(0)
  } catch (e) {
    console.error('[hocuspocus] Shutdown error:', e)
    clearTimeout(killTimer)
    process.exit(1)
  }
}
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT') })
```

### 7.2 Y.js Persistence — y-postgresql

Replaces the previous S3-blob-overwrite scheme. `y-postgresql` (table `yjs_documents`) appends granular updates and auto-merges them per flush threshold. Durable — a failed write doesn't destroy prior state — and recoverable: `pg_dump` covers both app data and Y.js state in one snapshot.

```typescript
// sync-server/src/persistence.ts
import * as Y from 'yjs'
import { PostgresqlPersistence } from 'y-postgresql'

if (!process.env.DATABASE_URL) throw new Error('[persistence] DATABASE_URL env is required')

// useIndex forced to `false` because y-postgresql@1.0.1 has a SQL bug in the
// index-creation branch ("AND indexname = $1_docname_idx" — invalid pg param
// syntax). Our scale doesn't need it; revisit when upstream fixes.
const pgdb = await PostgresqlPersistence.build(
  { connectionString: process.env.DATABASE_URL },
  { tableName: 'yjs_documents', useIndex: false, flushSize: 200 }
)

export const ypgPersistence = {
  async onLoadDocument({ documentName }) {
    try { return await pgdb.getYDoc(documentName) }
    catch (e: any) { console.error('[persistence] load failed:', e?.message); return new Y.Doc() }
  },
  async onStoreDocument({ documentName, document }) {
    try { await pgdb.storeUpdate(documentName, Y.encodeStateAsUpdate(document)) }
    catch (e: any) { console.error('[persistence] store failed:', e?.message) }
  },
  async clearDocument(documentName) { await pgdb.clearDocument(documentName) },
  async destroy() { await pgdb.destroy() }
}
```

The sync-server no longer imports `@aws-sdk/client-s3`; S3 is purely for image uploads and is handled exclusively by the Nuxt app.

### 7.3 Authentication

**Important:** Hocuspocus always requires a valid JWT. No anonymous bypass — even anonymous users go through the Nuxt token endpoint to get a JWT with the correct `readOnly` flag. Password-protected docs get `token: null` from the endpoint, so Hocuspocus rejects the connection entirely until the password is verified and a real token is obtained.

The sync-server requires `JWT_SECRET` env var at startup (no hardcoded fallback).

```typescript
// sync-server/src/auth.ts
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) throw new Error('[auth] JWT_SECRET environment variable is required')

export const auth = {
  async onAuthenticate({ documentName, token }: { documentName: string; token: string | null }) {
    if (!token) throw new Error('Authentication required')

    try {
      const payload = jwt.verify(token, JWT_SECRET) as {
        docId: string; userId: string; readOnly: boolean
      }
      if (payload.docId !== documentName) throw new Error('Token scope mismatch')
      return { readOnly: payload.readOnly }
    } catch (e: any) {
      throw new Error('Invalid token')
    }
  },
}
```

### 7.4 Rate Limiting

**Note:** Hocuspocus v3 hook parameter shapes vary. The rate limiter is defensive — it won't crash if the data structure is unexpected, and tracks IPs via a separate `connectionIPs` map keyed by socket ID rather than mutating the connection object.

```typescript
// sync-server/src/rate-limiter.ts
const connectionsPerIP = new Map<string, number>()
const connectionIPs = new Map<string, string>()  // socketId → IP
const LIMITS = { maxConnectionsPerIP: 20, maxActiveRooms: 5000 }

export const rateLimiter = {
  onConnect(data: any) {
    try {
      const request = data.request || data.requestHeaders
      const headers = request?.headers || request || {}
      const ip = headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown'
      const current = connectionsPerIP.get(ip) || 0
      if (current >= LIMITS.maxConnectionsPerIP) throw new Error('Too many connections')
      connectionsPerIP.set(ip, current + 1)
      const socketId = data.socketId || String(Date.now())
      connectionIPs.set(socketId, ip)
    } catch (e: any) {
      if (e.message === 'Too many connections') throw e
    }
  },
  onDisconnect(data: any) {
    try {
      const socketId = data.socketId || ''
      const ip = connectionIPs.get(socketId)
      if (ip) {
        connectionIPs.delete(socketId)
        const n = (connectionsPerIP.get(ip) || 1) - 1
        n <= 0 ? connectionsPerIP.delete(ip) : connectionsPerIP.set(ip, n)
      }
    } catch {}
  }
}
```

### 7.5 Activity Logging

Sync-server logs an `edit` activity entry per `onStoreDocument` fire (debounced 2-10s by Hocuspocus).

- **Attribution**: primary source is `lastEditorByDoc` — a per-doc Map populated in `onChange` from the authenticated connection context (JWT `userName`). `onStoreDocument` reads it; if absent (e.g. right after a sync-server restart, or an anonymous client whose JWT had no userName), it falls back to `mostRecentEditorFromAwareness(awareness)`. The fallback path logs a `[hocuspocus] Attribution fallback …` warning so we can detect drift in prod.
- **Self-healing bootstrap.** Both `lastEditorByDoc` and `previousTextByDoc` (diff baseline) are process-local Maps with bootstrap-on-demand. `previousTextByDoc` is re-seeded from disk in `onLoadDocument`; `lastEditorByDoc` is per-edit, so a restart only loses attribution if a store fires before any onChange — vanishingly rare since stores fire on debounce of edits. Persisting either map would cost more than the edge case is worth.
- **Transport**: fire-and-forget HTTP POST to `${APP_URL}/api/internal/activity` with `X-Internal-Secret` header. 5 s timeout. Failures are logged, never block sync.
- **Cap**: Nuxt endpoint keeps only the latest 500 entries per doc (older ones are deleted on each insert past the cap).
- **Dev networking**: sync-server runs in Docker, Nuxt dev runs on host. Sync-server uses `host.docker.internal` (with `host-gateway` extra_host on Linux) to reach the host. Nuxt dev must bind to `0.0.0.0` (`bun run dev --host 0.0.0.0`).

### 7.6 Internal HTTP Endpoints

Sync-server uses Hocuspocus's `onRequest` hook to handle internal HTTP routes. All routes require `X-Internal-Secret` matching `INTERNAL_API_SECRET`.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Public, unauthenticated. Used by the Docker HEALTHCHECK and by Traefik's service-loadbalancer healthcheck to stop routing to a container once it goes red (e.g. during graceful shutdown). |
| `POST /internal/notify-deleted` | Sets `ymeta._deleted = Date.now()` on the in-memory Y.Doc (broadcasts to connected clients), then calls `ypgPersistence.clearDocument()` to purge the `yjs_documents` rows so a deleted doc can't be revived from disk. Called by the Nuxt delete endpoint. |

Implementation in `sync-server/src/internal-http.ts`:
- Matches `url.startsWith('/internal/')`
- Validates secret header
- Reads JSON body (capped at 10KB)
- `handleInternalRequest()` returns `true` if handled; caller throws `null` (Hocuspocus's sentinel) to skip default request handling

### 7.7 Sync Server Dockerfile

**Note:** We run TypeScript directly with Bun rather than pre-bundling. Bun's bundler had issues with Hocuspocus's CJS/ESM exports, and the startup time difference is negligible.

```dockerfile
FROM oven/bun:1.3-alpine
WORKDIR /app
# /app is root-owned by default; chown before switching user so bun install
# can write node_modules.
RUN chown bun:bun /app
COPY --chown=bun:bun package.json bun.lock ./
USER bun
RUN bun install --frozen-lockfile
COPY --chown=bun:bun . .
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=3 http://127.0.0.1:4001/health || exit 1
CMD ["bun", "run", "src/index.ts"]
```

---

## 8. Sharing & Access Control

### 8.1 Access Modes

| Mode | Anonymous users | Logged-in users | Owner |
|---|---|---|---|
| **Open edit** (default) | Can edit | Can edit | Full control |
| **Open view** | Can view | Can view | Can edit + full control |
| **Password-protected** | Must enter password | Must enter password | Can edit + full control |

### 8.2 Read-Only Enforcement (4 layers)

1. **Token endpoint** — mints JWT with `readOnly: true` for open-view docs (non-owners)
2. **Hocuspocus** — `onAuthenticate` returns `{ readOnly: true }` from JWT, server blocks Y.js updates
3. **CodeMirror** — `EditorView.editable` + `EditorState.readOnly` via CM6 **Compartments** (dynamically reconfigured when `readOnly` prop changes — needed because `isReadOnly` is set asynchronously after `fetchToken`)
4. **UI** — view mode forced to preview-only, toolbar hidden, "View only" badge shown

### 8.3 Share Modal

The share modal lets the document owner change access mode, copy share links, and see connected users.

---

## 9. Workspaces

Workspaces are tied to user accounts (stored in PostgreSQL via Drizzle ORM). They replace the anonymous "secret URL" model from earlier iterations.

- **Login required** to create or access workspaces
- **Multiple workspaces** per user (e.g., "Personal", "Team Project")
- **Add documents** by creating new ones or adding existing doc IDs
- **Workspace page** (`/w/{id}`) shows a table of documents with title, last active, active users, and access mode

---

## 10. Pinia Colada for Data Fetching

All API calls use `useQuery` and `useMutation` from `@pinia/colada` for caching, deduplication, and loading states.

### 10.1 Query Key Factories

```typescript
// app/utils/queryKeys.ts
export const queryKeys = {
  user: {
    documents: () => ['user', 'documents'] as const,
    workspaces: () => ['user', 'workspaces'] as const,
  },
  docs: {
    meta: (docId: string) => ['docs', docId, 'meta'] as const,
    activity: (docId: string) => ['docs', docId, 'activity'] as const,
    token: (docId: string) => ['docs', docId, 'token'] as const,
  },
  workspaces: {
    detail: (wsId: string) => ['workspaces', wsId] as const,
  },
}
```

### 10.2 Example Usage

```vue
<script setup lang="ts">
const { data: myDocs, isPending } = useQuery({
  key: queryKeys.user.documents(),
  query: () => $fetch('/api/user/documents'),
})

const queryCache = useQueryCache()

const { mutate: createDoc, isLoading } = useMutation({
  mutation: () => $fetch('/api/docs', { method: 'POST' }),
  async onSettled() {
    await queryCache.invalidateQueries({ key: ['user', 'documents'] })
  },
})
</script>
```

---

## 11. VueUse Integration

`@vueuse/nuxt` v14.2.1 auto-imports all composables. Replaces custom code:

| Need | VueUse composable |
|---|---|
| Mobile breakpoints | `useMediaQuery('(max-width: 768px)')` |
| Persistent state | `useLocalStorage('ypad:recent', [])` |
| Copy to clipboard | `useClipboard()` |
| Keyboard shortcuts | `useMagicKeys()` |
| Online detection | `useOnline()` |
| Debounced preview | `watchDebounced(source, callback, { debounce: 100 })` |
| Window dimensions | `useWindowSize()` |
| Element visibility | `useIntersectionObserver()` |

---

## 12. Internationalization

### 12.1 Structure

```
i18n/locales/
├── en.json      # English (default, complete)
├── de.json      # German
├── fr.json      # French
├── es.json      # Spanish
├── ja.json      # Japanese
└── zh.json      # Chinese (Simplified)
```

**Note:** Nuxt 4 resolves `langDir: 'locales/'` relative to the `i18n/` directory, not `app/`.

### 12.2 Nuxt UI i18n Binding

```vue
<!-- app/app.vue -->
<script setup lang="ts">
import * as uiLocales from '@nuxt/ui/locale'
const { locale } = useI18n()
const uiLocale = computed(() => uiLocales[locale.value] || uiLocales.en)
useHead({ htmlAttrs: { lang: locale, dir: computed(() => uiLocale.value.dir) } })
</script>
<template>
  <UApp :locale="uiLocale">
    <NuxtPage />
  </UApp>
</template>
```

### 12.3 All UI text uses `t()`

Every string visible to the user goes through the `t()` function — buttons, labels, tooltips, error messages, placeholders, modals, toasts.

---

## 13. Document composables — `useDocument` (orchestrator) + two workers

`useDocument` used to own everything — token fetch, password flow, provider lifecycle, awareness bootstrap, title bridge, deletion observer. It grew past 200 lines of mixed concerns. It's now split into three files:

```
app/composables/
  useDocToken.ts         # /api/docs/:docId/token fetch; password-verified
                         # reconnect; reactive {token, readOnly, requiresPassword,
                         # forbidden, accessMode, isOwner, pendingPasswordUnlock}
  useHocuspocusSync.ts   # Provider lifecycle only: connect / disconnect /
                         # reconnect; reactive {provider, status, synced,
                         # userCount, docSizeBytes}. Reads the token lazily
                         # via a `getToken()` callback so reconnects pick up
                         # password-verified JWTs without wiring.
  useDocument.ts         # Thin orchestrator: creates Y.Doc + awareness +
                         # undoManager, composes the two workers, owns the
                         # title bridge (ymeta.observe → reactive ref),
                         # deletion observer, and welcome-doc seeding.
                         # Public API bit-for-bit unchanged from before split.
```

Key design decisions preserved from the pre-split version:

- **Single fetch on init:** The token endpoint returns `token`, `readOnly`, `requiresPassword`, `forbidden`, `accessMode`, and `ownerId` in one response — no separate `/meta` call.
- **Single Awareness instance:** Created once in the orchestrator and passed to `HocuspocusProvider` via its `awareness` option. PresenceBar and yCollab bind to this same reference for the component's lifetime.
- **Y.js Map reactivity bridge:** `ymeta.get('title')` isn't tracked by Vue. An `ymeta.observe()` callback updates a Vue `ref`, and a computed wraps get/set so two-way binding on the title input works.
- **Welcome content insertion** fires on `onSynced` (server had no content), `onDisconnect` before-ever-synced (server unreachable), or the no-syncUrl path.
- **Password flow:** `useDocToken.onPasswordVerified(newToken)` stashes the fresh JWT and raises `pendingPasswordUnlock`. The orchestrator listens and calls `useHocuspocusSync.reconnect()`. `requiresPassword` is only flipped false once the new provider emits `onSynced` (via `clearPendingUnlock`) — prevents the empty-doc-prepend bug where typed text got prefixed before content arrived.
- **Remote deletion:** `ymeta._deleted` flag is set by the sync-server on the in-memory Y.Doc in `/internal/notify-deleted`. The orchestrator's `ymeta.observe` flips a reactive `isDeleted` ref; EditorLayout watches it and redirects home.
- **`setAccessMode(mode)`** is delegated through to `useDocToken` so ShareModal can push access-mode changes back.

`useDocument` return shape (consumers destructure ~17 fields; unchanged by the split):

```typescript
return {
  ydoc, ytext, awareness,          // plain objects (not refs)
  provider: readonly(sync.provider),
  status: readonly(sync.status),   // 'connecting' | 'connected' | 'disconnected'
  synced: readonly(sync.synced),
  userCount: readonly(sync.userCount),
  isReadOnly: readonly(tokenState.isReadOnly),
  isOwner: readonly(tokenState.isOwner),
  isDeleted: readonly(isDeleted),  // broadcast from sync-server via ymeta._deleted
  requiresPassword: readonly(tokenState.requiresPassword),
  forbidden: readonly(tokenState.forbidden),  // private-doc, non-owner: no unlock path
  accessMode: readonly(tokenState.accessMode),
  docSizeBytes: readonly(sync.docSizeBytes),
  docSizeWarning,                  // null | 'warning' | 'critical'
  undoManager,
  title,                           // computed get/set via Y.js Map + observe bridge
  onPasswordVerified,
  setAccessMode: tokenState.setAccessMode,
  destroy
}
```

---

## 14. Preview Rendering

**Important:** All markdown-it plugins are loaded via **async dynamic imports** inside an `initMd()` function, guarded by `if (import.meta.client)`. This is necessary because:
1. `markdown-it` plugins have mixed CJS/ESM exports that crash during SSR
2. `DOMPurify` requires a browser DOM
3. `highlight.js` is large and should be lazy-loaded

The `markdown-it-emoji` plugin specifically needs the `.full` property from the module: `const emoji = (mod as any).full || (mod as any).default || mod`.

**Syntax highlighting CSS:** The `highlight.js/styles/github-dark.min.css` theme is imported dynamically inside `initMd()` after highlight.js loads. Without this, code blocks render with correct HTML class names (`.hljs-keyword`, etc.) but no colors — they all appear white.

Rendering is reactive via `watch(source, ...)` set up after init resolves. Output is sanitized with DOMPurify before being used in `v-html`.

---

## 15. AI Features — Gemini as Collaborator

YPad integrates Google Gemini (via `@google/genai`) as a real-time collaborator. Two user-facing flows share one backend architecture:

- **Top-bar prompt (`AIPromptBar`)** — horizontal input below the formatting toolbar. The user types a task, the model runs an agentic loop with function tools (`view_document` + `replace_text` + `insert_text` + `web_search`) and edits the document live.
- **Inline selection rewrite (`AISelectionPopup`)** — user selects text → sparkles button appears → click turns it into an input → model rewrites just that selection. No tools, single round-trip, cheap-tier model.

Both flows are **logged-in only**. Anonymous viewers see nothing.

**Provider swap note.** The architecture here was originally built on Anthropic (Claude) with its native `str_replace_based_edit_tool` + `web_search_20260209` + `web_fetch_20260209`. It was later swapped to Gemini without changing the AI-as-Y.js-collaborator model — only the SDK, tool shapes, and streaming event handling changed. Persistent references below to `ai:assistant:{sessionId}` (transaction origin) replaced the previous `ai:claude:{sessionId}`.

### 15.1 AI-as-collaborator — the model joins as a real Y.js client

When a prompt arrives, the server does NOT inject edits directly into the doc — it connects to Hocuspocus as its own client, exactly like a human browser would:

1. Generate a unique `sessionId` (`nanoid(12)`).
2. Mint a JWT with `userId: 'ai:assistant:{sessionId}'` and the same `jwtSecret` the regular auth flow uses.
3. Open a `HocuspocusProvider` pointed at `config.syncInternalUrl` (the internal-network URL, not the public `wss://sync.…`). See `server/utils/aiClient.ts`.
4. Set awareness state:
   ```
   user:      { name: 'AI Assistant', color, isAI: true }
   aiSession: { sessionId, initiatorName, initiatorUserId, initiatorColor, prompt }
   aiStatus:  { phase, message }
   ```
5. Run the Gemini agentic loop (`server/utils/agentic/runLoop.ts`); every `replace_text` / `insert_text` lands inside `ydoc.transact(fn, 'ai:assistant:{sessionId}')`. Hocuspocus broadcasts the Y.js updates, all browsers see edits stream in, no custom push channel needed.
6. On completion, abort, or error: clear awareness, disconnect the provider, remove the session entry, destroy the in-memory Y.Doc.

The browser learns "the AI is here" through standard awareness events — no new protocol. `PresenceBar.vue` just renders any awareness entry with `isAI: true` using a sparkles avatar and a pulsing ring while `aiStatus.phase !== 'done'`.

### 15.2 Concurrent sessions (multiple assistants per doc, one per user)

**No doc-level lock.** Two humans editing the same doc can each have their own AI session running simultaneously — each is a distinct Y.js client with its own awareness entry. Edits from any session merge via Y.js CRDT. Semantic conflicts ("make formal" vs "make casual") are an accepted trade-off for parallelism.

**Per-user cap:** one active session per user per doc. A second POST from the same user returns **409 Conflict** (`"You already have an AI session running on this document."`). Prevents runaway cost per user.

Session state lives in the `ai_sessions` Postgres table (not in-memory — survives Nitro restart so the per-user cap can't be bypassed by kicking the process). AbortControllers themselves stay process-local; if an abort request lands on a different worker than the one running the loop, the registry row is dropped and the stuck loop exits on its own deadline.

### 15.3 Cancellation — initiator only

`POST /api/ai/abort { sessionId }`:
- 404 if the session already ended (normal race; the client silently swallows 404).
- **403 if `session.initiatorUserId !== req.session.user.id`** — only the user who started the session can cancel it.
- Otherwise `session.abortController.abort()`; the agentic loop unwinds, awareness clears, session row is removed.

Client-side abort detection is belt-and-suspenders: the server treats **any error thrown after `abortController.signal.aborted === true`** as an abort, regardless of the SDK error shape. Status becomes `phase: 'done', message: 'Stopped'` — no error toast.

### 15.4 Function tools → Y.Text adapter

`server/utils/agentic/functionTools.ts` defines the Zod schemas for each tool's arguments and derives their JSON Schemas via `z.toJSONSchema(schema, { target: 'draft-7' })` — one source of truth for both the declaration Gemini sees and the runtime validator. `server/utils/aiToolAdapter.ts` translates validated calls into Y.Text operations on the AI session's local Y.Doc:

| Function | Translation |
|---|---|
| `view_document({ view_range? })` | Return `ytext.toString()` with 1-indexed line-number prefixes. `view_range` is a length-2 integer array `[start, end]` — we use `z.array(z.number().int()).min(2).max(2)` rather than `z.tuple(...)` because Gemini's validator rejects tuple-shaped `items: [...]` JSON Schema (`items` must be a single object). |
| `replace_text({ old_str, new_str })` | 0 matches → error "No match found". 2+ matches → error "Found N matches, add more context". Exactly 1 → `ydoc.transact(() => { ytext.delete(pos, old_str.length); ytext.insert(pos, new_str) }, 'ai:assistant:{sessionId}')`. |
| `insert_text({ insert_line, insert_text })` | Map line to char index (0 = file start); transact insert. |
| `web_search({ query })` | Grounded sub-call: a fresh `ai.models.generateContent(...)` with `tools: [{ googleSearch: {} }]` only. Returns the synthesised answer plus a bulleted `Sources:` list built from `response.candidates[0].groundingMetadata.groundingChunks`. Isolated here so our main loop never mixes `googleSearch` with `functionDeclarations` in a single request. |

**Parse-at-dispatch.** Before routing, `runLoop.ts` looks up the Zod schema in `TOOL_SCHEMAS[name]` and `safeParse`s the `FunctionCall.args`. On parse failure we emit a `functionResponse` with `isError: true` carrying the Zod issue path + message, so the model can see exactly what was wrong and self-correct on the next turn rather than us silently coercing garbage via `String()` / `Number()` casts.

Every edit is its own `ydoc.transact(fn, origin)` so:
- Each edit broadcasts independently — users watch the AI type in real time.
- The origin string carries the session id, so the activity log attributes edits to the initiator.
- Multi-edit responses ("update all headings") produce clean, ordered updates when the model emits several function calls in one response. Each transaction is atomic.

The content-based match of `replace_text` (not byte-offset-based) means earlier edits that shift text positions don't invalidate later edits in the same response — each one's `old_str` re-locates itself at apply time.

### 15.5 The agentic loop — termination & safety

`server/utils/agentic/runLoop.ts` runs a standard Gemini function-calling loop:

- The model returns content with zero or more `functionCall` parts.
- The loop executes each call via the adapter, appends `functionResponse` parts, and iterates.
- Termination: a response with only text (no `functionCall`) ends the loop.
- **`MAX_TURNS = 20`** hard cap.
- **`HARD_DEADLINE_MS = 5 min`** per prompt; `30 s` per rewrite.

### 15.6 Tools registered

The prompt endpoint registers four function tools via `@google/genai`'s `FunctionDeclaration` shape — exported as `ALL_TOOL_DECLARATIONS` from `functionTools.ts` and passed straight to `config: { tools: [{ functionDeclarations: ALL_TOOL_DECLARATIONS }] }`:

- `view_document` — reads the line-numbered doc.
- `replace_text` — unique-match string replace.
- `insert_text` — insert after a specific line.
- `web_search` — grounded sub-call (see 15.4).

Why this shape instead of Gemini's built-in `googleSearch` as a top-level tool: historically `googleSearch` + `functionDeclarations` in the same request had model-version coexistence issues, and even when it works we lose pre-call status UX (the search fires implicitly, with only post-hoc `groundingMetadata`). Wrapping `googleSearch` as our own function gets us both compatibility across model versions and live "Searching the web for 'X'…" status, with one extra sub-call per search as the cost.

### 15.7 Streaming status via awareness (no SSE)

The prompt loop consumes the model's streamed response and pushes `aiStatus` updates through Y.js awareness as it observes function-call parts arrive. See `server/utils/agentic/streamStatus.ts`. Every update is just a set on the AI client's awareness state; browsers pick it up via the standard `awareness.on('update')` they already use for presence. No SSE, no server-sent-events endpoint, no additional protocol.

Example status sequences:
- "Thinking…" → "Reading the document…" (after `view_document`) → "Searching the web for 'X'…" → "Editing: '…snippet…'" → "Done"

Error status gets a longer linger (2.5 s vs 500 ms for success) so clients can latch the message before awareness cleanup destroys the session. The client (`useAI.ts`) watches `mySession` for `phase === 'error'` and promotes the message into `lastError`, which `AIPromptBar.vue` toasts.

### 15.8 Rate limits, timeouts, and the sweeper

- **Rate limits** (via `server/utils/rateLimit.ts` — Postgres-backed sliding window):
  - `ai-prompt:{userId}` → 20 / hour
  - `ai-rewrite:{userId}` → 30 / hour
- **Deadlines:**
  - Per-prompt `HARD_DEADLINE_MS = 5 min`
  - Per-rewrite deadline 30 s (rewrites are one-shot, no tool loop)
  - Sweeper `STALE_THRESHOLD_MS = 7 min` (must be > prompt deadline so legitimate long grounded searches don't get killed)
- **Sweeper** (`server/plugins/ai-session-sweep.ts`): runs every 60 s. Aborts any session older than the stale threshold. Runs a one-shot purge at startup too — clears rows from a crashed prior process so the per-user cap unblocks immediately.
- **Disconnect cleanup:** the prompt endpoint hooks `event.node.req.on('close')` to abort if the client tab closes mid-request.

### 15.9 Inline rewrite — selection → replace in place

`server/api/ai/rewrite.post.ts` is structurally different from the prompt endpoint:

- **Model:** `config.google.rewriteModel` (defaults to `gemini-2.5-flash-lite`, set via `NUXT_GOOGLE_REWRITE_MODEL`). Rewrites are simple text transformations where the cheapest tier shines; prompt-loop tool orchestration uses the main `config.google.model`.
- **No tools.** Single `ai.models.generateContent(...)` call, non-streaming.
- **Full document as context.** The user message contains `<document>…</document>` + `<instruction>…</instruction>` + `<text>…</text>`, windowed to 40k chars around the selection for very large docs. The model matches tone/style from surrounding prose but rewrites only the selection.
- **Race-safe positions.** The client sends a Y.js `RelativePosition` for both ends of the selection (`Y.createRelativePositionFromTypeIndex`). The server resolves to absolute positions at apply time via `createAbsolutePositionFromRelativePosition`. If the human edited within the selection meanwhile, `RelativePosition` slides with the edit. Fallback chain: relative pos → raw index sanity check → single-`indexOf` fallback → **409 "Selection has moved"** if ambiguous.
- **Same Y.js transact pattern** with origin `ai:assistant:{sessionId}` so activity attribution still works.

### 15.10 Configuration

```ts
// nuxt.config.ts
runtimeConfig: {
  google: {
    apiKey: '',                                // NUXT_GOOGLE_API_KEY (required; throws on missing)
    model: 'gemini-3.1-flash-lite-preview',    // NUXT_GOOGLE_MODEL — agentic prompt loop
    rewriteModel: 'gemini-2.5-flash-lite'      // NUXT_GOOGLE_REWRITE_MODEL — inline rewrites
  }
}
```

`.env`:
```
NUXT_GOOGLE_API_KEY=…
NUXT_GOOGLE_MODEL=gemini-3.1-flash-lite-preview
NUXT_GOOGLE_REWRITE_MODEL=gemini-2.5-flash-lite
```

Docker compose passes `GOOGLE_API_KEY → NUXT_GOOGLE_API_KEY` via env. Both models are env-configurable so you can swap without a redeploy. Pricing reference (at time of writing): `gemini-3.1-flash-lite-preview` $0.25/1M in, $1.50/1M out, grounding free up to 5k prompts/month shared across the Gemini 3 family; `gemini-2.5-flash-lite` $0.10/1M in, $0.40/1M out.

### 15.11 File map

```
server/
  api/ai/
    prompt.post.ts              # Boots agentic loop, registers session, streams status via awareness
    rewrite.post.ts             # Inline selection rewrite (cheap-tier, no tools)
    abort.post.ts               # Initiator-only cancellation
  utils/
    aiSessions.ts               # Postgres-backed session registry + DuplicateSessionError
    aiClient.ts                 # AI as a Y.js client (HocuspocusProvider, awareness)
    aiToolAdapter.ts            # replace_text / insert_text / view_document → Y.Text ops
    agentic/
      runLoop.ts                # Gemini function-calling loop
      functionTools.ts          # FunctionDeclaration schemas
      streamStatus.ts           # awareness-status updater helpers
  plugins/
    ai-session-sweep.ts         # 60 s sweep; aborts sessions > 7 min old + startup purge

app/
  composables/
    useAI.ts                    # Reactive state derived from awareness; prompt/rewrite/abort
  components/ai/
    AIPromptBar.vue             # Top bar — prompt input, live status, Stop button
    AISelectionPopup.vue        # Floating sparkles → input; captures Y.js RelativePosition
  components/collab/
    PresenceBar.vue             # Renders AI avatars with sparkles + pulsing ring
```

### 15.12 Open for later (explicitly not in scope)

- Multi-turn conversation history per user per doc.
- Prompt caching on document content (breaks on every edit — likely not worth it).
- Streaming text responses to UI (currently discarded; edits ARE the response).
- Activity log attribution as "AI Assistant (for Alice)" — currently shows just "AI Assistant".
- User-selectable model (e.g. `gemini-2.5-pro` vs Flash-Lite for the agentic loop).
- Grounded-search result caching with a short TTL (material when grounding costs start to bite past the 5k-free/month org quota).
- Cost telemetry / budget caps.
- Swap back to other providers behind a thin adapter (Claude, local models via Ollama, …) without rewriting the agentic loop.

---

## 16. Mobile Editing

**Breakpoint:** `useMediaQuery('(max-width: 639px)')` — matches Tailwind's `sm:` (640px+ = not-mobile). This must match the CSS breakpoint used for `sm:hidden`/`sm:flex` classes; previously a 768px JS value caused layout inconsistencies in the 640–768px range.

### 16.1 Implemented

- **Edit-only default** on narrow screens — `watchEffect` forces `viewMode = 'edit'` when `isMobile && viewMode === 'split'`.
- **CM6 responsive theme via Compartment** — font (16px on mobile to prevent iOS auto-zoom), line-height (1.7), padding (12/16px), reconfigured live on viewport resize/rotation using `watch(isMobile, ...)` + `responsiveThemeCompartment.reconfigure(...)`.
- **CM6 content attributes:** `autocapitalize: 'sentences'`, `autocorrect: 'on'`, `spellcheck: 'true'` (always, not just mobile — no downside on desktop).
- **Toolbar wraps with `flex-wrap`** — formatting buttons flow to a second row on narrow viewports instead of horizontal-scrolling. Document action buttons (import/export/activity) stay anchored top-right via `items-start` + `shrink-0`.
- **Collapsed top-bar menu:** on mobile, a `UDropdownMenu` (hamburger) consolidates view-mode toggle, theme toggle, and auth actions. Visible controls on mobile: logo, title, collaborators, connection icon, share, menu. On desktop (`sm:`), everything is inline.
- **Icon-only connection badge** on mobile (`<span class="hidden sm:inline">` for the label).
- **Responsive title max-width:** `max-w-[180px] sm:max-w-56 md:max-w-80` — grows with viewport size. Truncates with ellipsis.

```typescript
// EditorPane.vue — responsive theme via Compartment
const responsiveThemeCompartment = new Compartment()
const isMobile = useMediaQuery('(max-width: 639px)')

function buildResponsiveTheme(mobile: boolean) {
  return EditorView.theme({
    '&': { fontSize: mobile ? '16px' : '15px' },
    '.cm-scroller': { lineHeight: mobile ? '1.7' : '1.5' },
    '.cm-content': { padding: mobile ? '12px 16px' : '16px 20px' }
  })
}

// On viewport change, reconfigure the compartment live (no remount)
watch(isMobile, (mobile) => {
  view.value?.dispatch({
    effects: responsiveThemeCompartment.reconfigure(buildResponsiveTheme(mobile))
  })
})
```

### 16.2 Deferred (MMP)

- **Floating toolbar** above virtual keyboard via `visualViewport` API
- **Bottom tab bar** for Edit / Preview / AI switching
- **Sidebar as bottom sheet** on mobile

### 16.3 Activity-feed layout (the other direction — wide screens)

On wide viewports the activity feed is a third pane next to editor + preview (triple-split), not a replacement for the preview.

- **< xl (≤ 1279 px)** — current behaviour: opening activity hides the preview pane. In edit mode, activity sits alongside the editor as a fixed `w-80` sidebar (full-width on xs). In split/preview mode, activity takes the "right half" via `flex-1` and preview is hidden.
- **xl+ (≥ 1280 px)** — activity becomes a fixed `w-80` right sidebar regardless of view mode. Editor + preview keep their 50/50 split of the remaining width, so split-mode becomes a genuine triple-pane layout.

Implemented with Tailwind responsive classes on three flex siblings in `EditorLayout.vue`:
```html
<main class="flex-1 flex min-h-0">
  <EditorImageDropZone
    v-if="viewMode !== 'preview'"
    :class="[
      'flex-1 min-w-0',
      (viewMode === 'split' || showActivity) ? 'border-r border-default' : '',
      showActivity ? 'hidden sm:block' : ''      // xs: activity covers viewport
    ]"
  >…</EditorImageDropZone>
  <div v-if="viewMode !== 'edit'"
       :class="['flex-1 min-w-0 h-full', showActivity ? 'hidden xl:block' : '']">
    <PreviewPane :source="textContent" />
  </div>
  <div v-if="showActivity"
       :class="[
         viewMode === 'edit'
           ? 'w-full sm:w-80 sm:shrink-0'
           : 'flex-1 min-w-0 xl:flex-none xl:w-80 xl:shrink-0'
       ]"
       class="border-l border-default h-full overflow-y-auto">…</div>
</main>
```

The preview uses `hidden xl:block` (CSS) rather than `v-if="!showActivity"` so resizing past xl brings it back instantly — no remount of the markdown-it / DOMPurify pipeline. Editor stays `hidden sm:block` when activity is open on xs so activity can take the full mobile viewport. `min-w-0` on each flex member lets the panes shrink past their intrinsic content width (essential for the editor's `cm-scroller`).

---

## 17. Docker Compose

### 17.1 Production services

Production runs **5 containers**: Traefik, `postgres`, `app`, `sync`, `pandoc`, plus a non-routed `backup` sidecar. **No SeaweedFS in production** — S3 is external (Infomaniak / R2 / AWS).

Key production differences from earlier iterations:
- `postgres:16-alpine` with `pg_isready` healthcheck and a named `pg_data` volume. `app` and `sync` both `depends_on: postgres { condition: service_healthy }` so they don't start querying before migrations can run.
- `stop_grace_period: 30s` on `app` and `sync` so SIGTERM handlers have time to drain (see Section 7.1 for sync graceful shutdown; `server/plugins/99-shutdown.ts` closes the pg pool on Nitro close).
- Traefik service-loadbalancer healthcheck labels on both (`/api/health` and `/health`). Traefik stops routing to a draining container the moment its healthcheck goes red.
- `backup` sidecar runs `pg_dump | gzip → aws s3 cp` on a configurable interval (default daily) with N-day retention (default 30). Uses the same `S3_*` env as the rest of the stack.
- `NUXT_S3_ENDPOINT` is env-driven (`${S3_ENDPOINT}`) — points to Infomaniak in prod, local SeaweedFS in dev.
- The old `app_data` volume (SQLite file) is gone.

```yaml
# docker-compose.yml (abbreviated — see file for full labels / env)
services:
  traefik: { image: traefik:v3, ... }

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=ypad
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=ypad
    volumes: [pg_data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ypad -d ypad"]
      interval: 10s
    networks: [internal]

  app:
    build: .
    stop_grace_period: 30s
    environment:
      - NUXT_SESSION_PASSWORD=${SESSION_PASSWORD}
      - NUXT_S3_ENDPOINT=${S3_ENDPOINT}         # Infomaniak / R2 / etc.
      - NUXT_S3_BUCKET=${S3_BUCKET:-ypad}
      - NUXT_GOOGLE_API_KEY=${GOOGLE_API_KEY}
      - NUXT_GOOGLE_MODEL=${GOOGLE_MODEL:-gemini-3.1-flash-lite-preview}
      - NUXT_GOOGLE_REWRITE_MODEL=${GOOGLE_REWRITE_MODEL:-gemini-2.5-flash-lite}
      - DATABASE_URL=postgres://ypad:${POSTGRES_PASSWORD}@postgres:5432/ypad
      # … OAuth, JWT, etc.
    labels:
      - "traefik.http.routers.app.rule=Host(`${DOMAIN}`)"
      - "traefik.http.services.app.loadbalancer.healthcheck.path=/api/health"
      - "traefik.http.services.app.loadbalancer.healthcheck.interval=10s"
    depends_on:
      postgres: { condition: service_healthy }
    networks: [web, internal]

  sync:
    build: ./sync-server
    stop_grace_period: 30s
    environment:
      - DATABASE_URL=postgres://ypad:${POSTGRES_PASSWORD}@postgres:5432/ypad
      - JWT_SECRET=${JWT_SECRET}
      - INTERNAL_API_SECRET=${INTERNAL_API_SECRET}
      - APP_URL=http://app:3000
    labels:
      - "traefik.http.routers.sync.rule=Host(`sync.${DOMAIN}`)"
      - "traefik.http.services.sync.loadbalancer.healthcheck.path=/health"
    depends_on:
      postgres: { condition: service_healthy }
    networks: [web, internal]

  pandoc: { build: ./pandoc-server, ... }

  backup:
    build: ./backup-server
    environment:
      - POSTGRES_HOST=postgres
      - PGPASSWORD=${POSTGRES_PASSWORD}
      - S3_ENDPOINT=${S3_ENDPOINT}
      - S3_ACCESS_KEY=${S3_ACCESS_KEY}
      - S3_SECRET_KEY=${S3_SECRET_KEY}
      - S3_BUCKET=${S3_BUCKET:-ypad}
      - BACKUP_INTERVAL_SECONDS=${BACKUP_INTERVAL_SECONDS:-86400}
      - BACKUP_RETENTION_COUNT=${BACKUP_RETENTION_COUNT:-30}
    depends_on:
      postgres: { condition: service_healthy }
    networks: [internal]

volumes:
  pg_data:
```

**DNS:** `yourdomain.com`, `sync.yourdomain.com` → VPS IP. `s3.yourdomain.com` is gone (external S3 endpoint is reached directly by clients from Infomaniak).

**Nuxt app Dockerfile (copies `drizzle/` so migrations run at boot):**

```dockerfile
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock ./
USER bun
RUN bun install --frozen-lockfile
COPY --chown=bun:bun . .
RUN bun run build

FROM oven/bun:1.3-alpine
WORKDIR /app
COPY --from=builder --chown=bun:bun /app/.output .output
# Drizzle migration files — applied at boot by server/plugins/00-db-migrate.ts.
COPY --from=builder --chown=bun:bun /app/drizzle ./drizzle
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=5 http://127.0.0.1:3000/api/health || exit 1
CMD ["bun", "run", ".output/server/index.mjs"]
```

**Backup sidecar Dockerfile (`backup-server/Dockerfile`):**

```dockerfile
# postgres:16-alpine gives us pg_dump matching the server; aws-cli for S3 upload.
FROM postgres:16-alpine
RUN apk add --no-cache aws-cli
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT []
CMD ["/usr/local/bin/backup.sh"]
```

The `backup.sh` script pipes `pg_dump --no-owner --clean --if-exists | gzip` to `s3://$S3_BUCKET/backups/postgres/{ISO8601}.sql.gz`, then prunes anything beyond `BACKUP_RETENTION_COUNT` newest files. Same script against any S3-compatible endpoint; `S3_ENDPOINT` is the only thing that changes between dev and prod.

Restore: `aws s3 cp s3://… - | gunzip | psql "$DATABASE_URL"`. The dump uses `--clean --if-exists` so it drops existing objects before recreating.

### 17.2 Development Setup

```bash
# Start infrastructure (Postgres + SeaweedFS + Hocuspocus + Pandoc + backup)
docker compose -f docker-compose.dev.yml up -d

# Apply any pending migrations + start Nuxt dev server
bun run dev
```

`docker-compose.dev.yml` runs only infrastructure services with ports exposed to localhost:
- **Postgres** → `localhost:5432` (`postgres://ypad:devpassword@localhost:5432/ypad`)
- **SeaweedFS** → `localhost:8333` (S3 API — image uploads + dev backups)
- **Hocuspocus** → `localhost:4001` (WebSocket sync, browser connects directly)
- **Pandoc** → `localhost:8080` (HTTP conversion API)
- **backup** sidecar runs with a tight loop (1 h interval, 5-file retention) so you can verify the backup path locally without waiting a day.

The Nuxt dev server runs on the host (not in Docker) for hot reload. Nitro's `devProxy` forwards `/_s3/*` to SeaweedFS to handle CORS for browser-direct S3 uploads. WebSocket doesn't have same-origin restrictions, so Hocuspocus connects directly without a proxy.

**Production `.env`:**

```env
DOMAIN=yourdomain.com
ACME_EMAIL=you@yourdomain.com
SESSION_PASSWORD=your-super-secure-password-with-at-least-32-characters
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
POSTGRES_PASSWORD=change-me-to-a-strong-password
S3_ENDPOINT=https://s3.pub1.infomaniak.cloud
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=ypad
JWT_SECRET=change-me-to-something-random-64-chars
INTERNAL_API_SECRET=change-me-to-something-random-used-between-app-and-sync-server
GOOGLE_API_KEY=...
GOOGLE_MODEL=gemini-3.1-flash-lite-preview
GOOGLE_REWRITE_MODEL=gemini-2.5-flash-lite
BACKUP_INTERVAL_SECONDS=86400
BACKUP_RETENTION_COUNT=30
```

**Dev `.env` (git-ignored; OAuth client secrets are per-developer):**

```env
NUXT_SESSION_PASSWORD=development-session-password-at-least-32-chars
NUXT_S3_ENDPOINT=http://localhost:8333
NUXT_S3_ACCESS_KEY=ypad-access-key
NUXT_S3_SECRET_KEY=ypad-secret-key
NUXT_S3_BUCKET=ypad
NUXT_JWT_SECRET=development-jwt-secret-change-me-in-production-64chars
NUXT_INTERNAL_API_SECRET=development-internal-api-secret-change-me
NUXT_PANDOC_URL=http://localhost:8080
NUXT_PUBLIC_SYNC_URL=ws://localhost:4001
NUXT_SYNC_INTERNAL_URL=http://localhost:4001
NUXT_GOOGLE_API_KEY=...
NUXT_GOOGLE_MODEL=gemini-3.1-flash-lite-preview
NUXT_GOOGLE_REWRITE_MODEL=gemini-2.5-flash-lite
DATABASE_URL=postgres://ypad:devpassword@localhost:5432/ypad
```

**Dev: run Nuxt with `--host 0.0.0.0`** so the sync-server Docker container can reach it via `host.docker.internal` (required for activity logging to work in dev).

---

## 18. Project Structure

```
ypad/
├── app/
│   ├── app.vue                          # UApp with i18n + auth
│   ├── app.config.ts
│   ├── assets/css/main.css
│   ├── components/
│   │   ├── auth/
│   │   │   ├── LoginButtons.vue
│   │   │   └── UserMenu.vue
│   │   ├── editor/
│   │   │   ├── EditorLayout.vue
│   │   │   ├── EditorPane.vue
│   │   │   ├── EditorToolbar.vue
│   │   │   ├── MobileToolbar.vue
│   │   │   └── ImageDropZone.vue
│   │   ├── preview/
│   │   │   └── PreviewPane.vue
│   │   ├── collab/
│   │   │   ├── PresenceBar.vue
│   │   │   ├── ConnectionStatus.vue
│   │   │   └── ActivityFeed.vue
│   │   ├── ai/
│   │   │   ├── AIPromptBar.vue             # Top-bar prompt input, live status, Stop
│   │   │   └── AISelectionPopup.vue        # Inline sparkles → rewrite popup
│   │   ├── sharing/
│   │   │   ├── ShareModal.vue
│   │   │   ├── PasswordModal.vue
│   │   │   └── DeleteConfirmModal.vue
│   │   ├── document/
│   │   │   └── ImportModal.vue          # Import with conflict handling (replace/append/cancel)
│   │   ├── workspace/
│   │   │   ├── WorkspaceList.vue
│   │   │   └── WorkspaceDocTable.vue
│   │   ├── history/
│   │   │   ├── HistoryTimeline.vue
│   │   │   └── DiffViewer.vue
│   │   ├── layout/
│   │   │   ├── AppSidebar.vue
│   │   │   ├── AppHeader.vue
│   │   │   ├── MobileBottomSheet.vue
│   │   │   └── LanguageSwitcher.vue
│   │   └── common/
│   │       └── SizeWarning.vue
│   ├── composables/
│   │   ├── useDocument.ts               # Y.js + HocuspocusProvider
│   │   ├── useDocToken.ts               # Token fetch + password-verify flow
│   │   ├── useHocuspocusSync.ts         # Provider lifecycle wrapper
│   │   ├── useAI.ts                     # Reactive AI state (derived from awareness) + prompt/rewrite/abort
│   │   ├── useImageUpload.ts            # useMutation-based upload
│   │   ├── useDocumentImport.ts         # Import with conflict handling
│   │   └── useMarkdownPreview.ts
│   ├── pages/
│   │   ├── index.vue                    # Landing page
│   │   ├── d/[id].vue                   # Editor page
│   │   └── w/[id].vue                   # Workspace page
│   ├── middleware/
│   │   └── auth.ts                      # Client-side auth guard
│   ├── plugins/
│   │   └── version-check.client.ts      # Poll /api/version; sticky "reload" toast on build mismatch
│   └── utils/
│       ├── queryKeys.ts                 # Pinia Colada key factories
│       ├── colors.ts                    # User color palette
│       ├── names.ts                     # Random name generator
│       ├── download.ts                  # Client-side .md/.html download helpers
│       └── welcomeDoc.ts                # Welcome markdown template
├── server/
│   ├── routes/
│   │   └── auth/
│   │       ├── github.get.ts           # OAuth GitHub callback
│   │       └── google.get.ts           # OAuth Google callback
│   ├── api/
│   │   ├── health.get.ts               # DB-touching health probe (Traefik + Docker healthchecks)
│   │   ├── version.get.ts              # { buildId } for SPA staleness detection
│   │   ├── docs.post.ts                # Create document
│   │   ├── docs/[docId]/
│   │   │   ├── meta.get.ts             # Get doc metadata
│   │   │   ├── meta.put.ts             # Update title, access mode
│   │   │   ├── index.delete.ts         # Delete document + cascade uploads + notify sync
│   │   │   ├── token.get.ts            # Get Hocuspocus JWT
│   │   │   ├── activity.get.ts         # Get activity log
│   │   │   └── password.post.ts        # Set/verify/remove password
│   │   ├── upload/
│   │   │   ├── request.post.ts         # Presigned PUT + insert unconfirmed uploads row
│   │   │   └── confirm.post.ts         # HEAD S3 + flip uploads.confirmed_at
│   │   ├── files/
│   │   │   └── [docId]/[fileId].get.ts # 302 to presigned GET
│   │   ├── import.post.ts              # PDF/DOCX → markdown via Pandoc
│   │   ├── export/[docId].post.ts      # Markdown → PDF/DOCX via Pandoc
│   │   ├── internal/
│   │   │   └── activity.post.ts        # Shared-secret endpoint called by sync-server
│   │   ├── ai/
│   │   │   ├── prompt.post.ts          # Gemini agentic loop; edits via y.js
│   │   │   ├── rewrite.post.ts         # Inline selection rewrite (cheap-tier, no tools)
│   │   │   └── abort.post.ts           # Initiator-only cancel
│   │   └── user/
│   │       ├── documents.get.ts        # List user's docs
│   │       └── workspaces.get.ts       # List user's workspaces
│   ├── db/
│   │   └── schema.ts                    # Drizzle (pg-core) schema
│   ├── middleware/
│   │   └── auth.ts                      # Server-side auth guard
│   ├── plugins/
│   │   ├── 00-db-migrate.ts             # Numeric prefix → loads first; runs drizzle migrate() at boot
│   │   ├── 99-shutdown.ts               # Numeric prefix → loads last; closes pg pool on Nitro `close`
│   │   ├── orphan-cleanup.ts            # 3-layer S3/uploads/docs reconciliation (hourly)
│   │   ├── ai-session-sweep.ts          # 60 s sweep; aborts AI sessions > 7 min old + startup purge
│   │   └── rate-limit-cleanup.ts        # Hourly prune of rate_limits rows
│   └── utils/
│       ├── database.ts                  # pg.Pool + drizzle-orm/node-postgres singleton
│       ├── s3.ts                        # S3 client singleton (used only by Nuxt, not sync-server)
│       ├── rateLimit.ts                 # Postgres-backed sliding-window limiter
│       ├── routeParams.ts               # requireDocId / requireRouteParam helpers
│       ├── validatedSession.ts          # SESSION_VERSION + DB-validated session
│       ├── aiSessions.ts                # Postgres-backed AI session registry
│       ├── aiClient.ts                  # AI as a Y.js client (HocuspocusProvider)
│       ├── aiToolAdapter.ts             # view/replace/insert → Y.Text ops
│       └── agentic/
│           ├── runLoop.ts               # Gemini function-calling loop
│           ├── functionTools.ts         # FunctionDeclaration schemas
│           └── streamStatus.ts          # awareness-status updater helpers
├── sync-server/                         # Hocuspocus (separate container)
│   ├── Dockerfile
│   ├── package.json
│   ├── bun.lock
│   └── src/
│       ├── index.ts                     # Server entry + hooks + SIGTERM graceful-shutdown
│       ├── persistence.ts                # y-postgresql load/store/clear hooks
│       ├── auth.ts                       # JWT verification (requires valid token)
│       ├── rate-limiter.ts               # Per-IP connection limits
│       ├── activity-logger.ts            # Posts edit events to Nuxt /api/internal/activity
│       └── internal-http.ts              # Internal endpoints (notify-deleted → also clearDocument)
├── pandoc-server/                       # Pandoc HTTP service (separate container)
│   ├── Dockerfile
│   └── server.py
├── backup-server/                       # Postgres → S3 backup sidecar (separate container)
│   ├── Dockerfile                        # postgres:16-alpine + aws-cli
│   └── backup.sh                         # pg_dump | gzip | aws s3 cp, with retention pruning
├── drizzle/                             # Generated SQL migrations (committed to git)
│   ├── 0000_*.sql
│   ├── 0001_*.sql
│   └── meta/                            # drizzle-kit diff snapshots + journal
├── drizzle.config.ts                    # Drizzle Kit config (pg dialect, ./drizzle out)
├── i18n/
│   └── locales/                         # i18n locale files (lazy-loaded)
│       ├── en.json
│       ├── de.json
│       ├── fr.json
│       ├── es.json
│       ├── ja.json
│       └── zh.json
├── shared/
│   └── types/
│       ├── auth.d.ts                    # nuxt-auth-utils module augmentation (User, UserSession, SESSION_VERSION)
│       └── markdown-it-plugins.d.ts
├── public/
│   ├── icon-192.png
│   ├── icon-512.png
│   └── favicon.ico
├── Dockerfile                           # Nuxt app (multi-stage; copies drizzle/ into runtime image)
├── docker-compose.yml                   # Production (Traefik + postgres + app + sync + pandoc + backup)
├── docker-compose.dev.yml               # Dev (postgres + SeaweedFS + sync + pandoc + backup)
├── nuxt.config.ts
├── package.json
├── bun.lock
├── colada.options.ts                    # Pinia Colada global config
└── .env
```

---

## 19. Development Phases

### MVP — Weeks 1-7

#### Phase 1: Infrastructure (Week 1) ✅
- [x] Docker Compose: Traefik + Nuxt app + Hocuspocus + SeaweedFS
- [x] Nuxt full-stack scaffold with all modules registered
- [x] Drizzle ORM schema (`server/db/schema.ts`), `useDatabase()` server utility
- [x] S3 client utility
- [x] Hocuspocus with S3 persistence + rate limiting
- [x] SeaweedFS S3 config, Dockerfiles, `.env.example`
- [x] Dev infrastructure: `docker-compose.dev.yml` with SeaweedFS + Hocuspocus + Pandoc
- [x] Verify Hocuspocus connects from browser and persists to S3
- [x] Pandoc HTTP service container (`pandoc-server/`)
- [x] Nitro devProxy for S3 CORS in dev
- [ ] DNS: `yourdomain.com`, `sync.`, `s3.` subdomains (production deploy)
- [ ] CORS: Traefik middleware for S3 (production deploy)

#### Phase 2: Auth & Core Editor (Weeks 2-3) ✅
- [x] `nuxt-auth-utils` setup: GitHub + Google OAuth routes
- [x] Login/logout UI with `useUserSession()`
- [x] `POST /api/docs` — create document (owner = logged-in user or anonymous)
- [x] `GET /api/user/documents` — list user's documents
- [x] Landing page with login buttons, "New Document", recent docs
- [x] `useDocument` composable (HocuspocusProvider + Y.js + local Awareness fallback)
- [x] CodeMirror 6 with `yCollab()` + `drawSelection()` extensions
- [x] Split view: editor + preview (markdown-it + DOMPurify, async dynamic imports)
- [x] Formatting toolbar, status bar (word/char count via `ydoc.on('update')`)
- [x] i18n: complete `en.json`, scaffold other locale files
- [x] Server auth middleware (`server/middleware/auth.ts`)
- [x] Welcome document pre-loaded for new documents
- [x] View mode toggle (edit / split / preview)

#### Phase 3: Collaboration & Sharing (Week 4) ✅
- [x] Awareness: user names, colors, avatars via Y.js awareness
- [x] Presence bar (PresenceBar component with avatar initials + colors)
- [x] Connection status (`UBadge`)
- [x] Document title synced via Y.js Map
- [x] Share modal: access mode selector (open-edit / open-view / password)
- [x] Read-only enforcement (3 layers: token endpoint, CM6 editable/readOnly, UI)
- [x] Password protection (set/verify/remove via Nuxt server, scrypt via nuxt-auth-utils)
- [x] Hocuspocus auth: JWT from `/api/docs/:docId/token` with requiresPassword flag
- [x] Activity feed endpoint (`GET /api/docs/:docId/activity`) and sidebar component
- [x] Password modal gate for password-protected documents

#### Phase 4: Files, Import & Export (Week 5) ✅
- [x] Presigned upload flow (request → PUT → confirm)
- [x] Drag-drop + paste → upload → insert markdown (ImageDropZone component)
- [x] Import modal + Pandoc conversion (via pandoc-server HTTP API)
- [x] Import conflict handling (replace / append / cancel)
- [x] Export PDF/DOCX via Pandoc (XeLaTeX for Unicode/emoji support)
- [x] Client-side .md and .html download
- [x] Import/export dropdown menu in editor header

#### Phase 4.5: Bug Fixes & Security Hardening (between Phase 4 and 5) ✅
- [x] Code block syntax highlighting (highlight.js CSS theme import)
- [x] Title editing: Y.js Map → Vue reactivity bridge via `ymeta.observe()`
- [x] Title auto-focus/select via `nextTick`, DB persistence via `meta.put`
- [x] Collaboration presence: single Awareness instance passed to HocuspocusProvider
- [x] Remote cursors working (colored labels, yCollab with shared awareness)
- [x] Presence bar: colored rings matching cursor colors
- [x] Header layout: collaborators next to title, import/export/activity in toolbar row
- [x] Read-only enforcement: CM6 Compartments for dynamic `readOnly` reconfiguration
- [x] View mode: auto-switch to preview for read-only, back to split after password verified
- [x] Password-protected docs: no token issued → Hocuspocus rejects → no content leaked
- [x] Password flow: content gated behind `v-if`, lock screen shown, editor mounts only after sync
- [x] EditorPane: initial `doc` content from `ytext.toString()` for late-mount scenarios
- [x] Landing page: fixed camelCase field names, date formatting (ISO string not Unix), word count display
- [x] Word count persistence: debounced (10s) `$fetch` to `meta.put` + `keepalive` on unmount
- [x] Security: removed hardcoded JWT/S3 fallbacks in sync-server, fail-fast on missing env vars
- [x] Security: token endpoint rate limiting (30/min/IP)
- [x] Security: file endpoint access control for password-protected docs
- [x] Security: input validation on `meta.put` (title length, access_mode enum, numeric bounds)
- [x] Security: password token expiry reduced from 24h to 2h

#### Phase 5: Mobile & Document Management (Week 6) ✅ mostly
- [ ] Mobile floating toolbar (visualViewport API) — deferred to MMP
- [ ] Mobile bottom tab bar — deferred to MMP
- [ ] Sidebar as bottom sheet on mobile — deferred to MMP
- [x] Touch-optimized CM6 extensions (autocapitalize, autocorrect, 16px mobile font via reactive Compartment)
- [x] Document deletion (owner only, DeleteConfirmModal with type-to-confirm safety)
- [x] S3 cleanup on delete (ListObjectsV2 + DeleteObjectsCommand) + orphan reconciliation plugin (hourly)
- [x] Delete-cascade broadcast: sync-server `onRequest` hook sets `ymeta._deleted`, clients observe and redirect
- [x] Document metadata updates (title, access mode, wordCount, sizeBytes — all validated)
- [x] Activity logging in Hocuspocus `onStoreDocument` (attribution via `awareness.meta.lastUpdated`, 500-entry cap per doc)
- [x] Activity feed in sidebar (30s auto-refresh, relative timestamps)
- [x] Mobile UX redesign: collapsed top-bar menu (⋮), icon-only connection badge, responsive title, wrap toolbar instead of horizontal scroll
- [x] Mobile breakpoint standardized on 640px (matches Tailwind `sm:`)

#### Phase 6: AI & Polish (Week 7) ✅
- [x] **AI as a Y.js collaborator** — server opens its own HocuspocusProvider, edits via `ydoc.transact` with origin `ai:assistant:{sessionId}` (`server/utils/aiClient.ts`)
- [x] **Agentic prompt loop** with Gemini function tools (`view_document` + `replace_text` + `insert_text` + `web_search`) in `server/utils/agentic/runLoop.ts`
- [x] **Inline selection rewrite** with a cheap-tier model + full-doc context + Y.js RelativePosition race safety (`server/api/ai/rewrite.post.ts`, `app/components/ai/AISelectionPopup.vue`)
- [x] **Streaming status via awareness** — function-call observation surfaces live status ("Searching the web for '…'", "Editing '…'"); no SSE/push channel to client
- [x] **Concurrent sessions allowed**, one per user per doc (`DuplicateSessionError` → 409; enforced by Postgres UNIQUE index)
- [x] **Initiator-only cancel** via `POST /api/ai/abort`
- [x] Per-user rate limits (`ai-prompt: 20/h`, `ai-rewrite: 30/h`) + 5-min deadline + 7-min sweeper (`server/plugins/ai-session-sweep.ts`)
- [x] AI avatars with sparkles + pulsing ring in `PresenceBar.vue`
- [x] Error toasts on mid-loop failures; abort is never an error
- [ ] PWA setup via `@vite-pwa/nuxt`
- [x] Rate limiting on Nuxt server routes — done in Phase 4.5 (token, password, import, export)
- [x] Scheduled cleanup of orphaned S3 objects — upgraded in Phase 7 to use the uploads table
- [ ] Scheduled cleanup of inactive documents (deferred)

**MVP ships at end of Week 7.**

#### Phase 7: Production Hardening ✅ (current)
Kicked off by a deployability audit that flagged 17 issues; 10 of them addressed in this phase:
- [x] **SQLite → Postgres migration.** `drizzle-orm/node-postgres` + `pg`. Versioned migrations in `drizzle/` via drizzle-kit, applied at boot by `server/plugins/00-db-migrate.ts`.
- [x] **S3-blob Y.js → y-postgresql.** Append-only updates + periodic merge in the `yjs_documents` table (same Postgres instance). One `pg_dump` covers app + Y.js state.
- [x] **Graceful shutdown everywhere.** sync-server: SIGTERM/SIGINT → `server.destroy()` → `ypgPersistence.destroy()`. Nuxt: `99-shutdown.ts` closes the pg pool on Nitro `close`. Compose: `stop_grace_period: 30s`.
- [x] **Daily Postgres backups to S3.** `backup-server/` sidecar — same script against SeaweedFS (dev) or Infomaniak (prod).
- [x] **SPA version detection.** `GET /api/version` + `plugins/version-check.client.ts` polling + on-focus; sticky "Reload" toast on build-id mismatch.
- [x] **Session TTL + shape version.** Cookie `maxAge: 7d`. `SESSION_VERSION = 1`; `validatedSession.ts` clears cookie on mismatch.
- [x] **Image uploads tracked in DB.** New `uploads` table — row inserted on presigned URL issue, `confirmed_at` flipped on confirm. Orphan cleanup rewritten with a 3-layer design (unconfirmed-sweep / doc-level / defensive) and a 24 h grace window.
- [x] **Attribution observability.** `[hocuspocus] Attribution fallback …` warning whenever the awareness heuristic kicks in (so we can spot drift in prod logs).
- [x] **Traefik healthcheck labels + compose healthchecks** on app and sync so Traefik stops routing to draining containers.
- [x] **AI provider swap.** Anthropic (Claude) → Google Gemini via `@google/genai`. Same AI-as-Y.js-collaborator design, different SDK + tool shapes.

Still on the list for later (not in scope for MVP launch):
- Dual-secret rotation (`JWT_SECRET`, `SESSION_PASSWORD`, `INTERNAL_API_SECRET`).
- Observability (Sentry / structured logs / metrics).
- Rate-limit cleanup failure surfacing.
- Multi-replica zero-downtime (requires infra beyond single-VPS compose).

---

### MMP — Weeks 8-14

#### Phase 7: Workspaces (Week 8)
- [ ] Workspace CRUD endpoints
- [ ] Workspace page (`/w/{id}`)
- [ ] Create doc from workspace, add existing docs
- [ ] Workspace doc table with activity indicators

#### Phase 8: History & Snapshots (Weeks 9-10)
- [ ] Timestamped snapshots in S3 via Hocuspocus hook
- [ ] History view: load any snapshot into fresh Y.Doc
- [ ] Timeline scrubber, diff view, restore, export at point
- [ ] Playback animation

#### Phase 9: Power Features (Weeks 13-14)
- [ ] Command palette
- [ ] Table of contents sidebar
- [ ] Follow cursor
- [ ] QR code sharing
- [ ] Keyboard shortcuts cheat sheet
- [ ] Offline mode (PWA cache)
- [ ] Y.js document compaction for oversized docs
- [ ] Remaining locale translations (de, fr, es, ja, zh)

---

## 20. Technical Decisions

| Decision | Rationale |
|---|---|
| **Full-stack Nuxt over SPA + Fastify** | One server instead of two. Nitro handles API routes, SSR, and auth in a single Bun process. Eliminates GitHub Pages dependency. |
| **`nuxt-auth-utils` over `@sidebase/nuxt-auth`** | Lighter (no Auth.js dependency), built by Nuxt creator, sealed cookie sessions (no session DB), 40+ OAuth providers, WebAuthn support. |
| **Drizzle ORM + PostgreSQL** (was SQLite) | Real versioned migrations, concurrent writers, pg_dump backup path. Swap from `better-sqlite3` → `pg` happened in Phase 7; no user-facing data migration was needed because the rewrite preceded any real user data. |
| **Single `pg` driver across the stack** | `y-postgresql` requires `pg.PoolConfig`, so mixing `pg` and `postgres-js` would mean two pools. One driver keeps things consistent. |
| **y-postgresql for Y.js persistence** (was S3 blob overwrite) | Append-only updates + periodic merge is vastly more durable than "encode full state and overwrite a single S3 key". A failed write can no longer nuke prior state. One Postgres backup covers both app and Y.js data. Caveat: `useIndex: true` has a SQL bug in 1.0.1 — forced to `false`. |
| **Text enum columns, not `pgEnum`** | Adding a new `accessMode` value is a TS-only change; no `ALTER TYPE` migration friction. Server-side validation is explicit in the route handlers. |
| **Drizzle migrations at boot via `00-db-migrate.ts`** | Numeric `00-` prefix forces load-first so the ai-sweep / rate-limit-cleanup plugins don't race against empty-schema queries. `99-shutdown.ts` mirrors it on the teardown side. |
| **Bun over Node.js** | 4x faster startup, 6-35x faster installs, TypeScript without transpilation. 98% Node.js compat. |
| **Pinia Colada over raw `$fetch`** | Automatic caching, deduplication, loading/error states, cache invalidation. Eliminates boilerplate. |
| **VueUse over custom composables** | 200+ battle-tested composables auto-imported. Replaces 5+ custom files. |
| **`@nuxtjs/i18n` with lazy loading** | Locale files loaded on demand. `strategy: 'no_prefix'` keeps clean URLs. Nuxt UI has built-in i18n binding. |
| **`nuxt-codemirror` over raw CM6** | Vue-wrapped component with reactive props and lifecycle management. Y.js integration via raw extensions. |
| **Y.js CRDT over custom OT** | Proven convergence under all concurrency. No custom conflict resolution code. |
| **Hocuspocus as separate container** | Long-lived WebSocket connections with in-memory Y.Doc state shouldn't share the event loop with HTTP request handling. |
| **Sync-server ↔ Nuxt via shared-secret HTTP** | Alternatives (direct DB access from sync-server, message queue) were heavier. HTTP + `X-Internal-Secret` is simple, debuggable, and already the contract we use for OAuth callbacks etc. Sync-server calls Nuxt for activity logging; Nuxt calls sync-server for delete broadcasts. |
| **Graceful shutdown at both tiers** | sync-server SIGTERM handler calls Hocuspocus's own `server.destroy()` (drains WS + awaits pending stores). Nuxt's `99-shutdown.ts` closes the pg pool on `close` hook. Compose gives 30 s grace. |
| **Uploads tracked in DB, not just S3** | Every presigned PUT writes a row pre-emptively. Orphan cleanup uses the uploads table as the source of truth with a 24 h grace window to avoid racing live uploads. |
| **3-layer orphan cleanup** | (1) unconfirmed-uploads older than 24 h, (2) whole prefixes for gone-docs, (3) defensive sweep of untracked S3 objects older than 24 h. The grace window closes the original race the SQLite-era cleanup had. |
| **Delete broadcast via `ymeta._deleted`** | Re-uses Y.js broadcast infrastructure instead of adding a custom WebSocket message. Sync-server sets the flag on the in-memory Y.Doc, then clears the y-postgresql rows so the doc can't be revived from disk. Clients observe via the existing `ymeta.observe` they already use for the title. |
| **OAuth optional, not mandatory** | Public docs work anonymously. Login required only for ownership/management. Low friction for casual use. |
| **SESSION_VERSION invalidation over backwards-compat shims** | Pre-launch, bumping a constant is simpler than carrying optional fields forever. Stale cookies are just cleared. |
| **Read-only at 4 layers** | Token endpoint, Hocuspocus JWT claim, CM6 Compartment, UI. Defense-in-depth. |
| **Backups via sidecar, not in-app** | Keeps the Nuxt image free of pg_dump / aws-cli. Sidecar uses `postgres:16-alpine` (pg_dump version matches server) + `aws-cli`. Same `S3_*` env as the rest of the stack, so it works against SeaweedFS in dev and Infomaniak in prod. |
| **SeaweedFS dev-only** | Production uses external S3 (Infomaniak). SeaweedFS exists only in `docker-compose.dev.yml`; production compose doesn't ship it. |
| **AI suggestions local-only** | Ghost text not broadcast to collaborators. Accepted text syncs as normal Y.js edits. |
| **Google Gemini via `@google/genai`** (was Anthropic Claude) | Materially cheaper per token at comparable quality for the two things we use AI for. Gemini 3.1 Flash-Lite-Preview for the agentic loop ($0.25/$1.50 per 1M in/out; 5k/month free grounds), Gemini 2.5 Flash-Lite for rewrites ($0.10/$0.40). Display name is vendor-neutral ("AI Assistant") so swaps are a config change. |
| **Custom `web_search` function over `googleSearch` tool** | We wrap Gemini's grounded search as our own function declaration. The main agentic loop only ever uses `functionDeclarations` — never mixes with the built-in `googleSearch` — which (a) guarantees compatibility across model versions where coexistence rules have shifted, and (b) gives us pre-call status UX ("Searching the web for 'X'…") we couldn't get from the implicit server-tool path. Cost is one extra Gemini call per search; at Gemini pricing, immaterial. |
| **Zod schemas as source-of-truth for AI tool args** | `z.toJSONSchema(schema)` (Zod 4 native — not the external `zod-to-json-schema` package, which is typed against Zod 3) produces the `parametersJsonSchema` we hand to Gemini. The same schema is used by `runLoop` to `safeParse` every `FunctionCall.args` before dispatch. Malformed args round-trip back to the model as a `functionResponse.isError` with the Zod issue path + message so the model can self-correct — no more silent `String()` / `Number()` coercion. Gotcha: use `z.array(...).min(2).max(2)` rather than `z.tuple(...)` for fixed-length arrays; Gemini's validator rejects tuple-shaped `items: [...]` JSON Schema. |
| **Pandoc as separate HTTP service** | Keeps Nuxt container lightweight (no TeX/fonts). Python HTTP wrapper around `pandoc/extra`. Same container for dev and prod. Nuxt calls `POST /convert` instead of `execFile`. |

---

## 21. Security

### 21.1 Authentication & Authorization

- **OAuth via `nuxt-auth-utils`** — encrypted HTTP-only session cookies, CSRF protection, no tokens in localStorage. Explicit `maxAge: 7d` on the cookie via `runtimeConfig.session.maxAge` (no silent session-forever).
- **Session shape versioning** — `SESSION_VERSION` constant in `server/utils/validatedSession.ts`. Every logged-in session carries `v: SESSION_VERSION`; any session with a mismatching `v` is cleared on the next request and the user is forced to re-auth. Bumping the constant invalidates every outstanding cookie cleanly.
- **Hocuspocus always requires a valid JWT** — no anonymous WebSocket bypass. Every connection must go through the Nuxt token endpoint first, which checks document access mode and sets the correct `readOnly` flag. Connecting without a token is rejected with "Authentication required".
- **JWT secret required at startup** — both the Nuxt server (`config.jwtSecret`) and the sync-server (`JWT_SECRET` env var) throw hard errors if the secret is missing. No dev-secret fallbacks exist.
- **DATABASE_URL required at startup** — both the Nuxt app and sync-server throw if it's missing. No silent fallback to a local socket.
- **Internal API secret** — server↔sync-server calls (activity logging, delete notifications) are authed via `INTERNAL_API_SECRET` shared between both services. Nuxt middleware whitelists `/api/internal/*` from user-session auth; those endpoints validate the secret themselves. Routes are only reachable on the internal Docker network in production; dev binds Nuxt to `0.0.0.0` and uses `host.docker.internal` for sync→Nuxt reachability.

### 21.2 Access Control (4 layers for read-only, 3 layers for password)

**Read-only enforcement:**
1. **Token endpoint** — mints JWT with `readOnly: true` for open-view docs (non-owners)
2. **Hocuspocus** — `onAuthenticate` returns `{ readOnly: true }` from JWT, server blocks Y.js updates
3. **CodeMirror** — `EditorView.editable` and `EditorState.readOnly` via CM6 Compartments (dynamically reconfigured when `readOnly` prop changes)
4. **UI** — view mode forced to preview-only, toolbar hidden, "View only" badge shown

**Password-protected enforcement:**
1. **Token endpoint** — returns `token: null` for password-protected docs (non-owners). No usable JWT is issued until password is verified.
2. **Hocuspocus** — rejects connection (no valid token), so no document content is synced before password entry
3. **Client** — `connect()` is not called until password verified; template gated by `v-if="!requiresPassword"` so no content renders; lock screen shown instead

### 21.3 Rate Limiting

- **Password brute-force** — 5 attempts per IP+docId per minute (429 after), via `server/utils/rateLimit.ts`
- **Token endpoint** — 30 requests per IP per minute (prevents document enumeration)
- **Import/export** — 10 requests per IP per minute on public Pandoc conversion endpoints
- **Hocuspocus** — 20 connections per IP, 5000 max rooms

### 21.4 Input Validation

- **meta.put endpoint** — title (string, max 255 chars), access_mode (enum whitelist: `open-edit`/`open-view`/`password-protected`), wordCount (0-10M, finite), sizeBytes (0-100M, finite)
- **Upload validation** — type whitelist (png/jpeg/gif/webp/svg), 10MB limit
- **Import validation** — extension whitelist, 50MB limit

### 21.5 File Access Control

- **File serving endpoint** (`/api/files/:docId/:fileId`) checks document access mode before generating presigned S3 URL. Password-protected docs require owner authentication — anonymous users cannot access uploaded files from password-protected documents.
- **Presigned URLs** — 5 min upload, 120 s read (short TTL because presigned URLs cannot be revoked — long-lived reads would outlive access-mode changes / password rotations / deletions), content-type locked

### 21.6 Other

- **Password hashing** via `nuxt-auth-utils` built-in scrypt (not argon2)
- **Password token expiry** — 2h (same as normal tokens, not 24h)
- **XSS prevention** — `html: false` in markdown-it + DOMPurify sanitization
- **Postgres** — standard client-library defaults; no special tuning needed at our scale.
- **`.env` is in `.gitignore`** — never committed to git. OAuth secrets stay local.

---

## 22. Performance

- **Y.js update batching** — automatic transaction grouping
- **Hocuspocus debounce** — persistence writes at 2s/10s intervals
- **y-postgresql periodic merge** — accumulated update rows are merged into a single compacted update once every `flushSize` (200) writes per doc
- **Bun startup** — 5-15ms cold start vs 60-120ms for Node.js
- **Pinia Colada caching** — stale-while-revalidate for API calls
- **i18n lazy loading** — locale files loaded on demand
- **Preview debouncing** — `watchDebounced` at 100ms via VueUse
- **CM6 viewport rendering** — only visible lines rendered
- **Pandoc isolation** — runs in separate container, Nuxt server not affected by heavy conversions
- **pg connection pooling** — single `pg.Pool` per process via `useDatabase()` singleton

---

## 23. S3 Key Layout

```
ypad/
├── docs/
│   └── {docId}/
│       └── {fileId}.{ext}              # Uploaded images/attachments
└── backups/
    └── postgres/
        └── {YYYYMMDDTHHMMSSZ}.sql.gz   # Daily pg_dump (sidecar)
```

Everything else — user data, document ownership, workspaces, activity log, uploads metadata, AI sessions, rate-limit hits, and **Y.js document state itself** — lives in PostgreSQL. S3 is strictly blob storage now (user image uploads + backup archives).

---

## 24. Swappable S3 Backend

```env
NUXT_S3_ENDPOINT=http://seaweedfs:8333                    # Dev (docker-compose.dev.yml)
NUXT_S3_ENDPOINT=https://s3.pub1.infomaniak.cloud         # Infomaniak (current prod)
NUXT_S3_ENDPOINT=https://s3.amazonaws.com                 # AWS
NUXT_S3_ENDPOINT=https://{id}.r2.cloudflarestorage.com    # Cloudflare R2
```

No code changes. The Nuxt app uses this endpoint for image uploads and the backup sidecar uses it for pg dumps. Sync-server no longer touches S3 — Y.js state is in Postgres now.

---

## 25. Architecture Evolution Summary

| Iteration | Containers | Sync | Auth | Data | AI | Frontend hosting |
|---|---|---|---|---|---|---|
| Original (NATS) | 8 | Custom OT over NATS | Anonymous tokens | NATS KV | — | GitHub Pages |
| v2 (NATS + Y.js) | 5 | Y.js over NATS | Anonymous tokens | NATS KV | — | GitHub Pages |
| v3 (Hocuspocus) | 4 | Y.js via Hocuspocus | Anonymous tokens | S3 metadata | — | GitHub Pages |
| v4 (Hocuspocus + features) | 4 | Y.js via Hocuspocus | Creator tokens | S3 metadata | — | GitHub Pages |
| v5 (full-stack Nuxt) | 5 | Y.js via Hocuspocus | OAuth (GitHub/Google) | SQLite + S3 (Y.js blobs) | Claude (Anthropic) | Nuxt SSR |
| **Current (production-hardened)** | **6** (prod) | **Y.js via Hocuspocus** | **OAuth (GitHub/Google) + SESSION_VERSION** | **PostgreSQL (app + y-postgresql) + external S3 (image uploads + pg backups)** | **Gemini (`@google/genai`)** | **Nuxt SSR** |

**Current container set:**
- Production (6): traefik, postgres, app, sync, pandoc, backup.
- Development (5): postgres, seaweedfs, sync, pandoc, backup. (Nuxt app runs on host for HMR.)
