<script setup lang="ts">
import type { ApiResponse } from '~/utils/api/client'
// MCP integrations management. Issue, list, and revoke Personal Access
// Tokens for external MCP clients (Claude Desktop, Cursor, ChatGPT app
// store, ad-hoc scripts). Token plaintext is shown ONCE on creation and
// never reconstructed — same pattern as GitHub PATs.
//
// Auth-gated client-side via redirect; the token endpoints are session-
// required so deep-linking without a session lands in the 401-toast
// surface.

type IssuedToken = ApiResponse<'/api/mcp/tokens', 'get'>[number]

type IssueResponse = ApiResponse<'/api/mcp/tokens', 'post'>

const router = useRouter()
const { t, locale } = useI18n()
const toast = useToast()
const { extractError } = useErrorHandler()
const { loggedIn, user } = useUserSession()
// Login starts at the first configured OAuth provider ('/' when none).
const { primaryLoginPath } = useInstanceConfig()
const config = useRuntimeConfig()

useHead({ title: () => t('settings.integrations.title') })

if (import.meta.client && !loggedIn.value) {
  globalThis.location.href = primaryLoginPath.value ?? '/'
}

function onClose(): void {
  if (globalThis.history.length > 1 && document.referrer) {
    router.back()
  } else {
    void router.push('/')
  }
}

const tokens = ref<IssuedToken[]>([])
const tokensLoading = ref(false)

async function refreshTokens(): Promise<void> {
  if (!loggedIn.value) return
  tokensLoading.value = true
  try {
    tokens.value = await apiFetch('/api/mcp/tokens')
  } catch (e) {
    toast.add({
      title: t('settings.integrations.loadFailed'),
      description: extractError(e).message,
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
    const created = await apiFetch('/api/mcp/tokens', {
      method: 'post',
      body: { name }
    })
    justIssued.value = created
    justIssuedCopied.value = false
    newName.value = ''
    await refreshTokens()
  } catch (e) {
    toast.add({
      title: t('settings.integrations.issueFailed'),
      description: extractError(e).message,
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
      title: t('settings.integrations.tokenCopied'),
      icon: 'i-lucide-check',
      color: 'neutral'
    })
  } catch {
    toast.add({
      title: t('settings.integrations.copyFailed'),
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
}

function dismissIssued(): void {
  justIssued.value = null
  justIssuedCopied.value = false
}

const revokingId = ref<string | null>(null)

async function onRevoke(tokenId: string): Promise<void> {
  if (revokingId.value !== null) return
  revokingId.value = tokenId
  try {
    await apiFetch('/api/mcp/tokens/:tokenId', { method: 'delete', path: { tokenId } })
    await refreshTokens()
    toast.add({
      title: t('settings.integrations.revoked'),
      icon: 'i-lucide-check',
      color: 'neutral'
    })
  } catch (e) {
    toast.add({
      title: t('settings.integrations.revokeFailed'),
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    revokingId.value = null
  }
}

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
      title: t('settings.integrations.snippetCopied'),
      icon: 'i-lucide-check',
      color: 'neutral'
    })
  } catch {
    toast.add({
      title: t('settings.integrations.copyFailed'),
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(locale.value, {
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
      :aria-label="t('common.close')"
      @click="onClose"
    />

    <main class="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header class="mb-10">
        <p class="font-mono text-[11px] uppercase tracking-wider text-muted mb-2">
          /settings/integrations
        </p>
        <h1 class="font-serif text-3xl sm:text-4xl font-normal tracking-tight">
          {{ t('settings.integrations.title') }}
        </h1>
        <p class="text-sm text-muted mt-2">
          {{ t('settings.integrations.intro') }}
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
              {{ t('settings.integrations.createdTitle') }}
            </p>
            <p class="text-xs text-muted mt-1">
              {{ t('settings.integrations.createdBody') }}
            </p>
          </div>
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            :aria-label="t('ai.responseDismiss')"
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
            {{ justIssuedCopied ? t('sso.copied') : t('settings.integrations.copy') }}
          </UButton>
        </div>
      </section>

      <!-- Issue new token. -->
      <section
        class="mb-10"
        data-testid="integrations-issue-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          {{ t('settings.integrations.generateTitle') }}
        </h2>
        <div class="border border-default rounded-lg px-4 py-4">
          <form
            class="flex flex-col sm:flex-row gap-3"
            @submit.prevent="onIssue"
          >
            <UInput
              v-model="newName"
              :placeholder="t('settings.integrations.namePlaceholder')"
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
              {{ t('settings.integrations.generate') }}
            </UButton>
          </form>
          <p class="text-xs text-muted mt-3">
            {{ t('settings.integrations.scopesNote') }}
          </p>
        </div>
      </section>

      <!-- Existing tokens. -->
      <section
        class="mb-10"
        data-testid="integrations-list-section"
      >
        <h2 class="font-mono text-[11px] uppercase tracking-wider text-muted mb-3">
          {{ t('settings.integrations.activeTitle') }}
        </h2>
        <div
          v-if="tokensLoading"
          class="text-sm text-muted"
        >
          <UIcon
            name="i-lucide-loader-2"
            class="size-4 animate-spin inline mr-2"
          />
          {{ t('common.loading') }}
        </div>
        <div
          v-else-if="tokens.length === 0"
          class="text-sm text-muted font-mono border border-default rounded-lg px-4 py-6 text-center"
        >
          {{ t('settings.integrations.empty') }}
        </div>
        <ul
          v-else
          class="space-y-2"
        >
          <li
            v-for="token in tokens"
            :key="token.tokenId"
            class="border border-default rounded-lg px-4 py-3 flex items-center justify-between gap-3"
            :data-testid="`token-row-${token.tokenId}`"
          >
            <div class="min-w-0 flex-1">
              <p class="font-serif text-base font-normal truncate">
                {{ token.name }}
              </p>
              <p class="text-xs text-muted font-mono mt-0.5">
                {{ t('settings.integrations.createdLastUsed', { created: fmtDate(token.createdAt), lastUsed: fmtDate(token.lastUsedAt) }) }}
              </p>
              <p class="text-[10px] text-muted font-mono mt-0.5 uppercase tracking-wider">
                {{ token.scopes.join(' · ') }}
              </p>
            </div>
            <UButton
              size="sm"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :loading="revokingId === token.tokenId"
              :disabled="revokingId !== null"
              :data-testid="`revoke-${token.tokenId}`"
              @click="onRevoke(token.tokenId)"
            >
              {{ t('settings.integrations.revoke') }}
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
          {{ t('settings.integrations.connectTitle') }}
        </h2>
        <div class="border border-default rounded-lg px-4 py-4">
          <p class="text-sm text-muted mb-3">
            <i18n-t
              keypath="settings.integrations.connectBody"
              scope="global"
            >
              <template #file>
                <code class="font-mono text-xs">claude_desktop_config.json</code>
              </template>
            </i18n-t>
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
              {{ t('settings.integrations.copy') }}
            </UButton>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>
