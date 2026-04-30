<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'

// Workspace settings tab — admin-only chrome around workspace-wide
// preferences. Currently exposes the default-theme picker; new
// settings (retention, member-policy presets, etc.) slot in as
// additional `<section>`s as we ship them.
//
// Default-theme model: pick a built-in preset OR one of the admin's
// own saved themes, OR clear (revert to "use markoto when creating
// new docs"). The default is a SNAPSHOT — applied at creation time
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

interface SavedTheme {
  themeId: string
  name: string
  theme: DocTheme
  createdAt: string
  updatedAt: string
}

const savedThemes = ref<SavedTheme[]>([])
const saving = ref(false)

async function loadSavedThemes() {
  try {
    const res = await $fetch<{ themes: SavedTheme[] }>('/api/themes')
    savedThemes.value = res.themes
  } catch {
    // Ignore — non-blocking. The built-in presets are still pickable.
  }
}

if (import.meta.client) loadSavedThemes()

// Eagerly preload the heading-font face for every preset so each card
// renders in its own typography. Same approach the new-doc dialog
// uses for its theme cards (`THEME_FONTS` preload via Google Fonts).
useHead({
  link: [{
    key: 'workspace-settings-theme-fonts',
    rel: 'stylesheet',
    href: `https://fonts.googleapis.com/css2?${THEME_PRESETS
      .map(p => `family=${p.theme.headings.font.replace(/ /g, '+')}:wght@400;500;600;700`)
      .join('&')}&display=swap`
  }]
})

// Match a theme to a preset id by deep-equality on the JSON payload —
// avoids "currently selected" highlights drifting when fields are
// added to DocTheme.
function isCurrentTheme(t: DocTheme): boolean {
  if (!props.defaultTheme) return false
  return JSON.stringify(t) === JSON.stringify(props.defaultTheme)
}

const isClearActive = computed(() => props.defaultTheme === null)

async function persist(theme: DocTheme | null) {
  if (saving.value) return
  saving.value = true
  try {
    await $fetch(`/api/workspaces/${props.workspaceId}`, {
      method: 'PUT',
      body: { defaultTheme: theme }
    })
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
    const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
    toast.add({
      title: t('workspace.settings.defaultTheme.failedTitle'),
      description: err.data?.message ?? err.statusMessage ?? err.message ?? '',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
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

    <!-- ── Default theme ──────────────────────────────────────────── -->
    <section class="space-y-3">
      <div class="space-y-1">
        <h3 class="font-serif text-lg font-normal tracking-tight">
          {{ t('workspace.settings.defaultTheme.title') }}
        </h3>
        <p class="text-xs text-muted">
          {{ t('workspace.settings.defaultTheme.help') }}
        </p>
      </div>

      <!-- Clear card — sits at the top so reverting to "use markoto"
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
          <UIcon name="i-lucide-circle-slash" class="size-3.5 text-muted" />
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

      <!-- User-saved themes (admin's own). Section hidden when empty
           so the panel doesn't render a stray empty heading. -->
      <div v-if="savedThemes.length > 0" class="space-y-2">
        <h4 class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted px-1">
          {{ t('theme.saved.title') }}
        </h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            v-for="saved in savedThemes"
            :key="saved.themeId"
            type="button"
            :data-testid="`workspace-default-theme-saved-${saved.themeId}`"
            class="text-left rounded-md border p-3 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            :class="isCurrentTheme(saved.theme)
              ? 'border-primary bg-primary/5'
              : 'border-default bg-default hover:border-default/80 hover:bg-default/80'"
            :disabled="saving"
            @click="persist(saved.theme)"
          >
            <div class="flex items-center gap-2 mb-1">
              <span
                class="size-3 rounded-full shrink-0"
                :style="{ backgroundColor: saved.theme.color.brand }"
              />
              <span
                class="text-sm font-semibold truncate"
                :style="{ fontFamily: `'${saved.theme.headings.font}', system-ui, sans-serif` }"
              >
                {{ saved.name }}
              </span>
              <UIcon
                v-if="isCurrentTheme(saved.theme)"
                name="i-lucide-check"
                class="size-3.5 text-primary ml-auto"
              />
            </div>
          </button>
        </div>
      </div>

      <!-- Built-in presets. Same heading-font preview each card uses
           in the new-doc dialog and the right-rail theme panel. -->
      <div class="space-y-2">
        <h4 class="font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted px-1">
          {{ t('theme.presets.title') }}
        </h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            v-for="preset in THEME_PRESETS"
            :key="preset.id"
            type="button"
            :data-testid="`workspace-default-theme-preset-${preset.id}`"
            class="text-left rounded-md border p-3 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            :class="isCurrentTheme(preset.theme)
              ? 'border-primary bg-primary/5'
              : 'border-default bg-default hover:border-default/80 hover:bg-default/80'"
            :disabled="saving"
            @click="persist(preset.theme)"
          >
            <div class="flex items-center gap-2 mb-1">
              <span
                class="size-3 rounded-full shrink-0"
                :style="{ backgroundColor: preset.theme.color.brand }"
              />
              <span
                class="text-sm font-semibold truncate"
                :style="{ fontFamily: `'${preset.theme.headings.font}', system-ui, sans-serif` }"
              >
                {{ t(`theme.presets.${preset.id}.name`) }}
              </span>
              <UIcon
                v-if="isCurrentTheme(preset.theme)"
                name="i-lucide-check"
                class="size-3.5 text-primary ml-auto"
              />
            </div>
            <p class="text-xs text-muted leading-snug line-clamp-2">
              {{ t(`theme.presets.${preset.id}.description`) }}
            </p>
          </button>
        </div>
      </div>
    </section>
  </section>
</template>
