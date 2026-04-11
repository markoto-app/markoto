# YPad — Implementation Plan

## Collaborative Markdown Editor with Y.js, Hocuspocus, S3 Storage, and AI Writing Assistance

A collaborative markdown editor with live sync via Y.js CRDT and Hocuspocus, S3-backed file storage via SeaweedFS, beautiful UI via Nuxt UI v4, and AI writing assistance (cloud-first with optional on-device inference via Gemma 4 on WebGPU). No login required — share a random URL and start writing together. Optional workspaces let you organize and manage documents across devices without creating an account. The SPA is deployed as a PWA to GitHub Pages; the backend runs on a single Linux VPS with Docker Compose.

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    GitHub Pages (CDN)                              │
│              Nuxt 4 SPA + PWA (client-only, static)               │
│                                                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────────┐  │
│  │CodeMirror│ │ Nuxt UI  │ │ Y.js     │ │   AI Provider       │  │
│  │  6 +     │ │   v4     │ │ WebSocket│ │ Cloud (default)     │  │
│  │  yCollab │ │          │ │ Provider │ │ Gemma WebGPU (opt)  │  │
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
     ┌────────▼───┐ ┌────▼─────┐ ┌─▼──────────────┐
     │Hocuspocus  │ │ Fastify  │ │ SeaweedFS      │
     │Y.js sync   │ │ API      │ │ (S3-compat)    │
     │server      │ │          │ │                 │
     │            │ │ • presign│ │ single-process  │
     │ • rooms    │ │ • import │ │ server mode     │
     │ • auth     │ │ • export │ │ (weed server    │
     │ • persist  │ │ • AI     │ │  -s3)           │
     │ • awareness│ │ • worksp.│ └─────────────────┘
     │ • read-only│ │ • cleanup│
     │ • rate lim.│ │ • delete │
     └────────────┘ └────┬─────┘
                         │               │
                 Pandoc runs inside       │
                 Fastify container        │
                                         │
                 Browser uploads/fetches ─┘
                 directly to/from S3
                 via presigned URLs

              Linux VPS (Docker Compose)
```

**Key design principles:**

- **Y.js CRDT for conflict-free collaboration.** Browsers maintain a local Y.Doc that merges automatically. Conflict resolution is handled entirely by Y.js — no custom OT, no hash-based conflict detection.
- **Hocuspocus is the sync server.** It handles WebSocket rooms, Y.js document persistence, awareness (cursors/presence), authentication hooks, read-only access control, and reconnection — all out of the box.
- **Fastify is a thin gatekeeper, not the sync layer.** It validates uploads and issues presigned S3 URLs, handles document import/export via Pandoc, manages workspaces, AI proxy, document deletion, and scheduled cleanup.
- **The SPA is fully static.** Deployed to GitHub Pages. No SSR, no Node.js server for the frontend. Works as a PWA with offline caching.
- **AI is cloud-first with an optional local fallback.** Cloud AI (any OpenAI-compatible API proxied through Fastify) ships first for broad compatibility. On-device Gemma 4 via WebGPU is an opt-in alternative for privacy-conscious users with compatible browsers.
- **No accounts, but optional workspaces.** A workspace is a secret URL that aggregates documents. No email, no password — just a shareable link. Losing the link means losing the workspace (but not the individual documents).

---

## 2. Technology Stack

### 2.1 Nuxt 4 (Client-Only SPA)

Nuxt 4 was released July 2025 and is now at v4.4. Key features we leverage:

- **`ssr: false`** — Pure SPA mode. `nuxt generate` produces static HTML/JS/CSS deployable to any static host.
- **`app/` directory structure** — All application code lives under `app/` (pages, components, composables, plugins, utils). Config files stay at root.
- **Improved TypeScript** — Separate TS projects for app/server/shared code. Better autocompletion.

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  ssr: false,
  modules: [
    '@nuxt/ui',
    '@vite-pwa/nuxt',
    '@nuxtjs/color-mode'
  ],
  app: {
    baseURL: '/ypad/',  // for GitHub Pages subdirectory
    head: { title: 'YPad — Collaborative Markdown' }
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
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    },
    workbox: {
      navigateFallback: '/index.html',
      runtimeCaching: [{
        urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
        handler: 'CacheFirst',
        options: { cacheName: 'cdn-cache', expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 3600 } }
      }]
    }
  }
})
```

### 2.2 Nuxt UI v4

Nuxt UI is at v4.6 (unified free library — 125+ components). Built on Reka UI + Tailwind CSS v4 + Tailwind Variants.

**Components we use:**

| Component | Purpose |
|---|---|
| `UDashboardPanel`, `USidebar` | Main app layout with collapsible sidebar |
| `UChatMessages`, `UChatMessage`, `UChatPrompt`, `UChatPalette` | AI writing assistant panel |
| `UToast` | Notifications (user joined, connection status, activity) |
| `UAvatar`, `UAvatarGroup` | Presence indicators |
| `UButton`, `UButtonGroup` | Editor toolbar |
| `UCommandPalette` | Quick actions (jump to heading, search doc) |
| `UModal`, `USlideover` | Settings, import, AI config, export options |
| `UTooltip` | Cursor labels showing collaborator names |
| `UBadge` | Connection status, user count, read-only indicator |
| `UDropdownMenu` | Context menus, export options, share options |
| `UTabs` | Switch between editor/preview/split/history view |
| `UAlert` | PDF import refinement prompt, import conflict warning |
| `UForm` | Password protection dialog |
| `UTable` | Workspace document list |

**Theming:**

```css
/* app/assets/css/main.css */
@import "tailwindcss";
@import "@nuxt/ui";

@theme {
  --color-primary-50: #eef2ff;
  --color-primary-500: #6366f1;
  --color-primary-900: #312e81;
  --font-sans: 'Inter', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}
```

### 2.3 Y.js + Hocuspocus

Y.js provides conflict-free replicated data types (CRDT) for the document model. Hocuspocus is the Y.js-native sync server that handles WebSocket connections, document persistence, awareness, and authentication.

**Why Hocuspocus over a custom sync layer:**

Hocuspocus replaces what would otherwise be custom wiring for subscriptions, update publishing, snapshot management, and awareness broadcasting. It handles persistence (multiple storage adapters), awareness (cursors, presence), authentication (hook-based), room management, and reconnection — all configured declaratively. The browser-side code reduces to a single `HocuspocusProvider` constructor.

**Core packages:**

```
# Browser
yjs                         — CRDT document model
y-codemirror.next           — CodeMirror 6 binding (includes remote cursors)
@hocuspocus/provider        — WebSocket provider for Hocuspocus
lib0                        — Y.js utility dependency

# Server
@hocuspocus/server          — Hocuspocus sync server
@aws-sdk/client-s3          — S3 storage for document persistence
```

**Browser-side — the entire sync setup:**

```typescript
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { yCollab } from 'y-codemirror.next'

const ydoc = new Y.Doc()
const provider = new HocuspocusProvider({
  url: 'wss://sync.yourdomain.com',
  name: docId,            // room name = document ID
  document: ydoc,
  token: authToken,       // optional, for password-protected or read-only docs
  onConnect: () => { /* connected */ },
  onDisconnect: () => { /* disconnected */ },
  onSynced: () => { /* initial sync complete, doc is ready */ },
})

const ytext = ydoc.getText('content')
const awareness = provider.awareness

// That's it. Persistence, sync, awareness, reconnection — all handled.
```

**How persistence works:**

Hocuspocus calls `onStoreDocument` whenever a document changes (debounced). We store the encoded Y.Doc state as a single S3 object. On room open, `onLoadDocument` fetches the object and hydrates the Y.Doc:

```typescript
// sync-server/src/persistence.ts
import * as Y from 'yjs'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, /* ... */ })

export const s3Persistence = {
  async onLoadDocument({ documentName }: { documentName: string }): Promise<Y.Doc> {
    const doc = new Y.Doc()
    try {
      const obj = await s3.send(new GetObjectCommand({
        Bucket: 'ypad', Key: `docs/${documentName}/state.yjs`
      }))
      const data = await obj.Body!.transformToByteArray()
      Y.applyUpdate(doc, new Uint8Array(data))
    } catch (e: any) {
      if (e.name !== 'NoSuchKey') throw e
      // New document, return empty doc
    }
    return doc
  },

  async onStoreDocument({ documentName, document }: { documentName: string, document: Y.Doc }) {
    const state = Y.encodeStateAsUpdate(document)
    await s3.send(new PutObjectCommand({
      Bucket: 'ypad',
      Key: `docs/${documentName}/state.yjs`,
      Body: state,
      ContentType: 'application/octet-stream'
    }))
  }
}
```

**Y.js document size management:**

Y.js CRDTs accumulate tombstones (markers for deleted content) over time. A heavily edited document can grow significantly larger than its visible text. Mitigation strategy:

1. **Periodic garbage collection via `Y.encodeStateAsUpdate`.** When Hocuspocus stores a document, it encodes the full state, which implicitly compacts the internal representation. Reloading this state on room open starts with a clean structure.
2. **Document size monitoring.** Track the encoded state size in metadata on each store. If a document exceeds 5MB, show a warning in the UI. If it exceeds 8MB, trigger a server-side compaction (encode → store → reload).
3. **Size alerts in the UI.** The `useDocument` composable exposes a `docSize` ref updated on sync. If large, a `UAlert` warns the user.

```typescript
// In Hocuspocus onStoreDocument
async onStoreDocument({ documentName, document }) {
  const state = Y.encodeStateAsUpdate(document)
  const sizeMB = state.byteLength / (1024 * 1024)

  await s3.send(new PutObjectCommand({
    Bucket: 'ypad',
    Key: `docs/${documentName}/state.yjs`,
    Body: state,
    ContentType: 'application/octet-stream'
  }))

  // Update metadata with size info
  const meta = await getDocMeta(documentName) || {}
  meta.lastActive = Date.now()
  meta.sizeBytes = state.byteLength
  if (sizeMB > 8) meta.needsCompaction = true
  await putDocMeta(documentName, meta)
}
```

### 2.4 CodeMirror 6

