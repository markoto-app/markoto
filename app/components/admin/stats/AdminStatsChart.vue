<script setup lang="ts">
import type { Chart as ChartInstance, ChartConfiguration } from 'chart.js'

// A Chart.js canvas. chart.js is imported on mount, so it ships in its own
// chunk that only the admin stats pages load. It draws on a canvas: no
// eval, no injected script, nothing the CSP has to allow. Colours come
// from the design tokens and follow the colour mode.

export interface StatsDataset {
  label: string
  data: number[]
}

const props = withDefaults(defineProps<{
  type: 'line' | 'bar'
  title: string
  labels: string[]
  datasets: StatsDataset[]
  stacked?: boolean
  horizontal?: boolean
  formatValue?: (n: number) => string
  height?: number
}>(), { stacked: false, horizontal: false, formatValue: undefined, height: 240 })

const canvas = ref<HTMLCanvasElement | null>(null)
let chart: ChartInstance | null = null
let registered = false
const colorMode = useColorMode()

// Light / dark series colours: ink first, then the seal red, alternating
// tones so neighbouring stacks stay apart.
const LIGHT = ['--color-sumi-800', '--color-shu-500', '--color-sumi-400', '--color-shu-300', '--color-sumi-600', '--color-shu-700', '--color-sumi-300', '--color-shu-200', '--color-sumi-500']
const DARK = ['--color-sumi-100', '--color-shu-400', '--color-sumi-400', '--color-shu-200', '--color-sumi-300', '--color-shu-600', '--color-sumi-500', '--color-shu-300', '--color-sumi-600']

async function render(): Promise<void> {
  const el = canvas.value
  if (!el) return
  const lib = await import('chart.js')
  if (!registered) {
    lib.Chart.register(lib.LineController, lib.BarController, lib.LineElement, lib.BarElement, lib.PointElement,
      lib.CategoryScale, lib.LinearScale, lib.Tooltip, lib.Legend, lib.Filler)
    registered = true
  }
  const css = getComputedStyle(document.documentElement)
  const token = (name: string): string => css.getPropertyValue(name).trim()
  const dark = document.documentElement.classList.contains('dark')
  const palette = (dark ? DARK : LIGHT).map(token)
  const text = token('--ui-text-muted')
  const grid = token('--ui-border')
  const fmt = props.formatValue ?? ((n: number) => n.toLocaleString())
  const single = props.datasets.length === 1
  const valueAxis = props.horizontal ? 'x' : 'y'
  const config: ChartConfiguration<'line' | 'bar'> = {
    type: props.type,
    data: {
      labels: props.labels,
      datasets: props.datasets.map((d, i) => {
        const color = palette[i % palette.length] ?? text
        return {
          label: d.label,
          data: d.data,
          borderColor: color,
          backgroundColor: color,
          borderWidth: props.type === 'line' ? 2 : 0,
          pointRadius: props.type === 'line' && props.labels.length <= 31 ? 2 : 0,
          tension: 0.25,
          maxBarThickness: 28
        }
      })
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      indexAxis: props.horizontal ? 'y' : 'x',
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: !single, position: 'bottom', labels: { color: text, boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label ?? ''}: ${fmt(Number(c.raw))}` } }
      },
      scales: {
        x: { stacked: props.stacked, ticks: { color: text, maxRotation: 0, autoSkip: true }, grid: { display: valueAxis === 'x', color: grid } },
        y: {
          stacked: props.stacked,
          beginAtZero: true,
          ticks: { color: text, ...(valueAxis === 'y' ? { callback: (v: string | number) => fmt(Number(v)) } : {}) },
          grid: { display: valueAxis === 'y', color: grid }
        }
      }
    }
  }
  chart?.destroy()
  chart = new lib.Chart(el, config)
}

onMounted(() => {
  void render()
})
watch(() => [props.labels, props.datasets, props.stacked, colorMode.value], () => {
  void render()
}, { deep: true })
onBeforeUnmount(() => {
  chart?.destroy()
  chart = null
})
</script>

<template>
  <figure class="rounded-md bg-default p-4 break-inside-avoid">
    <figcaption class="text-sm text-default mb-3">
      {{ title }}
    </figcaption>
    <div :style="{ height: `${height}px` }">
      <canvas
        ref="canvas"
        role="img"
        :aria-label="title"
      />
    </div>
  </figure>
</template>
