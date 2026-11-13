<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import { useCoverDate } from '~/composables/document/themeFieldOptions'

// The theme panel under a locked workspace design (brand kit): only the
// cover text is the document's own.
defineProps<{
  /** The viewer can unlock / change the workspace design (admin). */
  canManageBrand?: boolean
  workspaceId?: string | null
}>()
const theme = defineModel<DocTheme>('theme', { required: true })
const { t } = useI18n()
const coverDate = useCoverDate(theme)
</script>

<template>
  <div
    class="space-y-4"
    data-testid="theme-brand-locked"
  >
    <div class="rounded-md border border-default bg-default p-3 space-y-2">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-lock"
          class="size-4 text-muted"
        />
        <p class="text-sm font-medium">
          {{ t('brandKit.lockedTitle') }}
        </p>
      </div>
      <p class="text-xs text-muted">
        {{ t('brandKit.lockedBody') }}
      </p>
      <UButton
        v-if="canManageBrand && workspaceId"
        :to="`/w/${workspaceId}?tab=brand`"
        color="neutral"
        variant="outline"
        size="xs"
        icon="i-lucide-palette"
      >
        {{ t('brandKit.openBrandKit') }}
      </UButton>
    </div>
    <UFormField :label="t('theme.cover.subtitle')">
      <UInput
        v-model="theme.cover.subtitle"
        maxlength="200"
        class="w-full"
        data-testid="theme-locked-subtitle"
      />
    </UFormField>
    <UFormField
      :label="t('theme.cover.date')"
      :help="t('theme.cover.dateHelp')"
    >
      <UInput
        v-model="coverDate"
        type="date"
        class="w-full"
      />
    </UFormField>
    <UFormField :label="t('theme.cover.authors')">
      <DocumentThemeAuthorsField v-model:theme="theme" />
    </UFormField>
  </div>
</template>