**Core packages:**

```
codemirror                      — Base editor
@codemirror/lang-markdown       — Markdown language (GFM mode built-in!)
@codemirror/language-data       — Syntax highlighting for fenced code blocks
@lezer/highlight                — Highlight tag system for theming
y-codemirror.next               — Y.js binding (replaces custom collab extension)
```

**`@codemirror/lang-markdown` GFM features (built-in):**

- Tables, strikethrough, task lists, autolinks, emoji
- `pasteURLAsLink` — auto-wraps selected text as a link when pasting a URL
- `insertNewlineContinueMarkup` — continues lists/blockquotes on Enter
- `codeLanguages` — syntax highlighting inside fenced code blocks

```typescript
import { markdown } from "@codemirror/lang-markdown"
import { languages } from "@codemirror/language-data"

const mdExtension = markdown({
  codeLanguages: languages,
  // GFM is the default — no extra config needed
})
```

**Hybrid rendering — `codemirror-markdown-hybrid`:**
A community extension that renders preview for unfocused lines while keeping the active line in raw markdown (Typora-like). Evaluate stability; if not ready, build a simpler version using CodeMirror's decoration API.

**Alternative to consider: `ink-mde`:**
Complete markdown editor on CM6 with GFM, inline image previews, drag-drop uploads, formatting toolbar, and an official Vue wrapper (`ink-mde/vue`). Useful as a reference or possibly as the editor component directly.

**Custom theme:**

```typescript
const ypadTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--ui-bg)",
    color: "var(--ui-text-highlighted)",
    fontFamily: "var(--font-mono)",
    fontSize: "15px"
  },
  ".cm-content": { padding: "16px 24px", caretColor: "var(--color-primary-500)" },
  ".cm-cursor": { borderLeftColor: "var(--color-primary-500)", borderLeftWidth: "2px" },
  ".cm-selectionBackground": { backgroundColor: "var(--color-primary-500/20)" },
  ".cm-gutters": { backgroundColor: "transparent", borderRight: "none" },
  ".cm-lineNumbers .cm-gutterElement": { color: "var(--ui-text-muted)", fontSize: "12px" },
}, { dark: true })

const ypadHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700", color: "var(--color-primary-400)" },
  { tag: t.heading2, fontSize: "1.4em", fontWeight: "600", color: "var(--color-primary-300)" },
  { tag: t.heading3, fontSize: "1.2em", fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.link, color: "var(--color-primary-500)", textDecoration: "underline" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", backgroundColor: "var(--ui-bg-elevated)" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--ui-text-muted)" },
  { tag: t.meta, color: "var(--ui-text-dimmed)" },
])
```

**Mobile editing:**

CodeMirror 6 on mobile requires specific attention. The default desktop experience has known issues with virtual keyboards, toolbar discoverability, and touch-based text selection. Our mobile strategy:

1. **Detect mobile viewport** (`useMediaQuery('(max-width: 768px)')`) and apply a mobile-specific configuration.
2. **Default to edit-only view** on mobile — no split pane. A bottom tab bar toggles between Edit and Preview.
3. **Floating toolbar.** The formatting toolbar becomes a compact floating bar above the virtual keyboard, using the `visualViewport` API to stay positioned correctly when the keyboard opens/closes:

```typescript
// composables/useMobileToolbar.ts
export function useMobileToolbar() {
  const toolbarY = ref(0)
  const isMobile = useMediaQuery('(max-width: 768px)')

  onMounted(() => {
    if (!isMobile.value) return
    window.visualViewport?.addEventListener('resize', () => {
      const vv = window.visualViewport!
      toolbarY.value = vv.offsetTop + vv.height - 48  // 48px toolbar height
    })
  })

  return { toolbarY, isMobile }
}
```

4. **Larger touch targets.** Toolbar buttons get 44x44px minimum touch targets on mobile. Cursor handles for text selection are enlarged.
5. **Swipe to preview.** A horizontal swipe gesture toggles between edit and preview modes on mobile.
6. **Sidebar as bottom sheet.** The sidebar (TOC, users, AI) becomes a swipeable bottom sheet on mobile rather than a fixed side panel.
7. **CM6 mobile extensions:**

```typescript
const mobileExtensions = isMobile.value ? [
  EditorView.contentAttributes.of({ autocapitalize: 'sentences', autocorrect: 'on' }),
  // Increase line height for easier touch interaction
  EditorView.theme({ '.cm-content': { lineHeight: '1.8', fontSize: '16px', padding: '12px 16px' } }),
] : []
```

### 2.5 AI Writing Assistance — Dual Provider Architecture

AI is implemented as a pluggable provider system. Cloud AI ships first (MVP) for broad browser compatibility and higher quality. On-device Gemma 4 is added later (MMP) as an opt-in privacy alternative.

**Provider abstraction:**

```typescript
// composables/useAI.ts
interface AIProvider {
  name: string
  label: string        // "Cloud AI (faster)" | "On-device AI (private)"
  available: boolean   // runtime check (e.g. WebGPU support)
  loading: boolean
  generate(prompt: string, context: string): AsyncGenerator<string>
}

export function useAI() {
  const provider = ref<'cloud' | 'local'>('cloud')
  const cloudProvider = useCloudAI()
  const localProvider = useLocalAI()  // MMP phase

  const activeProvider = computed(() =>
    provider.value === 'local' && localProvider.available
      ? localProvider
      : cloudProvider
  )

  return { provider, activeProvider, switchProvider: (p: 'cloud' | 'local') => { provider.value = p } }
}
```

**Cloud AI provider (MVP):**

Fastify proxies requests to any OpenAI-compatible API. The endpoint is generic — swap the upstream by changing environment variables.

```typescript
// composables/useCloudAI.ts
export function useCloudAI(): AIProvider {
  return {
    name: 'cloud', label: 'Cloud AI (faster)', available: true, loading: false,
    async *generate(prompt: string, context: string) {
      const response = await fetch(`${apiBase}/api/ai/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, context }),
      })
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        yield decoder.decode(value)
      }
    }
  }
}
```

**On-device AI provider (MMP — Phase 8):**

Gemma 4 E2B loads via `@huggingface/transformers` v4 in a Web Worker with WebGPU inference. The model is ~500MB (q4f16 quantized), cached in the browser Cache API after first download.

**Architecture:**

```
Main Thread (Vue/CodeMirror)
    ↕ postMessage
AI Web Worker (gemma-worker.ts)
    → @huggingface/transformers
    → WebGPU inference
    → Token streaming back to main thread
```

**Compatibility constraints:** WebGPU is Chrome/Edge-only for this use case as of mid-2026. Firefox has partial support but `@huggingface/transformers` WebGPU backend doesn't fully work there. Safari has known issues with compute shaders. This means on-device AI works for ~65-70% of desktop users and almost no mobile users.

**Quality constraints:** Gemma 2B can fix grammar and continue simple prose. It struggles with maintaining tone over long passages, producing structured markdown (tables, nested lists), and domain-specific knowledge. Users who've used larger models will find it noticeably weaker. This is why cloud AI is the default.

```typescript
// workers/gemma-worker.ts
import { AutoModelForCausalLM, AutoTokenizer, TextStreamer } from "@huggingface/transformers"

let model, tokenizer

self.onmessage = async (e) => {
  const { type, payload } = e.data

  if (type === 'load') {
    const modelId = "onnx-community/gemma-4-E2B-it-ONNX"
    self.postMessage({ type: 'progress', stage: 'loading-tokenizer' })
    tokenizer = await AutoTokenizer.from_pretrained(modelId)

    self.postMessage({ type: 'progress', stage: 'loading-model' })
    model = await AutoModelForCausalLM.from_pretrained(modelId, {
      dtype: { embed_tokens: "q8", decoder_model_merged: "q4" },
      device: "webgpu",
      progress_callback: (progress) => {
        self.postMessage({ type: 'progress', stage: 'downloading', ...progress })
      }
    })
    self.postMessage({ type: 'ready' })
  }

  if (type === 'generate') {
    const { prompt, context } = payload
    const messages = [
      { role: "system", content: "You are a collaborative writing assistant. Help improve, continue, or rewrite the provided markdown text. Be concise and match the document's tone." },
      { role: "user", content: `Document context:\n${context}\n\nRequest: ${prompt}` }
    ]
    const inputs = tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true, return_dict: true, tokenize: true
    })
    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      callback_function: (text) => { self.postMessage({ type: 'token', text }) }
    })
    await model.generate({ ...inputs, max_new_tokens: 512, do_sample: true, temperature: 0.7, streamer })
    self.postMessage({ type: 'done' })
  }
}
```

**AI features (both providers):**

| Feature | Description |
|---|---|
| Continue writing | Place cursor, ask AI to continue |
| Rewrite selection | Select text → "Rewrite this paragraph" |
| Summarize | Select → "Summarize this section" |
| Fix grammar | Select → "Fix grammar and improve clarity" |
| Suggest title | AI reads doc and proposes a title |
| Refine imported PDF | Restructure Pandoc PDF output into clean markdown |

**AI suggestion UX for collaboration:**

AI suggestions are **local-only** until explicitly accepted. When a user requests AI assistance, the suggestion appears as ghost text (greyed-out inline preview) only in that user's editor. Other collaborators do not see it. When the user accepts the suggestion (Tab or click), the accepted text is written to the Y.js document as a normal edit, which then syncs to all collaborators through the standard Y.js/Hocuspocus flow.

### 2.6 Preview Rendering

```typescript
import MarkdownIt from "markdown-it"
import taskLists from "markdown-it-task-lists"
import emoji from "markdown-it-emoji"
import footnote from "markdown-it-footnote"
import container from "markdown-it-container"
import hljs from "highlight.js"
import DOMPurify from "dompurify"

const md = new MarkdownIt({
  html: false,  // SECURITY: prevent XSS in shared documents
  linkify: true,
  typographer: true,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(str, { language: lang }).value
    return ''
  }
})
.use(taskLists, { enabled: true })
.use(emoji)
.use(footnote)
.use(container, 'warning')
.use(container, 'info')
.use(container, 'tip')

