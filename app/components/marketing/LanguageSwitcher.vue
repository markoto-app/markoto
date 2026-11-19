<script setup lang="ts">
import { splitMarketingLocale } from '~~/shared/seo/marketing'

// Language switcher of the public marketing pages (site footer): one link
// per language version of the current page (useMarketingLanguages), so
// it navigates to the language's own URL (`/de/pricing`). Plain links:
// they work before the footer hydrates and crawlers can follow them.
// Choosing a language also makes it the visitor's UI language for the app
// (the locale cookie), see useChooseMarketingLanguage. Renders nothing on
// a page without language versions.

const { t, locales } = useI18n()
const route = useRoute()
const variants = useCurrentMarketingVariants()
const choose = useChooseMarketingLanguage()

const current = computed(() => splitMarketingLocale(route.path).locale)
const options = computed(() => variants.value.map(v => ({
  ...v,
  name: locales.value.find(l => l.code === v.locale)?.name ?? v.locale
})))

function onClick(event: MouseEvent, variant: typeof options.value[number]): void {
  // Let the browser handle new-tab / new-window clicks.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
  event.preventDefault()
  void choose(variant)
}
</script>

<template>
  <nav
    v-if="options.length > 1"
    :aria-label="t('marketing.language.label')"
    data-testid="marketing-language-switcher"
  >
    <ul class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px]">
      <li
        v-for="option in options"
        :key="option.locale"
      >
        <span
          v-if="option.locale === current"
          class="text-default"
          aria-current="page"
          :lang="option.locale"
        >{{ option.name }}</span>
        <NuxtLink
          v-else
          :to="option.path"
          :hreflang="option.locale"
          :lang="option.locale"
          class="text-muted transition-colors hover:text-default"
          :data-testid="`marketing-language-${option.locale}`"
          @click="onClick($event, option)"
        >
          {{ option.name }}
        </NuxtLink>
      </li>
    </ul>
  </nav>
</template>
