<script setup lang="ts">
// Embeddable flow component. Two ways to use it from MDC / a Vue page:
//
//   ::flow{id="create-document"}                       — scroll mode (default)
//   ::flow{id="create-document" mode="slides"}         — paginated viewer
//   ::flow{id="create-document" images-only hide-title} — minimal embed
//   ::flow{path="/internal/flows/admin/manifest.json"} — escape hatch for non-public flows
//
// i18n: by default reads the current locale from useI18n() and fetches
// /flows/<id>/<locale>/manifest.json. Falls back to `defaultLocale`
// (en) on 404 so a missing translation degrades to source language
// rather than disappearing.

import type { ComputedRef } from 'vue'

type Highlight = { label: string, x: number, y: number, w: number, h: number }

type ShotEntry = {
  kind: 'shot'
  file: string
  caption: string
  cursor: { x: number, y: number } | null
  path: string
  highlights?: Highlight[]
}
type NarrateEntry = { kind: 'narrate', text: string }
type HeadingEntry = { kind: 'heading', level: 2 | 3, text: string }
type Entry = ShotEntry | NarrateEntry | HeadingEntry

type Manifest = {
  version: 1
  title: string
  slug: string
  locale: string
  viewport: { w: number, h: number }
  entries: Entry[]
}

const props = withDefaults(defineProps<{
  /** Flow id — looks up /flows/<id>/<locale>/manifest.json */
  id?: string
  /** Explicit manifest URL — overrides id + locale. */
  path?: string
  /** "scroll" (inline list) | "slides" (paginated viewer) */
  mode?: 'scroll' | 'slides'
  /** Hide the flow's own title heading (when wrapping with your own h2). */
  hideTitle?: boolean
  /** Hide narration + heading entries; show only screenshots + captions. */
  imagesOnly?: boolean
  /** Locale fallback if the requested locale's manifest is missing. */
  defaultLocale?: string
  /** Show or hide the cursor overlay on screenshots that have one. */
  showCursor?: boolean
  /** Show or hide the fake browser chrome above each screenshot. */
  showChrome?: boolean
  /** Domain to display in the fake address bar (cosmetic only). */
  chromeDomain?: string
  /** Show or hide the bounding-box highlights on shots that carry them. */
  showHighlights?: boolean
}>(), {
  mode: 'scroll',
  hideTitle: false,
  imagesOnly: false,
  defaultLocale: 'en',
  showCursor: true,
  showChrome: true,
  chromeDomain: 'ypad.app',
  showHighlights: true
})

const { locale: i18nLocale } = useI18n()

// Build a fully-qualified URL for the manifest fetch. On the server,
// `$fetch('/flows/...')` with a bare path goes through Nitro's internal
// route resolver — which in dev does NOT delegate to Vite's static
// handler, so public/ assets 404 during SSR. Routing through the request
// origin turns it into a real HTTP fetch that hits Vite. On the client,
// `useRequestURL().origin` resolves to `window.location.origin` — same
// behaviour as a relative path. One code path, both contexts; SSR can
// pre-render the manifest into the page (no client flash on hydration).
const reqUrl = useRequestURL()
const flowUrl = (id: string, locale: string) =>
  `${reqUrl.origin}/flows/${id}/${locale}/manifest.json`

// Try current locale first; on 404 fall back to defaultLocale. We do this
// at the fetch level (not by trying both URLs in parallel) because the
// docs site usually has full coverage for one or two locales and partial
// coverage for the rest — the fast path costs one request.
const { data: manifest, error } = await useAsyncData<Manifest | null>(
  () => `flow:${props.id ?? props.path}:${i18nLocale.value}`,
  async () => {
    if (props.path) {
      // `path` may be relative (in-app) or absolute (cross-app escape hatch).
      // Only prefix the origin when it's a relative path.
      const url = props.path.startsWith('http') ? props.path : `${reqUrl.origin}${props.path}`
      return await $fetch<Manifest>(url)
    }
    if (!props.id) throw new Error('<Flow> requires either `id` or `path`')

    const primary = flowUrl(props.id, i18nLocale.value)
    try {
      return await $fetch<Manifest>(primary)
    } catch (e) {
      if (i18nLocale.value === props.defaultLocale) throw e
      const fallback = flowUrl(props.id, props.defaultLocale)
      return await $fetch<Manifest>(fallback)
    }
  },
  { watch: [i18nLocale] }
)

