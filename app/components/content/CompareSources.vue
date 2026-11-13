<script setup lang="ts">
import { compareSources, formatCheckedDate, oldestCheck } from '~~/shared/seo/compare'
import { fetchCompareData } from '~/utils/marketing/marketingPage'

// Footer of a comparison page: when the facts were checked and where
// each one comes from (content/compare/<competitor>.yml), plus the
// trademark note.
//
//   ::compare-sources{competitor="hackmd"}
//   ::
const props = defineProps<{ competitor: string }>()

const { t, locale } = useI18n()

const { data } = await useAsyncData(`compare:${props.competitor}`, () => fetchCompareData(props.competitor))

const sources = computed(() => (data.value ? compareSources(data.value) : null))
const checked = computed(() => {
  const date = data.value ? oldestCheck(data.value) : null
  return date ? formatCheckedDate(date, locale.value) : ''
})
</script>

<template>
  <footer
    v-if="data && sources"
    class="mk-sources not-prose"
    data-testid="marketing-compare-sources"
  >
    <p
      v-if="checked"
      class="mk-sources__checked"
    >
      {{ t('marketing.compare.checked', { date: checked }) }}
    </p>
    <p class="mk-sources__head">
      {{ t('marketing.compare.sources') }} · {{ data.name }}
    </p>
    <ul class="mk-sources__list">
      <li
        v-for="link in sources.competitor"
        :key="link.label"
      >
        <a
          v-if="link.href"
          :href="link.href"
          rel="noopener nofollow"
          target="_blank"
        >{{ link.label }}</a>
      </li>
    </ul>
    <p class="mk-sources__head">
      {{ t('marketing.compare.markotoSources') }}
    </p>
    <ul class="mk-sources__list">
      <li
        v-for="link in sources.markoto"
        :key="link.label"
      >
        <NuxtLink
          v-if="link.href"
          :to="link.href"
        >
          {{ link.label }}
        </NuxtLink>
        <code v-else>{{ link.label }}</code>
      </li>
    </ul>
    <p class="mk-sources__note">
      {{ t('marketing.compare.trademark', { name: data.name }) }}
    </p>
  </footer>
</template>

<style scoped>
.mk-sources {
  margin: 48px 0 0;
  padding-top: 20px;
  border-top: 1px solid var(--ui-border);
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.mk-sources__checked {
  margin: 0 0 12px;
  color: var(--ui-text);
}
.mk-sources__head {
  margin: 14px 0 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.mk-sources__list {
  margin: 0;
  padding-left: 18px;
  list-style: disc;
}
.mk-sources__list :is(a, code) {
  overflow-wrap: anywhere;
}
.mk-sources__list a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.mk-sources__list a:hover { color: var(--ui-text); }
.mk-sources__list code {
  font-family: var(--font-mono);
  font-size: 12px;
}
.mk-sources__note {
  margin: 16px 0 0;
  font-size: 12px;
}
</style>
