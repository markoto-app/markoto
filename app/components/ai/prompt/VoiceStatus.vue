<script setup lang="ts">
import WaveformVisualizer from '../WaveformVisualizer.vue'

// The prompt bar's middle slot while voice input runs: the live waveform
// and timer, "Transcribing…", or the permission request. The 8px vertical
// padding of the recording row compensates for the 32px waveform canvas
// (8 + 32 + 8 = 48 px, the text input's height), so the pill doesn't grow
// when the user toggles the mic.
const props = defineProps<{
  state: 'recording' | 'transcribing' | 'requesting-permission'
  levels: readonly number[]
  durationSec: number
  maxDurationSec: number
}>()
const { t } = useI18n()

// MM:SS is enough: voice input caps at 60s so minutes are always 0 or 1
// but the format stays familiar.
const formattedTime = computed(() => {
  const s = Math.max(0, Math.floor(props.durationSec))
  const mm = String(Math.floor(s / 60)).padStart(1, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
})

// Amber at the last 10s, red at the last 5s, gives the user a moment
// to wrap up before the hard auto-stop fires.
const timerColorClass = computed(() => {
  const remaining = props.maxDurationSec - props.durationSec
  if (remaining <= 5) return 'text-red-500'
  if (remaining <= 10) return 'text-amber-500'
  return 'text-muted'
})
</script>

<template>
  <div
    v-if="state === 'recording'"
    class="flex-1 min-w-0 flex items-center gap-3 py-2"
  >
    <WaveformVisualizer
      :levels="levels"
      :height="32"
      class="flex-1 min-w-0"
    />
    <span
      class="voice-timer text-sm tabular-nums font-medium shrink-0"
      :class="timerColorClass"
    >{{ formattedTime }}</span>
  </div>
  <div
    v-else-if="state === 'transcribing'"
    class="flex-1 min-w-0 flex items-center py-3"
  >
    <span class="text-muted italic transcribing-shimmer">{{ t('ai.micTranscribing') }}</span>
  </div>
  <div
    v-else
    class="flex-1 min-w-0 flex items-center py-3"
  >
    <span class="text-muted italic">{{ t('ai.micRequestingPermission') }}</span>
  </div>
</template>

<style scoped>
/*
 * Transcribing shimmer: a subtle left-to-right gradient sweep on the
 * "Transcribing…" label so the UI reads as "working" without a full
 * spinner (the primary button already carries one).
 */
@keyframes transcribe-shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.transcribing-shimmer {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--ui-text-muted) 60%, transparent) 0%,
    var(--color-shu-500) 50%,
    color-mix(in srgb, var(--ui-text-muted) 60%, transparent) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: transcribe-shimmer 2s linear infinite;
}
</style>
