# YPad — Implementation Plan (Final)

## Collaborative Markdown Editor with Full-Stack Nuxt 4, Y.js, Hocuspocus, OAuth, and AI

A collaborative markdown editor with live sync via Y.js CRDT and Hocuspocus, OAuth authentication (GitHub, Google) via `nuxt-auth-utils`, user data in SQLite via Drizzle ORM, S3-backed file storage via SeaweedFS, multi-lingual UI via `@nuxtjs/i18n`, and AI writing assistance (cloud-first with optional on-device Gemma 4 via WebGPU). Log in to own and manage documents across devices, or skip login to edit public documents anonymously. The full-stack Nuxt app and Hocuspocus sync server run on a single Linux VPS with Docker Compose.

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         Browser                                    │
│              Nuxt 4 (SSR + SPA hydration)                         │
│                                                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────────┐  │
│  │CodeMirror│ │ Nuxt UI  │ │ Y.js     │ │   AI Provider       │  │
│  │  6 +     │ │   v4     │ │ Hocusp.  │ │ Cloud (default)     │  │
│  │  yCollab │ │   i18n   │ │ Provider │ │ Gemma WebGPU (opt)  │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────────┬──────────┘  │
│       └──────────────┴───────────┴──────────────────┘             │
│                   │ WSS              │ HTTPS                      │
└───────────────────┼──────────────────┼────────────────────────────┘
                    │                  │
           ┌────────▼──────────────────▼────────┐
           │          Traefik v3                 │  ← Let's Encrypt
           │       (reverse proxy)               │     auto TLS
           └──┬──────────┬──────────┬───────────┘
              │          │          │
     ┌────────▼───┐ ┌────▼─────────────────┐ ┌─▼──────────────┐
     ┌────────▼───┐ ┌────▼─────────────────┐ ┌─▼──────────────┐
     │Hocuspocus  │ │ Nuxt 4 Full-Stack    │ │ SeaweedFS      │
     │Y.js sync   │ │ (Bun + Nitro)        │ │ (S3-compat)    │
     │server      │ │                      │ │                 │
     │            │ │ • SSR + SPA hydrate  │ │ single-process  │
     │ • rooms    │ │ • server/api/ routes │ │ server mode     │
     │ • auth     │ │ • OAuth (GH/Google)  │ └─────────────────┘
     │ • persist  │ │ • Drizzle ORM + SQLite │
     │ • awareness│ │ • presigned S3 URLs  │  ┌─────────────────┐
     │ • read-only│ │ • import/export      │  │ Pandoc Server   │
     │ • rate lim.│ │ • AI proxy           │  │ (HTTP wrapper)  │
     └────────────┘ └──────────────────────┘  │ • pandoc/extra  │
                            │                  │ • PDF/DOCX/md   │
                            │ HTTP             └─────────────────┘
                            └──────────────────────┘

              Linux VPS (Docker Compose)
```

**Key design principles:**

- **Full-stack Nuxt replaces both GitHub Pages and Fastify.** Nuxt serves the SPA, handles API routes via Nitro `server/api/`, and manages OAuth sessions — all in one Bun process. Zero CDN dependency.
- **OAuth is optional, not mandatory.** Public documents work without login. Anyone with the link can view (or edit, if the owner allows). Login is required to create documents, manage permissions, use workspaces, or delete.
- **Drizzle ORM + SQLite for user data.** Type-safe ORM over `better-sqlite3`. Schema defined in `server/db/schema.ts` with full TypeScript inference. Stores users, document ownership, workspace membership, and permissions. No external database container.
- **Y.js CRDT for conflict-free collaboration.** Browsers maintain a local Y.Doc that merges automatically. No custom OT.
- **Hocuspocus is the sync server.** WebSocket rooms, Y.js persistence to S3, awareness (cursors/presence), auth hooks, read-only access — all out of the box.
- **AI is cloud-first with an optional local fallback.** Cloud AI (any OpenAI-compatible API) ships first. On-device Gemma 4 via WebGPU is opt-in for privacy-conscious users.
- **Pandoc runs as a separate HTTP service.** A lightweight Python HTTP wrapper around `pandoc/extra` Docker image. Both dev and production use the same container. Keeps the Nuxt container lightweight (no TeX/font dependencies).

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
| `@huggingface/transformers` | 4.3.0 | WebGPU AI inference (MMP phase) |

### 2.4 Hocuspocus Sync Server Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@hocuspocus/server` | 3.4.4 | Y.js WebSocket sync server |
| `@aws-sdk/client-s3` | 3.750.0 | S3 persistence for Y.js docs |
| `yjs` | 13.6.30 | Shared with frontend |
| `jsonwebtoken` | 9.0.2 | JWT verification for protected docs |

### 2.5 Nuxt Server Dependencies (replace Fastify)

