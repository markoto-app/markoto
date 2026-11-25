<script setup lang="ts">
import type { ApiResponse } from '~/utils/api/client'

// Operator page: does Stripe bill exactly the subscriptions markoto
// tracks? From /api/admin/billing-consistency (admin-only, read-only,
// computed on request). The same check runs daily and reports to Sentry
// and the billing notification email. Ids only, no names or emails.

type ConsistencyResponse = ApiResponse<'/api/admin/billing-consistency', 'get'>

definePageMeta({ layout: 'admin' })

const { t, te, locale } = useI18n()
const { isAdmin } = useAdminGate()
const toast = useToast()
const { extractError } = useErrorHandler()

useHead({ title: () => `${t('admin.billingConsistency.title')} · ${t('admin.title')}` })

const data = ref<ConsistencyResponse | null>(null)
const loading = ref(false)

async function load(): Promise<void> {
  loading.value = true
  try {
    data.value = await apiFetch('/api/admin/billing-consistency')
  } catch (e) {
    toast.add({
      title: t('admin.billingConsistency.loadFailed'),
      description: extractError(e).message,
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  watch(isAdmin, (admin) => {
    if (admin && data.value === null && !loading.value) void load()
  }, { immediate: true })
})

const report = computed(() => data.value?.report ?? null)
const count = (v: number) => statsCount(v, locale.value)
const checkedAt = computed(() => report.value ? new Date(report.value.checkedAt).toLocaleString(locale.value) : '')

function kindLabel(kind: string): string {
  const key = `admin.billingConsistency.kind.${kind}`
  return te(key) ? t(key) : kind
}
</script>

<template>
  <div data-testid="admin-billing-consistency-page">
    <AdminPageHeader
      :title="t('admin.billingConsistency.title')"
      :intro="t('admin.billingConsistency.intro')"
    />

    <div class="mb-6 sm:mb-8">
      <UButton
        size="sm"
        icon="i-lucide-refresh-cw"
        :loading="loading"
        @click="load"
      >
        {{ t('admin.billingConsistency.refresh') }}
      </UButton>
    </div>

    <div
      v-if="data && !data.billingEnabled"
      class="rounded-md bg-default px-6 py-12 text-center text-sm text-muted"
      data-testid="billing-consistency-disabled"
    >
      {{ t('admin.billingConsistency.disabled') }}
    </div>

    <div
      v-else-if="report"
      class="space-y-8"
    >
      <AdminSection
        :title="t('admin.billingConsistency.totals')"
        :note="t('admin.billingConsistency.checkedAt', { time: checkedAt })"
      >
        <AdminStatsKpiGrid>
          <AdminStatsKpi
            :label="t('admin.billingConsistency.stripeLive')"
            :value="count(report.stripeLive)"
          />
          <AdminStatsKpi
            :label="t('admin.billingConsistency.trackedUsers')"
            :value="count(report.trackedLive.users)"
          />
          <AdminStatsKpi
            :label="t('admin.billingConsistency.trackedWorkspaces')"
            :value="count(report.trackedLive.workspaces)"
          />
          <AdminStatsKpi
            :label="t('admin.billingConsistency.mismatches')"
            :value="count(report.mismatches.length)"
          />
        </AdminStatsKpiGrid>
      </AdminSection>

      <AdminSection :title="t('admin.billingConsistency.listTitle')">
        <div
          v-if="report.mismatches.length === 0"
          class="rounded-md bg-default px-6 py-8 text-center text-sm text-muted"
          data-testid="billing-consistency-clean"
        >
          {{ t('admin.billingConsistency.none') }}
        </div>
        <div
          v-else
          class="rounded-md bg-default p-4 overflow-x-auto"
        >
          <table
            class="w-full text-sm"
            data-testid="billing-consistency-mismatches"
          >
            <thead>
              <tr class="text-left text-xs text-muted border-b border-default">
                <th class="py-2 pr-3 font-normal">
                  {{ t('admin.billingConsistency.column.kind') }}
                </th>
                <th class="py-2 px-3 font-normal">
                  {{ t('admin.billingConsistency.column.subscription') }}
                </th>
                <th class="py-2 px-3 font-normal">
                  {{ t('admin.billingConsistency.column.subject') }}
                </th>
                <th class="py-2 px-3 font-normal">
                  {{ t('admin.billingConsistency.column.stripe') }}
                </th>
                <th class="py-2 pl-3 font-normal">
                  {{ t('admin.billingConsistency.column.markoto') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(m, i) in report.mismatches"
                :key="`${m.subscriptionId}-${m.kind}-${i}`"
                class="border-b border-default last:border-0"
              >
                <td class="py-2 pr-3 text-default">
                  {{ kindLabel(m.kind) }}
                </td>
                <td class="py-2 px-3 font-mono text-xs">
                  {{ m.subscriptionId }}
                </td>
                <td class="py-2 px-3 font-mono text-xs text-muted">
                  {{ m.subject ? `${m.subject.type} ${m.subject.id}` : '-' }}
                </td>
                <td class="py-2 px-3 text-muted">
                  {{ m.stripe ?? '-' }}
                </td>
                <td class="py-2 pl-3 text-muted">
                  {{ m.markoto ?? '-' }}
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
  </div>
</template>
