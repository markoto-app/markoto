<script setup lang="ts">
// Workspace usage, admins: per person, what they own and added in
// this workspace — documents, documents shared with guests, knowledge
// files, image storage — and, in a Team / Business workspace, their AI
// spend on the shared budget this period. No activity times: this is
// usage, not monitoring. Server: `server/api/workspaces/[wsId]/usage.get.ts`.
import { formatBytes } from '~/utils/billing/usageMeter'
import type { ApiResponse } from '~/utils/api/client'

type UsageRow = ApiResponse<'/api/workspaces/:wsId/usage', 'get'>['members'][number]

const props = defineProps<{ workspaceId: string }>()
const { t, locale } = useI18n()
const { showError } = useErrorHandler()

const rows = ref<UsageRow[]>([])
const aiBudgetShared = ref(false)
const loading = ref(false)

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = await apiFetch('/api/workspaces/:wsId/usage', { path: { wsId: props.workspaceId } })
    rows.value = res.members
    aiBudgetShared.value = res.aiBudgetShared
  } catch (e) {
    showError('usage.loadFailed', e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

const members = computed(() => rows.value.filter(r => r.role !== 'guest'))
const guests = computed(() => rows.value.filter(r => r.role === 'guest'))

function usd(n: number | null): string {
  if (n === null) return '—'
  return new Intl.NumberFormat(locale.value, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n)
}

function roleLabel(role: UsageRow['role']): string {
  return t(`workspace.roles.${role}`)
}
</script>

<template>
  <section
    class="space-y-6"
    data-testid="workspace-usage-panel"
  >
    <div class="flex items-center gap-2.5">
      <UIcon
        name="i-lucide-chart-no-axes-column"
        class="text-toned size-5 shrink-0"
      />
      <h2 class="font-serif text-2xl font-normal tracking-tight">
        {{ t('usage.title') }}
      </h2>
    </div>
    <p class="text-sm text-muted max-w-2xl">
      {{ t('usage.intro') }}
    </p>

    <div class="rounded-lg border border-default bg-default overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
            <th class="px-4 py-2 font-normal">
              {{ t('usage.person') }}
            </th>
            <th class="px-4 py-2 font-normal text-right">
              {{ t('usage.documents') }}
            </th>
            <th class="px-4 py-2 font-normal text-right">
              {{ t('usage.knowledge') }}
            </th>
            <th class="px-4 py-2 font-normal text-right">
              {{ t('usage.images') }}
            </th>
            <th
              v-if="aiBudgetShared"
              class="px-4 py-2 font-normal text-right"
            >
              {{ t('usage.aiSpend') }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr
            v-for="r in members"
            :key="r.userId"
            :data-testid="`workspace-usage-row-${r.userId}`"
          >
            <td class="px-4 py-2">
              <span>{{ r.name }}</span>
              <span class="ms-2 font-mono text-[10.5px] lowercase text-muted">{{ roleLabel(r.role) }}</span>
            </td>
            <td class="px-4 py-2 text-right tabular-nums">
              {{ r.documents }}
            </td>
            <td class="px-4 py-2 text-right tabular-nums">
              {{ t('usage.files', { n: r.knowledgeFiles, size: formatBytes(r.knowledgeBytes) }, r.knowledgeFiles) }}
            </td>
            <td class="px-4 py-2 text-right tabular-nums">
              {{ formatBytes(r.imageBytes) }}
            </td>
            <td
              v-if="aiBudgetShared"
              class="px-4 py-2 text-right tabular-nums"
            >
              {{ usd(r.aiSpendUsd) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p
        v-if="!loading && members.length === 0"
        class="p-4 text-sm text-muted"
      >
        {{ t('usage.empty') }}
      </p>
    </div>

    <div
      v-if="guests.length > 0"
      class="space-y-2"
      data-testid="workspace-usage-guests"
    >
      <h3 class="font-mono text-[11px] uppercase tracking-wider text-muted">
        {{ t('usage.guestsTitle') }}
      </h3>
      <ul class="rounded-lg border border-default bg-default divide-y divide-default">
        <li
          v-for="g in guests"
          :key="g.userId"
          class="px-4 py-2 flex items-baseline gap-3 text-sm"
          :data-testid="`workspace-usage-guest-${g.userId}`"
        >
          <span class="flex-1 truncate">{{ g.name }}</span>
          <span class="font-mono text-[10.5px] text-muted">{{ t('usage.sharedDocs', { n: g.sharedDocuments }, g.sharedDocuments) }}</span>
        </li>
      </ul>
      <p class="text-xs text-muted">
        {{ t('usage.guestsHint') }}
      </p>
    </div>
  </section>
</template>