| Package | Version | Purpose |
|---|---|---|
| `drizzle-orm` | 0.45.2 | Type-safe ORM for SQLite |
| `better-sqlite3` | 12.8.0 | SQLite driver (Node.js compatible) |
| `@aws-sdk/client-s3` | 3.750.0 | S3 storage for files |
| `@aws-sdk/s3-request-presigner` | 3.750.0 | Presigned URLs |
| `jsonwebtoken` | 9.0.2 | JWT for Hocuspocus auth tokens |
| `mime` | 4.0.6 | MIME type detection |

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
    sessionPassword: '',           // NUXT_SESSION_PASSWORD (≥32 chars)
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
      endpoint: '',                // NUXT_S3_ENDPOINT
      accessKey: '',               // NUXT_S3_ACCESS_KEY
      secretKey: '',               // NUXT_S3_SECRET_KEY
      bucket: 'ypad',             // NUXT_S3_BUCKET
    },
    llm: {
      apiUrl: '',                  // NUXT_LLM_API_URL
      apiKey: '',                  // NUXT_LLM_API_KEY
      model: 'gpt-4o-mini',       // NUXT_LLM_MODEL
    },
    jwtSecret: '',                 // NUXT_JWT_SECRET (for Hocuspocus tokens)
    pandocUrl: '',                 // NUXT_PANDOC_URL (http://pandoc:8080 in Docker, http://localhost:8080 in dev)
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
    lazy: true,
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
// server/routes/auth/github.get.ts
export default defineOAuthGitHubEventHandler({
  config: { emailRequired: true },
  async onSuccess(event, { user, tokens }) {
    // Upsert user in SQLite
    const db = useDatabase()
    db.run(`
      INSERT INTO users (github_id, login, name, email, avatar_url)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(github_id) DO UPDATE SET
        login = excluded.login, name = excluded.name,
        email = excluded.email, avatar_url = excluded.avatar_url
    `, [user.id, user.login, user.name, user.email, user.avatar_url])

    const dbUser = db.get('SELECT id FROM users WHERE github_id = ?', [user.id])

    await setUserSession(event, {
      user: {
        id: dbUser.id,
        login: user.login,
        name: user.name,
        email: user.email,
        avatar: user.avatar_url,
        provider: 'github',
      },
      loggedInAt: Date.now(),
    })
    return sendRedirect(event, '/')
  },
})
```

**Google login server route:**

```typescript
// server/routes/auth/google.get.ts
export default defineOAuthGoogleEventHandler({
  config: { scope: ['openid', 'email', 'profile'] },
  async onSuccess(event, { user }) {
    const db = useDatabase()
    db.run(`
      INSERT INTO users (google_id, name, email, avatar_url)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(google_id) DO UPDATE SET
        name = excluded.name, email = excluded.email, avatar_url = excluded.avatar_url
    `, [user.sub, user.name, user.email, user.picture])

    const dbUser = db.get('SELECT id FROM users WHERE google_id = ?', [user.sub])

    await setUserSession(event, {
      user: {
        id: dbUser.id,
        name: user.name,
        email: user.email,
        avatar: user.picture,
        provider: 'google',
      },
      loggedInAt: Date.now(),
    })
    return sendRedirect(event, '/')
  },
})
```

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
// server/api/docs/[docId]/token.get.ts
export default defineEventHandler(async (event) => {
  const docId = getRouterParam(event, 'docId')
  if (!docId) throw createError({ statusCode: 400, message: 'Missing docId' })
  const session = await getUserSession(event)
  const db = useDatabase()
  const config = useRuntimeConfig()
  if (!config.jwtSecret) throw createError({ statusCode: 500, message: 'JWT secret not configured' })

  const doc = db.select().from(documents).where(eq(documents.docId, docId)).get()
  let readOnly = false
  let requiresPassword = false
  const accessMode = doc?.accessMode ?? 'open-edit'
  const ownerId = doc?.ownerId ?? null

  if (doc) {
    const userId = session?.user?.id
    const isOwner = ownerId != null && typeof userId === 'number' && ownerId === userId
    if (doc.accessMode === 'open-view' && !isOwner) readOnly = true
    if (doc.accessMode === 'password-protected' && !isOwner) {
      requiresPassword = true
      readOnly = true
    }
  }

  const token = jwt.sign(
    { docId, userId: session?.user?.id || 'anonymous', readOnly },
    config.jwtSecret,
    { expiresIn: '2h' }
  )
  return { token, readOnly, requiresPassword, accessMode, ownerId }
})
```

---

## 5. Database — Drizzle ORM + SQLite

### 5.1 Why Drizzle ORM + SQLite

- **Type-safe queries** — Drizzle provides full TypeScript inference from schema to query results. No `as any` casts.
- **Zero infrastructure** — `better-sqlite3` is a native Node.js module, no container needed
- **Single-file database** — backed up by mounting a Docker volume
- **Schema-as-code** — schema defined in `server/db/schema.ts`, serves as both migration source and type source
- **Sufficient scale** — SQLite handles millions of rows; a collaborative editor will never hit its limits on a single VPS

**Note:** We use `better-sqlite3` instead of `bun:sqlite` because Nitro's dev server runs on Node.js. In production Docker (which uses Bun), `better-sqlite3` still works correctly.

### 5.2 Schema

