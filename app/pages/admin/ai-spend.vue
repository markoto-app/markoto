<script setup lang="ts">
import { DAY_MS } from '~~/shared/config/units'
import type { ApiResponse } from '~/utils/api/client'

// Operator dashboard: per-feature AI spend over a date window. Reads
// LiteLLM_SpendLogs via /api/admin/ai-spend (admin-gated server-
// side; the page also defensively redirects non-admins so the
// account-status check doesn't leak the layout to refresh).
//
// What this answers fast: "where is this month's AI bill going?".
// Each row is one of the canonical feature tags from
// `server/utils/litellm/featureTags.ts`: a tag missing here is a
// regression (a call site forgot to stamp metadata). The "other"
// row catches anything outside the known set.

type SpendResponse = ApiResponse<'/api/admin/ai-spend', 'get'>

const router = useRouter()
const { loggedIn } = useUserSession()
// Login starts at the first configured OAuth provider ('/' when none).
const { primaryLoginPath } = useInstanceConfig()
const { status: accountStatus } = useAccountStatus()
const toast = useToast()
const { extractError } = useErrorHandler()

useHead({ title: 'AI spend · Admin' })

if (import.meta.client) {
  watchEffect(() => {
    if (!loggedIn.value) {
      globalThis.location.href = primaryLoginPath.value ?? '/'
    } else if (accountStatus.value && !accountStatus.value.isAdmin) {
      void router.push('/')
    }
  })
}

// Default range: last 30 days. The endpoint also defaults to 30 days
// when query params are missing, so the empty page-mount fetch
// matches what the user sees in the date picker.
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
const today = new Date()
const thirtyAgo = new Date(today.getTime() - 30 * DAY_MS)
const fromDate = ref(isoDate(thirtyAgo))
const toDate = ref(isoDate(today))

const data = ref<SpendResponse | null>(null)
const loading = ref(false)

async function load(): Promise<void> {
  loading.value = true
  try {
    data.value = await apiFetch('/api/admin/ai-spend', {
      query: { from: fromDate.value, to: toDate.value }
    })
  } catch (e) {
    toast.add({
      title: 'Could not load AI spend',
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    loading.value = false
  }
}

// Auto-fetch once admin-gating clears.
watchEffect(() => {
  if (loggedIn.value && accountStatus.value?.isAdmin && data.value === null && !loading.value) {
    void load()
  }
})

// Friendly labels for the canonical tags. Unknown tags render as-is.
const TAG_LABELS: Record<string, string> = {
  'feature:transcribe': 'Voice transcribe (Voxtral)',
  'feature:text-loop': 'Text agentic loop (Mistral + sub-tools)',
  'feature:dictate-tick': 'Live dictation ticks (Voxtral Realtime)',
  'feature:web-search': 'Web search calls (Staan)',
  'feature:web-fetch': 'Page fetches (Jina Reader)',
  'feature:image-gen': 'Image generation (BFL FLUX)',
  'feature:embeddings': 'Knowledge embeddings (Jina)',
  'feature:design-import': 'Design from a document (vision)',
  'other': 'Other / untagged'
}
function labelFor(tag: string): string {
  return TAG_LABELS[tag] ?? tag
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-10">
    <h1 class="font-serif text-3xl font-normal tracking-tight text-default mb-2">
      AI spend
    </h1>
    <p class="text-sm text-muted mb-8">
      Per-feature LiteLLM spend over a date window, one row per call
      in the proxy's <code class="font-mono text-xs">LiteLLM_SpendLogs</code>.
      Tag drift = a missing call site; investigate before
      treating "other" as expected. Multi-axis breakdowns (per
      workspace / per user / per doc) are available via the
      <code class="font-mono text-xs">/api/admin/axis-spend</code>
      endpoint.
    </p>

    <div class="flex items-end gap-3 mb-8">
      <label
        for="ai-spend-from"
      >
        <span class="block text-xs font-mono uppercase tracking-wide text-muted mb-1">From</span>
        <input
          id="ai-spend-from"
          v-model="fromDate"
          type="date"
          class="px-3 py-1.5 border border-default bg-default rounded text-sm font-mono"
        >
      </label>
      <label
        for="ai-spend-to"
      >
        <span class="block text-xs font-mono uppercase tracking-wide text-muted mb-1">To</span>
        <input
          id="ai-spend-to"
          v-model="toDate"
          type="date"
          class="px-3 py-1.5 border border-default bg-default rounded text-sm font-mono"
        >
      </label>
      <UButton
        color="neutral"
        :loading="loading"
        @click="load"
      >
        Refresh
      </UButton>
    </div>

    <div
      v-if="data"
      class="rounded border border-default bg-default p-6"
    >
      <div class="flex items-baseline justify-between mb-6">
        <div>
          <div class="text-xs font-mono uppercase tracking-wide text-muted">
            Total spend
          </div>
          <div class="font-serif text-2xl font-normal tracking-tight text-default">
            {{ formatUsd(data.totalSpendUsd) }}
          </div>
        </div>
        <div class="text-right">
          <div class="text-xs font-mono uppercase tracking-wide text-muted">
            Requests
          </div>
          <div class="font-mono text-sm">
            {{ data.totalRequests.toLocaleString() }}
          </div>
        </div>
      </div>

      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-xs font-mono uppercase tracking-wide text-muted border-b border-default">
            <th class="py-2 pr-3">
              Feature
            </th>
            <th class="py-2 px-3 text-right">
              Spend
            </th>
            <th class="py-2 px-3 text-right">
              Share
            </th>
            <th class="py-2 px-3 text-right">
              Requests
            </th>
            <th class="py-2 pl-3 text-right">
              Tokens
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in data.breakdown"
            :key="row.tag"
            class="border-b border-default last:border-0"
          >
            <td class="py-3 pr-3 text-default">
              {{ labelFor(row.tag) }}
            </td>
            <td class="py-3 px-3 text-right font-mono">
              {{ formatUsd(row.spendUsd) }}
            </td>
            <td class="py-3 px-3 text-right font-mono text-muted">
              {{ row.sharePct.toFixed(1) }}%
            </td>
            <td class="py-3 px-3 text-right font-mono text-muted">
              {{ row.requests.toLocaleString() }}
            </td>
            <td class="py-3 pl-3 text-right font-mono text-muted">
              {{ row.totalTokens.toLocaleString() }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-else-if="loading"
      class="text-sm text-muted"
    >
      Loading…
    </div>
    <div
      v-else
      class="text-sm text-muted"
    >
      No data.
    </div>
  </div>
</template>
