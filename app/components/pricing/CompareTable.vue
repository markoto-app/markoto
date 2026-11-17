<script setup lang="ts">
import { PAID_PLAN_NAMES, isPerSeatPlan } from '~~/shared/config/pricing'
import type { FeatureField, PlanName, TiersMap } from '~~/shared/config/tiers'
import { planToPointsTotal } from '~~/shared/billing/aiPoints'

// Comparison table under the plan cards (folded away until opened): one
// row per limit or feature, one column per plan (Free, Pro, Team,
// Business). Every cell reads the resolved tier map and the configured
// prices, so TIER_* overrides show here as on the cards.
//
// Wide on purpose: on phones the table scrolls inside its own box, the
// first column stays put, and the page itself never scrolls sideways.
const props = defineProps<{
  tiers: TiersMap
  /** Monthly price per plan in `currency`. */
  prices: Record<PlanName, number>
  currency: string
  /** Paid prices are planned, not on sale (billing off + coming soon). */
  planned: boolean
}>()

const { t, locale } = useI18n()

type Cell = { kind: 'yes' } | { kind: 'no' } | { kind: 'text', text: string }
interface Row { id: string, label: string, cells: Cell[] }

const COLUMNS = ['free', ...PAID_PLAN_NAMES] as const

const columnLabels = computed(() => [t('pricing.plans.free'), 'Pro', 'Team', 'Business'])

const yes: Cell = { kind: 'yes' }
const no: Cell = { kind: 'no' }
function text(value: string): Cell {
  return { kind: 'text', text: value }
}
/** Team / Business values are per seat, shared across the workspace. */
function seatValue(plan: PlanName, value: string): string {
  return isPerSeatPlan(plan) ? t('pricing.compare.perSeat', { value }) : value
}

function num(n: number): string {
  return formatCount(n, locale.value)
}

/** A plan limit cell: `null` = no limit ("Unlimited"). */
function limitCell(limit: number | null, format: (n: number) => string): Cell {
  return text(limit === null ? t('pricing.compare.unlimited') : format(limit))
}

function each(fn: (plan: typeof COLUMNS[number]) => Cell): Cell[] {
  return COLUMNS.map(fn)
}

/** A feature switch row: a check where the plan has it. */
function featureRow(field: FeatureField, fallback: Cell = no): Row {
  return {
    id: field,
    label: t(`pricing.compare.${field}`),
    cells: each(plan => props.tiers[plan][field] ? yes : fallback)
  }
}

const rows = computed<Row[]>(() => {
  const ownKeyOnly = text(t('pricing.compare.ownKeyOnly'))
  return [
    {
      id: 'price',
      label: t('pricing.compare.price'),
      cells: [
        text(t('pricing.price.free')),
        ...PAID_PLAN_NAMES.map(plan => text(
          t(props.planned ? 'pricing.compare.pricePlanned' : 'pricing.compare.priceMonthly', {
            price: formatPrice(props.prices[plan], props.currency, locale.value)
          })
        ))
      ]
    },
    { id: 'documents', label: t('pricing.compare.documents'), cells: each(() => text(t('pricing.compare.unlimited'))) },
    { id: 'writing', label: t('pricing.compare.writing'), cells: each(() => yes) },
    { id: 'aiPoints', label: t('pricing.compare.aiPoints'), cells: each(plan => text(seatValue(plan, num(planToPointsTotal(plan, props.tiers))))) },
    { id: 'ownKey', label: t('pricing.compare.ownKey'), cells: each(() => yes) },
    { id: 'workspaces', label: t('pricing.compare.workspaces'), cells: each(plan => text(num(props.tiers[plan].workspacesOwned))) },
    { id: 'members', label: t('pricing.compare.members'), cells: each(plan => limitCell(props.tiers[plan].membersPerWorkspace, num)) },
    { id: 'knowledgeFiles', label: t('pricing.compare.knowledgeFiles'), cells: each(plan => text(seatValue(plan, num(props.tiers[plan].knowledgeFiles)))) },
    {
      id: 'knowledgeStorage',
      label: t('pricing.compare.knowledgeStorage'),
      cells: each(plan => text(seatValue(plan, formatPlanBytes(isPerSeatPlan(plan) ? props.tiers[plan].knowledgeBytesPerWorkspace : props.tiers[plan].knowledgeBytesPerUser))))
    },
    { id: 'imageStorage', label: t('pricing.compare.imageStorage'), cells: each(plan => text(seatValue(plan, formatPlanBytes(props.tiers[plan].imageBytesPerUser)))) },
    { id: 'history', label: t('pricing.compare.history'), cells: each(plan => limitCell(props.tiers[plan].historyDays, n => t('pricing.compare.days', { n: num(n) }, n))) },
    featureRow('aiStrongModel'),
    featureRow('aiImage', ownKeyOnly),
    featureRow('aiVoice', ownKeyOnly),
    featureRow('customCss'),
    featureRow('shareControls'),
    featureRow('customDomains'),
    featureRow('brandKit'),
    featureRow('guests'),
    featureRow('sso'),
    featureRow('auditLog'),
    { id: 'mcp', label: t('pricing.compare.mcp'), cells: each(plan => props.tiers[plan].mcpWrite ? yes : text(t('pricing.compare.readOnly'))) }
  ]
})
</script>

<template>
  <!-- `relative`: the sr-only labels are absolutely positioned; without a
         positioned ancestor they escape the scroll box and widen the page. -->
  <div class="relative mt-4 overflow-x-auto rounded-lg border border-default bg-default">
    <table class="w-full min-w-[600px] text-sm border-collapse">
      <thead>
        <tr class="border-b border-default">
          <th
            scope="col"
            class="sticky left-0 z-10 bg-default text-left font-normal px-3 py-3 w-[26%]"
          >
            <span class="sr-only">{{ t('pricing.compare.feature') }}</span>
          </th>
          <th
            v-for="(label, i) in columnLabels"
            :key="COLUMNS[i]"
            scope="col"
            class="text-left font-mono font-normal text-[11px] uppercase tracking-[0.06em] text-muted px-3 py-3 whitespace-nowrap"
            :data-testid="`pricing-compare-col-${COLUMNS[i]}`"
          >
            {{ label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          class="border-b border-default last:border-b-0"
          :data-testid="`pricing-compare-row-${row.id}`"
        >
          <th
            scope="row"
            class="sticky left-0 z-10 bg-default text-left font-normal px-3 py-2.5 align-top"
          >
            {{ row.label }}
          </th>
          <td
            v-for="(cell, i) in row.cells"
            :key="COLUMNS[i]"
            class="px-3 py-2.5 align-top tabular-nums"
          >
            <template v-if="cell.kind === 'yes'">
              <UIcon
                name="i-lucide-check"
                class="size-4 text-default"
                aria-hidden="true"
              />
              <span class="sr-only">{{ t('pricing.compare.included') }}</span>
            </template>
            <template v-else-if="cell.kind === 'no'">
              <span
                class="text-muted"
                aria-hidden="true"
              >–</span>
              <span class="sr-only">{{ t('pricing.compare.notIncluded') }}</span>
            </template>
            <template v-else>
              {{ cell.text }}
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
