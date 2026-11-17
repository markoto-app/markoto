<script setup lang="ts">
import type { ContentStats } from '~~/shared/contracts/adminStats'

const props = defineProps<{ data: ContentStats, range: string }>()
const { t, locale } = useI18n()
const n = (v: number) => statsCount(v, locale.value)
const bytes = (v: number) => statsBytes(v, locale.value)

const metricColumns = computed(() => [
  { key: 'metric', label: t('adminStats.table.metric') },
  { key: 'value', label: t('adminStats.table.value'), numeric: true }
])

type Metric = [key: string, value: number, kind?: 'bytes']
function metricTable(items: Metric[]) {
  return {
    rows: items.map(([key, v, kind]) => ({ metric: t(`adminStats.kpi.${key}`), value: kind === 'bytes' ? bytes(v) : n(v) })),
    csv: items.map(([key, v]) => ({ metric: t(`adminStats.kpi.${key}`), value: v }))
  }
}

const docs = computed(() => metricTable([
  ['documents', props.data.documents.total],
  ['ownedDocs', props.data.documents.owned],
  ['anonymousDocs', props.data.documents.anonymous],
  ['workspaceDocs', props.data.documents.inWorkspaces],
  ['words', props.data.documents.words],
  ['documentsCreated', props.data.documents.created.value],
  ['documentsEdited', props.data.documents.edited.value]
]))
const knowledge = computed(() => metricTable([
  ['knowledgeFiles', props.data.knowledge.files],
  ['knowledgeFailed', props.data.knowledge.failed],
  ['knowledgeBytes', props.data.knowledge.bytes, 'bytes'],
  ['knowledgeChunks', props.data.knowledge.chunks],
  ['knowledgeTokens', props.data.knowledge.tokens],
  ['knowledgeUploaded', props.data.knowledge.uploaded.value],
  ['images', props.data.images.files],
  ['imageBytes', props.data.images.bytes, 'bytes'],
  ['imagesUploaded', props.data.images.uploaded.value]
]))
const publishing = computed(() => metricTable([
  ['publishedPages', props.data.published.pages],
  ['indexablePages', props.data.published.indexable],
  ['customDomains', props.data.published.customDomains],
  ['verifiedDomains', props.data.published.verifiedDomains],
  ['comments', props.data.comments.total],
  ['commentsAdded', props.data.comments.added.value],
  ['savedThemes', props.data.savedThemes]
]))
const memberColumns = computed(() => [
  { key: 'members', label: t('adminStats.table.members') },
  { key: 'workspaces', label: t('adminStats.table.workspaces'), numeric: true }
])
const memberCsv = computed(() => props.data.workspaces.memberBuckets.map(b => ({ members: b.bucket, workspaces: b.workspaces })))
const memberRows = computed(() => memberCsv.value.map(r => ({ members: r.members, workspaces: n(r.workspaces) })))
</script>

<template>
  <div class="space-y-6">
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <AdminStatsKpi
        :label="t('adminStats.kpi.documents')"
        :value="n(data.documents.total)"
        :hint="`${t('adminStats.kpi.anonymousDocs')}: ${n(data.documents.anonymous)}`"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.documentsCreated')"
        :value="n(data.documents.created.value)"
        :kpi="data.documents.created"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.documentsEdited')"
        :value="n(data.documents.edited.value)"
        :kpi="data.documents.edited"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.workspaces')"
        :value="n(data.workspaces.total)"
        :hint="`${t('adminStats.kpi.guests')}: ${n(data.workspaces.guests)}`"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.workspacesCreated')"
        :value="n(data.workspaces.created.value)"
        :kpi="data.workspaces.created"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.knowledgeFiles')"
        :value="n(data.knowledge.files)"
        :hint="bytes(data.knowledge.bytes)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.knowledgeUploaded')"
        :value="n(data.knowledge.uploaded.value)"
        :kpi="data.knowledge.uploaded"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.images')"
        :value="n(data.images.files)"
        :hint="bytes(data.images.bytes)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.publishedPages')"
        :value="n(data.published.pages)"
      />
      <AdminStatsKpi
        :label="t('adminStats.kpi.commentsAdded')"
        :value="n(data.comments.added.value)"
        :kpi="data.comments.added"
      />
    </div>
    <ClientOnly>
      <div class="grid gap-3 lg:grid-cols-2">
        <AdminStatsChart
          type="bar"
          :title="t('adminStats.chart.documents')"
          :labels="data.documentSeries.map(p => statsBucketLabel(p.t, data.window.bucket, locale))"
          :datasets="[{ label: t('adminStats.chart.documents'), data: data.documentSeries.map(p => p.v) }]"
          :format-value="n"
        />
        <AdminStatsChart
          type="bar"
          :title="t('adminStats.chart.members')"
          :labels="data.workspaces.memberBuckets.map(b => b.bucket)"
          :datasets="[{ label: t('adminStats.table.workspaces'), data: data.workspaces.memberBuckets.map(b => b.workspaces) }]"
          :format-value="n"
        />
      </div>
    </ClientOnly>
    <div class="grid gap-3 lg:grid-cols-2">
      <AdminStatsTable
        :title="t('adminStats.section.documents')"
        name="documents"
        :range="range"
        :columns="metricColumns"
        :rows="docs.rows"
        :csv-rows="docs.csv"
      />
      <AdminStatsTable
        :title="t('adminStats.section.workspaces')"
        name="workspace-members"
        :range="range"
        :columns="memberColumns"
        :rows="memberRows"
        :csv-rows="memberCsv"
      />
      <AdminStatsTable
        :title="t('adminStats.section.knowledge')"
        name="knowledge-images"
        :range="range"
        :columns="metricColumns"
        :rows="knowledge.rows"
        :csv-rows="knowledge.csv"
      />
      <AdminStatsTable
        :title="t('adminStats.section.publishing')"
        name="publishing"
        :range="range"
        :columns="metricColumns"
        :rows="publishing.rows"
        :csv-rows="publishing.csv"
      />
    </div>
  </div>
</template>
