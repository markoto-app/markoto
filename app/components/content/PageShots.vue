<script setup lang="ts">
// Static pictures of printed pages, for marketing content where a live
// `::try-it` doesn't suit (a document too long to edit in a box):
//
//   ::page-shots{caption="Three of the twelve pages."}
//   ---
//   pages:
//     - src: /tour/light/share/sharePdf-0-720.webp
//       small: /tour/light/share/sharePdf-0-400.webp
//       alt: The executive summary page.
//   ---
//   ::
//
// A row of A4 sheets on desktop; on phones the row scrolls sideways
// inside its own box (never the page). Pages are white paper in both
// colour modes, like the preview.
interface Shot {
  src: string
  /** Optional 400px-wide version for the srcset. */
  small?: string
  alt: string
}

const props = withDefaults(defineProps<{
  pages?: Shot[]
  caption?: string
}>(), { pages: () => [], caption: undefined })

function srcset(shot: Shot): string | undefined {
  return shot.small ? `${shot.small} 400w, ${shot.src} 720w` : undefined
}

const count = computed(() => props.pages.length)
</script>

<template>
  <figure
    class="mk-page-shots mk-wide not-prose"
    data-testid="page-shots"
  >
    <div
      class="mk-page-shots__row"
      :style="{ '--mk-shots': count }"
    >
      <img
        v-for="shot in pages"
        :key="shot.src"
        loading="lazy"
        :src="shot.src"
        :srcset="srcset(shot)"
        sizes="(max-width: 639px) 70vw, 340px"
        :alt="shot.alt"
        width="720"
        height="1019"
        class="mk-page-shots__page"
      >
    </div>
    <figcaption
      v-if="caption"
      class="mk-page-shots__caption"
    >
      {{ caption }}
    </figcaption>
  </figure>
</template>

<style scoped>
.mk-page-shots {
  margin: 32px 0;
}
.mk-page-shots__row {
  display: grid;
  grid-template-columns: repeat(var(--mk-shots, 3), minmax(0, 1fr));
  gap: 16px;
  padding: 20px;
  border-radius: 10px;
  background: var(--ui-bg-elevated);
}
.mk-page-shots__page {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 720 / 1019;
  background: #fff;
  border: 1px solid var(--ui-border);
}
.mk-page-shots__caption {
  margin-top: 10px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
@media (max-width: 639px) {
  .mk-page-shots__row {
    grid-template-columns: none;
    grid-auto-flow: column;
    grid-auto-columns: 70%;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    padding: 12px;
    gap: 12px;
  }
  .mk-page-shots__page {
    scroll-snap-align: start;
  }
}
</style>
