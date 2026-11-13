<script setup lang="ts">
import type * as Y from 'yjs'

// The Activity panel in the editor's right sidebar.
defineProps<{
  docId: string
  ydoc: Y.Doc
  readOnly: boolean
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
</script>

<template>
  <div
    class="h-full flex flex-col bg-muted"
  >
    <!-- Same Fraunces title register as the Comments panel. -->
    <div class="p-3 border-b border-default/60 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-activity"
          class="size-4 text-muted"
        />
        <h3 class="font-serif text-base font-normal tracking-tight">
          {{ t('activity.title') }}
        </h3>
      </div>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="xs"
        class="mk-panel-close"
        data-testid="panel-close"
        :aria-label="t('common.close')"
        @click="emit('close')"
      />
    </div>
    <!-- Owns padding + scrolling; `bg-muted` is on the panel root. -->
    <div class="flex-1 overflow-y-auto p-2 min-h-0">
      <CollabActivityFeed
        :doc-id="docId"
        :ydoc="ydoc"
        :read-only="readOnly"
      />
    </div>
  </div>
</template>
