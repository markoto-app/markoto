<script setup lang="ts">
import type { OpsStats } from '~~/shared/contracts/adminStats'

const props = defineProps<{ data: OpsStats, range: string }>()
const { t, locale } = useI18n()
const n = (v: number) => statsCount(v, locale.value)
const bytes = (v: number) => statsBytes(v, locale.value)

const statusColumns = computed(() => [
  { key: 'status', label: t('adminStats.table.status') },
  { key: 'count', label: t('adminStats.table.count'), numeric: true }
])
function statusTable(entries: Array<[string, number]>) {
  const csv = entries.map(([status, count]) => ({ status: t(`adminStats.status.${status}`), count }))
  return { csv, rows: csv.map(r => ({ status: r.status, count: n(r.count) })) }
}
const exportsTable = computed(() => statusTable(Object.entries(props.data.exports)))
const abuseTable = computed(() => statusTable([
  ['open', props.data.abuse.open],
  ['acknowledged', props.data.abuse.acknowledged],
  ['actioned', props.data.abuse.actioned],
  ['dismissed', props.data.abuse.dismissed]
]))
</script>

<template>
  <div class="space-y-8">
    <AdminSection :title="t('adminStats.section.storage')">
      <AdminStatsKpiGrid>
        <AdminStatsKpi
          :label="t('adminStats.kpi.databaseSize')"
          :value="bytes(data.storage.databaseBytes)"
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.imageBytes')"
          :value="bytes(data.storage.imageBytes)"
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.knowledgeBytes')"
          :value="bytes(data.storage.knowledgeBytes)"
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.publishedPages')"
          :value="n(data.storage.publishedPages)"
        />
      </AdminStatsKpiGrid>
    </AdminSection>
    <AdminSection :title="t('adminStats.section.queues')">
      <AdminStatsKpiGrid>
        <AdminStatsKpi
          :label="t('adminStats.kpi.abuseOpen')"
          :value="n(data.abuse.open)"
          lower-is-better
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.abuseReceived')"
          :value="n(data.abuse.received.value)"
          :kpi="data.abuse.received"
          lower-is-better
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.pendingDeletion')"
          :value="n(data.pendingDeletion)"
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.knowledgeFailed')"
          :value="n(data.knowledgeFailed)"
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.restrictedDocs')"
          :value="n(data.restrictedDocuments)"
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.openInvites')"
          :value="n(data.openInvites)"
        />
        <AdminStatsKpi
          :label="t('adminStats.kpi.pendingStripeEvents')"
          :value="n(data.pendingStripeEvents)"
        />
      </AdminStatsKpiGrid>
    </AdminSection>
    <AdminSection :title="t('adminStats.section.details')">
      <div class="grid gap-3 lg:grid-cols-2">
        <AdminStatsTable
          :title="t('adminStats.section.exports')"
          name="data-exports"
          :range="range"
          :columns="statusColumns"
          :rows="exportsTable.rows"
          :csv-rows="exportsTable.csv"
        />
        <AdminStatsTable
          :title="t('adminStats.section.abuse')"
          name="abuse-reports"
          :range="range"
          :columns="statusColumns"
          :rows="abuseTable.rows"
          :csv-rows="abuseTable.csv"
        />
      </div>
    </AdminSection>
  </div>
</template>