const baseUrl = computed(() => {
  if (!manifest.value) return ''
  if (props.path) return props.path.replace(/\/manifest\.json$/, '')
  return `/flows/${props.id}/${manifest.value.locale}`
})

const visibleEntries: ComputedRef<Entry[]> = computed(() => {
  if (!manifest.value) return []
  if (!props.imagesOnly) return manifest.value.entries
  return manifest.value.entries.filter((e) => e.kind === 'shot')
})

const shots = computed(() =>
  visibleEntries.value.filter((e): e is ShotEntry => e.kind === 'shot')
)

// Slide mode state.
const slideIdx = ref(0)
watch(visibleEntries, () => { slideIdx.value = 0 })
const goPrev = () => { if (slideIdx.value > 0) slideIdx.value -= 1 }
const goNext = () => { if (slideIdx.value < shots.value.length - 1) slideIdx.value += 1 }

// Keyboard nav for slides — only active when the slides container has focus,
// so embedding two on the same page doesn't have them fighting.
const slidesEl = ref<HTMLElement | null>(null)
useEventListener(slidesEl, 'keydown', (e: KeyboardEvent) => {
  if (props.mode !== 'slides') return
  if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() } else if (e.key === 'ArrowRight') { e.preventDefault(); goNext() }
})
</script>

<template>
  <div v-if="error" class="my-6 p-4 border border-red-500/40 bg-red-500/5 rounded text-sm">
    Flow <code>{{ id ?? path }}</code> failed to load: {{ error.message }}
  </div>

  <div v-else-if="manifest" class="my-8 not-prose">
    <h3 v-if="!hideTitle" class="text-lg font-semibold mb-4">
      {{ manifest.title }}
    </h3>

    <!-- ─── SLIDES MODE ─────────────────────────────────────────── -->
    <div
      v-if="mode === 'slides' && shots.length"
      ref="slidesEl"
      tabindex="0"
      class="space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
    >
      <FlowFrame
        :src="`${baseUrl}/${shots[slideIdx].file}`"
        :caption="shots[slideIdx].caption"
        :cursor="shots[slideIdx].cursor"
        :path="shots[slideIdx].path"
        :highlights="shots[slideIdx].highlights"
        :viewport="manifest.viewport"
        :show-cursor="showCursor"
        :show-chrome="showChrome"
        :chrome-domain="chromeDomain"
        :show-highlights="showHighlights"
      />
      <div class="flex items-center gap-3 text-sm">
        <button
          class="px-3 py-1 rounded border border-default disabled:opacity-40 hover:bg-elevated"
          :disabled="slideIdx === 0"
          @click="goPrev"
        >
          ←
        </button>
        <span class="font-mono text-xs text-toned">
          {{ slideIdx + 1 }} / {{ shots.length }}
        </span>
        <button
          class="px-3 py-1 rounded border border-default disabled:opacity-40 hover:bg-elevated"
          :disabled="slideIdx === shots.length - 1"
          @click="goNext"
        >
          →
        </button>
        <span class="text-toned ml-2 truncate">{{ shots[slideIdx].caption }}</span>
      </div>
    </div>

    <!-- ─── SCROLL MODE (default) ───────────────────────────────── -->
    <div v-else class="space-y-6">
      <template v-for="(e, i) in visibleEntries" :key="i">
        <h2 v-if="e.kind === 'heading' && e.level === 2" class="text-xl font-semibold">
          {{ e.text }}
        </h2>
        <h3 v-else-if="e.kind === 'heading'" class="text-base font-semibold">
          {{ e.text }}
        </h3>
        <aside
          v-else-if="e.kind === 'narrate'"
          class="px-4 py-3 border-l-2 border-primary/40 bg-primary/5 text-sm"
        >
          {{ e.text }}
        </aside>
        <FlowFrame
          v-else
          :src="`${baseUrl}/${e.file}`"
          :caption="e.caption"
          :cursor="e.cursor"
          :path="e.path"
          :highlights="e.highlights"
          :viewport="manifest.viewport"
          :show-cursor="showCursor"
          :show-chrome="showChrome"
          :chrome-domain="chromeDomain"
          :show-highlights="showHighlights"
        />
      </template>
    </div>
  </div>
</template>
