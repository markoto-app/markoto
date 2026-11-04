<script setup lang="ts">
import { compareTable, formatCheckedDate, oldestCheck } from '~~/shared/seo/compare'
import { fetchCompareData } from '~/utils/marketingPage'

// Feature table of a comparison page, built from its claim data
// (content/compare/<competitor>.yml):
//
//   ::compare-facts{competitor="hackmd"}
//   ::
//
// markoto in the first column, the competitor in the second; the caption
// says when the facts were checked. The sources are listed by
// `::compare-sources` at the end of the page.
const props = defineProps<{ competitor: string }>()

const { t, locale } = useI18n()

const { data } = await useAsyncData(`compare:${props.competitor}`, () => fetchCompareData(props.competitor))

const table = computed(() => (data.value ? compareTable(data.value) : null))

const caption = computed(() => {
  const checked = data.value ? oldestCheck(data.value) : null
  if (!checked) return undefined
  return t('marketing.compare.caption', { date: formatCheckedDate(checked, locale.value) })
})
</script>

<template>
  <CompareTable
    v-if="table"
    :columns="table.columns"
    :rows="table.rows"
    :caption="caption"
  />
</template>
