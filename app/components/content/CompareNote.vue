<script setup lang="ts">
import { fetchCompareData } from '~/utils/marketingPage'

// Trademark note at the end of a comparison page:
//
//   ::compare-note{competitor="hackmd"}
//   ::
//
// The page's source list (`::compare-sources`) is for our own periodic
// fact checks and stays commented out in the page source.
const props = defineProps<{ competitor: string }>()

const { t } = useI18n()

const { data } = await useAsyncData(`compare:${props.competitor}`, () => fetchCompareData(props.competitor))
</script>

<template>
  <!-- A div, not a <p>: the prose styles would recolour a paragraph. -->
  <div
    v-if="data"
    class="not-prose mt-10 text-xs leading-[1.6] text-muted"
    data-testid="marketing-compare-note"
  >
    {{ t('marketing.compare.trademarkNote', { name: data.name }) }}
  </div>
</template>
