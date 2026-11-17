<script setup lang="ts">
import { DAY_MS } from '~~/shared/config/units'
import type { ApiResponse } from '~/utils/api/client'

// Operator dashboard: AI cost per feature over a date window, from
// LiteLLM_SpendLogs via /api/admin/ai-spend (admin-only; `useAdminGate`
// keeps others off the page).
//
// What this answers fast: "where is this month's AI bill going?". Each
// row is one of the canonical feature tags from
// `server/utils/litellm/featureTags.ts`; a tag missing here is a
// regression (a call site forgot to stamp metadata). "Other" catches
// anything outside the known set.

type SpendResponse = ApiResponse<'/api/admin/ai-spend', 'get'>

definePageMeta({ layout: 'admin' })

const { t, te, locale } = useI18n()
const { isAdmin } = useAdminGate()
const toast = useToast()
const { extractError } = useErrorHandler()

useHead({ title: () => `${t('admin.aiSpend.title')} · ${t('admin.title')}` })

// Default range: the last 30 days. The endpoint also defaults to 30 days
// without query parameters, so the first fetch matches the date fields.
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}
const today = new Date()
const fromDate = ref(isoDate(new Date(today.getTime() - 30 * DAY_MS)))
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
      title: t('admin.aiSpend.loadFailed'),
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    loading.value = false
  }
}

// Fetch once the admin check has passed.
onMounted(() => {
  watch(isAdmin, (admin) => {
    if (admin && data.value === null && !loading.value) void load()
  }, { immediate: true })
})

// The stats page's feature names; an unknown tag shows as it is.
function labelFor(tag: string): string {
  const key = `adminStats.feature.${tag.replace(/^feature:/, '')}`
  return te(key) ? t(key) : tag
}

const usd = (v: number) => new Intl.NumberFormat(locale.value, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v)
const count = (v: number) => statsCount(v, locale.value)
const share = (v: number) => statsPercent(v, locale.value)
</script>

<template>
  <div data-testid="admin-ai-spend-page">
    <AdminPageHeader
      :title="t('admin.aiSpend.title')"
      :intro="t('admin.aiSpend.intro')"
    />

    <form
      class="flex flex-wrap items-end gap-3 mb-6 sm:mb-8"
      @submit.prevent="load"
    >
      <label for="ai-spend-from">
        <span class="block font-mono text-[11px] uppercase tracking-wider text-muted mb-1">{{ t('admin.aiSpend.from') }}</span>
        <UInput
          id="ai-spend-from"
          v-model="fromDate"
          type="date"
          size="sm"
        />
      </label>
      <label for="ai-spend-to">
        <span class="block font-mono text-[11px] uppercase tracking-wider text-muted mb-1">{{ t('admin.aiSpend.to') }}</span>
        <UInput
          id="ai-spend-to"
          v-model="toDate"
          type="date"
          size="sm"
        />
      </label>
      <UButton
        type="submit"
        size="sm"
        icon="i-lucide-refresh-cw"
        :loading="loading"
      >
        {{ t('admin.aiSpend.refresh') }}
      </UButton>
    </form>

    <div
      v-if="data"
      class="space-y-8"
    >
      <AdminSection :title="t('admin.aiSpend.totals')">
        <AdminStatsKpiGrid>
          <AdminStatsKpi
            :label="t('adminStats.kpi.aiSpend')"
            :value="usd(data.totalSpendUsd)"
          />
          <AdminStatsKpi
            :label="t('adminStats.kpi.aiRequests')"
            :value="count(data.totalRequests)"
          />
        </AdminStatsKpiGrid>
      </AdminSection>
      <AdminSection
        :title="t('admin.aiSpend.byFeature')"
        :note="t('admin.aiSpend.otherHint')"
      >
        <div class="rounded-md bg-default p-4 overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-muted border-b border-default">
                <th class="py-2 pr-3 font-normal">
                  {{ t('adminStats.table.feature') }}
                </th>
                <th class="py-2 px-3 font-normal text-right">
                  {{ t('adminStats.table.cost') }}
                </th>
                <th class="py-2 px-3 font-normal text-right">
                  {{ t('adminStats.table.share') }}
                </th>
                <th class="py-2 px-3 font-normal text-right">
                  {{ t('adminStats.table.requests') }}
                </th>
                <th class="py-2 pl-3 font-normal text-right">
                  {{ t('admin.aiSpend.tokens') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in data.breakdown"
                :key="row.tag"
                class="border-b border-default last:border-0"
              >
                <td class="py-2 pr-3 text-default">
                  {{ labelFor(row.tag) }}
                </td>
                <td class="py-2 px-3 text-right tabular-nums">
                  {{ usd(row.spendUsd) }}
                </td>
                <td class="py-2 px-3 text-right tabular-nums text-muted">
                  {{ share(row.sharePct) }}
                </td>
                <td class="py-2 px-3 text-right tabular-nums text-muted">
                  {{ count(row.requests) }}
                </td>
                <td class="py-2 pl-3 text-right tabular-nums text-muted">
                  {{ count(row.totalTokens) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </AdminSection>
    </div>

    <div
      v-else-if="loading"
      class="text-sm text-muted"
    >
      {{ t('adminStats.loading') }}
    </div>
    <div
      v-else
      class="rounded-md bg-default px-6 py-12 text-center text-sm text-muted"
    >
      {{ t('admin.aiSpend.empty') }}
    </div>
  </div>
</template>