```typescript
// server/db/schema.ts
import { sqliteTable, integer, text, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  githubId: text('github_id').unique(),
  googleId: text('google_id').unique(),
  login: text('login'),
  name: text('name').notNull(),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
})

export const documents = sqliteTable('documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  docId: text('doc_id').notNull().unique(),
  ownerId: integer('owner_id').references(() => users.id),
  title: text('title').notNull().default('Untitled'),
  accessMode: text('access_mode', { enum: ['open-edit', 'open-view', 'password-protected'] }).notNull().default('open-edit'),
  passwordHash: text('password_hash'),
  sizeBytes: integer('size_bytes').default(0),
  wordCount: integer('word_count').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  lastActive: integer('last_active', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
}, (table) => [
  index('idx_documents_owner').on(table.ownerId),
  index('idx_documents_last_active').on(table.lastActive)
])
// ... documentShares, workspaces, workspaceDocuments, activityLog tables
```

### 5.2.1 Database Utility

```typescript
// server/utils/database.ts
import { drizzle } from 'drizzle-orm/better-sqlite3'
import Database from 'better-sqlite3'
import * as schema from '../db/schema'

let db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function useDatabase() {
  if (!db) {
    const sqlite = new Database(process.env.DATABASE_PATH || './data/ypad.db')
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    db = drizzle(sqlite, { schema })
  }
  return db
}
```

### 5.2.2 Example Query

```typescript
// server/api/docs/[docId]/meta.get.ts
import { eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const { docId } = getRouterParams(event)
  const db = useDatabase()
  const doc = db.select().from(documents).where(eq(documents.docId, docId)).get()
  if (!doc) throw createError({ statusCode: 404, message: 'Document not found' })
  return doc  // Fully typed: { id: number, docId: string, title: string, ... }
})
```

### 5.3 What lives where

| Data | Storage | Why |
|---|---|---|
| Users, ownership, permissions, workspaces | SQLite (Drizzle ORM) | Type-safe relational queries, fast lookups |
| Y.js document state | S3 (`docs/{docId}/state.yjs`) | Binary blobs, Hocuspocus persistence hooks |
| Uploaded images/files | S3 (`docs/{docId}/{fileId}.ext`) | Large blobs, presigned URL access |
| History snapshots | S3 (`docs/{docId}/history/*.yjs`) | Binary blobs, time-ordered |
| User sessions | Sealed cookies | No storage needed, `nuxt-auth-utils` handles it |
| Activity log | SQLite (Drizzle ORM) | Queryable, capped per document |

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

# Documents
POST   /api/docs                       Create document (requires login)
GET    /api/docs/:docId/meta           Get document metadata
PUT    /api/docs/:docId/meta           Update title, access mode
DELETE /api/docs/:docId                Delete document (owner only)
GET    /api/docs/:docId/token          Get Hocuspocus JWT
GET    /api/docs/:docId/activity       Get activity log
POST   /api/docs/:docId/password       Set/verify/remove password

# User
GET    /api/user/documents             List user's documents
GET    /api/user/recent                List recently visited docs

# Files
POST   /api/upload/request             Request presigned S3 PUT URL
POST   /api/upload/confirm             Confirm upload landed in S3
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

# AI
POST   /api/ai/generate                Streaming LLM proxy
```

### 6.2 Key Server Route Implementations

**Create document (requires login):**

```typescript
// server/api/docs.post.ts
export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  const db = useDatabase()
  const docId = nanoid(10)

  db.run(
    'INSERT INTO documents (doc_id, owner_id) VALUES (?, ?)',
    [docId, session.user.id]
  )

  return { docId }
})
```

**List user's documents:**

```typescript
// server/api/user/documents.get.ts
export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  const db = useDatabase()

  const docs = db.all(`
    SELECT d.doc_id, d.title, d.access_mode, d.word_count, d.last_active,
           d.size_bytes, d.owner_id = ? as is_owner
    FROM documents d
    LEFT JOIN document_shares ds ON d.doc_id = ds.doc_id AND ds.user_id = ?
    WHERE d.owner_id = ? OR ds.user_id IS NOT NULL
    ORDER BY d.last_active DESC
  `, [session.user.id, session.user.id, session.user.id])

  return docs
})
```

**Presigned upload:**

```typescript
// server/api/upload/request.post.ts
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])
const MAX_SIZE = 10 * 1024 * 1024

export default defineEventHandler(async (event) => {
  const { docId, filename, contentType, size } = await readBody(event)
  if (!ALLOWED_TYPES.has(contentType)) throw createError({ statusCode: 415, message: 'Type not allowed' })
  if (size > MAX_SIZE) throw createError({ statusCode: 413, message: 'Max 10MB' })

  const s3 = useS3Client()
  const config = useRuntimeConfig()
  const fileId = nanoid(12)
  const ext = filename.split('.').pop() || 'bin'
  const key = `docs/${docId}/${fileId}.${ext}`

  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: config.s3.bucket, Key: key, ContentType: contentType, ContentLength: size
  }), { expiresIn: 300 })

  return { uploadUrl, fileId: `${fileId}.${ext}`, expiresIn: 300 }
})
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

**AI proxy (streaming):**

