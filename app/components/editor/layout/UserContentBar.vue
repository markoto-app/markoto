<script setup lang="ts">
// "Created by a markoto user, not by markoto · Report": on documents written
// by anonymous visitors, not the operator. Links the report form
// prefilled with this document's URL.
const props = defineProps<{
  docId: string
}>()
const { t } = useI18n()
const reportContentLink = computed(() => {
  const url = import.meta.client ? `${globalThis.location.origin}/d/${props.docId}` : `/d/${props.docId}`
  return { path: '/legal/abuse', query: { url } }
})
</script>

<template>
  <div
    class="border-b border-default bg-muted px-4 py-1 flex items-center gap-2 font-mono text-[10.5px] tracking-wide text-muted shrink-0"
    data-testid="user-content-bar"
  >
    <UIcon
      name="i-lucide-info"
      class="size-3.5 shrink-0"
    />
    <span class="min-w-0 truncate">{{ t('userContent.notice') }}</span>
    <span aria-hidden="true">·</span>
    <NuxtLink
      :to="reportContentLink"
      class="underline shrink-0"
      data-testid="user-content-report"
    >
      {{ t('userContent.report') }}
    </NuxtLink>
  </div>
</template>
