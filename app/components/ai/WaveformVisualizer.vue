<script setup lang="ts">
// Live audio-level visualiser — a centered row of vertical bars whose
// heights follow the 0..1 amplitude samples in `levels`. Canvas-based so
// 30+ fps updates don't trigger layout or Vue diffs; only the 2D context
// touches pixels.
//
// The mic composable already does the max-pooling + smoothing, so this
// component is intentionally dumb: it maps `levels[i]` → bar height and
// redraws whenever the array reference changes.

const props = withDefaults(defineProps<{
  levels: readonly number[]
  /** Display height in CSS pixels (bars span the full container width). */
  height?: number
  /** Gap between bars, px. */
  gap?: number
  /** Minimum bar height as a fraction of container (keeps "quiet" state visible). */
  minHeight?: number
}>(), {
  height: 36,
  gap: 3,
  minHeight: 0.08
})

const canvas = ref<HTMLCanvasElement | null>(null)
const wrapper = ref<HTMLDivElement | null>(null)

// devicePixelRatio-aware sizing: the canvas backing store is DPR× the CSS
// size so bars stay crisp on retina. `useElementSize` tracks the wrapper
// width via ResizeObserver and triggers the resize watcher below.
const { width: wrapperWidth } = useElementSize(wrapper)
let dpr = 1

function resize() {
  if (!canvas.value || !wrapper.value) return
  dpr = window.devicePixelRatio || 1
  const cssWidth = wrapperWidth.value
  canvas.value.width = Math.max(1, Math.floor(cssWidth * dpr))
  canvas.value.height = Math.max(1, Math.floor(props.height * dpr))
  canvas.value.style.width = `${cssWidth}px`
  canvas.value.style.height = `${props.height}px`
  draw()
}

function draw() {
  const el = canvas.value
  if (!el) return
  const ctx = el.getContext('2d')
  if (!ctx) return
  const w = el.width
  const h = el.height
  ctx.clearRect(0, 0, w, h)

  const count = props.levels.length
  if (count === 0) return

  const gapPx = props.gap * dpr
  const totalGap = gapPx * (count - 1)
  const barWidth = Math.max(1, (w - totalGap) / count)
  const minBar = props.minHeight * h

  // Theme-aware fill: pull the brand shu (vermillion) from CSS vars
  // so the bars match the prompt-bar's seal + ring + send button.
  // Dark mode uses the brighter shu-400 stop for legibility on the
  // darker chrome. Earlier this fill came from `--color-blue-500`
  // — leftover from the pre-brand placeholder accent.
  const styles = getComputedStyle(el)
  const isDark = document.documentElement.classList.contains('dark')
  const stop = isDark ? '--color-shu-400' : '--color-shu-500'
  const base = styles.getPropertyValue(stop).trim() || (isDark ? '#D14828' : '#B5371F')
  ctx.fillStyle = base

  for (let i = 0; i < count; i++) {
    const amp = Math.max(0, Math.min(1, props.levels[i] ?? 0))
    const barHeight = Math.max(minBar, amp * h)
    const x = i * (barWidth + gapPx)
    const y = (h - barHeight) / 2
    // Pill-shaped bars — radius = half the bar width rounds both top AND
    // bottom to a semicircle, which reads as a clean voice waveform
    // rather than a chunky equalizer. Clamped to barHeight/2 so very
    // short bars stay proportional instead of overflowing their row.
    const r = Math.min(barWidth / 2, barHeight / 2)
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath()
      ctx.roundRect(x, y, barWidth, barHeight, r)
      ctx.fill()
    } else {
      ctx.fillRect(x, y, barWidth, barHeight)
    }
  }
}

// Redraw whenever the levels array reference changes. The composable
// allocates a fresh array each tick so Vue reactivity fires naturally.
watch(() => props.levels, () => draw(), { flush: 'post' })
watch(() => props.height, resize)
// Wrapper width changes (parent resize, layout shift) → reapply the
// DPR-aware sizing. Fires post-mount on the first non-zero width too,
// so we don't need an extra onMounted to seed the canvas.
watch(wrapperWidth, resize)
</script>

<template>
  <div
    ref="wrapper"
    class="waveform"
    :style="{ height: `${height}px` }"
  >
    <canvas ref="canvas" />
  </div>
</template>

<style scoped>
.waveform {
  width: 100%;
  display: block;
}
.waveform canvas {
  display: block;
}
</style>
