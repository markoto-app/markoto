<script setup lang="ts">
import type { Chart as ChartInstance, ChartConfiguration } from 'chart.js'

// A Chart.js canvas. chart.js is imported on mount, so it ships in its own
// chunk that only the admin stats pages load. It draws on a canvas: no
// eval, no injected script, nothing the CSP has to allow. Colours come
// from the design tokens and follow the colour mode; while printing the
// chart is redrawn in the light palette (paper is white).
//
// `kind` decides the value axis: counts step in whole numbers (a series
// of 0s and 1s would otherwise label 0.2, 0.4 … and round them to
// "0 0 1 1"), money keeps its decimals.

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
  kind?: 'count' | 'money'
}>(), { stacked: false, horizontal: false, formatValue: undefined, height: 240, kind: 'count' })

const canvas = ref<HTMLCanvasElement | null>(null)
let chart: ChartInstance | null = null
const colorMode = useColorMode()

// Light / dark series colours: ink first, then the seal red, alternating
// tones so neighbouring stacks stay apart.
const LIGHT = ['--color-sumi-800', '--color-shu-500', '--color-sumi-400', '--color-shu-300', '--color-sumi-600', '--color-shu-700', '--color-sumi-300', '--color-shu-200', '--color-sumi-500']
const DARK = ['--color-sumi-100', '--color-shu-400', '--color-sumi-400', '--color-shu-200', '--color-sumi-300', '--color-shu-600', '--color-sumi-500', '--color-shu-300', '--color-sumi-600']

type ChartLib = typeof import('chart.js')
// Loaded once per page; kept so a print can redraw synchronously.
let chartLib: ChartLib | null = null

async function loadLib(): Promise<ChartLib> {
  if (chartLib) return chartLib
  const lib = await import('chart.js')
  lib.Chart.register(lib.LineController, lib.BarController, lib.LineElement, lib.BarElement, lib.PointElement,
    lib.CategoryScale, lib.LinearScale, lib.Tooltip, lib.Legend, lib.Filler)
  chartLib = lib
  return lib
}

/** Smallest axis maximum of a count chart, so 0 / 1 series get a few whole steps. */
const MIN_COUNT_AXIS = 4

/** Design tokens of the light or dark theme, read from the document. */
function readTokens(light: boolean): { palette: string[], text: string, grid: string } {
  const root = document.documentElement
  const wasDark = root.classList.contains('dark')
  // Printing in dark mode: read the light values for a moment.
  if (light && wasDark) root.classList.remove('dark')
  try {
    const css = getComputedStyle(root)
    const token = (name: string): string => css.getPropertyValue(name).trim()
    const dark = !light && wasDark
    return { palette: (dark ? DARK : LIGHT).map(token), text: token('--ui-text-muted'), grid: token('--ui-border') }
  } finally {
    if (light && wasDark) root.classList.add('dark')
  }
}

async function render(): Promise<void> {
  const lib = await loadLib()
  draw(lib, false)
}

function draw(lib: ChartLib, forPrint: boolean): void {
  const el = canvas.value
  if (!el) return
  const { palette, text, grid } = readTokens(forPrint)
  const fmt = props.formatValue ?? ((n: number) => n.toLocaleString())
  const single = props.datasets.length === 1
  const valueAxis = props.horizontal ? 'x' : 'y'
  const counts = props.kind === 'count'
  const valueScale = {
    beginAtZero: true,
    ...(counts ? { suggestedMax: MIN_COUNT_AXIS } : {}),
    ticks: {
      color: text,
      ...(counts ? { precision: 0 } : {}),
      callback: (v: string | number) => fmt(Number(v))
    },
    grid: { display: true, color: grid }
  }
  const categoryScale = { ticks: { color: text, maxRotation: 0, autoSkip: true }, grid: { display: false, color: grid } }
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
        x: { stacked: props.stacked, ...(valueAxis === 'x' ? valueScale : categoryScale) },
        y: { stacked: props.stacked, ...(valueAxis === 'y' ? valueScale : categoryScale) }
      }
    }
  }
  chart?.destroy()
  chart = new lib.Chart(el, config)
}

function redrawForPrint(forPrint: boolean): void {
  if (chartLib) draw(chartLib, forPrint)
}

onMounted(() => {
  void render()
})
useEventListener('beforeprint', () => redrawForPrint(true))
useEventListener('afterprint', () => redrawForPrint(false))
watch(() => [props.labels, props.datasets, props.stacked, props.kind, colorMode.value], () => {
  void render()
}, { deep: true })
onBeforeUnmount(() => {
  chart?.destroy()
  chart = null
})
</script>

<template>
  <figure
    class="rounded-md bg-default p-4 break-inside-avoid print:border print:border-default print:p-3"
    data-testid="admin-stats-chart"
  >
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
