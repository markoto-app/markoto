<script setup lang="ts">
import { flowStripData, stripCaption } from '~~/shared/docs/flowStrip'

// A row of screenshots from a flow (the Playwright flows that double as
// docs, public/flows/<id>/…) for marketing content:
//
//   ::flow-strip{id="rich-content" frames="10,20"}
//   ---
//   captions:
//     - A tip alert in the preview.
//     - Code, math and a chart on one page.
//   ---
//   ::
//
// Rendered on the server: the default variant (en, light, desktop) as
// real <img> tags with alt text, width and height, so the HTML a crawler
// gets has the pictures. The dark variant sits next to each light one and
// CSS shows whichever matches `html.dark` (the Wordmark pattern, same DOM
// on server and client, and `loading="lazy"` keeps the hidden one from
// downloading). Unlike `<Flow>`, no slideshow and no fetch.
const props = withDefaults(defineProps<{
  /** Flow id (folder under public/flows). */
  id: string
  /** Image numbers to show, comma-separated (`"10,20"`); default: the flow's last outcomes. */
  frames?: string
  /** How many shots without `frames`. */
  limit?: number
  /** Caption (and alt text) for a single-shot strip, replacing the flow step's own text. */
  caption?: string
  /** One caption (and alt text) per shown shot, in order, a YAML list in the block. Wins over `caption` and the step text. */
  captions?: string[]
}>(), { frames: undefined, limit: 3, caption: undefined, captions: undefined })

// The page's own text wins over the flow's step text, which is written
// for the docs walkthrough ("On YOUR screen: …"). `caption` alone covers
// only a single shot (one string can't describe several).
function captionFor(frame: { caption: string }, index: number, count: number): string {
  return stripCaption(frame.caption, index, count, { caption: props.caption, captions: props.captions })
}

const LOCALE = 'en'
const base = (variant: string) => `/flows/${props.id}/${LOCALE}/${variant}`

// The manifests are bundled (one lazy chunk each) rather than fetched:
// the server can't fetch its own public files in every setup (dev serves
// them from Vite), and this way SSR needs no request at all.
const manifests = import.meta.glob<unknown>('../../../public/flows/*/en/*-desktop/manifest.json', { import: 'default' })
async function loadManifest(variant: string): Promise<unknown> {
  const load = manifests[`../../../public${base(variant)}/manifest.json`]
  return load ? await load() : null
}

const { data } = await useAsyncData(`flow-strip:${props.id}:${props.frames ?? props.limit}`, async () => {
  const [light, dark] = await Promise.all([loadManifest('light-desktop'), loadManifest('dark-desktop')])
  const strip = flowStripData(light, props.frames, props.limit)
  if (!strip) return null
  // Dark shots only where the dark capture has the same file.
  const darkFiles = new Set(flowStripData(dark, props.frames, 99)?.frames.map(f => f.file) ?? [])
  return { ...strip, frames: strip.frames.map(f => ({ ...f, dark: darkFiles.has(f.file) })) }
})
</script>

<template>
  <div
    v-if="data && data.frames.length"
    class="mk-flow-strip not-prose"
    :class="[`mk-flow-strip--${Math.min(data.frames.length, 3)}`, { 'mk-wide': data.frames.length > 1 }]"
    data-testid="marketing-flow-strip"
  >
    <figure
      v-for="(frame, index) in data.frames"
      :key="frame.file"
      class="mk-flow-strip__item"
    >
      <span class="mk-flow-strip__shot">
        <img
          loading="lazy"
          class="mk-flow-strip__img mk-flow-strip__img--light"
          :src="`${base('light-desktop')}/${frame.file}`"
          :alt="captionFor(frame, index, data.frames.length)"
          :width="data.width"
          :height="data.height"
          decoding="async"
        >
        <img
          v-if="frame.dark"
          loading="lazy"
          class="mk-flow-strip__img mk-flow-strip__img--dark"
          :src="`${base('dark-desktop')}/${frame.file}`"
          alt=""
          aria-hidden="true"
          :width="data.width"
          :height="data.height"
          decoding="async"
        >
      </span>
      <figcaption class="mk-flow-strip__caption">
        {{ captionFor(frame, index, data.frames.length) }}
      </figcaption>
    </figure>
  </div>
</template>

<style scoped>
.mk-flow-strip {
  display: grid;
  gap: 20px;
  margin: 24px 0 32px;
  grid-template-columns: minmax(0, 1fr);
}
@media (min-width: 640px) {
  .mk-flow-strip--2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mk-flow-strip--3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
.mk-flow-strip__item { margin: 0; min-width: 0; }
.mk-flow-strip__shot {
  display: block;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--ui-bg-muted);
}
.mk-flow-strip__img {
  display: block;
  width: 100%;
  height: auto;
}
.mk-flow-strip__img--dark { display: none; }
html.dark .mk-flow-strip__img--light:has(+ .mk-flow-strip__img--dark) { display: none; }
html.dark .mk-flow-strip__img--dark { display: block; }
.mk-flow-strip__caption {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
</style>
