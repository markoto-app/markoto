<script setup lang="ts">
// Call to action for marketing content:
//
//   ::cta{title="Try it with your own Markdown." secondary-label="Read the docs" secondary-to="/docs"}
//   Free on markoto.app, no sign-up needed.
//   ::
//
// The main button opens the new-document dialog (MarketingStartButton,
// same gate as the home page); `label` replaces its text, `to` turns it
// into a plain link instead. `template` + `theme` pre-select a template
// id and a theme preset in the dialog (the template pages):
//
//   ::cta{title="Start your resume." label="Use this template" template="resume" theme="modern"}
//
// The slot is the line under the title.
withDefaults(defineProps<{
  title?: string
  label?: string
  to?: string
  template?: string
  theme?: string
  secondaryLabel?: string
  secondaryTo?: string
}>(), {
  title: undefined,
  label: undefined,
  to: undefined,
  template: undefined,
  theme: undefined,
  secondaryLabel: undefined,
  secondaryTo: undefined
})
</script>

<template>
  <aside
    class="mk-cta not-prose"
    data-testid="marketing-cta"
  >
    <p
      v-if="title"
      class="mk-cta__title"
    >
      {{ title }}
    </p>
    <div class="mk-cta__body">
      <slot />
    </div>
    <div class="mk-cta__actions">
      <UButton
        v-if="to"
        :to="to"
        color="neutral"
        size="lg"
      >
        {{ label }}
      </UButton>
      <MarketingStartButton
        v-else
        :label="label"
        size="lg"
        :template-id="template"
        :theme-preset="theme"
        :testid="template ? 'cta-use-template' : 'cta-start-writing'"
      />
      <UButton
        v-if="secondaryLabel && secondaryTo"
        :to="secondaryTo"
        color="neutral"
        variant="ghost"
        size="lg"
        trailing-icon="i-lucide-arrow-right"
      >
        {{ secondaryLabel }}
      </UButton>
    </div>
  </aside>
</template>

<style scoped>
.mk-cta {
  margin: 40px 0;
  padding: 28px 24px;
  border-radius: 10px;
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  text-align: center;
}
.mk-cta__title {
  font-family: var(--font-serif);
  font-weight: 300;
  font-size: clamp(24px, 3.5vw, 32px);
  line-height: 1.15;
  letter-spacing: -0.02em;
  margin: 0 0 8px;
}
.mk-cta__body {
  font-size: 15px;
  line-height: 1.6;
  color: var(--ui-text-muted);
  max-width: 48ch;
  margin-inline: auto;
}
.mk-cta__body :deep(p) { margin: 0; }
/* Buttons, not prose links (the article's `.prose a` underline). */
.mk-cta .mk-cta__actions :deep(a) { text-decoration: none; }
.mk-cta__actions {
  margin-top: 18px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
</style>
