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
    class="mk-wide not-prose my-8"
    data-testid="page-shots"
  >
    <!-- Phones: one sheet at 70% of the width, the row scrolls sideways
         in its own box. From `sm`: one grid column per page. -->
    <div
      class="grid grid-flow-col auto-cols-[70%] gap-3 overflow-x-auto snap-x snap-mandatory rounded-[10px] bg-elevated p-3 sm:grid-flow-row sm:auto-cols-auto sm:grid-cols-[repeat(var(--mk-shots,3),minmax(0,1fr))] sm:gap-4 sm:overflow-x-visible sm:snap-none sm:p-5"
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
        class="block h-auto w-full aspect-[720/1019] snap-start border border-default bg-white"
      >
    </div>
    <figcaption
      v-if="caption"
      class="mt-2.5 text-sm leading-normal text-muted"
    >
      {{ caption }}
    </figcaption>
  </figure>
</template>
