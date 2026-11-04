<script setup lang="ts">
// MCP integrations management. Issue, list, and revoke Personal Access
// Tokens for external MCP clients (Claude Desktop, Cursor, ChatGPT app
// store, ad-hoc scripts). Token plaintext is shown ONCE on creation and
// never reconstructed — same pattern as GitHub PATs.
//
// Auth-gated client-side via redirect; the token endpoints are session-
// required so deep-linking without a session lands in the 401-toast
// surface.

interface IssuedToken {
  tokenId: string
  name: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

interface IssueResponse extends IssuedToken {
  token: string
}

const router = useRouter()
const toast = useToast()
const { loggedIn, user } = useUserSession()
// Login starts at the first configured OAuth provider ('/' when none).
const { primaryLoginPath } = useInstanceConfig()
const config = useRuntimeConfig()

useHead({ title: 'Integrations' })

if (import.meta.client && !loggedIn.value) {
  globalThis.location.href = primaryLoginPath.value ?? '/'
}

function onClose(): void {
  if (globalThis.history.length > 1 && document.referrer) {
    router.back()
  } else {
    router.push('/')
  }
}

const tokens = ref<IssuedToken[]>([])
const tokensLoading = ref(false)

async function refreshTokens(): Promise<void> {
  if (!loggedIn.value) return
  tokensLoading.value = true
  try {
    tokens.value = await $fetch<IssuedToken[]>('/api/mcp/tokens')
  } catch (e) {
    const err = e as { message?: string, data?: { message?: string } }
    toast.add({
      title: 'Could not load tokens',
      description: err.data?.message ?? err.message ?? 'Unknown error',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    tokensLoading.value = false
  }
}

onMounted(() => {
  void refreshTokens()
})

// ─────────── New token form ───────────
const newName = ref('')
const issuing = ref(false)

// Plaintext shown exactly once after issuance. Cleared when the user
// dismisses the inline alert. We deliberately don't persist it anywhere
// else — refreshing the page wipes it forever, mirroring GitHub PATs.
const justIssued = ref<IssueResponse | null>(null)
const justIssuedCopied = ref(false)

async function onIssue(): Promise<void> {
  if (issuing.value) return
  const name = newName.value.trim()
  if (!name) return
  issuing.value = true
  try {
    const created = await $fetch<IssueResponse>('/api/mcp/tokens', {
      method: 'POST',
      body: { name }
    })
    justIssued.value = created
    justIssuedCopied.value = false
    newName.value = ''
    await refreshTokens()
  } catch (e) {
    const err = e as { message?: string, data?: { message?: string } }
    toast.add({
      title: 'Could not issue token',
      description: err.data?.message ?? err.message ?? 'Unknown error',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    issuing.value = false
  }
}

async function copyToken(): Promise<void> {
  if (!justIssued.value) return
  try {
    await navigator.clipboard.writeText(justIssued.value.token)
    justIssuedCopied.value = true
    toast.add({
      title: 'Token copied to clipboard',
      icon: 'i-lucide-check',
      color: 'neutral'
    })
  } catch {
    toast.add({
      title: 'Could not copy — select and copy manually',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
}

function dismissIssued(): void {
  justIssued.value = null
  justIssuedCopied.value = false
}

// ─────────── Revoke ───────────
const revokingId = ref<string | null>(null)

async function onRevoke(tokenId: string): Promise<void> {
  if (revokingId.value !== null) return
  revokingId.value = tokenId
  try {
    await $fetch(`/api/mcp/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' })
    await refreshTokens()
    toast.add({
      title: 'Token revoked',
      icon: 'i-lucide-check',
      color: 'neutral'
    })
  } catch (e) {
    const err = e as { message?: string, data?: { message?: string } }
    toast.add({
      title: 'Could not revoke token',
      description: err.data?.message ?? err.message ?? 'Unknown error',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    revokingId.value = null
  }
}

// ─────────── Claude Desktop config snippet ───────────
// Uses the just-issued plaintext when available; otherwise a placeholder.
// The MCP URL is derived from the running origin so localhost users see
// `http://localhost:3000/mcp` and prod users see their domain.
const mcpUrl = computed(() => {
  if (!import.meta.client) return 'https://markoto.app/mcp'
  return `${globalThis.location.origin}/mcp`
})

const configSnippet = computed(() => {
  const plaintext = justIssued.value?.token ?? '<paste-your-token-here>'
  return JSON.stringify({
    mcpServers: {
      markoto: {
        url: mcpUrl.value,
        headers: { Authorization: `Bearer ${plaintext}` }
      }
    }
  }, null, 2)
})

async function copySnippet(): Promise<void> {
  try {
    await navigator.clipboard.writeText(configSnippet.value)
    toast.add({
      title: 'Config snippet copied',
      icon: 'i-lucide-check',
      color: 'neutral'
    })
  } catch {
    toast.add({
      title: 'Could not copy — select and copy manually',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return iso
  }
}

// Surface the litellm key id for debugging from the user object only when
// it's actually meaningful — keeps the Vue compiler from complaining about
// `config` being unused.
void config
void user
</script>

<template>
  <div class="min-h-[100dvh] bg-default text-default relative">
    <CommonHomeLink />
    <UButton
      icon="i-lucide-x"
      color="neutral"
      variant="ghost"
      size="md"
      class="absolute top-4 right-4 z-10"
      aria-label="Close"
      @click="onClose"
    />

    <main class="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header class="mb-10">
        <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
          /settings/integrations
        </p>
        <h1 class="font-serif text-3xl sm:text-4xl font-normal tracking-tight">
          Integrations
        </h1>
        <p class="text-sm text-muted mt-2">
          Personal access tokens for external MCP clients — Claude Desktop, Cursor, ChatGPT app store, or your own scripts.
        </p>
      </header>

      <!-- Just-issued banner. Plaintext is here ONCE — refresh wipes it forever. -->
      <section
        v-if="justIssued"
        class="mb-8 border border-default rounded-lg px-4 py-4 bg-elevated"
        data-testid="just-issued-banner"
      >
        <div class="flex items-start justify-between gap-3 mb-3">
          <div>
            <p class="font-serif text-base font-normal">
              Token created — copy it now
            </p>
            <p class="text-xs text-muted mt-1">
              For security, this token is shown exactly once. We can't recover it for you. If you lose it, revoke and create a new one.
            </p>
          </div>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Dismiss"
            @click="dismissIssued"
          />
        </div>

        <div class="flex items-center gap-2 mb-2">
          <code
            class="font-mono text-xs px-3 py-2 rounded bg-default border border-default flex-1 break-all select-all"
            data-testid="just-issued-plaintext"
          >{{ justIssued.token }}</code>
          <UButton
            :icon="justIssuedCopied ? 'i-lucide-check' : 'i-lucide-clipboard'"
            color="neutral"
            variant="outline"
            size="sm"
            @click="copyToken"
          >
            {{ justIssuedCopied ? 'Copied' : 'Copy' }}
          </UButton>
        </div>
      </section>

      <!-- Issue new token. -->
      <section
        class="mb-10"
        data-testid="integrations-issue-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          Generate token
        </h2>
        <div class="border border-default rounded-lg px-4 py-4">
          <form
            class="flex flex-col sm:flex-row gap-3"
            @submit.prevent="onIssue"
          >
            <UInput
              v-model="newName"
              placeholder="e.g. Claude Desktop on laptop"
              maxlength="80"
              class="flex-1"
              data-testid="new-token-name"
              :disabled="issuing"
            />
            <UButton
              type="submit"
              color="neutral"
              icon="i-lucide-key"
              :loading="issuing"
              :disabled="!newName.trim() || issuing"
              data-testid="issue-token-button"
            >
              Generate
            </UButton>
          </form>
          <p class="text-xs text-muted mt-3">
            Tokens grant the same access as your account, scoped to read, write, knowledge, and web fetch.
          </p>
        </div>
      </section>

      <!-- Existing tokens. -->
      <section
        class="mb-10"
        data-testid="integrations-list-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          Active tokens
        </h2>
        <div
          v-if="tokensLoading"
          class="text-sm text-muted"
        >
          <UIcon
            name="i-lucide-loader-2"
            class="size-4 animate-spin inline mr-2"
          />
          Loading…
        </div>
        <div
          v-else-if="tokens.length === 0"
          class="text-sm text-muted font-mono border border-default rounded-lg px-4 py-6 text-center"
        >
          No tokens yet.
        </div>
        <ul
          v-else
          class="space-y-2"
        >
          <li
            v-for="t in tokens"
            :key="t.tokenId"
            class="border border-default rounded-lg px-4 py-3 flex items-center justify-between gap-3"
            :data-testid="`token-row-${t.tokenId}`"
          >
            <div class="min-w-0 flex-1">
              <p class="font-serif text-base font-normal truncate">
                {{ t.name }}
              </p>
              <p class="text-xs text-muted font-mono mt-0.5">
                created {{ fmtDate(t.createdAt) }} · last used {{ fmtDate(t.lastUsedAt) }}
              </p>
              <p class="text-[10px] text-muted font-mono mt-0.5 uppercase tracking-wider">
                {{ t.scopes.join(' · ') }}
              </p>
            </div>
            <UButton
              size="sm"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :loading="revokingId === t.tokenId"
              :disabled="revokingId !== null"
              :data-testid="`revoke-${t.tokenId}`"
              @click="onRevoke(t.tokenId)"
            >
              Revoke
            </UButton>
          </li>
        </ul>
      </section>

      <!-- How to use. -->
      <section
        class="mb-10"
        data-testid="integrations-howto-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          Connect Claude Desktop
        </h2>
        <div class="border border-default rounded-lg px-4 py-4">
          <p class="text-sm text-muted mb-3">
            Add this block to your <code class="font-mono text-xs">claude_desktop_config.json</code>
            (Settings → Developer → Edit Config).
          </p>
          <div class="flex items-start gap-2">
            <pre
              class="font-mono text-xs px-3 py-3 rounded bg-elevated border border-default flex-1 overflow-x-auto"
              data-testid="config-snippet"
            >{{ configSnippet }}</pre>
            <UButton
              icon="i-lucide-clipboard"
              color="neutral"
              variant="outline"
              size="sm"
              @click="copySnippet"
            >
              Copy
            </UButton>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>
