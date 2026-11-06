<script setup lang="ts">
import { faqStructuredData, serializeJsonLd, type FaqItem } from '~~/shared/seo/structuredData'

// Questions and answers for marketing content:
//
//   ::faq{json-ld}
//   ---
//   items:
//     - q: Is it free?
//       a: Yes. …
//   ---
//   ::
//
// Answers are plain text (the same string goes into the optional
// FAQPage JSON-LD, which must match what the page shows). Each pair is a
// <details>: closed, but every answer is in the server-rendered HTML.
// Deliberately not UAccordion: <details> opens without JavaScript (the
// page paints from the server render, its code follows), and the
// browser's find-in-page reaches the closed answers.
const props = withDefaults(defineProps<{
  items: FaqItem[]
  /** Also emit FAQPage JSON-LD. */
  jsonLd?: boolean
}>(), { jsonLd: false })

const { locale, localeProperties } = useI18n()

useHead(() => (props.jsonLd && props.items.length
  ? {
      script: [{
        key: 'ld-faq',
        type: 'application/ld+json',
        innerHTML: serializeJsonLd(faqStructuredData(props.items, localeProperties.value.language ?? locale.value))
      }]
    }
  : {}))
</script>

<template>
  <div
    class="not-prose mt-4 mb-7 border-t border-default"
    data-testid="marketing-faq"
  >
    <details
      v-for="item in items"
      :key="item.q"
      class="group border-b border-default"
    >
      <summary
        class="flex cursor-pointer list-none justify-between gap-3 px-0.5 py-3.5 font-serif text-lg leading-normal tracking-[-0.01em] [&::-webkit-details-marker]:hidden after:font-mono after:text-muted after:content-['+'] group-open:after:content-['−']"
      >
        {{ item.q }}
      </summary>
      <!-- A div, not a <p>: main.css's `.prose p` would restyle it. -->
      <div class="mx-0.5 mb-4 text-[15px] leading-[1.65] text-muted">
        {{ item.a }}
      </div>
    </details>
  </div>
</template>