// Render with sanitization as defense-in-depth
function renderMarkdown(source: string): string {
  return DOMPurify.sanitize(md.render(source))
}
```

**Security note:** `html: false` prevents collaborators from injecting arbitrary HTML into the preview pane. In a collaborative editor with shared URLs and no authentication, this would otherwise be an XSS vector. DOMPurify adds defense-in-depth.

---

## 3. Sharing & Access Control

The original design only supported two modes: fully public (anyone with the link can edit) and password-protected. This section introduces a complete sharing model.

### 3.1 Access Modes

Every document has an access mode stored in its metadata:

| Mode | Behavior | URL |
|---|---|---|
| **Open edit** (default) | Anyone with the link can edit | `/d/{id}` |
| **Open view** | Anyone with the link can view, only creator can edit | `/d/{id}` (auto read-only) |
| **Link-scoped edit** | Edit link and view link are separate | `/d/{id}?token={editToken}` for edit, `/d/{id}` for view |
| **Password-protected** | Password required to edit, optional for view | `/d/{id}` → password modal |

### 3.2 Read-Only Sharing

Read-only mode is enforced at three layers for defense-in-depth:

1. **Hocuspocus layer:** The `onAuthenticate` hook returns `{ readOnly: true }` for view-only connections. Hocuspocus blocks all Y.js updates from read-only clients at the server level — even a modified client cannot write.
2. **CodeMirror layer:** The editor is configured with `EditorView.editable.of(false)` and `EditorState.readOnly.of(true)` for read-only users.
3. **UI layer:** The toolbar, formatting shortcuts, and AI writing features are hidden. A `UBadge` shows "View only" in the header. A "Request edit access" button is shown if the document supports link-scoped edit.

```typescript
// In Hocuspocus onAuthenticate
async onAuthenticate({ documentName, token, connection }) {
  const meta = await getDocMeta(documentName)

  // Password-protected documents
  if (meta?.protected) {
    if (!token) throw new Error('Authentication required')
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { docId: string; mode?: string }
    if (payload.docId !== documentName) throw new Error('Token scope mismatch')
    return { readOnly: payload.mode === 'view' }
  }

  // Link-scoped edit: token required for edit access
  if (meta?.accessMode === 'link-scoped-edit') {
    if (token) {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as { docId: string; mode: string }
      if (payload.docId === documentName && payload.mode === 'edit') return { readOnly: false }
    }
    return { readOnly: true }  // default to read-only without edit token
  }

  // Open view: everyone is read-only except creator
  if (meta?.accessMode === 'open-view') {
    if (token) {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as { docId: string; role: string }
      if (payload.role === 'creator') return { readOnly: false }
    }
    return { readOnly: true }
  }

  // Default: open edit
  return { readOnly: false }
}
```

### 3.3 Share Modal

The share modal (opened via Share button in header) shows:

```
┌─────────────────────────────────────────┐
│  Share "My Document"                     │
│                                          │
│  Access: [Anyone can edit ▾]             │
│    • Anyone can edit                     │
│    • Anyone can view                     │
│    • View + edit link                    │
│    • Password protected                  │
│                                          │
│  ─────────────────────────────────────── │
│                                          │
│  View link:                              │
│  ┌────────────────────────────┐ [Copy]   │
│  │ https://...ypad/d/abc123   │          │
│  └────────────────────────────┘          │
│                                          │
│  Edit link: (if link-scoped)             │
│  ┌────────────────────────────┐ [Copy]   │
│  │ https://...ypad/d/abc123?  │          │
│  │ token=eyJ...               │          │
│  └────────────────────────────┘          │
│                                          │
│  [QR Code]                   [Delete ⚠]  │
└─────────────────────────────────────────┘
```

### 3.4 Creator Token

When a document is created, Fastify mints a "creator token" — a long-lived JWT stored in the browser's localStorage under `ypad:creator:{docId}`. This token grants:

- Ability to change the access mode
- Ability to delete the document
- Edit access even in "open view" mode

The creator token is device-specific. If the user loses it (clears browser, switches device), they lose creator privileges. The workspace feature (section 6) provides a recovery mechanism by storing creator tokens server-side.

```typescript
// POST /api/docs/:docId/create
app.post('/api/docs/:docId/create', async (req, reply) => {
  const { docId } = req.params
  const meta = { createdAt: Date.now(), lastActive: Date.now(), accessMode: 'open-edit', protected: false }
  await putDocMeta(docId, meta)

  const creatorToken = jwt.sign(
    { docId, role: 'creator' },
    process.env.JWT_SECRET!,
    { expiresIn: '365d' }
  )
  // Also issue a delete token — a separate short token for the delete action
  const deleteToken = nanoid(32)
  meta.deleteToken = await argon2.hash(deleteToken)
  await putDocMeta(docId, meta)

  return { docId, creatorToken, deleteToken }
})
```

---

## 4. Workspaces — Document Discovery Without Accounts

### 4.1 Concept

A workspace is a secret URL that aggregates documents. It solves the "I cleared my browser and lost everything" problem without requiring user accounts.

- **No account needed.** A workspace is identified by a `workspaceId` (nanoid). The URL `/w/{workspaceId}` is the only credential.
- **Cross-device.** Open the workspace URL on any device to see all your documents.
- **Sharable.** Share the workspace URL with a team — everyone sees the same document list.
- **Optional.** Users who never visit `/w/` are unaffected. Documents work identically without a workspace.

### 4.2 Data Model

A workspace is a lightweight S3 object:

```typescript
// S3 key: workspaces/{workspaceId}/workspace.json
interface Workspace {
  id: string
  name: string               // user-editable workspace name
  createdAt: number
  documents: WorkspaceDoc[]
}

interface WorkspaceDoc {
  docId: string
  title: string              // cached from document metadata
  addedAt: number
  lastActive: number         // updated periodically
  creatorToken: string       // stored server-side for recovery
  role: 'creator' | 'editor' | 'viewer'
}
```

### 4.3 Endpoints

```
POST   /api/workspaces                        Create a new workspace
GET    /api/workspaces/:workspaceId           Get workspace with document list
PUT    /api/workspaces/:workspaceId           Update workspace name
POST   /api/workspaces/:workspaceId/docs      Add a document to workspace
DELETE /api/workspaces/:workspaceId/docs/:docId  Remove document from workspace
```

### 4.4 Workspace Page (`/w/{id}`)

```
┌──────────────────────────────────────────────┐
│  📂 My Workspace                    [+ New]   │
│                                               │
│  ┌───────────┬────────────┬──────────┬─────┐ │
│  │ Title     │ Last edit  │ By       │ 🔒  │ │
│  ├───────────┼────────────┼──────────┼─────┤ │
│  │ Meeting   │ 2 min ago  │ Alice    │     │ │
│  │ notes     │            │ +2       │     │ │
│  ├───────────┼────────────┼──────────┼─────┤ │
│  │ Project   │ Yesterday  │ You      │ 🔒  │ │
│  │ plan      │            │          │     │ │
│  ├───────────┼────────────┼──────────┼─────┤ │
│  │ Draft v3  │ 3 days ago │ Bob      │     │ │
│  └───────────┴────────────┴──────────┴─────┘ │
│                                               │
│  ─────────────────────────────────────────── │
│  📋 Workspace link: https://...ypad/w/xyz    │
│  Share this link to give others access to     │
│  this document list.                 [Copy]   │
└──────────────────────────────────────────────┘
```

Features:
- Document list with title, last active time, active users, and lock icon for protected docs
- **Activity indicator** — shows which docs have been edited recently (highlighted row) and by whom
- "New Document" button — creates doc and auto-adds to workspace
- "Import" button — imports and auto-adds to workspace
- "Add existing" — paste a document URL to add it to the workspace
- Sort by: last active, title, created date
- Documents can be removed from workspace (doesn't delete the document itself)
- Workspace name is editable

### 4.5 Integration with Document Page

When a document is accessed from a workspace, the `workspaceId` is passed as a query parameter (`/d/{docId}?ws={workspaceId}`). This enables:

- "Back to workspace" button in the editor header
- Auto-update of workspace metadata when the document is edited (title sync, last active time)
- Creator token recovery — if the localStorage creator token is missing but the workspace has it stored, it can be re-issued

### 4.6 Local Storage Fallback

For users who don't use workspaces, the recent documents list in localStorage continues to work. The landing page shows:

1. **Workspace section** (if any workspace IDs are in localStorage): clickable workspace links
2. **Recent documents** (from localStorage `ypad:recent`): last 20 documents visited on this device

---

## 5. Hocuspocus Sync Server

### 5.1 Server Implementation

```typescript
// sync-server/src/index.ts
import { Hocuspocus } from '@hocuspocus/server'
import { s3Persistence } from './persistence'
import { auth } from './auth'
import { metadata } from './metadata'
import { rateLimiter } from './rate-limiter'

const server = new Hocuspocus({
  port: parseInt(process.env.PORT || '4001'),

  // Debounce persistence writes — don't write on every keystroke
  debounce: 2000,         // wait 2s after last change
  maxDebounce: 10000,     // force write after 10s regardless

  async onLoadDocument(data) {
    return s3Persistence.onLoadDocument(data)
  },

  async onStoreDocument(data) {
    await s3Persistence.onStoreDocument(data)
    await metadata.onStoreDocument(data)
  },

  async onAuthenticate(data) {
    return auth.onAuthenticate(data)
  },

  async onConnect(data) {
    rateLimiter.onConnect(data)
    metadata.onConnect(data)
  },

  async onDisconnect(data) {
    metadata.onDisconnect(data)
  },
})

server.listen()
```

### 5.2 Rate Limiting & Abuse Prevention

Without protection, a single bad actor can exhaust VPS memory by opening unique document IDs in a loop (each creates a Y.Doc in memory and an S3 object), flood a document with garbage, or open hundreds of connections.

```typescript
// sync-server/src/rate-limiter.ts

// Track connections per IP
const connectionsPerIP = new Map<string, number>()
// Track rooms created per IP in a rolling window
const roomCreationsPerIP = new Map<string, { count: number; windowStart: number }>()
// Track total active rooms
let activeRoomCount = 0

