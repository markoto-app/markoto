<script setup lang="ts">
// "Start writing": opens the new-document dialog (the same one as the
// home page — anonymous visitors pass the terms + bot-check gate there)
// and opens the created document. Used by the marketing header and the
// `::cta` content block.
withDefaults(defineProps<{
  label?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  testid?: string
}>(), {
  label: undefined,
  size: 'md',
  testid: 'marketing-start-writing'
})

const { t } = useI18n()
const router = useRouter()
const open = ref(false)

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
      @click="open = true"
    >
      {{ label ?? t('tour.cta.start') }}
    </UButton>
    <DocumentNewDocumentDialog
      v-model:open="open"
      :workspace-id="null"
      @created="onCreated"
    />
  </span>
</template>
