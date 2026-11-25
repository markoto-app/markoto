<script setup lang="ts">
// "Start writing": a first-time anonymous visitor gets the Demo document
// at once (after the terms + bot check); everyone else the new-document
// dialog (the same one as the home page). Then opens the created document. Used by the marketing header and the
// `::cta` content block; `templateId` pre-selects a template (text + its
// design) in the dialog ("Use this template"), `themePreset` puts another
// built-in design on it. The dialog
// mounts on the first click (useNewDocDialog), so a marketing page
// doesn't ship its code.
const props = withDefaults(defineProps<{
  label?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  testid?: string
  templateId?: string
  themePreset?: string
  /** `link`: an inline text link (the pricing page's "write without an account"). */
  variant?: 'solid' | 'link'
}>(), {
  label: undefined,
  size: 'md',
  testid: 'marketing-start-writing',
  templateId: undefined,
  themePreset: undefined,
  variant: 'solid'
})

const { t } = useI18n()
const router = useRouter()
const { mounted, open, start, warm, quickMounted, quickRun, quickBusy, quickDone } = useStartWriting(() => import('~/components/document/NewDocumentDialog.vue'))
const carryLocale = useCarryMarketingLocale()

// A first-time anonymous visitor gets the Demo document at once; "Use this
// template" (a template picked on the page) keeps the dialog.
function onClick(): void {
  start({ dialog: props.templateId !== undefined || props.themePreset !== undefined })
}

function onCreated(docId: string): void {
  // The app keeps the language of the page the visitor was reading.
  carryLocale()
  void router.push(`/d/${docId}`)
}
</script>

<template>
  <!-- One root, so a `class` from the parent lands on it. -->
  <span>
    <UButton
      color="neutral"
      :size="size"
      :variant="variant"
      :class="variant === 'link' ? 'p-0 underline text-default' : undefined"
      :data-testid="testid"
      data-early-click
      :loading="quickBusy"
      @click="onClick"
      @pointerenter="warm"
      @focus="warm"
    >
      {{ label ?? t('tour.cta.start') }}
    </UButton>
    <LazyDocumentNewDocumentDialog
      v-if="mounted"
      v-model:open="open"
      :workspace-id="null"
      :initial-template-id="templateId"
      :initial-theme-preset="themePreset"
      @created="onCreated"
    />
    <LazyDocumentQuickStartDocument
      v-if="quickMounted"
      :run="quickRun"
      @created="onCreated"
      @done="quickDone"
    />
  </span>
</template>
