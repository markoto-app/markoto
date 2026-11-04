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
</script>

<template>
  <div
    class="mk-template-cards mk-wide not-prose"
    data-testid="template-cards"
  >
    <article
      v-for="card in items"
      :key="card.to"
      class="mk-template-card"
    >
      <div class="mk-template-card__sheet">
        <img
          loading="lazy"
          :src="card.image"
          alt=""
          width="600"
          height="850"
          class="mk-template-card__img"
        >
      </div>
      <div class="mk-template-card__body">
        <h2 class="mk-template-card__title">
          {{ card.title }}
        </h2>
        <p class="mk-template-card__text">
          {{ card.text }}
        </p>
        <NuxtLink
          :to="card.to"
          class="mk-template-card__link"
        >
          {{ card.link }}
        </NuxtLink>
      </div>
    </article>
  </div>
</template>

<style scoped>
.mk-template-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
  margin: 36px 0 48px;
}
.mk-template-card {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-bg);
  overflow: hidden;
}
.mk-template-card:hover {
  border-color: var(--ui-border-accented);
}
.mk-template-card__sheet {
  padding: 20px 28px 0;
  background: var(--ui-bg-elevated);
  height: 240px;
  overflow: hidden;
}
.mk-template-card__img {
  display: block;
  width: 100%;
  height: auto;
  background: #fff;
  border: 1px solid var(--ui-border);
  border-bottom: 0;
}
.mk-template-card__body {
  padding: 16px 18px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}
.mk-template-card__title {
  font-family: var(--font-serif);
  font-weight: 400;
  font-size: 20px;
  line-height: 1.2;
  letter-spacing: -0.01em;
  margin: 0;
}
.mk-template-card__text {
  font-size: 14px;
  line-height: 1.55;
  color: var(--ui-text-muted);
  margin: 0;
  flex: 1;
}
.mk-template-card__link {
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: var(--ui-border-accented);
  margin-top: 6px;
}
/* The whole card is the click target. */
.mk-template-card__link::after {
  content: '';
  position: absolute;
  inset: 0;
}
.mk-template-card__link:focus-visible {
  outline: none;
}
.mk-template-card:has(.mk-template-card__link:focus-visible) {
  outline: 2px solid var(--ui-text);
  outline-offset: 2px;
}
@media (max-width: 1023px) {
  .mk-template-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 639px) {
  .mk-template-cards { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .mk-template-card__sheet { height: 200px; }
}
</style>