const LIMITS = {
  maxConnectionsPerIP: 20,       // max simultaneous connections from one IP
  maxRoomCreationsPerIPPerHour: 30,  // max new rooms one IP can trigger per hour
  maxActiveRooms: 5000,          // total room limit for the server
  maxDocSizeBytes: 10 * 1024 * 1024, // 10MB max Y.Doc encoded size
}

export const rateLimiter = {
  onConnect({ connection, documentName, request }: any) {
    const ip = request.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || request.socket.remoteAddress || 'unknown'

    // Check per-IP connection limit
    const current = connectionsPerIP.get(ip) || 0
    if (current >= LIMITS.maxConnectionsPerIP) {
      throw new Error('Too many connections from this IP')
    }
    connectionsPerIP.set(ip, current + 1)

    // Track room creations (new documents)
    const now = Date.now()
    const creation = roomCreationsPerIP.get(ip) || { count: 0, windowStart: now }
    if (now - creation.windowStart > 3600_000) {
      creation.count = 0
      creation.windowStart = now
    }
    creation.count++
    if (creation.count > LIMITS.maxRoomCreationsPerIPPerHour) {
      throw new Error('Too many documents created — try again later')
    }
    roomCreationsPerIP.set(ip, creation)

    // Total room limit
    if (activeRoomCount >= LIMITS.maxActiveRooms) {
      throw new Error('Server at capacity — try again later')
    }

    // Store IP on connection for cleanup
    connection.__ip = ip
  },

  onDisconnect({ connection }: any) {
    const ip = connection.__ip
    if (ip) {
      const current = connectionsPerIP.get(ip) || 1
      if (current <= 1) connectionsPerIP.delete(ip)
      else connectionsPerIP.set(ip, current - 1)
    }
  }
}
```

Additionally, in `onStoreDocument`, check the encoded document size. If it exceeds `maxDocSizeBytes`, reject further updates and notify connected clients:

```typescript
// In persistence.ts onStoreDocument
const state = Y.encodeStateAsUpdate(document)
if (state.byteLength > LIMITS.maxDocSizeBytes) {
  console.warn(`Document ${documentName} exceeds size limit: ${state.byteLength} bytes`)
  // Store anyway but flag for compaction or admin review
}
```

### 5.3 History Snapshots (MMP)

For the history replay feature, Hocuspocus stores timestamped snapshots on a schedule:

```typescript
// sync-server/src/history.ts
const SNAPSHOT_INTERVAL = 5 * 60 * 1000  // snapshot every 5 minutes of activity

const lastSnapshotTime = new Map<string, number>()

export async function maybeStoreSnapshot(documentName: string, document: Y.Doc) {
  const now = Date.now()
  const last = lastSnapshotTime.get(documentName) || 0
  if (now - last < SNAPSHOT_INTERVAL) return

  lastSnapshotTime.set(documentName, now)
  const state = Y.encodeStateAsUpdate(document)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

  await s3.send(new PutObjectCommand({
    Bucket: 'ypad',
    Key: `docs/${documentName}/history/${timestamp}.yjs`,
    Body: state,
    ContentType: 'application/octet-stream',
    Metadata: { timestamp: now.toString() }
  }))
}
```

### 5.4 Activity Tracking

Hocuspocus tracks edit activity for the activity feed and workspace "last edited by" display. Each document stores a lightweight activity log in S3:

```typescript
// sync-server/src/metadata.ts

export const metadata = {
  async onStoreDocument({ documentName, document, context }: any) {
    const text = document.getText('content').toString()
    const meta = await getDocMeta(documentName) || {}
    meta.lastActive = Date.now()
    meta.wordCount = text.split(/\s+/).filter(Boolean).length
    meta.lineCount = text.split('\n').length

    // Track recent editors (from awareness state)
    const states = Array.from(context?.awareness?.getStates?.()?.values?.() || [])
    const editors = states
      .filter((s: any) => s.user?.name)
      .map((s: any) => s.user.name)
    if (editors.length > 0) {
      meta.lastEditedBy = editors[0]
      meta.activeEditors = editors
    }

    await putDocMeta(documentName, meta)

    // Append to activity log (capped at last 100 entries)
    await appendActivity(documentName, {
      timestamp: Date.now(),
      editors,
      wordCount: meta.wordCount,
      sizeBytes: Y.encodeStateAsUpdate(document).byteLength
    })
  },

  onConnect({ documentName }: any) { /* tracked for analytics */ },
  onDisconnect({ documentName }: any) { /* tracked for analytics */ }
}

async function appendActivity(documentName: string, entry: any) {
  const key = `docs/${documentName}/activity.json`
  let log: any[] = []
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: 'ypad', Key: key }))
    log = JSON.parse(await obj.Body!.transformToString())
  } catch { /* new log */ }

  log.push(entry)
  if (log.length > 100) log = log.slice(-100)  // keep last 100 entries

  await s3.send(new PutObjectCommand({
    Bucket: 'ypad', Key: key, Body: JSON.stringify(log), ContentType: 'application/json'
  }))
}
```

### 5.5 Sync Server Project Structure

```
sync-server/
├── Dockerfile
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # Hocuspocus server setup
    ├── persistence.ts        # S3 load/store for Y.js documents
    ├── history.ts            # Timestamped snapshot storage (MMP)
    ├── auth.ts               # Access control (password, read-only, link-scoped)
    ├── rate-limiter.ts       # Per-IP connection and room creation limits
    ├── metadata.ts           # Document metadata + activity tracking
    ├── cleanup.ts            # Scheduled cleanup of inactive docs
    └── utils/
        └── s3.ts             # Shared S3 client and helpers
```

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
EXPOSE 4001
CMD ["node", "dist/index.js"]
```

---

## 6. Fastify Backend

With Hocuspocus handling real-time sync and access control, Fastify handles: file management, document import/export, workspace management, document deletion, AI proxy, and scheduled cleanup.

### 6.1 Endpoints

```
# Document lifecycle
POST   /api/docs/:docId/create         Create document, return creator + delete tokens
DELETE /api/docs/:docId                 Delete document (requires delete token or creator token)
PUT    /api/docs/:docId/access         Change access mode (requires creator token)
GET    /api/docs/:docId/meta           Get document metadata
GET    /api/docs/:docId/activity       Get recent activity log

# File upload/download
POST   /api/upload/request             Request presigned S3 PUT URL
POST   /api/upload/confirm             Confirm upload landed in S3
GET    /api/files/:docId/:fileId       302 redirect to presigned S3 GET URL
DELETE /api/files/:docId/:fileId       Delete uploaded file

# Import/Export
POST   /api/import                     Import PDF/DOCX → convert to markdown via Pandoc
POST   /api/export/:docId              Export markdown → PDF/DOCX/HTML via Pandoc
GET    /api/export/:docId/download     Download completed export

# Authentication
POST   /api/docs/:docId/protect        Set password → store hash in S3 metadata
POST   /api/docs/:docId/verify         Verify password → return signed JWT for Hocuspocus
DELETE /api/docs/:docId/protect        Remove password protection

# Workspaces
POST   /api/workspaces                 Create a new workspace
GET    /api/workspaces/:workspaceId    Get workspace with document list (enriched with metadata)
PUT    /api/workspaces/:workspaceId    Update workspace name
POST   /api/workspaces/:workspaceId/docs     Add a document to workspace
DELETE /api/workspaces/:workspaceId/docs/:docId  Remove document from workspace

# AI
POST   /api/ai/generate                Streaming AI generation (proxied to LLM API)

# Health
GET    /api/health                      Health check
```

### 6.2 Document Creation & Deletion

```typescript
// routes/docs.ts

// Create document — issues creator token and delete token
app.post('/api/docs/:docId/create', async (req, reply) => {
  const { docId } = req.params
  const deleteToken = nanoid(32)

  const meta = {
    createdAt: Date.now(),
    lastActive: Date.now(),
    accessMode: 'open-edit',
    protected: false,
    deleteTokenHash: await argon2.hash(deleteToken)
  }
  await putDocMeta(docId, meta)

  const creatorToken = jwt.sign(
    { docId, role: 'creator' },
    process.env.JWT_SECRET!,
    { expiresIn: '365d' }
  )

  return { docId, creatorToken, deleteToken }
})

// Delete document — requires delete token OR creator token
app.delete('/api/docs/:docId', async (req, reply) => {
  const { docId } = req.params
  const { deleteToken, creatorToken } = req.body

  const meta = await getDocMeta(docId)
  if (!meta) return reply.code(404).send({ error: 'Document not found' })

  // Verify authorization
  let authorized = false
  if (deleteToken && meta.deleteTokenHash) {
    authorized = await argon2.verify(meta.deleteTokenHash, deleteToken)
  }
  if (creatorToken) {
    try {
      const payload = jwt.verify(creatorToken, process.env.JWT_SECRET!) as { docId: string; role: string }
      if (payload.docId === docId && payload.role === 'creator') authorized = true
    } catch { /* invalid token */ }
  }

  if (!authorized) return reply.code(403).send({ error: 'Not authorized' })

  // Delete all S3 objects for this document
  const objects = await listObjects(`docs/${docId}/`)
  for (const obj of objects) {
    await s3.send(new DeleteObjectCommand({ Bucket: 'ypad', Key: obj.Key }))
  }

  // Disconnect active Hocuspocus clients (via internal API or just let them 404)
  return { deleted: true }
})

// Change access mode
app.put('/api/docs/:docId/access', async (req, reply) => {
  const { docId } = req.params
  const { accessMode, creatorToken } = req.body

  // Verify creator token
  const payload = jwt.verify(creatorToken, process.env.JWT_SECRET!) as { docId: string; role: string }
  if (payload.docId !== docId || payload.role !== 'creator')
    return reply.code(403).send({ error: 'Not authorized' })

  const meta = await getDocMeta(docId) || {}
  meta.accessMode = accessMode  // 'open-edit' | 'open-view' | 'link-scoped-edit' | 'password-protected'

  // For link-scoped-edit, generate an edit token
  let editToken = null
  if (accessMode === 'link-scoped-edit') {
    editToken = jwt.sign({ docId, mode: 'edit' }, process.env.JWT_SECRET!, { expiresIn: '365d' })
  }

  await putDocMeta(docId, meta)
  return { accessMode, editToken }
})
```

