<script setup lang="ts">
import type { PlanName, TiersMap } from '~~/shared/config/tiers'
import { planToPointsTotal } from '~~/shared/billing/aiPoints'
import { isPerSeatPlan } from '~~/shared/config/pricing'

// The limits of one plan, as a list: AI Points, workspaces, knowledge
// files + storage, image storage. For Team / Business the AI Points and
// storage are per seat. Every number comes from the resolved tier map
// (`GET /api/billing/tiers`); counts use vue-i18n pluralisation.
const props = defineProps<{
  plan: PlanName
  tiers: TiersMap
}>()

const { t, locale } = useI18n()

const caps = computed(() => props.tiers[props.plan])
const points = computed(() => planToPointsTotal(props.plan, props.tiers))
// Team / Business: AI Points, knowledge files and storage are per seat and
// pooled across the workspace (server/utils/billing/workspaceBilling.ts).
const perSeat = computed(() => isPerSeatPlan(props.plan))
const knowledgeBytes = computed(() => perSeat.value ? caps.value.knowledgeBytesPerWorkspace : caps.value.knowledgeBytesPerUser)

function count(key: string, n: number): string {
  return t(perSeat.value ? key.replace('pricing.count.', 'pricing.countPerSeat.') : key, { n: formatCount(n, locale.value) }, n)
}
function sized(key: string, bytes: number): string {
  return t(perSeat.value ? key.replace('pricing.count.', 'pricing.countPerSeat.') : key, { size: formatPlanBytes(bytes) })
}
</script>

<template>
  <ul
    class="space-y-2 text-sm"
    data-testid="pricing-caps"
  >
    <li class="flex items-baseline gap-2">
      <CommonSeal
        :size="9"
        class="shrink-0 self-center"
      />
      <span data-testid="pricing-cap-ai">{{ count('pricing.count.aiPoints', points) }}</span>
    </li>
    <li class="flex gap-2">
      <UIcon
        name="i-lucide-folder"
        class="size-4 text-muted shrink-0 mt-0.5"
      />
      <span data-testid="pricing-cap-workspaces">{{ count('pricing.count.workspaces', caps.workspacesOwned) }}</span>
    </li>
    <li class="flex gap-2">
      <UIcon
        name="i-lucide-file-text"
        class="size-4 text-muted shrink-0 mt-0.5"
      />
      <span>{{ count('pricing.count.knowledgeFiles', caps.knowledgeFiles) }}</span>
    </li>
    <li class="flex gap-2">
      <UIcon
        name="i-lucide-hard-drive"
        class="size-4 text-muted shrink-0 mt-0.5"
      />
      <span>{{ sized('pricing.count.knowledgeStorage', knowledgeBytes) }}</span>
    </li>
    <li class="flex gap-2">
      <UIcon
        name="i-lucide-image"
        class="size-4 text-muted shrink-0 mt-0.5"
      />
      <span>{{ sized('pricing.count.imageStorage', caps.imageBytesPerUser) }}</span>
    </li>
  </ul>
</template>
