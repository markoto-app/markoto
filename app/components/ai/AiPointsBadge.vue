<script setup lang="ts">
import { useAiCredits } from '~/composables/useAiCredits'

// AI Points budget badge — progress ring + numeric label.
//
// Bar fill = `pointsRemaining / pointsTotal` regardless of plan size.
// Free user with 500 pts displays the same ring shape as Ultra with
// 35000 pts; only the fill ratio + the numeric label differ.
//
// Color coding (kept minimal, brand-restraint):
//   - normal (>=10% remaining)  → sumi (default text color)
//   - low (<10%)                → shu-500 / shu-400 (the seal color
//     stays brand-consistent: AI in trouble = shu, not amber)
//   - exhausted (=0)            → shu, with reduced fill opacity
//
// Mounted in AIPromptBar.vue (right-side chip alongside the seal +
// send button) and the workspace overview header.

const props = defineProps<{
  workspaceId?: string | null
}>()

const { pointsRemaining, pointsTotal, fillRatio, isLow, isExhausted, refresh } = useAiCredits(props.workspaceId)

defineExpose({ refresh })

// Numeric label — show pointsRemaining slim if total >= 1000 (avoid
// "00500/00500" zero-padding feel); otherwise full pair.
const label = computed(() => {
  if (pointsTotal.value <= 0) return '—'
  return `${pointsRemaining.value} / ${pointsTotal.value}`
})

// SVG progress ring math
const RADIUS = 9
const STROKE = 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const dashOffset = computed(() => CIRCUMFERENCE * (1 - fillRatio.value))
</script>

<template>
  <div
    class="ai-points-badge inline-flex items-center gap-1.5"
    :class="{ 'is-low': isLow, 'is-exhausted': isExhausted }"
    :title="`${pointsRemaining} of ${pointsTotal} AI Points remaining`"
  >
    <svg
      :width="(RADIUS + STROKE) * 2"
      :height="(RADIUS + STROKE) * 2"
      class="ring"
      aria-hidden="true"
    >
      <circle
        :cx="RADIUS + STROKE"
        :cy="RADIUS + STROKE"
        :r="RADIUS"
        fill="none"
        stroke="currentColor"
        :stroke-width="STROKE"
        opacity="0.15"
      />
      <circle
        :cx="RADIUS + STROKE"
        :cy="RADIUS + STROKE"
        :r="RADIUS"
        fill="none"
        stroke="currentColor"
        :stroke-width="STROKE"
        :stroke-dasharray="CIRCUMFERENCE"
        :stroke-dashoffset="dashOffset"
        stroke-linecap="round"
        :transform="`rotate(-90 ${RADIUS + STROKE} ${RADIUS + STROKE})`"
        class="ring-fill"
      />
    </svg>
    <span class="font-mono text-[10.5px] tabular-nums">{{ label }}</span>
  </div>
</template>

<style scoped>
.ai-points-badge {
  color: var(--ui-text-muted);
}
.ai-points-badge.is-low {
  color: var(--color-shu-500);
}
:root.dark .ai-points-badge.is-low {
  color: var(--color-shu-400);
}
.ai-points-badge.is-exhausted .ring-fill {
  opacity: 0.4;
}
.ring-fill {
  transition: stroke-dashoffset 600ms ease-out;
}
</style>
