<script setup lang="ts">
// The editor's status bar, a colophon strip in mono micro-meta: word, page
// and character counts, sync and read-only state.
defineProps<{
  wordCount: number
  charCount: number
  /** Pages of the paged preview (0 while it isn't shown or paginated). */
  pageCount: number
  viewMode: 'edit' | 'preview' | 'split'
  synced: boolean
  readOnly: boolean
}>()
const { t } = useI18n()
</script>

<template>
  <footer class="border-t border-default/60 bg-muted px-4 py-1.5 flex items-center justify-between font-mono text-[10.5px] tracking-[0.04em] text-muted shrink-0">
    <div class="flex items-center gap-3">
      <span data-testid="word-count">{{ wordCount }} <span class="opacity-70">{{ t('editor.footer.words', wordCount) }}</span></span>
      <span
        class="opacity-50"
        aria-hidden="true"
      >·</span>
      <span
        v-if="viewMode !== 'edit' && pageCount > 0"
        data-testid="page-count"
      >{{ pageCount }} <span class="opacity-70">{{ t('editor.footer.pages', pageCount) }}</span></span>
      <span
        v-if="viewMode !== 'edit' && pageCount > 0"
        class="opacity-50"
        aria-hidden="true"
      >·</span>
      <span data-testid="char-count">{{ charCount }} <span class="opacity-70">{{ t('editor.footer.chars', charCount) }}</span></span>
    </div>
    <div
      class="flex items-center gap-3"
      data-testid="sync-status"
    >
      <span
        v-if="synced"
        class="inline-flex items-center gap-1.5"
      >
        <span
          class="block size-1.5 rounded-full bg-green-600 dark:bg-green-500"
          aria-hidden="true"
        />
        {{ t('status.synced') }}
      </span>
      <span
        v-if="readOnly"
        class="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-400"
      >
        <UIcon
          name="i-lucide-lock"
          class="size-3"
        />
        {{ t('editor.footer.readOnly') }}
      </span>
    </div>
  </footer>
</template>