```typescript
// server/api/ai/generate.post.ts
export default defineEventHandler(async (event) => {
  const { prompt, context } = await readBody(event)
  const config = useRuntimeConfig()

  const upstream = await fetch(config.llm.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify({
      model: config.llm.model,
      stream: true,
      messages: [
        { role: 'system', content: 'You are a writing assistant. Be concise. Match the document tone.' },
        { role: 'user', content: `Document:\n${context}\n\nRequest: ${prompt}` },
      ],
      max_tokens: 512,
    }),
  })

  setResponseHeaders(event, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  return sendStream(event, upstream.body)
})
```

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
// sync-server/src/index.ts
import { Server } from '@hocuspocus/server'
import { s3Persistence } from './persistence'
import { auth } from './auth'
import { rateLimiter } from './rate-limiter'

const port = parseInt(process.env.PORT || '4001')

const server = new Server({
  port,
  debounce: 2000,
  maxDebounce: 10000,

  async onLoadDocument(data) { return s3Persistence.onLoadDocument(data) },
  async onStoreDocument(data) { await s3Persistence.onStoreDocument(data) },
  async onAuthenticate(data) { return auth.onAuthenticate(data) },
  async onConnect(data) { rateLimiter.onConnect(data) },
  async onDisconnect(data) { rateLimiter.onDisconnect(data) },
})

server.listen(port, () => {
  console.log(`[hocuspocus] Sync server listening on port ${port}`)
})
```

### 7.2 S3 Persistence

```typescript
// sync-server/src/persistence.ts
import * as Y from 'yjs'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
  forcePathStyle: true,
})

export const s3Persistence = {
  async onLoadDocument({ documentName }: { documentName: string }) {
    const doc = new Y.Doc()
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: 'ypad', Key: `docs/${documentName}/state.yjs` }))
      Y.applyUpdate(doc, new Uint8Array(await obj.Body!.transformToByteArray()))
    } catch (e: any) {
      if (e.name !== 'NoSuchKey') throw e
    }
    return doc
  },

  async onStoreDocument({ documentName, document }: { documentName: string; document: Y.Doc }) {
    const state = Y.encodeStateAsUpdate(document)
    await s3.send(new PutObjectCommand({
      Bucket: 'ypad', Key: `docs/${documentName}/state.yjs`,
      Body: state, ContentType: 'application/octet-stream',
    }))
  },
}
```

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

### 7.5 Sync Server Dockerfile

**Note:** We run TypeScript directly with Bun rather than pre-bundling. Bun's bundler had issues with Hocuspocus's CJS/ESM exports, and the startup time difference is negligible.

```dockerfile
FROM oven/bun:1.3-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 4001
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

Workspaces are tied to user accounts (stored in SQLite via Drizzle ORM). They replace the anonymous "secret URL" model from earlier iterations.

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

## 13. Key Composable: `useDocument.ts`

Key design decisions in the actual implementation:

- **Single fetch on init:** The token endpoint returns `token`, `readOnly`, `requiresPassword`, `accessMode`, and `ownerId` — no separate `/meta` call needed.
- **Single Awareness instance:** One `Awareness` object is created early and passed to HocuspocusProvider via the `awareness` option. This ensures PresenceBar and yCollab always reference the same object — no reference-switching when the provider connects. Previously, a separate `localAwareness` fallback caused presence and cursors to silently break.
- **Y.js Map reactivity bridge:** `ymeta.get('title')` is not tracked by Vue's reactivity system. A `ymeta.observe()` callback updates a Vue `ref`, and a computed wraps get/set. Without this, the title input appeared to save but reverted immediately.
- **`useUserSession()` declared before `connect()`** to avoid fragile variable ordering.
- **Welcome content insertion** on `onSynced` (server had no content), `onDisconnect` (server unreachable and never synced), or no-sync path (no syncUrl configured).
- **Password flow:** Token endpoint returns `token: null` for password-protected docs (non-owners). `connect()` is NOT called until password is verified. After verification, `onPasswordVerified(token)` connects with the new token, and `requiresPassword` is cleared only in `onSynced` — this ensures the editor mounts with content already loaded (prevents empty-doc bug where typed text was prepended to the document).
- **`setAccessMode(mode)`** allows the ShareModal to propagate access mode changes back to the composable.

```typescript
// app/composables/useDocument.ts — returns:
return {
  ydoc, ytext, awareness,          // awareness is a plain Awareness (not a computed ref)
  provider: readonly(provider),
  status: readonly(status),        // 'connecting' | 'connected' | 'disconnected'
  synced: readonly(synced),
  userCount: readonly(userCount),
  isReadOnly: readonly(isReadOnly),
  isOwner: readonly(isOwner),
  requiresPassword: readonly(requiresPassword),
  accessMode: readonly(accessMode),
  docSizeBytes: readonly(docSizeBytes),
  docSizeWarning,                  // null | 'warning' | 'critical'
  undoManager,
  title,                           // computed get/set via Y.js Map + observe bridge
  onPasswordVerified,
  setAccessMode,
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

## 15. AI Writing Assistance

### 15.1 Dual Provider Architecture

Cloud AI ships in the MVP. On-device Gemma 4 via WebGPU is MMP.

```typescript
// app/composables/useAI.ts
interface AIProvider {
  name: string
  label: string
  available: boolean
  generate(prompt: string, context: string): AsyncGenerator<string>
}

