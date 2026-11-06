<script setup lang="ts">
// The template hub's grid (content/marketing/en/templates/index.md):
//
//   ::template-cards
//   ---
//   items:
//     - to: /templates/resume
//       title: Resume
//       image: /templates/resume.webp
//       text: A one-page CV …
//       link: The resume template
//   ---
//   ::
//
// One card per template: a picture of its first page (white paper in
// both colour modes, `public/templates/<id>.webp`, captured from the
// page's preview), the name as a heading, one line, and a link. The whole
// card is the link's target area; the visible link text stays for
// screen readers and crawlers.
interface TemplateCard {
  to: string
  title: string
  image: string
  text: string
  link: string
}

withDefaults(defineProps<{ items?: TemplateCard[] }>(), { items: () => [] })

// A 1px border, not the outline variant's ring: the ring sits outside
// the box and would make the card 2px narrower inside.
// UPageCard without `to`: its own link would carry only an aria-label,
// the visible link text below is what crawlers and screen readers read.
// The picture sits in the header slot on the elevated field, cut off at
// a fixed height; title, line and link below.
const cardUi = {
  root: 'rounded-[10px] overflow-hidden border border-default ring-0 hover:border-accented has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-(--ui-text)',
  container: 'p-0 sm:p-0 gap-0 gap-y-0 lg:flex',
  wrapper: 'items-stretch',
  header: 'mb-0 h-[200px] sm:h-[240px] overflow-hidden bg-elevated px-7 pt-5',
  body: 'flex flex-col px-[18px] pt-4',
  description: 'mt-1.5 flex-1 text-wrap text-sm leading-[1.55] text-muted',
  footer: 'mt-0 flex flex-col items-start px-[18px] pt-3 pb-[18px]'
}
</script>

<template>
  <UPageGrid
    class="mk-wide not-prose mt-9 mb-12 gap-4 sm:gap-5"
    data-testid="template-cards"
  >
    <UPageCard
      v-for="card in items"
      :key="card.to"
      as="article"
      variant="outline"
      :ui="cardUi"
    >
      <template #header>
        <img
          loading="lazy"
          :src="card.image"
          alt=""
          width="600"
          height="850"
          class="block h-auto w-full border border-b-0 border-default bg-white"
        >
      </template>
      <template #title>
        <h2 class="mk-template-card__title">
          {{ card.title }}
        </h2>
      </template>
      <template #description>
        {{ card.text }}
      </template>
      <template #footer>
        <!-- The whole card is the link's target area (`after:` covers
             the card); the visible text stays the anchor text. -->
        <NuxtLink
          :to="card.to"
          class="mk-template-card__link after:absolute after:inset-0 focus-visible:outline-none"
        >
          {{ card.link }}
        </NuxtLink>
      </template>
    </UPageCard>
  </UPageGrid>
</template>

<style scoped>
/* The title and the link sit inside the marketing page's prose, whose
   heading and link rules (main.css `.prose h2` / `.prose a`, the page's
   `:deep(h2)`) are unlayered CSS: utility classes can't outrank them. */
.mk-template-card__title {
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
}
.mk-template-card__link {
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--ui-border-accented);
}
</style>