### 6.3 Presigned Upload Flow

Unchanged — the browser never sends file bytes through Fastify:

```typescript
// routes/upload.ts
const ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'
])
const MAX_SIZE = 10 * 1024 * 1024

app.post('/api/upload/request', async (req, reply) => {
  const { docId, filename, contentType, size } = req.body
  if (!ALLOWED_TYPES.has(contentType)) return reply.code(415).send({ error: 'Type not allowed' })
  if (size > MAX_SIZE) return reply.code(413).send({ error: 'Max 10MB' })

  const fileId = nanoid(12)
  const ext = filename.split('.').pop() || 'bin'
  const key = `docs/${docId}/${fileId}.${ext}`

  const command = new PutObjectCommand({
    Bucket: 'ypad', Key: key, ContentType: contentType, ContentLength: size
  })
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 })

  return {
    uploadUrl,
    fileId: `${fileId}.${ext}`,
    publicUrl: `https://api.${process.env.DOMAIN}/api/files/${docId}/${fileId}.${ext}`,
    expiresIn: 300
  }
})

app.post('/api/upload/confirm', async (req, reply) => {
  const { docId, fileId } = req.body
  const key = `docs/${docId}/${fileId}`
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'ypad', Key: key }))
    if (!ALLOWED_TYPES.has(head.ContentType || '')) return reply.code(415).send({ error: 'Mismatch' })
    if ((head.ContentLength || 0) > MAX_SIZE) return reply.code(413).send({ error: 'Too large' })
  } catch { return reply.code(404).send({ error: 'Not found in storage' }) }

  const meta = await getDocMeta(docId) || {}
  meta.files = meta.files || []
  meta.files.push({ fileId, uploadedAt: Date.now() })
  await putDocMeta(docId, meta)
  return { confirmed: true }
})

app.get('/api/files/:docId/:fileId', async (req, reply) => {
  const key = `docs/${req.params.docId}/${req.params.fileId}`
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: 'ypad', Key: key }), { expiresIn: 3600 })
  return reply.redirect(302, url)
})
```

**Drag-and-drop / paste — CodeMirror extension:**

```typescript
const imageUploadExtension = EditorView.domEventHandlers({
  drop: async (event, view) => {
    const files = event.dataTransfer?.files
    if (!files?.length) return false
    event.preventDefault()
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      const url = await upload(file)
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      view.dispatch({ changes: { from: pos, insert: `![${file.name}](${url})\n` } })
    }
    return true
  },
  paste: async (event, view) => {
    const items = event.clipboardData?.items
    if (!items) return false
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue
      event.preventDefault()
      const file = item.getAsFile()
      if (!file) continue
      const url = await upload(file)
      view.dispatch(view.state.replaceSelection(`![pasted image](${url})`))
      return true
    }
    return false
  }
})
```

### 6.4 Document Import (PDF & DOCX → Markdown)

```typescript
// routes/import.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pLimit from 'p-limit'

const execFileAsync = promisify(execFile)
const pandocLimit = pLimit(2)  // max 2 concurrent conversions

async function runPandoc(args: string[], cwd?: string) {
  return pandocLimit(() =>
    execFileAsync('pandoc', args, { cwd, timeout: 60_000 })
  )
}

app.post('/api/import', async (req, reply) => {
  const data = await req.file()
  if (!data) return reply.code(400).send({ error: 'No file' })

  const buffer = await data.toBuffer()
  if (buffer.length > 50 * 1024 * 1024) return reply.code(413).send({ error: 'Max 50MB' })

  const docId = req.body?.docId || nanoid(10)
  const ext = data.filename.split('.').pop()?.toLowerCase()

  const tmpDir = join('/tmp/imports', nanoid(8))
  await mkdir(tmpDir, { recursive: true })
  const inputPath = join(tmpDir, `input.${ext}`)
  const outputPath = join(tmpDir, 'output.md')
  const mediaDir = join(tmpDir, 'media')
  await writeFile(inputPath, buffer)

  const pandocArgs = [inputPath, '-t', 'gfm', '-o', outputPath, '--wrap=none', '--standalone']
  if (ext === 'docx') pandocArgs.push('--extract-media', mediaDir)

  await runPandoc(pandocArgs, tmpDir)
  let markdown = await readFile(outputPath, 'utf-8')
  let images = []

  const mediaFiles = await readdir(mediaDir, { recursive: true }).catch(() => [])
  for (const file of mediaFiles) {
    const filePath = join(mediaDir, String(file))
    if (!(await lstat(filePath)).isFile()) continue
    const fileBuffer = await readFile(filePath)
    const fileId = `${nanoid(12)}.${String(file).split('.').pop()}`
    await s3.send(new PutObjectCommand({
      Bucket: 'ypad', Key: `docs/${docId}/${fileId}`,
      Body: fileBuffer, ContentType: mime.getType(String(file)) || 'application/octet-stream'
    }))
    const publicUrl = `https://api.${process.env.DOMAIN}/api/files/${docId}/${fileId}`
    markdown = markdown.replaceAll(String(file), publicUrl)
    images.push({ fileId, publicUrl })
  }

  await rm(tmpDir, { recursive: true })
  return { docId, markdown, images, source: ext, hint: ext === 'pdf' ? 'ai-refinement-available' : null }
})
```

**Import conflict handling:**

When importing into an existing document that already has content, the browser must handle the conflict. The import flow checks whether the Y.Text is empty before inserting:

```typescript
// composables/useDocumentImport.ts
export function useDocumentImport(docId: string, ytext: Y.Text) {
  async function importFile(file: File) {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('docId', docId)

    const result = await $fetch('/api/import', { baseURL: apiBase, method: 'POST', body: formData })
    const existingContent = ytext.toString()

    if (existingContent.trim().length > 0) {
      // Document has content — ask user what to do
      const action = await showImportConflictModal({
        existingLength: existingContent.length,
        importedLength: result.markdown.length,
        options: ['replace', 'append', 'cancel']
      })

      if (action === 'cancel') return
      if (action === 'replace') {
        ytext.delete(0, ytext.length)
        ytext.insert(0, result.markdown)
      }
      if (action === 'append') {
        ytext.insert(ytext.length, '\n\n---\n\n' + result.markdown)
      }
    } else {
      // Empty document — insert directly
      ytext.insert(0, result.markdown)
    }

    return result
  }

  return { importFile }
}
```

**Import conflict modal:**

```
┌─────────────────────────────────────────────┐
│  ⚠ This document already has content        │
│                                              │
│  Importing "report.docx" (2,450 words)       │
│  will affect existing content (890 words).    │
│                                              │
│  What would you like to do?                  │
│                                              │
│  [Replace all]  [Append to end]  [Cancel]    │
│                                              │
│  ℹ Replace is undoable with Ctrl+Z           │
└─────────────────────────────────────────────┘
```

### 6.5 Document Export (Markdown → PDF/DOCX)

```typescript
// routes/export.ts
app.post('/api/export/:docId', async (req, reply) => {
  const { markdown, format, title } = req.body
  const jobId = nanoid(8)
  const tmpDir = join('/tmp/exports', jobId)
  await mkdir(tmpDir, { recursive: true })

  const fullMd = `---\ntitle: "${title || 'Untitled'}"\ndate: "${new Date().toISOString().split('T')[0]}"\n---\n\n${markdown}`
  await writeFile(join(tmpDir, 'input.md'), fullMd)

  for (const match of markdown.matchAll(/!\[.*?\]\(https:\/\/api\..+?\/api\/files\/(.+?)\/(.+?)\)/g)) {
    const [, docId, fileId] = match
    const obj = await s3.send(new GetObjectCommand({ Bucket: 'ypad', Key: `docs/${docId}/${fileId}` }))
    await writeFile(join(tmpDir, fileId), Buffer.from(await obj.Body!.transformToByteArray()))
  }

  const args = [join(tmpDir, 'input.md'), '-o', join(tmpDir, `output.${format}`), '--standalone']
  if (format === 'pdf') args.push('--pdf-engine=xelatex', '-V', 'geometry:margin=1in', '-V', 'fontsize=12pt', '--toc', '--highlight-style=tango')
  if (format === 'docx') args.push('--reference-doc=/templates/reference.docx')

  await runPandoc(args, tmpDir)
  // Upload result to S3, return download URL
})
```

### 6.6 Password Protection

```typescript
app.post('/api/docs/:docId/protect', async (req, reply) => {
  const hash = await argon2.hash(req.body.password)
  const meta = await getDocMeta(req.params.docId) || {}
  meta.protected = true
  meta.accessMode = 'password-protected'
  meta.passwordHash = hash
  meta.protectedAt = Date.now()
  await putDocMeta(req.params.docId, meta)
  return { protected: true }
})