export function useAI() {
  const provider = ref<'cloud' | 'local'>('cloud')
  const { t } = useI18n()
  const cloudProvider = useCloudAI()
  const localProvider = useLocalAI()

  const active = computed(() =>
    provider.value === 'local' && localProvider.available ? localProvider : cloudProvider
  )

  return { provider, active, switchProvider: (p: 'cloud' | 'local') => { provider.value = p } }
}
```

### 15.2 AI Suggestion UX

Suggestions are **local-only** until accepted. Ghost text appears in the requesting user's editor only. On accept (Tab), the text is written to the Y.js document and syncs normally.

---

## 16. Mobile Editing

CodeMirror 6 on mobile requires specific attention:

1. **Edit-only default** — no split pane on narrow screens
2. **Floating toolbar** above virtual keyboard via `visualViewport` API
3. **44px touch targets** on toolbar buttons
4. **Bottom tab bar** for Edit / Preview / AI switching
5. **Sidebar as bottom sheet** on mobile
6. **CM6 mobile extensions:** `autocapitalize`, `autocorrect`, larger font/line-height

```typescript
const isMobile = useMediaQuery('(max-width: 768px)')

const mobileExtensions = computed(() => isMobile.value ? [
  EditorView.contentAttributes.of({ autocapitalize: 'sentences', autocorrect: 'on' }),
  EditorView.theme({ '.cm-content': { lineHeight: '1.8', fontSize: '16px', padding: '12px 16px' } }),
] : [])
```

---

## 17. Docker Compose

```yaml
networks:
  web: { name: web }
  internal: { name: internal }

services:
  traefik:
    image: traefik:v3
    restart: unless-stopped
    command:
      - "--api.dashboard=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.web.http.redirections.entryPoint.to=websecure"
      - "--entrypoints.websecure.address=:443"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--providers.docker.network=web"
      - "--certificatesresolvers.le.acme.tlschallenge=true"
      - "--certificatesresolvers.le.acme.email=${ACME_EMAIL}"
      - "--certificatesresolvers.le.acme.storage=/acme.json"
    ports: ["80:80", "443:443"]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./traefik/acme.json:/acme.json
    networks: [web]

  app:
    build: .
    restart: unless-stopped
    environment:
      - NUXT_SESSION_PASSWORD=${SESSION_PASSWORD}
      - NUXT_OAUTH_GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
      - NUXT_OAUTH_GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}
      - NUXT_OAUTH_GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
      - NUXT_OAUTH_GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
      - NUXT_S3_ENDPOINT=http://seaweedfs:8333
      - NUXT_S3_ACCESS_KEY=${S3_ACCESS_KEY}
      - NUXT_S3_SECRET_KEY=${S3_SECRET_KEY}
      - NUXT_JWT_SECRET=${JWT_SECRET}
      - NUXT_LLM_API_URL=${LLM_API_URL}
      - NUXT_LLM_API_KEY=${LLM_API_KEY}
      - NUXT_LLM_MODEL=${LLM_MODEL:-gpt-4o-mini}
      - NUXT_PUBLIC_SYNC_URL=wss://sync.${DOMAIN}
      - NUXT_PANDOC_URL=http://pandoc:8080
      - DATABASE_PATH=/data/ypad.db
    volumes:
      - app_data:/data    # SQLite database (Drizzle ORM)
    expose: ["3000"]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.app.rule=Host(`${DOMAIN}`)"
      - "traefik.http.routers.app.entrypoints=websecure"
      - "traefik.http.routers.app.tls.certresolver=le"
      - "traefik.http.services.app.loadbalancer.server.port=3000"
    depends_on: [seaweedfs]
    networks: [web, internal]

  sync:
    build: ./sync-server
    restart: unless-stopped
    environment:
      - PORT=4001
      - S3_ENDPOINT=http://seaweedfs:8333
      - S3_ACCESS_KEY=${S3_ACCESS_KEY}
      - S3_SECRET_KEY=${S3_SECRET_KEY}
      - JWT_SECRET=${JWT_SECRET}
    expose: ["4001"]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.sync.rule=Host(`sync.${DOMAIN}`)"
      - "traefik.http.routers.sync.entrypoints=websecure"
      - "traefik.http.routers.sync.tls.certresolver=le"
      - "traefik.http.services.sync.loadbalancer.server.port=4001"
    depends_on: [seaweedfs]
    networks: [web, internal]

  seaweedfs:
    image: chrislusf/seaweedfs:latest
    restart: unless-stopped
    command: >
      server -s3
      -ip=seaweedfs -ip.bind=0.0.0.0
      -dir=/data -s3.config=/etc/seaweedfs/s3.json -s3.port=8333
    volumes:
      - seaweed_data:/data
      - ./seaweedfs/s3.json:/etc/seaweedfs/s3.json:ro
    expose: ["8333"]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.s3.rule=Host(`s3.${DOMAIN}`)"
      - "traefik.http.routers.s3.entrypoints=websecure"
      - "traefik.http.routers.s3.tls.certresolver=le"
      - "traefik.http.services.s3.loadbalancer.server.port=8333"
      - "traefik.http.middlewares.s3-cors.headers.accesscontrolalloworiginlist=https://${DOMAIN}"
      - "traefik.http.middlewares.s3-cors.headers.accesscontrolallowmethods=GET,PUT,HEAD,OPTIONS"
      - "traefik.http.middlewares.s3-cors.headers.accesscontrolallowheaders=Content-Type,Content-Length"
      - "traefik.http.routers.s3.middlewares=s3-cors"
    networks: [web, internal]

