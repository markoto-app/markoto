<script setup lang="ts">
// "Start writing": opens the new-document dialog (the same one as the
// home page: anonymous visitors pass the terms + bot-check gate there)
// and opens the created document. Used by the marketing header and the
// `::cta` content block; `templateId` pre-selects a template (text + its
// design) in the dialog ("Use this template"), `themePreset` puts another
// built-in design on it. The dialog
// mounts on the first click (useNewDocDialog), so a marketing page
// doesn't ship its code.
withDefaults(defineProps<{
  label?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  testid?: string
  templateId?: string
  themePreset?: string
}>(), {
  label: undefined,
  size: 'md',
  testid: 'marketing-start-writing',
  templateId: undefined,
  themePreset: undefined
})

const { t } = useI18n()
const router = useRouter()
const { mounted, open, show, warm } = useNewDocDialog(() => import('~/components/document/NewDocumentDialog.vue'))

function onCreated(docId: string): void {
  void router.push(`/d/${docId}`)
}
</script>

<template>
  <!-- One root, so a `class` from the parent lands on it. -->
  <span>
    <UButton
      color="neutral"
      :size="size"
      :data-testid="testid"
      data-early-click
      @click="show"
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
  </span>
</template>
