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
  <!-- Title as a div: a <p> would take main.css's `.prose p` size. -->
  <UPageCTA
    :as="{ root: 'aside', title: 'div' }"
    :title="title"
    variant="outline"
    class="mk-cta not-prose my-10"
    :ui="{
      root: 'rounded-[10px] border border-default ring-0',
      container: 'px-6 py-7 sm:px-6 sm:py-7 lg:px-6 lg:py-7 gap-0 sm:gap-0',
      title: 'mb-2 text-wrap text-[length:clamp(24px,3.5vw,32px)] sm:text-[length:clamp(24px,3.5vw,32px)] leading-[1.15]',
      description: 'mt-0 mx-auto max-w-[48ch] text-[15px] sm:text-[15px] leading-[1.7] text-sumi-700 dark:text-sumi-200 [&_p]:m-0',
      footer: 'mt-[18px]',
      links: 'gap-x-2 gap-y-2'
    }"
    data-testid="marketing-cta"
  >
    <template #description>
      <slot />
    </template>
    <template #links>
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
    </template>
  </UPageCTA>
</template>

<style scoped>
/* Buttons, not prose links: main.css's `.prose a` underline is unlayered
   CSS, which no utility class outranks. */
.mk-cta :deep([data-slot="links"] a) { text-decoration: none; }
</style>