volumes:
  app_data:
  seaweed_data:
```

**Nuxt app Dockerfile (lightweight — no Pandoc):**

```dockerfile
FROM oven/bun:1.3-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3-alpine
WORKDIR /app
COPY --from=builder /app/.output .output
EXPOSE 3000
CMD ["bun", "run", ".output/server/index.mjs"]
```

**Pandoc server Dockerfile:**

```dockerfile
FROM pandoc/extra:latest
RUN apk add --no-cache python3
COPY server.py /server.py
EXPOSE 8080
ENTRYPOINT []
CMD ["python3", "/server.py"]
```

The Pandoc server is a minimal Python HTTP wrapper that accepts `POST /convert?from=docx&to=gfm` with raw file body and returns converted output. It uses `pandoc/extra` which includes TeX, fonts, and all format support.

**5 containers:** Traefik + Nuxt app + Hocuspocus + Pandoc + SeaweedFS.

**DNS:** `yourdomain.com`, `sync.yourdomain.com`, `s3.yourdomain.com` → VPS IP.

### 17.2 Development Setup

```bash
# Start infrastructure (SeaweedFS + Hocuspocus + Pandoc)
docker compose -f docker-compose.dev.yml up -d

# Start Nuxt dev server
bun run dev
```

`docker-compose.dev.yml` runs only infrastructure services with ports exposed to localhost:
- **SeaweedFS** → `localhost:8333` (S3 API)
- **Hocuspocus** → `localhost:4001` (WebSocket sync, browser connects directly)
- **Pandoc** → `localhost:8080` (HTTP conversion API)

The Nuxt dev server runs on the host (not in Docker) for hot reload. Nitro's `devProxy` forwards `/_s3/*` to SeaweedFS to handle CORS for browser-direct S3 uploads. WebSocket doesn't have same-origin restrictions, so Hocuspocus connects directly without a proxy.

**Environment (`.env`):**

**Production `.env`:**

```env
DOMAIN=yourdomain.com
ACME_EMAIL=you@yourdomain.com
SESSION_PASSWORD=your-super-secure-password-with-at-least-32-characters
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
S3_ACCESS_KEY=ypad-access-key
S3_SECRET_KEY=change-me-to-something-secure
JWT_SECRET=change-me-to-something-random-64-chars
LLM_API_URL=https://api.openai.com/v1/chat/completions
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

**Dev `.env` (checked in, no secrets):**

```env
NUXT_SESSION_PASSWORD=development-session-password-at-least-32-chars
NUXT_S3_ENDPOINT=http://localhost:8333
NUXT_S3_ACCESS_KEY=ypad-access-key
NUXT_S3_SECRET_KEY=ypad-secret-key
NUXT_S3_BUCKET=ypad
NUXT_JWT_SECRET=development-jwt-secret-change-me-in-production-64chars
NUXT_PANDOC_URL=http://localhost:8080
NUXT_PUBLIC_SYNC_URL=ws://localhost:4001
```

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
│   │   │   ├── AiPanel.vue
│   │   │   ├── AiSuggestion.vue
│   │   │   ├── ProviderToggle.vue
│   │   │   └── ModelLoader.vue
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
│   │   ├── useAI.ts                     # Provider abstraction
│   │   ├── useCloudAI.ts               # Cloud AI provider
│   │   ├── useLocalAI.ts               # WebGPU Gemma (MMP)
│   │   ├── useImageUpload.ts           # useMutation-based upload
│   │   ├── useDocumentImport.ts         # Import with conflict handling
│   │   └── useMarkdownPreview.ts
│   ├── pages/
│   │   ├── index.vue                    # Landing page
│   │   ├── d/[id].vue                   # Editor page
│   │   └── w/[id].vue                   # Workspace page
│   ├── middleware/
│   │   └── auth.ts                      # Client-side auth guard
│   └── utils/
│       ├── queryKeys.ts                 # Pinia Colada key factories
│       ├── colors.ts                    # User color palette
│       ├── names.ts                     # Random name generator
│       ├── download.ts                  # Client-side .md/.html download helpers
│       └── welcomeDoc.ts               # Welcome markdown template
├── server/
│   ├── routes/
│   │   └── auth/
│   │       ├── github.get.ts           # OAuth GitHub callback
│   │       └── google.get.ts           # OAuth Google callback
│   ├── api/
│   │   ├── docs.post.ts                # Create document
│   │   ├── docs/
│   │   │   ├── [docId]/
│   │   │   │   ├── meta.get.ts         # Get doc metadata
│   │   │   │   ├── meta.put.ts         # Update title, access mode
│   │   │   │   ├── index.delete.ts     # Delete document
│   │   │   │   ├── token.get.ts        # Get Hocuspocus JWT
│   │   │   │   ├── activity.get.ts     # Get activity log
│   │   │   │   └── password.post.ts    # Set/verify/remove password
│   │   ├── upload/
│   │   │   ├── request.post.ts         # Presigned S3 PUT URL
│   │   │   └── confirm.post.ts         # Confirm upload
│   │   ├── files/
│   │   │   └── [docId]/[fileId].get.ts # 302 to presigned GET
│   │   ├── import.post.ts              # PDF/DOCX → markdown
│   │   ├── export/[docId].post.ts      # Markdown → PDF/DOCX
│   │   ├── ai/generate.post.ts         # Streaming LLM proxy
│   │   ├── workspaces.post.ts          # Create workspace
│   │   ├── workspaces/
│   │   │   ├── [wsId].get.ts           # Get workspace
│   │   │   ├── [wsId].put.ts           # Update workspace
│   │   │   └── [wsId]/docs.post.ts     # Add doc to workspace
│   │   └── user/
│   │       ├── documents.get.ts        # List user's docs
│   │       └── workspaces.get.ts       # List user's workspaces
│   ├── db/
│   │   └── schema.ts                    # Drizzle ORM schema (all tables)
│   ├── middleware/
│   │   └── auth.ts                      # Server-side auth guard
│   └── utils/
│       ├── database.ts                  # Drizzle ORM + better-sqlite3 singleton
│       ├── s3.ts                        # S3 client singleton
│       └── rateLimit.ts                 # In-memory rate limiter (password, import, export)
├── sync-server/                         # Hocuspocus (separate container)
│   ├── Dockerfile
│   ├── package.json
│   ├── bun.lock
│   └── src/
│       ├── index.ts
│       ├── persistence.ts
│       ├── auth.ts
│       └── rate-limiter.ts
├── pandoc-server/                       # Pandoc HTTP service (separate container)
│   ├── Dockerfile
│   └── server.py
├── workers/
│   └── gemma-worker.ts                  # WebGPU AI (MMP)
├── i18n/
│   └── locales/                         # i18n locale files (lazy-loaded)
│       ├── en.json
│       ├── de.json
│       ├── fr.json
│       ├── es.json
│       ├── ja.json
│       └── zh.json
├── shared/
│   └── types.ts
├── public/
│   ├── icon-192.png
│   ├── icon-512.png
│   └── favicon.ico
├── Dockerfile                           # Nuxt app (multi-stage, lightweight)
├── docker-compose.yml                   # Production (Traefik + all services)
├── docker-compose.dev.yml               # Dev (SeaweedFS + Hocuspocus + Pandoc only)
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

#### Phase 5: Mobile & Document Management (Week 6)
- [ ] Mobile floating toolbar (visualViewport API)
- [ ] Mobile bottom tab bar, sidebar as bottom sheet
- [ ] Touch-optimized CM6 extensions
- [ ] Document deletion (owner only, confirmation modal)
- [x] Document metadata updates (title, access mode) — done in Phase 4.5
- [ ] Activity logging in Hocuspocus `onStoreDocument`
- [ ] Activity feed in sidebar

#### Phase 6: AI & Polish (Week 7)
- [ ] Cloud AI proxy endpoint (streaming SSE)
- [ ] AI sidebar with Nuxt UI chat components
- [ ] Quick actions on text selection
- [ ] Ghost text suggestions (local-only until accepted)
- [ ] PWA setup via `@vite-pwa/nuxt`
- [x] Rate limiting on Nuxt server routes — done in Phase 4.5 (token, password, import, export)
- [ ] Scheduled cleanup (inactive docs, orphaned S3 objects)

**MVP ships at end of Week 7.**

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

#### Phase 9: On-Device AI (Weeks 11-12)
- [ ] WebGPU Gemma 4 E2B in Web Worker
- [ ] Model download progress UI
- [ ] Provider toggle (Cloud / On-device)
- [ ] WebGPU detection + graceful fallback

#### Phase 10: Power Features (Weeks 13-14)
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
| **Drizzle ORM + better-sqlite3** | Type-safe ORM with full TS inference from schema. `better-sqlite3` chosen over `bun:sqlite` because Nitro dev server runs on Node.js. Works in both dev (Node) and prod (Bun Docker). |
| **Bun over Node.js** | 4x faster startup, 6-35x faster installs, TypeScript without transpilation. 98% Node.js compat. |
| **Pinia Colada over raw `$fetch`** | Automatic caching, deduplication, loading/error states, cache invalidation. Eliminates boilerplate. |
| **VueUse over custom composables** | 200+ battle-tested composables auto-imported. Replaces 5+ custom files. |
| **`@nuxtjs/i18n` with lazy loading** | Locale files loaded on demand. `strategy: 'no_prefix'` keeps clean URLs. Nuxt UI has built-in i18n binding. |
| **`nuxt-codemirror` over raw CM6** | Vue-wrapped component with reactive props and lifecycle management. Y.js integration via raw extensions. |
| **Y.js CRDT over custom OT** | Proven convergence under all concurrency. No custom conflict resolution code. |
| **Hocuspocus as separate container** | Long-lived WebSocket connections with in-memory Y.Doc state shouldn't share the event loop with HTTP request handling. |
| **OAuth optional, not mandatory** | Public docs work anonymously. Login required only for ownership/management. Low friction for casual use. |
| **Read-only at 3 layers** | Hocuspocus (server), CM6 (editor), UI (visual) — defense-in-depth. |
| **AI suggestions local-only** | Ghost text not broadcast to collaborators. Accepted text syncs as normal Y.js edits. |
| **Pandoc as separate HTTP service** | Keeps Nuxt container lightweight (no TeX/fonts). Python HTTP wrapper around `pandoc/extra`. Same container for dev and prod. Nuxt calls `POST /convert` instead of `execFile`. |
| **SeaweedFS single-process** | `weed server -s3` — one container instead of four. |

---

## 21. Security

### 21.1 Authentication & Authorization

- **OAuth via `nuxt-auth-utils`** — encrypted HTTP-only session cookies, CSRF protection, no tokens in localStorage
- **Hocuspocus always requires a valid JWT** — no anonymous WebSocket bypass. Every connection must go through the Nuxt token endpoint first, which checks document access mode and sets the correct `readOnly` flag. Connecting without a token is rejected with "Authentication required".
- **JWT secret required at startup** — both the Nuxt server (`config.jwtSecret`) and the sync-server (`JWT_SECRET` env var) throw hard errors if the secret is missing. No dev-secret fallbacks exist.
- **S3 credentials required at startup** — sync-server throws if `S3_ENDPOINT`, `S3_ACCESS_KEY`, or `S3_SECRET_KEY` are not set. No hardcoded fallbacks.

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
- **Presigned URLs** — 5 min upload, 1 hour read, content-type locked

### 21.6 Other

- **Password hashing** via `nuxt-auth-utils` built-in scrypt (not argon2)
- **Password token expiry** — 2h (same as normal tokens, not 24h)
- **XSS prevention** — `html: false` in markdown-it + DOMPurify sanitization
- **SQLite WAL mode** — safe concurrent reads, single-writer
- **`.env` is in `.gitignore`** — never committed to git. OAuth secrets stay local.

---

## 22. Performance

- **Y.js update batching** — automatic transaction grouping
- **Hocuspocus debounce** — persistence writes at 2s/10s intervals
- **Bun startup** — 5-15ms cold start vs 60-120ms for Node.js
- **Pinia Colada caching** — stale-while-revalidate for API calls
- **i18n lazy loading** — locale files loaded on demand
- **Preview debouncing** — `watchDebounced` at 100ms via VueUse
- **CM6 viewport rendering** — only visible lines rendered
- **Pandoc isolation** — runs in separate container, Nuxt server not affected by heavy conversions
- **SQLite WAL mode** — non-blocking reads during writes
- **Y.js compaction** — `encodeStateAsUpdate` on each Hocuspocus store

---

## 23. S3 Key Layout

```
ypad/
├── docs/
│   └── {docId}/
│       ├── state.yjs              # Current Y.js document state
│       ├── history/               # Timestamped snapshots (MMP)
│       │   ├── 2026-04-11T10-30-00.yjs
│       │   └── 2026-04-11T10-35-00.yjs
│       └── {fileId}.{ext}         # Uploaded images/attachments
```

User data, document ownership, workspaces, and activity logs are in SQLite (via Drizzle ORM), not S3.

---

## 24. Swappable S3 Backend

```env
NUXT_S3_ENDPOINT=http://seaweedfs:8333               # Self-hosted
NUXT_S3_ENDPOINT=https://s3.pub1.infomaniak.cloud     # Infomaniak
NUXT_S3_ENDPOINT=https://s3.amazonaws.com             # AWS
NUXT_S3_ENDPOINT=https://{id}.r2.cloudflarestorage.com  # Cloudflare R2
```

No code changes. Both Hocuspocus and Nuxt server use the same S3 endpoint.

---

## 25. Architecture Evolution Summary

| Iteration | Containers | Sync | Auth | Data | Frontend hosting |
|---|---|---|---|---|---|
| Original (NATS) | 8 | Custom OT over NATS | Anonymous tokens | NATS KV | GitHub Pages |
| v2 (NATS + Y.js) | 5 | Y.js over NATS | Anonymous tokens | NATS KV | GitHub Pages |
| v3 (Hocuspocus) | 4 | Y.js via Hocuspocus | Anonymous tokens | S3 metadata | GitHub Pages |
| v4 (Hocuspocus + features) | 4 | Y.js via Hocuspocus | Creator tokens | S3 metadata | GitHub Pages |
| **Final (full-stack Nuxt)** | **5** | **Y.js via Hocuspocus** | **OAuth (GitHub/Google)** | **SQLite (Drizzle ORM) + S3** | **Nuxt SSR** |