app.post('/api/docs/:docId/verify', async (req, reply) => {
  const meta = await getDocMeta(req.params.docId)
  if (!meta?.protected) return reply.code(404).send({ error: 'Not protected' })
  if (!await argon2.verify(meta.passwordHash, req.body.password))
    return reply.code(403).send({ error: 'Invalid' })

  const mode = req.body.mode || 'edit'  // 'edit' or 'view'
  const token = jwt.sign(
    { docId: req.params.docId, mode },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  )
  return { token, expiresIn: 3600 }
})
```

### 6.7 AI Proxy Endpoint

```typescript
// routes/ai.ts
app.post('/api/ai/generate', async (req, reply) => {
  const { prompt, context } = req.body

  const upstream = await fetch(process.env.LLM_API_URL!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.LLM_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      stream: true,
      messages: [
        { role: 'system', content: 'You are a collaborative writing assistant. Help improve, continue, or rewrite the provided markdown text. Be concise and match the document\'s tone.' },
        { role: 'user', content: `Document context:\n${context}\n\nRequest: ${prompt}` }
      ],
      max_tokens: 512,
      temperature: 0.7
    })
  })

  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for await (const chunk of upstream.body) {
    reply.raw.write(chunk)
  }
  reply.raw.end()
})
```

### 6.8 Scheduled Cleanup

A Fastify plugin runs every 6 hours:

- List all `docs/*/meta.json` in S3, delete documents inactive > 14 days (only if no workspace references them)
- Delete orphaned S3 objects (uploaded files for deleted documents)
- Delete expired export files (> 1 hour old)
- Clean up empty workspaces (no documents, inactive > 30 days)

### 6.9 API Project Structure

```
api/
├── Dockerfile
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # Fastify app, plugin registration
    ├── routes/
    │   ├── docs.ts           # Create, delete, access mode, metadata, activity
    │   ├── upload.ts         # Presigned URL request/confirm
    │   ├── files.ts          # Presigned GET redirect, delete
    │   ├── import.ts         # PDF/DOCX → markdown via Pandoc
    │   ├── export.ts         # Markdown → PDF/DOCX via Pandoc
    │   ├── auth.ts           # Password protect/verify/remove
    │   ├── workspaces.ts     # Workspace CRUD + document management
    │   ├── ai.ts             # LLM proxy endpoint
    │   └── health.ts
    ├── plugins/
    │   ├── s3.ts             # S3 client singleton
    │   ├── cleanup.ts        # Scheduled cleanup
    │   └── cors.ts           # CORS for GitHub Pages origin
    └── services/
        └── pandoc.ts         # Async pandoc execution with concurrency limit
```

**Dockerfile — Pandoc runs inside the Fastify container:**

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache pandoc texlive-xetex texlive-luatex \
    font-noto font-noto-cjk font-noto-emoji
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

---

## 7. S3 Storage with SeaweedFS

| Option | Verdict |
|---|---|
| **SeaweedFS** | **Winner for self-hosted** — single binary `weed server -s3` for dev, full S3 API, O(1) disk seek, Apache 2.0 |
| Garage | Good alternative if SeaweedFS feels heavy (Rust, lightweight, geo-distributed) |
| RustFS (MinIO fork) | Too new, wait and see |
| Infomaniak S3 | **Winner for managed** — zero maintenance, Swiss privacy, just change the S3 endpoint URL |

**Recommendation:** SeaweedFS in Docker Compose for self-hosting, running in single-process `weed server -s3` mode (one container instead of four).

**S3 key layout:**

```
ypad/
├── docs/
│   └── {docId}/
│       ├── state.yjs          # Current Y.js document state (written by Hocuspocus)
│       ├── meta.json          # Document metadata (access mode, creation time, etc.)
│       ├── activity.json      # Activity log (last 100 entries)
│       ├── history/           # Timestamped snapshots (MMP)
│       │   ├── 2026-04-11T10-30-00-000Z.yjs
│       │   └── 2026-04-11T10-35-00-000Z.yjs
│       └── {fileId}.{ext}     # Uploaded images/attachments
└── workspaces/
    └── {workspaceId}/
        └── workspace.json     # Workspace document list
```

---

## 8. Frontend Specification

### 8.1 Landing Page (`/`)

- App logo + tagline
- **"New Document"** button → creates doc via `POST /api/docs/:docId/create`, stores creator token in localStorage, navigates to `/d/{id}`
- **"Import"** button → opens import modal (PDF/DOCX upload)
- **"Open Document"** input → paste doc ID or URL
- **Workspace section** (if any workspace IDs in localStorage):
    - Clickable workspace links with document counts
    - "New Workspace" button
- **Recent documents** (from localStorage `ypad:recent`):
    - Last 20 documents visited on this device
    - Shows: title, last visited time, "last edited by X, Y minutes ago" (fetched from `/api/docs/:docId/meta` on page load)
    - Documents with creator tokens in localStorage show a ★ icon
- Dark/light mode toggle

### 8.2 Editor Page (`/d/{id}`)

```
Desktop:
┌──────────────────────────────────────────┐
│ Header: title · presence · connection    │
├────────┬─────────────────────────────────┤
│        │                                 │
│  Side  │    Main Content Area            │
│  bar   │    (view mode dependent)        │
│        │                                 │
│  TOC   │                                 │
│  Users │                                 │
│  AI    │                                 │
│        │                                 │
├────────┴─────────────────────────────────┤
│ Status bar: word count · line · version  │
└──────────────────────────────────────────┘

Mobile:
┌──────────────────────┐
│ ≡ Title    👥3  ●    │
├──────────────────────┤
│                      │
│   Full-width         │
│   editor or          │
│   preview            │
│                      │
│                      │
├──────────────────────┤
│ [B][I][H][•][🔗][📷]│ ← floating toolbar
├──────────────────────┤
│ [Edit] [Preview] [AI]│ ← bottom tab bar
└──────────────────────┘
```

**View modes** (switchable via `UTabs` or keyboard shortcuts):

| Mode | Desktop | Mobile |
|---|---|---|
| **Edit** | Full-width CodeMirror | Full-width, floating toolbar |
| **Split** | 50/50 editor + preview with synced scroll | Not available (too narrow) |
| **Preview** | Full-width rendered HTML | Full-width, swipe to switch |
| **History** | Timeline scrubber + diff viewer (MMP) | Simplified single-pane |

**Header bar:**
- Editable document title (stored in Y.js document as `ydoc.getMap('meta').set('title', ...)`)
- Presence avatars (`UAvatarGroup`)
- Connection status (`UBadge`)
- **Read-only indicator** (`UBadge` "View only" when in read-only mode)
- Share button → Share modal (see section 3.3)
- Lock button (password dialog, only visible to creator)
- Export dropdown (Download .md, Export PDF, Export DOCX)
- Import button
- **Delete button** (only visible to creator, with confirmation dialog)
- Settings
- **"Back to workspace"** link (if accessed from workspace)

**Sidebar (`USidebar`, collapsible — bottom sheet on mobile):**
- Table of contents (auto-generated from headings)
- Connected users (with "follow cursor" toggle)
- **Activity feed** — recent edits summary:

```
  Activity
  ─────────────────
  Alice edited · 2m ago
    +45 words in section 2
  Bob joined · 5m ago
  You edited · 12m ago
    Added image to section 1
  Carol left · 1h ago
```

- AI assistant (`UChatPalette` with `UChatMessages`, provider toggle)
- Document info (created, last edit, word count, **document size**)
- **Size warning** (if Y.Doc > 5MB): "This document is getting large. Performance may be affected."

**Editor toolbar (`UButtonGroup`):**

```
Desktop: [B] [I] [S] [~] | [H1] [H2] [H3] | [•] [1.] [☐] | [🔗] [📷] [</>] [```] | [📎] [---]
Mobile:  [B] [I] [H] [•] [🔗] [📷] [···]  (overflow menu for less common actions)
```

**Editor extensions:**

```typescript
const undoManager = new Y.UndoManager(ytext)

const extensions = [
  markdown({ codeLanguages: languages }),
  ypadTheme,
  syntaxHighlighting(ypadHighlight),
  keymap.of([...markdownKeymap, ...defaultKeymap]),
  EditorView.lineWrapping,
  yCollab(ytext, provider.awareness, { undoManager }),
  imageUploadExtension(docId),
  lineNumbers(), highlightActiveLine(), bracketMatching(),
  closeBrackets(), search(),
  // Read-only mode (set dynamically based on access control)
  ...(isReadOnly.value ? [
    EditorView.editable.of(false),
    EditorState.readOnly.of(true)
  ] : []),
  // Mobile-specific
  ...mobileExtensions,
]
```

**Preview pane:** Synced scrolling · Image URL resolution · Interactive task list checkboxes (disabled in read-only) · Code highlighting with copy button · KaTeX math rendering (optional).

**Status bar:** `Ln 42, Col 8 | 1,247 words | 156 lines | 3 users | Connected` (desktop) / `1,247 words · 3 users · ●` (mobile)

### 8.3 History Replay (MMP)

```
┌───────────────────────────────────────────────┐
│ ◀ ▶ ⏸  ━━━━━━━━●━━━━━━━━━━━━━━━━━  snap 47  │
│ Timeline scrubber                              │
├───────────────────┬───────────────────────────┤
│  Document at      │  Diff view (optional)     │
│  selected point   │  Shows what changed       │
└───────────────────┴───────────────────────────┘
```

- Timeline scrubber — drag to any snapshot, shows timestamp
- Playback — animate between snapshots at 1x/2x/5x/10x speed
- Diff view — optional split showing changes between snapshots
- Restore — load historical snapshot into current Y.Doc as a new update
- Export at point — download document as it was at any snapshot

### 8.4 Download & Export

**Client-side (instant):** Download .md · Download .html (standalone with embedded CSS) · Copy to clipboard

**Server-side (via Fastify + Pandoc):** Export PDF (xelatex, TOC, custom margins) · Export DOCX (custom reference template) · Export EPUB. Modal with options: title override, TOC yes/no, paper size A4/Letter.

### 8.5 Import Modal

Drop zone for PDF/DOCX. Shows conversion progress. **If document has existing content, shows conflict resolution modal** (replace all / append to end / cancel). For PDF imports, offers "Refine with AI" button.

### 8.6 Delete Confirmation

When the creator clicks Delete, a destructive confirmation modal appears:

```
┌─────────────────────────────────────────────┐
│  ⚠ Delete "My Document"?                    │
│                                              │
│  This will permanently delete the document,  │
│  all uploaded images, and all history.        │
│  This cannot be undone.                      │
│                                              │
│  3 collaborators are currently connected.    │
│                                              │
│  Type "delete" to confirm:                   │
│  ┌──────────────────────────────────┐        │
│  │                                  │        │
│  └──────────────────────────────────┘        │
│                                              │
│  [Cancel]                  [Delete forever]   │
└─────────────────────────────────────────────┘
```

---

## 9. Docker Compose

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
      - "--log.level=info"
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

  api:
    build: ./api
    restart: unless-stopped
    environment:
      - S3_ENDPOINT=http://seaweedfs:8333
      - S3_ACCESS_KEY=${S3_ACCESS_KEY}
      - S3_SECRET_KEY=${S3_SECRET_KEY}
      - S3_BUCKET=ypad
      - JWT_SECRET=${JWT_SECRET}
      - DOMAIN=${DOMAIN}
      - LLM_API_URL=${LLM_API_URL}
      - LLM_API_KEY=${LLM_API_KEY}
      - LLM_MODEL=${LLM_MODEL:-gpt-4o-mini}
    expose: ["3001"]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.api.rule=Host(`api.${DOMAIN}`)"
      - "traefik.http.routers.api.entrypoints=websecure"
      - "traefik.http.routers.api.tls.certresolver=le"
      - "traefik.http.services.api.loadbalancer.server.port=3001"
    depends_on: [seaweedfs]
    networks: [web, internal]

  seaweedfs:
    image: chrislusf/seaweedfs:latest
    restart: unless-stopped
    command: >
      server -s3
      -ip=seaweedfs
      -ip.bind=0.0.0.0
      -dir=/data
      -s3.config=/etc/seaweedfs/s3.json
      -s3.port=8333
    volumes:
      - seaweed_data:/data
      - ./seaweedfs/s3.json:/etc/seaweedfs/s3.json:ro
    expose: ["8333", "9333", "8080"]
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.s3.rule=Host(`s3.${DOMAIN}`)"
      - "traefik.http.routers.s3.entrypoints=websecure"
      - "traefik.http.routers.s3.tls.certresolver=le"
      - "traefik.http.services.s3.loadbalancer.server.port=8333"
      - "traefik.http.middlewares.s3-cors.headers.accesscontrolalloworiginlist=https://${GITHUB_PAGES_ORIGIN}"
      - "traefik.http.middlewares.s3-cors.headers.accesscontrolallowmethods=GET,PUT,HEAD,OPTIONS"
      - "traefik.http.middlewares.s3-cors.headers.accesscontrolallowheaders=Content-Type,Content-Length"
      - "traefik.http.middlewares.s3-cors.headers.accesscontrolmaxage=3600"
      - "traefik.http.routers.s3.middlewares=s3-cors"
    networks: [web, internal]

volumes:
  seaweed_data:
```

**4 containers total:** Traefik + Hocuspocus + Fastify + SeaweedFS.

**Environment (`.env`):**

```env
DOMAIN=yourdomain.com
ACME_EMAIL=you@yourdomain.com
S3_ACCESS_KEY=ypad-access-key
S3_SECRET_KEY=change-me-to-something-secure
JWT_SECRET=change-me-to-something-random-64-chars
LLM_API_URL=https://api.openai.com/v1/chat/completions
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
GITHUB_PAGES_ORIGIN=youruser.github.io
```

**DNS:** Point `sync.yourdomain.com`, `api.yourdomain.com`, and `s3.yourdomain.com` → VPS IP.

**Setup:**

```bash
mkdir -p /opt/ypad/{sync-server,api,traefik,seaweedfs,templates}
touch /opt/ypad/traefik/acme.json && chmod 600 /opt/ypad/traefik/acme.json
cd /opt/ypad && docker compose up -d
```

---

## 10. Nuxt Project Structure

```
ypad/
├── app/
│   ├── app.vue
│   ├── app.config.ts
│   ├── assets/css/main.css
│   ├── components/
│   │   ├── editor/
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
│   │   │   └── ModelLoader.vue          # MMP
│   │   ├── sharing/
│   │   │   ├── ShareModal.vue
│   │   │   ├── PasswordModal.vue
│   │   │   └── DeleteConfirmModal.vue
│   │   ├── import/
│   │   │   ├── ImportModal.vue
│   │   │   └── ImportConflictModal.vue
│   │   ├── workspace/
│   │   │   ├── WorkspaceList.vue
│   │   │   └── WorkspaceDocTable.vue
│   │   ├── history/                      # MMP
│   │   │   ├── HistoryTimeline.vue
│   │   │   └── DiffViewer.vue
│   │   └── layout/
│   │       ├── AppSidebar.vue
│   │       ├── AppHeader.vue
│   │       └── MobileBottomSheet.vue
│   ├── composables/
│   │   ├── useDocument.ts               # Y.js + HocuspocusProvider
│   │   ├── useAccessControl.ts          # Read-only state, creator checks
│   │   ├── useAI.ts                     # Provider abstraction
│   │   ├── useCloudAI.ts               # Cloud AI provider
│   │   ├── useLocalAI.ts               # WebGPU Gemma provider (MMP)
│   │   ├── useImageUpload.ts
│   │   ├── useDocumentImport.ts         # Import with conflict handling
│   │   ├── useMarkdownPreview.ts
│   │   ├── useCodemirror.ts
│   │   ├── useWorkspace.ts              # Workspace CRUD
│   │   ├── useActivity.ts              # Activity feed polling
│   │   ├── useMobileToolbar.ts         # Virtual keyboard handling
│   │   └── useMediaQuery.ts            # Responsive breakpoints
│   ├── pages/
│   │   ├── index.vue                    # Landing page
│   │   ├── d/[id].vue                   # Editor page
│   │   └── w/[id].vue                   # Workspace page
│   ├── plugins/
│   │   └── (none needed)
│   └── utils/
│       ├── colors.ts
│       ├── names.ts
│       └── sanitize.ts                  # DOMPurify wrapper
├── workers/
│   └── gemma-worker.ts                  # MMP
├── shared/
│   └── types.ts
├── public/
│   ├── icon-192.png
│   ├── icon-512.png
│   └── favicon.ico
├── nuxt.config.ts
├── package.json
└── .github/workflows/deploy.yml
```

---

## 11. Key Composable: `useDocument.ts`

```typescript
// composables/useDocument.ts
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { yCollab } from 'y-codemirror.next'

export function useDocument(docId: string, authToken?: string) {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  const ymeta = ydoc.getMap('meta')

  const status = ref<'connecting' | 'connected' | 'disconnected'>('connecting')
  const synced = ref(false)
  const userCount = ref(0)
  const isReadOnly = ref(false)
  const docSizeBytes = ref(0)

  const provider = new HocuspocusProvider({
    url: useRuntimeConfig().public.syncUrl,
    name: docId,
    document: ydoc,
    token: authToken,
    onConnect: () => { status.value = 'connected' },
    onDisconnect: () => { status.value = 'disconnected' },
    onSynced: () => {
      synced.value = true
      docSizeBytes.value = Y.encodeStateAsUpdate(ydoc).byteLength
    },
    onAuthenticationFailed: () => {
      // Could be password-required or insufficient permissions
      isReadOnly.value = true  // will be overridden by proper auth flow
    },
    onAwarenessChange: ({ states }) => { userCount.value = states.length },
  })

  // Check if connection is read-only (set by Hocuspocus onAuthenticate)
  watch(status, () => {
    if (provider.authorizedScope === 'readonly') {
      isReadOnly.value = true
    }
  })

  // Set local user awareness
  const userName = generateRandomName()
  const userColor = pickColor()
  provider.awareness.setLocalStateField('user', { name: userName, color: userColor })

  const undoManager = new Y.UndoManager(ytext)

  function getCollabExtension() {
    return yCollab(ytext, provider.awareness, { undoManager })
  }

  // Document title — synced via Y.js Map
  const title = computed({
    get: () => ymeta.get('title') as string || 'Untitled',
    set: (v: string) => { if (!isReadOnly.value) ymeta.set('title', v) }
  })

  // Track document size changes
  ydoc.on('update', () => {
    docSizeBytes.value = Y.encodeStateAsUpdate(ydoc).byteLength
  })

  const docSizeWarning = computed(() => {
    const mb = docSizeBytes.value / (1024 * 1024)
    if (mb > 8) return 'critical'
    if (mb > 5) return 'warning'
    return null
  })

  function destroy() {
    provider.destroy()
    ydoc.destroy()
  }

  return {
    ydoc, ytext, provider, awareness: provider.awareness,
    status: readonly(status), synced: readonly(synced),
    userCount: readonly(userCount), isReadOnly: readonly(isReadOnly),
    docSizeBytes: readonly(docSizeBytes), docSizeWarning,
    undoManager, title, getCollabExtension, destroy
  }
}
```

---

## 12. Deployment

### 12.1 GitHub Pages (SPA + PWA)

```yaml
# .github/workflows/deploy.yml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install
      - run: pnpm generate
        env:
          NUXT_PUBLIC_SYNC_URL: wss://sync.yourdomain.com
          NUXT_PUBLIC_API_URL: https://api.yourdomain.com
      - uses: actions/upload-pages-artifact@v3
        with: { path: .output/public }
      - uses: actions/deploy-pages@v4
        id: deployment
```

Nuxt generates a `404.html` (identical to `index.html`) enabling client-side routing for `/d/{id}` and `/w/{id}` URLs on GitHub Pages.

---

## 13. Development Phases

### MVP — Weeks 1-7

The MVP delivers a fully functional collaborative markdown editor with image support, import/export, access control (including read-only sharing), document creation/deletion, cloud AI, and mobile support.

#### Phase 1: Infrastructure (Week 1)

- [ ] Docker Compose with Traefik + Hocuspocus + SeaweedFS (single-process mode) + Fastify
- [ ] DNS setup for `sync.`, `api.`, `s3.` subdomains, verify TLS certificates
- [ ] Hocuspocus server with S3 persistence (load/store hooks)
- [ ] Hocuspocus rate limiting (per-IP connection limits, room creation limits)
- [ ] Fastify skeleton with health check, S3 client
- [ ] `POST /api/docs/:docId/create` — document creation with creator + delete tokens
- [ ] S3 bucket creation via SeaweedFS config, test presigned upload/download
- [ ] CORS setup: Traefik CORS middleware for S3, Fastify CORS for API
- [ ] Verify HocuspocusProvider connects from browser, syncs a Y.Doc, and persists to S3

#### Phase 2: Core Editor (Weeks 2-3)

- [ ] Nuxt 4 scaffold with `ssr: false`, Nuxt UI v4
- [ ] Landing page → create doc via API → store creator token → navigate to `/d/{id}`
- [ ] `useDocument` composable (HocuspocusProvider + Y.Doc + Y.Text + size tracking)
- [ ] CodeMirror 6 with `yCollab()` binding, GFM, custom theme
- [ ] Basic split view: editor + preview (markdown-it with `html: false` + DOMPurify)
- [ ] Formatting toolbar (desktop)
- [ ] Status bar (word count, line, connected users, document size)
- [ ] Recent documents list in localStorage (`ypad:recent`)

#### Phase 3: Collaboration & Sharing (Week 4)

- [ ] Awareness state: user names, colors via `provider.awareness`
- [ ] Presence bar with `UAvatarGroup`
- [ ] Connection status indicator (`UBadge`)
- [ ] User join/leave `UToast` notifications
- [ ] Document title synced via Y.js Map
- [ ] Share modal with access mode selector (open edit / open view / link-scoped edit / password-protected)
- [ ] Read-only mode enforcement (Hocuspocus `onAuthenticate` + CM6 `readOnly` + UI)
- [ ] Read-only badge in header
- [ ] Password protection flow (set/verify via Fastify, JWT for Hocuspocus auth)
- [ ] Creator token management in localStorage

#### Phase 4: Images, Import & Export (Week 5)

- [ ] Presigned URL request/confirm upload flow
- [ ] Drag-drop + paste in editor → upload → insert markdown
- [ ] Preview pane resolves image URLs via presigned GET redirect
- [ ] Import modal UI + DOCX/PDF import via Pandoc
- [ ] **Import conflict modal** (replace / append / cancel when document has content)
- [ ] Download .md and .html (client-side)
- [ ] Export PDF/DOCX via Pandoc (async, concurrency-limited)
- [ ] Export modal with options

#### Phase 5: Document Management & Mobile (Week 6)

- [ ] **Document deletion** — `DELETE /api/docs/:docId` with delete token or creator token
- [ ] Delete confirmation modal (type "delete" to confirm)
- [ ] **Mobile layout** — floating toolbar above virtual keyboard
- [ ] Mobile bottom tab bar (Edit / Preview / AI)
- [ ] Sidebar as bottom sheet on mobile
- [ ] Touch-optimized toolbar with 44px targets
- [ ] Mobile CM6 extensions (font size, line height, autocapitalize)
- [ ] Responsive status bar

#### Phase 6: AI & Polish (Week 7)

- [ ] Cloud AI proxy endpoint (`POST /api/ai/generate`)
- [ ] AI sidebar using Nuxt UI chat components
- [ ] Quick actions on text selection
- [ ] Ghost text rendering for AI suggestions (local-only until accepted)
- [ ] `@vite-pwa/nuxt` setup
- [ ] GitHub Actions CI/CD for Pages deploy
- [ ] Rate limiting on Fastify endpoints
- [ ] Scheduled cleanup job

**MVP ships at end of Week 7.**

---

### MMP (Minimum Marketable Product) — Weeks 8-14

#### Phase 7: Workspaces (Week 8)

- [ ] Workspace API endpoints (create, get, update, add/remove docs)
- [ ] Workspace page (`/w/{id}`) with document table
- [ ] "New Workspace" on landing page
- [ ] "New Document" from workspace auto-adds to workspace
- [ ] Creator token recovery from workspace
- [ ] Activity indicators on workspace doc table (last edited by, when)
- [ ] Workspace link sharing

#### Phase 8: Activity Feed & Notifications (Week 9)

- [ ] Activity tracking in Hocuspocus `onStoreDocument`
- [ ] Activity log storage in S3 (capped at 100 entries per doc)
- [ ] `GET /api/docs/:docId/activity` endpoint
- [ ] Activity feed component in sidebar
- [ ] "Last edited by X, Y ago" on landing page recent docs
- [ ] `UToast` notifications for significant events (large edits, new users)

#### Phase 9: History & Snapshots (Weeks 10-11)

- [ ] Timestamped snapshot storage in S3 via Hocuspocus hook
- [ ] `GET /api/docs/:docId/history` endpoint (list snapshots)
- [ ] History view: load any snapshot into fresh Y.Doc for rendering
- [ ] Timeline scrubber with timestamp display
- [ ] Diff view between snapshots
- [ ] Restore to historical snapshot
- [ ] Download document at any snapshot
- [ ] Playback animation (1x/2x/5x/10x speed)

#### Phase 10: On-Device AI (Weeks 12-13)

- [ ] WebGPU Gemma 4 E2B Web Worker with `@huggingface/transformers`
- [ ] Model download progress UI
- [ ] `useLocalAI` composable
- [ ] Provider toggle in AI panel
- [ ] Runtime WebGPU detection, graceful fallback messaging
- [ ] "Refine imported PDF" via on-device AI

#### Phase 11: Power Features (Week 14)

- [ ] Command palette (`UCommandPalette`)
- [ ] Table of contents sidebar
- [ ] Follow cursor feature
- [ ] QR code sharing
- [ ] Keyboard shortcuts cheat sheet
- [ ] Offline mode (read cached docs from PWA cache)
- [ ] Y.js document compaction for oversized documents

---

## 14. Technical Decisions

| Decision | Rationale |
|---|---|
| **Y.js CRDT over custom OT** | Custom OT with hash-based conflict detection breaks under concurrent edits. Y.js guarantees convergence under all concurrency scenarios. |
| **Hocuspocus over NATS JetStream** | NATS added complexity to solve a problem that Hocuspocus solves natively. Y.js is order-independent, so JetStream's ordering was redundant. |
| **S3 for everything** | Y.js state, metadata, activity logs, uploaded files, and workspaces all stored in S3. No database needed. |
| **Creator tokens over accounts** | Avoids email/password infrastructure. The workspace feature provides cross-device recovery without authentication. |
| **Read-only enforced at 3 layers** | Hocuspocus (server), CM6 (editor), UI (visual) — defense-in-depth prevents any single layer from being bypassed. |
| **Import conflict modal** | Silently replacing content when collaborators are editing is destructive and confusing. Explicit choice prevents data loss. |
| **Per-IP rate limiting on Hocuspocus** | Without it, a single actor can OOM the server by creating rooms. Connection and room limits prevent resource exhaustion. |
| **Document deletion with token** | Without accounts, deletion needs an authorization mechanism. Creator token + delete token provide two independent paths. |
| **Mobile-first toolbar** | CM6 on mobile is a known pain point. Floating toolbar, larger targets, and bottom navigation are essential, not optional. |
| **Activity log capped at 100 entries** | Prevents unbounded growth while giving meaningful recent history. Older entries are implicitly discarded. |
| **Cloud AI first, on-device second** | WebGPU is Chrome/Edge-only. Cloud AI gives immediate broad compatibility. On-device is an opt-in privacy alternative. |
| **AI suggestions local-only** | Broadcasting ghost text to collaborators who didn't request it is confusing. Accepted text syncs as normal Y.js edits. |
| **Pandoc inside Fastify container** | Eliminates sidecar complexity. Async `execFile` with `p-limit(2)` prevents blocking and OOM. |
| **SeaweedFS single-process mode** | Four containers unnecessary for single VPS. One process, less memory, simpler debugging. |
| **`html: false` + DOMPurify** | Prevents XSS in shared documents. Defense-in-depth. |
| **Namespaced localStorage** | GitHub Pages shares localStorage across `*.github.io`. `ypad:` prefix prevents collisions. |
| **Y.js size monitoring** | CRDT tombstones cause document bloat over time. Size tracking + warnings + compaction strategy prevent performance degradation. |

---

## 15. Security

- **Read-only enforcement** at Hocuspocus (server-side update rejection), CodeMirror (editor state), and UI (hidden controls) — three independent layers
- **Per-IP rate limiting** — max 20 connections, max 30 new rooms/hour per IP
- **Server capacity limits** — max 5000 active rooms, max 10MB per document
- **Upload validation** — type whitelist, 10MB limit, rate limiting (10/min)
- **Password protection** — argon2 hashed, JWT-scoped Hocuspocus access per document
- **Presigned URLs** — time-limited (5 min for upload, 1 hour for read), content-type locked
- **XSS prevention** — `html: false` in markdown-it + DOMPurify sanitization in preview
- **Document deletion** — requires creator token or delete token, destructive confirmation UI
- **Creator tokens** — long-lived JWTs stored in localStorage, recoverable via workspace
- **Workspace security** — workspace ID is the only credential; URL is the access control

---

## 16. Performance

- **Y.js update batching** — Y.js batches rapid keystrokes into single update blobs via transaction grouping
- **Hocuspocus debounce** — persistence writes debounced to 2s (max 10s), preventing excessive S3 writes
- **Awareness throttling** — HocuspocusProvider throttles awareness broadcasts internally
- **Y.js document compaction** — `Y.encodeStateAsUpdate` on each store implicitly compacts tombstones
- **Document size monitoring** — warnings at 5MB, critical at 8MB, with compaction strategy
- **Lazy AI model loading** — don't load Gemma until user opens AI panel and selects on-device provider
- **Presigned URL caching** — cache presigned GET URLs for image resolution (1 hour TTL)
- **Preview debouncing** — re-render at most every 100ms
- **CM6 viewport rendering** — only renders visible lines by default
- **WebGPU model caching** — `@huggingface/transformers` caches in browser Cache API
- **Pandoc concurrency limit** — `p-limit(2)` prevents OOM from parallel LaTeX renders
- **Async Pandoc execution** — `execFile` (async) prevents blocking the Node.js event loop
- **Activity log capping** — capped at 100 entries per document to prevent S3 object bloat

---

## 17. Swappable S3 Backend

Change one environment variable to switch storage providers:

```env
S3_ENDPOINT=http://seaweedfs:8333               # Self-hosted SeaweedFS
S3_ENDPOINT=https://s3.pub1.infomaniak.cloud     # Infomaniak
S3_ENDPOINT=https://s3.amazonaws.com             # AWS
S3_ENDPOINT=https://{id}.r2.cloudflarestorage.com  # Cloudflare R2
S3_ENDPOINT=http://garage:3900                   # Garage
```

No code changes needed. Both Hocuspocus (document persistence) and Fastify (file uploads, workspaces, exports) use the same S3 client configured from this endpoint.
