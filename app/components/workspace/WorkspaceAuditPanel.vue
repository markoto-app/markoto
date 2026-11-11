<script setup lang="ts">
import type { ApiResponse } from '~/utils/api/client'

// The workspace audit log: who changed what, when and from which
// (shortened) network address — members, roles, invitations, sharing,
// deletions, billing, single sign-on. Admins of a plan that includes it.
// Filter by kind and dates, page with "Show older", download as CSV or
// JSON Lines. Server: `server/api/workspaces/[wsId]/audit/`.

type AuditEvent = ApiResponse<'/api/workspaces/:wsId/audit', 'get'>['events'][number]

const props = defineProps<{ workspaceId: string }>()
const { t, te, locale } = useI18n()
const { showError } = useErrorHandler()

const events = ref<AuditEvent[]>([])
const nextBefore = ref<number | null>(null)
const retentionDays = ref<number | null>(null)
const loading = ref(false)
// `all` = no filter (the select can't use an empty value).
const kind = ref('all')
const from = ref('')
const to = ref('')
const open = ref<number | null>(null)

const kindItems = computed(() => [
  { label: t('audit.kind.all'), value: 'all' },
  { label: t('audit.kind.members'), value: 'workspace.member' },
  { label: t('audit.kind.invites'), value: 'workspace.invite' },
  { label: t('audit.kind.documents'), value: 'doc.' },
  { label: t('audit.kind.billing'), value: 'workspace.billing' },
  { label: t('audit.kind.sso'), value: 'sso.' }
])

const base = computed(() => `/api/workspaces/${encodeURIComponent(props.workspaceId)}/audit`)

// The filters shared by the list and the export link.
function query(): { action?: string, from?: string, to?: string } {
  const q: { action?: string, from?: string, to?: string } = {}
  if (kind.value !== 'all') q.action = kind.value
  // Dates are local calendar days; `to` is inclusive (up to the next midnight).
  if (from.value) q.from = new Date(`${from.value}T00:00:00`).toISOString()
  if (to.value) q.to = new Date(new Date(`${to.value}T00:00:00`).getTime() + 86_400_000).toISOString()
  return q
}

async function load(more = false): Promise<void> {
  loading.value = true
  try {
    const res = await apiFetch('/api/workspaces/:wsId/audit', {
      path: { wsId: props.workspaceId },
      query: { ...query(), ...(more && nextBefore.value ? { before: nextBefore.value } : {}) }
    })
    events.value = more ? [...events.value, ...res.events] : res.events
    nextBefore.value = res.nextBefore
    retentionDays.value = res.retentionDays
  } catch (e) {
    showError('audit.loadFailed', e)
  } finally {
    loading.value = false
  }
}

onMounted(() => load())
watch([kind, from, to], () => load())

function exportUrl(format: 'csv' | 'jsonl'): string {
  const params = new URLSearchParams(Object.entries({ ...query(), format }))
  return `${base.value}/export?${params.toString()}`
}

function actionLabel(action: string): string {
  const key = `audit.actions.${action.replace(/\./g, '_')}`
  return te(key) ? t(key) : action
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
}

function actorLabel(e: AuditEvent): string {
  if (e.actor.name) return e.actor.name
  return e.actor.id === null ? t('audit.system') : t('audit.deletedUser')
}

function detailsJson(e: AuditEvent): string {
  return JSON.stringify({ before: e.before, after: e.after, details: e.details, target: e.target }, null, 2)
}
</script>

<template>
  <section
    class="space-y-6"
    data-testid="workspace-audit-panel"
  >
    <div class="flex items-center gap-2.5">
      <UIcon
        name="i-lucide-scroll-text"
        class="text-toned size-5 shrink-0"
      />
      <h2 class="font-serif text-2xl font-normal tracking-tight">
        {{ t('audit.title') }}
      </h2>
    </div>
    <p class="text-sm text-muted max-w-2xl">
      {{ t('audit.intro') }}
      <template v-if="retentionDays">
        {{ t('audit.retention', { days: retentionDays }) }}
      </template>
    </p>

    <div class="flex items-end gap-3 flex-wrap">
      <UFormField :label="t('audit.filter')">
        <USelect
          v-model="kind"
          :items="kindItems"
          class="w-56"
          data-testid="workspace-audit-kind"
        />
      </UFormField>
      <UFormField :label="t('audit.from')">
        <UInput
          v-model="from"
          type="date"
          data-testid="workspace-audit-from"
        />
      </UFormField>
      <UFormField :label="t('audit.to')">
        <UInput
          v-model="to"
          type="date"
          data-testid="workspace-audit-to"
        />
      </UFormField>
      <div class="flex gap-2 ms-auto">
        <UButton
          :to="exportUrl('csv')"
          external
          download
          color="neutral"
          variant="outline"
          icon="i-lucide-download"
          data-testid="workspace-audit-export-csv"
        >
          CSV
        </UButton>
        <UButton
          :to="exportUrl('jsonl')"
          external
          download
          color="neutral"
          variant="ghost"
          data-testid="workspace-audit-export-jsonl"
        >
          JSON Lines
        </UButton>
      </div>
    </div>

    <div class="rounded-lg border border-default bg-default divide-y divide-default">
      <p
        v-if="!loading && events.length === 0"
        class="p-5 text-sm text-muted"
        data-testid="workspace-audit-empty"
      >
        {{ t('audit.empty') }}
      </p>
      <div
        v-for="e in events"
        :key="e.id"
        class="px-4 py-3"
        :data-testid="`workspace-audit-event-${e.id}`"
      >
        <button
          type="button"
          class="w-full flex items-baseline gap-3 flex-wrap text-left"
          :aria-expanded="open === e.id"
          @click="open = open === e.id ? null : e.id"
        >
          <span class="font-mono text-[10.5px] tracking-[0.04em] text-muted w-36 shrink-0">{{ when(e.at) }}</span>
          <span class="text-sm">{{ actionLabel(e.action) }}</span>
          <span class="text-sm text-muted">{{ actorLabel(e) }}</span>
          <span
            v-if="e.ip"
            class="font-mono text-[10.5px] text-muted ms-auto"
            :title="t('audit.ipHint')"
          >{{ e.ip }}</span>
        </button>
        <pre
          v-if="open === e.id"
          class="mt-2 text-xs font-mono bg-muted rounded p-3 overflow-x-auto"
          data-testid="workspace-audit-details"
        >{{ detailsJson(e) }}</pre>
      </div>
    </div>

    <UButton
      v-if="nextBefore"
      color="neutral"
      variant="ghost"
      :loading="loading"
      data-testid="workspace-audit-more"
      @click="load(true)"
    >
      {{ t('audit.older') }}
    </UButton>
  </section>
</template>
