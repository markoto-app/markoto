<script setup lang="ts">
import type { DocTheme } from '~~/shared/types/theme'
import {
  SAVED_THEME_DESCRIPTION_MAX,
  SAVED_THEME_NAME_MAX,
  checkSavedThemeDescription,
  checkSavedThemeName
} from '~~/shared/config/savedThemes'

/**
 * Save the current theme as a personal preset, or edit the name and
 * description of one already saved (the pencil on a "Your themes" card).
 * Replaces the browser's `window.prompt`. Limits come from
 * `shared/config/savedThemes.ts`, the same module the API validates with.
 *
 * `mode: 'create'` POSTs `{name, description, theme}`; `mode: 'edit'`
 * PATCHes `{name, description}` of `savedTheme` (the theme itself is
 * left alone). Emits `saved` after a successful request.
 */
const props = defineProps<{
  mode: 'create' | 'edit'
  /** Theme to store (create mode). */
  theme?: DocTheme
  /** The saved theme being edited (edit mode). */
  savedTheme?: { themeId: string, name: string, description?: string }
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{ saved: [name: string] }>()

const { t } = useI18n()
const toast = useToast()

const name = ref('')
const description = ref('')
const submitting = ref(false)
const triedSubmit = ref(false)

watch(open, (v) => {
  if (!v) return
  triedSubmit.value = false
  name.value = props.mode === 'edit' ? (props.savedTheme?.name ?? '') : ''
  description.value = props.mode === 'edit' ? (props.savedTheme?.description ?? '') : ''
}, { immediate: true })

const nameCheck = computed(() => checkSavedThemeName(name.value))
const descriptionCheck = computed(() => checkSavedThemeDescription(description.value))
const canSubmit = computed(() => nameCheck.value.ok && descriptionCheck.value.ok && !submitting.value)
const nameError = computed(() => {
  if (!triedSubmit.value || nameCheck.value.ok) return undefined
  return nameCheck.value.issue === 'too-long'
    ? t('theme.saved.nameTooLong', { max: SAVED_THEME_NAME_MAX })
    : t('theme.saved.nameRequired')
})

async function submit() {
  triedSubmit.value = true
  const n = nameCheck.value
  const d = descriptionCheck.value
  if (!n.ok || !d.ok || submitting.value) return
  submitting.value = true
  try {
    if (props.mode === 'create') {
      await $fetch('/api/themes', {
        method: 'POST',
        body: { name: n.value, description: d.value, theme: props.theme }
      })
    } else if (props.savedTheme) {
      await $fetch(`/api/themes/${props.savedTheme.themeId}`, {
        method: 'PATCH',
        body: { name: n.value, description: d.value }
      })
    }
    open.value = false
    emit('saved', n.value)
  } catch (e) {
    const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
    toast.add({
      title: props.mode === 'create' ? t('theme.saved.saveFailedTitle') : t('theme.saved.updateFailedTitle'),
      description: err.data?.message ?? err.statusMessage ?? err.message ?? '',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  } finally {
    submitting.value = false
  }
}

const numberFormat = new Intl.NumberFormat()
</script>

<template>
  <UModal
    v-model:open="open"
    :title="mode === 'create' ? t('theme.saved.saveDialogTitle') : t('theme.saved.editDialogTitle')"
    :description="mode === 'create' ? t('theme.saved.saveDialogIntro') : t('theme.saved.editDialogIntro')"
  >
    <template #content>
      <form
        class="p-6 space-y-5"
        data-testid="saved-theme-dialog"
        novalidate
        @submit.prevent="submit"
      >
        <div>
          <h2 class="font-serif text-2xl font-normal tracking-tight">
            {{ mode === 'create' ? t('theme.saved.saveDialogTitle') : t('theme.saved.editDialogTitle') }}
          </h2>
          <p class="text-sm text-muted mt-1.5 leading-relaxed">
            {{ mode === 'create' ? t('theme.saved.saveDialogIntro') : t('theme.saved.editDialogIntro') }}
          </p>
        </div>

        <UFormField
          :label="t('theme.saved.nameLabel')"
          :error="nameError"
          name="name"
          required
        >
          <template #hint>
            <span class="font-mono text-[10.5px] tracking-[0.04em] text-muted">
              {{ numberFormat.format(name.trim().length) }} / {{ numberFormat.format(SAVED_THEME_NAME_MAX) }}
            </span>
          </template>
          <UInput
            v-model="name"
            :placeholder="t('theme.saved.namePlaceholder')"
            :maxlength="SAVED_THEME_NAME_MAX"
            autofocus
            class="w-full"
            data-testid="saved-theme-name-input"
          />
        </UFormField>

        <UFormField
          :label="t('theme.saved.descriptionLabel')"
          name="description"
        >
          <template #hint>
            <span class="font-mono text-[10.5px] tracking-[0.04em] text-muted">
              {{ t('theme.saved.descriptionOptional') }} · {{ numberFormat.format(description.trim().length) }} / {{ numberFormat.format(SAVED_THEME_DESCRIPTION_MAX) }}
            </span>
          </template>
          <UTextarea
            v-model="description"
            :placeholder="t('theme.saved.descriptionPlaceholder')"
            :maxlength="SAVED_THEME_DESCRIPTION_MAX"
            :rows="3"
            autoresize
            class="w-full"
            data-testid="saved-theme-description-input"
          />
        </UFormField>

        <div class="flex gap-2 justify-end pt-1">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="submitting"
            data-testid="saved-theme-cancel"
            @click="open = false"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            type="submit"
            color="neutral"
            :loading="submitting"
            :disabled="!canSubmit"
            data-testid="saved-theme-submit"
          >
            {{ mode === 'create' ? t('theme.saved.save') : t('theme.saved.saveChanges') }}
          </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>
