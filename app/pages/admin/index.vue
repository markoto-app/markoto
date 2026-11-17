<script setup lang="ts">
import type { OpsStats, OverviewStats } from '~~/shared/contracts/adminStats'
import { useAdminStatsQuery } from '~/queries/adminStats'
import { ADMIN_SECTIONS } from '~/utils/admin/adminSections'

// The admin hub: one card per admin page, each with the number that
// says whether it needs a look (open abuse reports, this month's AI
// cost …). The numbers come from the 30-day overview and operations
// stats, which the stats page shares through the query cache.

definePageMeta({ layout: 'admin' })

const { t, locale } = useI18n()
const { isAdmin } = useAdminGate()

useHead({ title: () => t('admin.title') })

const overviewQuery = useAdminStatsQuery('overview', '30', isAdmin)
const opsQuery = useAdminStatsQuery('ops', '30', isAdmin)
const overview = computed(() => overviewQuery.data.value as OverviewStats | undefined)
const ops = computed(() => opsQuery.data.value as OpsStats | undefined)

const n = (v: number) => statsCount(v, locale.value)

interface HubFigure { value: string, label: string, alert?: boolean }

const figures = computed<Record<string, HubFigure | null>>(() => {
  const o = overview.value
  const p = ops.value
  return {
    stats: o ? { value: n(o.users.registered), label: t('adminStats.kpi.registered') } : null,
    investor: o ? { value: statsMoney(o.revenue.combinedChf.mrr, 'chf', locale.value), label: t('adminStats.kpi.mrrTotal') } : null,
    aiSpend: o ? { value: statsMoney(o.ai.spendUsd.value, 'usd', locale.value), label: t('admin.hub.aiSpend30') } : null,
    abuseReports: p ? { value: n(p.abuse.open + p.abuse.acknowledged), label: t('admin.hub.abuseActive'), alert: p.abuse.open > 0 } : null
  }
})

const cards = computed(() => ADMIN_SECTIONS.filter(s => s.key !== 'overview').map(s => ({
  ...s,
  title: t(`admin.nav.${s.key}`),
  description: t(`admin.hub.description.${s.key}`),
  figure: figures.value[s.key] ?? null
})))
</script>

<template>
  <div data-testid="admin-hub">
    <AdminPageHeader
      :title="t('admin.hub.title')"
      :intro="t('admin.hub.intro')"
    />
    <ul class="grid gap-3 sm:grid-cols-2">
      <li
        v-for="card in cards"
        :key="card.key"
      >
        <NuxtLink
          :to="card.to"
          class="group flex h-full flex-col gap-4 rounded-md bg-default p-5 transition-colors hover:bg-elevated"
          :data-testid="`admin-hub-${card.key}`"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="font-serif text-xl font-normal tracking-tight text-default">
                {{ card.title }}
              </h2>
              <p class="mt-1 text-sm text-muted">
                {{ card.description }}
              </p>
            </div>
            <UIcon
              :name="card.icon"
              class="size-5 shrink-0 text-muted group-hover:text-default"
            />
          </div>
          <div
            v-if="card.figure"
            class="mt-auto flex items-baseline gap-2"
          >
            <span
              class="font-serif text-2xl font-normal tracking-tight tabular-nums"
              :class="card.figure.alert ? 'text-error' : 'text-default'"
            >
              {{ card.figure.value }}
            </span>
            <span class="text-xs text-muted">{{ card.figure.label }}</span>
          </div>
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
