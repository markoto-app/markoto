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
    class="mk-faq not-prose"
    data-testid="marketing-faq"
  >
    <details
      v-for="item in items"
      :key="item.q"
      class="mk-faq__item"
    >
      <summary class="mk-faq__q">
        {{ item.q }}
      </summary>
      <p class="mk-faq__a">
        {{ item.a }}
      </p>
    </details>
  </div>
</template>

<style scoped>
.mk-faq {
  margin: 16px 0 28px;
  border-top: 1px solid var(--ui-border);
}
.mk-faq__item { border-bottom: 1px solid var(--ui-border); }
.mk-faq__q {
  cursor: pointer;
  list-style: none;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 2px;
  font-family: var(--font-serif);
  font-size: 18px;
  letter-spacing: -0.01em;
}
.mk-faq__q::-webkit-details-marker { display: none; }
.mk-faq__q::after {
  content: '+';
  font-family: var(--font-mono);
  color: var(--ui-text-muted);
}
.mk-faq__item[open] .mk-faq__q::after { content: '−'; }
.mk-faq__a {
  margin: 0 2px 16px;
  font-size: 15px;
  line-height: 1.65;
  color: var(--ui-text-muted);
}
</style>
