<script setup lang="ts">
import type { SavedTheme } from '~/utils/api/types/themes'

// "Your themes" in the theme panel: one card per saved theme (same card as
// the built-in presets: name in the theme's heading face, one description
// line) with edit and delete actions.
defineProps<{
  themes: SavedTheme[]
}>()
const emit = defineEmits<{
  apply: [saved: SavedTheme]
  edit: [saved: SavedTheme]
  delete: [saved: SavedTheme]
}>()
const { t } = useI18n()
</script>

<template>
  <section class="mb-4">
    <div class="flex items-baseline justify-between mb-2 px-1">
      <h4 class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted">
        {{ t('theme.saved.title') }}
      </h4>
    </div>
    <div class="grid grid-cols-1 gap-2">
      <!-- Same card as the built-in presets below (name in the
           theme's heading face, one description line) plus two
           neutral icon actions. The trash stays sumi; the error
           colour only appears in the confirmation dialog. -->
      <div
        v-for="saved in themes"
        :key="saved.themeId"
        :data-testid="`theme-saved-${saved.themeId}`"
        class="relative rounded-md border border-default bg-default hover:border-default/80 hover:bg-default/80 transition-colors"
      >
        <button
          type="button"
          class="block w-full text-left p-3 pr-18 rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          :data-testid="`saved-theme-apply-${saved.themeId}`"
          @click="emit('apply', saved)"
        >
          <div class="flex items-center gap-2 mb-1">
            <span
              class="size-3 rounded-full shrink-0"
              :style="{ backgroundColor: saved.theme.color.brand }"
            />
            <span
              class="text-sm font-medium truncate"
              :style="{ fontFamily: `'${saved.theme.headings.font}', system-ui, sans-serif` }"
            >
              {{ saved.name }}
            </span>
          </div>
          <p
            class="text-xs text-muted leading-snug line-clamp-2"
            :data-testid="`saved-theme-description-${saved.themeId}`"
          >
            {{ saved.description || t('theme.saved.fallbackDescription', { heading: saved.theme.headings.font, body: saved.theme.body.font }) }}
          </p>
        </button>
        <div class="absolute top-1.5 right-1.5 flex items-center gap-0.5">
          <UTooltip :text="t('theme.saved.edit')">
            <UButton
              :aria-label="t('theme.saved.editAria', { name: saved.name })"
              icon="i-lucide-pencil"
              color="neutral"
              variant="ghost"
              size="xs"
              class="text-muted hover:text-default"
              :data-testid="`saved-theme-edit-${saved.themeId}`"
              @click.stop="emit('edit', saved)"
            />
          </UTooltip>
          <UTooltip :text="t('theme.saved.delete')">
            <UButton
              :aria-label="t('theme.saved.deleteAria', { name: saved.name })"
              icon="i-lucide-trash-2"
              color="neutral"
              variant="ghost"
              size="xs"
              class="text-muted hover:text-default"
              :data-testid="`saved-theme-delete-${saved.themeId}`"
              @click.stop="emit('delete', saved)"
            />
          </UTooltip>
        </div>
      </div>
    </div>
  </section>
</template>
