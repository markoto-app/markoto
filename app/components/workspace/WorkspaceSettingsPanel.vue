<script setup lang="ts">
import { useSavedThemes } from '~/queries/themes'
import { useUpdateWorkspace } from '~/queries/workspaces'
import type { DocTheme } from '~~/shared/types/theme'
import { THEME_PRESETS } from '~~/shared/utils/theme/themePresets'
import { jsonEqual } from '~~/shared/utils/jsonEqual'
import { fontStylesheetUrls } from '~~/shared/utils/theme/themeFonts'

// Workspace settings tab: admin-only. Currently the default-theme picker;
// further workspace-wide settings go in as additional `<section>`s.
//
// Default-theme model: pick a built-in preset OR one of the admin's
// own saved themes, OR clear (revert to "use markoto when creating
// new docs"). The default is a SNAPSHOT, applied at creation time
// only, never retroactively. Existing docs keep whatever theme they
// have, even if the workspace default later changes.

const props = defineProps<{
  workspaceId: string
  defaultTheme: DocTheme | null
}>()

const emit = defineEmits<{
  // Bubble updates to the page so it can keep its own copy of
  // `data.workspace.defaultTheme` in sync without re-fetching the
  // whole workspace.
  updated: [DocTheme | null]
}>()

const { t } = useI18n()
const toast = useToast()
const { showError } = useErrorHandler()

// The admin's own saved themes; a failed load leaves the built-in presets.
const { themes: savedThemes } = useSavedThemes()
const saving = ref(false)
const updateWorkspace = useUpdateWorkspace()

// Link the (same-origin) stylesheet of every preset's heading font so
// each card renders in its own typography. Same approach the new-doc
// dialog uses for its theme cards.
useHead({
  link: fontStylesheetUrls(THEME_PRESETS.map(p => p.theme.headings.font)).map(href => ({
    key: `workspace-settings-theme-fonts-${href}`,
    rel: 'stylesheet',
    href
  }))
})

// Match a theme by structural equality: the stored default comes back
// from a jsonb column whose key order differs from the in-code preset.
function isCurrentTheme(t: DocTheme): boolean {
  if (!props.defaultTheme) return false
  return jsonEqual(t, props.defaultTheme)
}

const isClearActive = computed(() => props.defaultTheme === null)

// The built-in preset the workspace default matches, for the picker's
// highlight (null when the default is a saved design or none is set).
const selectedPresetId = computed(() =>
  THEME_PRESETS.find(p => isCurrentTheme(p.theme))?.id ?? null
)

async function persist(theme: DocTheme | null) {
  if (saving.value) return
  saving.value = true
  try {
    await updateWorkspace.mutateAsync({ workspaceId: props.workspaceId, body: { defaultTheme: theme } })
    emit('updated', theme)
    toast.add({
      title: t('workspace.settings.defaultTheme.savedTitle'),
      description: theme === null
        ? t('workspace.settings.defaultTheme.clearedToast')
        : t('workspace.settings.defaultTheme.appliedToast'),
      icon: 'i-lucide-palette',
      color: 'success'
    })
  } catch (e) {
    showError('workspace.settings.defaultTheme.failedTitle', e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="space-y-6">
    <header class="space-y-1">
      <h2 class="font-serif text-2xl font-normal tracking-tight">
        {{ t('workspace.settings.title') }}
      </h2>
      <p class="text-sm text-muted">
        {{ t('workspace.settings.subtitle') }}
      </p>
    </header>

    <section class="space-y-3">
      <div class="space-y-1">
        <h3 class="font-serif text-lg font-normal tracking-tight">
          {{ t('workspace.settings.defaultTheme.title') }}
        </h3>
        <p class="text-xs text-muted">
          {{ t('workspace.settings.defaultTheme.help') }}
        </p>
      </div>

      <!-- Clear card: sits at the top so reverting to "use markoto"
           is one tap away. Highlighted when no default is set. -->
      <button
        type="button"
        data-testid="workspace-default-theme-clear"
        class="w-full text-left rounded-md border p-3 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        :class="isClearActive
          ? 'border-primary bg-primary/5'
          : 'border-default bg-default hover:border-default/80 hover:bg-default/80'"
        :disabled="saving"
        @click="persist(null)"
      >
        <div class="flex items-center gap-2 mb-1">
          <UIcon
            name="i-lucide-circle-slash"
            class="size-3.5 text-muted"
          />
          <span class="text-sm font-medium">
            {{ t('workspace.settings.defaultTheme.useGlobal') }}
          </span>
          <UIcon
            v-if="isClearActive"
            name="i-lucide-check"
            class="size-3.5 text-primary ml-auto"
          />
        </div>
        <p class="text-xs text-muted leading-snug">
          {{ t('workspace.settings.defaultTheme.useGlobalHelp') }}
        </p>
      </button>

      <!-- Same design picker as the new-document dialog and the theme
           panel: audience tabs over a picture of each design's first page;
           the admin's own saved designs come first (and under "My
           designs"). A click makes it the workspace default. -->
      <DocumentThemePresetGrid
        testid-prefix="workspace-default-theme-preset-"
        :columns="4"
        :saved-tab="savedThemes.length > 0"
        :selected-id="selectedPresetId"
        @select="(preset) => persist(preset.theme)"
      >
        <template #before="{ tab }">
          <template v-if="tab === 'all' || tab === 'saved'">
            <DocumentPictureCard
              v-for="saved in savedThemes"
              :key="saved.themeId"
              :testid="`workspace-default-theme-saved-${saved.themeId}`"
              :description-testid="`workspace-default-theme-saved-description-${saved.themeId}`"
              :name="saved.name"
              :description="saved.description || t('theme.saved.fallbackDescription', { heading: saved.theme.headings.font, body: saved.theme.body.font })"
              :selected="isCurrentTheme(saved.theme)"
              :brand="saved.theme.color.brand"
              :heading-font="saved.theme.headings.font"
              @click="persist(saved.theme)"
            />
          </template>
        </template>
      </DocumentThemePresetGrid>
    </section>
  </section>
</template>
