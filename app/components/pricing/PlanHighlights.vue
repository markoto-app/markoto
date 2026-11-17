<script setup lang="ts">
import type { FeatureField, PlanName, TierCaps, TiersMap } from '~~/shared/config/tiers'
import { planToPointsTotal } from '~~/shared/billing/aiPoints'
import { isPerSeatPlan } from '~~/shared/config/pricing'

// The three or four short benefit lines of one plan card. Every number and
// every switch comes from the resolved tier map (`GET /api/billing/tiers`,
// committed defaults + TIER_* overrides), so an instance that changes a
// limit or a feature sees it here. The full list is the comparison table.
//
//   - Free / Pro: AI Points per month, workspaces you own.
//   - Team / Business: AI Points per seat (shared), people per workspace.
//   - Free: AI on your own key, the writing features every account has.
//   - Paid plans: what the plan adds over the plan below it (features on
//     here and off there), the AI extras folded into one line; storage
//     fills a line that is left.
const props = defineProps<{
  plan: PlanName
  tiers: TiersMap
}>()

const { t, locale } = useI18n()

const MAX_LINES = 4

/** The plan whose features this one is compared with. */
const PREVIOUS: Record<PlanName, PlanName | null> = { free: null, pro: 'free', team: 'pro', business: 'team' }

const AI_FEATURES = ['aiStrongModel', 'aiImage', 'aiVoice'] as const satisfies readonly FeatureField[]
/** Order in which added features earn a line. */
const OTHER_FEATURES = ['sso', 'auditLog', 'brandKit', 'guests', 'customDomains', 'shareControls', 'customCss', 'mcpWrite'] as const satisfies readonly FeatureField[]

interface Line { id: string, icon: string | null, text: string }

function added(caps: TierCaps, base: TierCaps, field: FeatureField): boolean {
  return caps[field] && !base[field]
}

function n(value: number): string {
  return formatCount(value, locale.value)
}

/** AI Points, then workspaces (personal plans) or people per workspace. */
function baseLines(caps: TierCaps, perSeat: boolean): Line[] {
  const points = planToPointsTotal(props.plan, props.tiers)
  const ai: Line = {
    id: 'ai',
    icon: null,
    text: t(perSeat ? 'pricing.countPerSeat.aiPoints' : 'pricing.count.aiPoints', { n: n(points) }, points)
  }
  if (!perSeat) {
    return [ai, { id: 'workspaces', icon: 'i-lucide-folder', text: t('pricing.count.workspaces', { n: n(caps.workspacesOwned) }, caps.workspacesOwned) }]
  }
  const members = caps.membersPerWorkspace
  return [ai, {
    id: 'members',
    icon: 'i-lucide-users',
    text: members === null ? t('pricing.highlights.membersUnlimited') : t('pricing.highlights.members', { n: n(members) }, members)
  }]
}

/** What the plan adds over `base`: the AI extras as one line, then other features. */
function addedLines(caps: TierCaps, base: TierCaps): Line[] {
  const out: Line[] = []
  const ai = AI_FEATURES.filter(field => added(caps, base, field))
  if (ai.length > 0) {
    const list = new Intl.ListFormat(locale.value, { type: 'conjunction' })
      .format(ai.map(field => t(`pricing.highlights.ai.${field}`)))
    out.push({ id: 'ai-extras', icon: null, text: t('pricing.highlights.aiExtras', { list }) })
  }
  for (const field of OTHER_FEATURES.filter(f => added(caps, base, f))) {
    out.push({ id: field, icon: 'i-lucide-check', text: t(`pricing.highlights.feature.${field}`) })
  }
  return out
}

function storageLine(caps: TierCaps, perSeat: boolean): Line {
  const bytes = perSeat ? caps.knowledgeBytesPerWorkspace : caps.knowledgeBytesPerUser
  return {
    id: 'storage',
    icon: 'i-lucide-hard-drive',
    text: t(perSeat ? 'pricing.countPerSeat.knowledgeStorage' : 'pricing.count.knowledgeStorage', { size: formatPlanBytes(bytes) })
  }
}

const lines = computed<Line[]>(() => {
  const caps = props.tiers[props.plan]
  const previous = PREVIOUS[props.plan]
  const perSeat = isPerSeatPlan(props.plan)
  const out = baseLines(caps, perSeat)
  if (!previous) {
    return [
      ...out,
      { id: 'own-key', icon: 'i-lucide-key-round', text: t('pricing.freeAccount.byok') },
      { id: 'writing', icon: 'i-lucide-pen-line', text: t('pricing.highlights.writing') }
    ]
  }
  out.push(...addedLines(caps, props.tiers[previous]))
  if (out.length < MAX_LINES) out.push(storageLine(caps, perSeat))
  return out.slice(0, MAX_LINES)
})

const TESTIDS: Record<string, string> = { ai: 'pricing-cap-ai', workspaces: 'pricing-cap-workspaces', members: 'pricing-cap-members' }
</script>

<template>
  <ul
    class="space-y-2.5 text-sm"
    data-testid="pricing-highlights"
  >
    <li
      v-for="line in lines"
      :key="line.id"
      class="flex gap-2"
      :data-highlight="line.id"
    >
      <CommonSeal
        v-if="line.icon === null"
        :size="9"
        class="shrink-0 mt-1.5"
      />
      <UIcon
        v-else
        :name="line.icon"
        class="size-4 text-muted shrink-0 mt-0.5"
      />
      <span :data-testid="TESTIDS[line.id]">{{ line.text }}</span>
    </li>
  </ul>
</template>
