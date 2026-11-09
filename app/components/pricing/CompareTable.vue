<script setup lang="ts">
import { PAID_PLAN_NAMES, isPerSeatPlan } from '~~/shared/config/pricing'
import type { PlanName, TiersMap } from '~~/shared/config/tiers'
import { planToPointsTotal } from '~~/shared/billing/aiPoints'

// Comparison table under the pricing cards: one row per limit or
// feature, one column per option (self-hosted, no account, free
// account, Pro, Team, Business). Account columns read the resolved tier map
// and the configured prices; the no-account column reads the instance
// config (anonymous-document retention) and what the server allows an
// anonymous visitor (no AI, no workspaces, no uploads, open-edit only:
// see server/middleware/auth.ts + server/AGENTS.md).
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
  /** Days without edits before an anonymous document is deleted; 0 = kept. */
  anonTtlDays: number
}>()

const { t, locale } = useI18n()

type Cell = { kind: 'yes' } | { kind: 'no' } | { kind: 'text', text: string }
interface Row { id: string, label: string, cells: Cell[] }

const COLUMNS = ['selfHosted', 'anon', 'free', ...PAID_PLAN_NAMES] as const

const columnLabels = computed(() => [
  t('pricing.selfHosted.title'),
  t('pricing.anon.title'),
  t('pricing.freeAccount.title'),
  'Pro',
  'Team',
  'Business'
])

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

const accountPlans = ['free', ...PAID_PLAN_NAMES] as const

/** A plan limit cell: `null` = no limit ("Unlimited"). */
function limitCell(limit: number | null, format: (n: number) => string): Cell {
  return text(limit === null ? t('pricing.compare.unlimited') : format(limit))
}

const rows = computed<Row[]>(() => {
  const setByYou = text(t('pricing.compare.setByYou'))
  const free = text(t('pricing.price.free'))
  const perAccount = (fn: (plan: typeof accountPlans[number]) => Cell) => accountPlans.map(fn)
  return [
    {
      id: 'price',
      label: t('pricing.compare.price'),
      cells: [
        free,
        free,
        free,
        ...PAID_PLAN_NAMES.map(plan => text(
          t(props.planned ? 'pricing.compare.pricePlanned' : 'pricing.compare.priceMonthly', {
            price: formatPrice(props.prices[plan], props.currency, locale.value)
          })
        ))
      ]
    },
    {
      id: 'documents',
      label: t('pricing.compare.documents'),
      cells: [
        text(t('pricing.compare.unlimited')),
        text(props.anonTtlDays > 0
          ? t('pricing.compare.anonRetention', { n: num(props.anonTtlDays) }, props.anonTtlDays)
          : t('pricing.compare.unlimited')),
        ...perAccount(() => text(t('pricing.compare.unlimited')))
      ]
    },
    {
      id: 'writing',
      label: t('pricing.compare.writing'),
      cells: COLUMNS.map(() => yes)
    },
    {
      id: 'sharing',
      label: t('pricing.compare.sharing'),
      cells: [yes, text(t('pricing.compare.openEditOnly')), ...perAccount(() => yes)]
    },
    {
      id: 'aiPoints',
      label: t('pricing.compare.aiPoints'),
      cells: [setByYou, no, ...perAccount(plan => text(seatValue(plan, num(planToPointsTotal(plan, props.tiers)))))]
    },
    {
      id: 'ownKey',
      label: t('pricing.compare.ownKey'),
      cells: [yes, no, ...perAccount(() => yes)]
    },
    {
      id: 'workspaces',
      label: t('pricing.compare.workspaces'),
      cells: [setByYou, no, ...perAccount(plan => text(num(props.tiers[plan].workspacesOwned)))]
    },
    {
      id: 'knowledgeFiles',
      label: t('pricing.compare.knowledgeFiles'),
      cells: [setByYou, no, ...perAccount(plan => text(seatValue(plan, num(props.tiers[plan].knowledgeFiles))))]
    },
    {
      id: 'knowledgeStorage',
      label: t('pricing.compare.knowledgeStorage'),
      cells: [setByYou, no, ...perAccount(plan => text(seatValue(plan, formatPlanBytes(isPerSeatPlan(plan) ? props.tiers[plan].knowledgeBytesPerWorkspace : props.tiers[plan].knowledgeBytesPerUser))))]
    },
    {
      id: 'imageStorage',
      label: t('pricing.compare.imageStorage'),
      cells: [setByYou, no, ...perAccount(plan => text(seatValue(plan, formatPlanBytes(props.tiers[plan].imageBytesPerUser))))]
    },
    {
      id: 'members',
      label: t('pricing.compare.members'),
      cells: [setByYou, no, ...perAccount(plan => limitCell(props.tiers[plan].membersPerWorkspace, num))]
    },
    {
      id: 'history',
      label: t('pricing.compare.history'),
      cells: [setByYou, no, ...perAccount(plan => limitCell(props.tiers[plan].historyDays, n => t('pricing.compare.days', { n: num(n) }, n)))]
    },
    {
      id: 'customCss',
      label: t('pricing.compare.customCss'),
      cells: [yes, no, ...perAccount(plan => props.tiers[plan].customCss ? yes : no)]
    },
    {
      id: 'mcp',
      label: t('pricing.compare.mcp'),
      cells: [yes, no, ...perAccount(plan => props.tiers[plan].mcpWrite ? yes : text(t('pricing.compare.readOnly')))]
    }
  ]
})
</script>

<template>
  <section
    class="mt-12 sm:mt-16"
    data-testid="pricing-compare"
    aria-labelledby="pricing-compare-title"
  >
    <h2
      id="pricing-compare-title"
      class="font-serif text-2xl sm:text-3xl font-normal tracking-tight"
    >
      {{ t('pricing.compare.title') }}
    </h2>
    <!-- `relative`: the sr-only labels are absolutely positioned; without a
         positioned ancestor they escape the scroll box and widen the page. -->
    <div class="relative mt-4 overflow-x-auto rounded-lg border border-default bg-default">
      <table class="w-full min-w-[720px] text-sm border-collapse">
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
  </section>
</template>
