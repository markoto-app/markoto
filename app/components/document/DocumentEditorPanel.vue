<script setup lang="ts">
import { AUDIENCE_KINDS } from '~~/shared/audiences'
import { LANGUAGE_PRESETS, LANGUAGE_MAX_LENGTH } from '~~/shared/languages'

/**
 * Right-sidebar panel for the doc's first-class context properties:
 * description, language, audience. The values are the AI's authoritative
 * source-of-truth — they're injected into every system prompt — so this
 * surface is the canonical place to edit them.
 *
 * Same write semantics as the Theme panel: owner + editors mutate
 * (Y.js broadcasts to collaborators + debounced DB persist for the
 * owner); viewers see read-only labels.
 *
 * The language input is a single combobox (Nuxt UI's UInputMenu): the
 * 6 curated presets are filterable suggestions, and `create-item` lets
 * the user accept any free-text language ("Romansh",
 * "Schwiizerdütsch") with one Enter. One field, two affordances.
 */
const props = defineProps<{
  description: string
  audience: string
  language: string
  canEdit: boolean
}>()

const emit = defineEmits<{
  'update:description': [string]
  'update:audience': [string]
  'update:language': [string]
  'close': []
}>()

const { t } = useI18n()

// Local drafts for two-way binding. Same pattern as ThemeEditorPanel —
// drafts mirror props, watchers fire updates upstream. Keeps the
// inputs from flickering on remote-collaborator edits.
//
// `watchIgnorable` exposes `ignoreUpdates(fn)` so we can write the
// prop value back into the draft (when the prop changes externally)
// without re-triggering the upstream-emit watcher. Replaces the
// previous "if (next === propValue) return" equality guards inside
// each emit watcher.
const descriptionDraft = ref(props.description)
const audienceDraft = ref(props.audience)

const { ignoreUpdates: ignoreDescriptionUpdates } = watchIgnorable(descriptionDraft, (next) => {
  if (next.length > 500) {
    ignoreDescriptionUpdates(() => {
      descriptionDraft.value = next.slice(0, 500)
    })
    return
  }
  emit('update:description', next)
})
const { ignoreUpdates: ignoreAudienceUpdates } = watchIgnorable(audienceDraft, (next) => {
  emit('update:audience', next)
})

watch(() => props.description, (next) => {
  if (next === descriptionDraft.value) return
  ignoreDescriptionUpdates(() => {
    descriptionDraft.value = next
  })
})
watch(() => props.audience, (next) => {
  if (next === audienceDraft.value) return
  ignoreAudienceUpdates(() => {
    audienceDraft.value = next
  })
})

// — Language combobox ────────────────────────────────────────────────
// One UInputMenu drives both "pick a preset" and "type any language".
// `value-key="value"` makes the model the language STRING ("de",
// "Romansh"), not the item object. (The model used to be typed as the
// item while UInputMenu emitted the string, so the watcher below threw
// every pick away: choosing "Deutsch" showed in the field but never
// reached the document — the AI kept writing English.)
//
// Items: 6 curated presets, each {label, value}. The user can:
//   - type to filter presets, click one → emits the preset value
//   - type a non-matching string and press Enter (or click "Create…")
//     → the create-item callback fires; we cap to MAX_LENGTH and use it
//     as the new language; a synthetic item for it is listed first so
//     the input shows the typed string instead of clearing.
interface LanguageItem { label: string, value: string, custom?: boolean }

const presetItems = computed<LanguageItem[]>(() =>
  LANGUAGE_PRESETS.map(code => ({ label: t(`languages.${code}`), value: code }))
)

const isPresetLanguage = (v: string) => (LANGUAGE_PRESETS as readonly string[]).includes(v)

const languageModel = ref<string>(props.language)
const languageIsCustom = computed(() =>
  languageModel.value.trim().length > 0 && !isPresetLanguage(languageModel.value)
)

// Items list shown in the dropdown. When the user has typed a custom
// value, surface it at the top so they can re-select it without
// retyping.
const languageItems = computed<LanguageItem[]>(() => {
  if (languageIsCustom.value) {
    return [{ label: languageModel.value, value: languageModel.value, custom: true }, ...presetItems.value]
  }
  return presetItems.value
})

const { ignoreUpdates: ignoreLanguageUpdates } = watchIgnorable(languageModel, (next) => {
  if (typeof next !== 'string') return
  const value = next.trim()
  if (value.length === 0) return
  emit('update:language', value)
})

watch(() => props.language, (next) => {
  if (next === languageModel.value) return
  ignoreLanguageUpdates(() => {
    languageModel.value = next
  })
})

function onCreateLanguage(text: string): string {
  return text.trim().slice(0, LANGUAGE_MAX_LENGTH)
}

const audienceItems = AUDIENCE_KINDS.map(kind => ({
  label: t(`audiences.${kind}.label`),
  description: t(`audiences.${kind}.description`),
  value: kind
}))
</script>

<template>
  <div class="flex flex-col h-full bg-muted">
    <!-- Document panel header — Fraunces title in the editorial
         register, matching the Comments / Activity / Theme panels. -->
    <div class="p-3 border-b border-default/60 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-info"
          class="size-4 text-muted"
        />
        <h3 class="font-serif text-base font-normal tracking-tight">
          {{ t('documentPanel.title') }}
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

    <div class="flex-1 overflow-y-auto p-3 min-h-0 space-y-5">
      <!-- Description ────────────────────────────────────────────── -->
      <section>
        <label
          for="doc-description"
          class="block font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted mb-1.5"
        >
          {{ t('documentPanel.description.label') }}
        </label>
        <p class="text-xs text-toned mb-2">
          {{ t('documentPanel.description.help') }}
        </p>
        <UTextarea
          id="doc-description"
          v-model="descriptionDraft"
          :placeholder="t('documentPanel.description.placeholder')"
          :rows="3"
          :maxrows="6"
          :disabled="!canEdit"
          autoresize
          class="w-full"
        />
        <!-- Character counter in the slate caption register —
             JetBrains Mono with 0.04em tracking, matches the rest of
             the editor's micro-meta voice. The format shifts from
             "X / 500" to a thin-spaced "X · 500" for editorial polish;
             the slash variant scans as "fraction" (= filling up),
             middot scans as "of" (= you have headroom). -->
        <div class="font-mono text-[10.5px] tracking-[0.04em] text-muted mt-1 text-right">
          {{ descriptionDraft.length }} <span class="opacity-50">/</span> 500
        </div>
      </section>

      <!-- Language ───────────────────────────────────────────────── -->
      <section>
        <label
          for="doc-language"
          class="block font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted mb-1.5"
        >
          {{ t('documentPanel.language.label') }}
        </label>
        <p class="text-xs text-toned mb-2">
          {{ t('documentPanel.language.help') }}
        </p>
        <UInputMenu
          id="doc-language"
          v-model="languageModel"
          :items="languageItems"
          :placeholder="t('documentPanel.language.placeholder')"
          :disabled="!canEdit"
          :create-item="true"
          :create-item-position="'bottom'"
          value-key="value"
          class="w-full"
          @create="(text: string) => languageModel = onCreateLanguage(text)"
        />
        <p
          v-if="languageIsCustom"
          class="text-xs text-toned mt-1"
        >
          {{ t('documentPanel.language.customActive') }}
        </p>
      </section>

      <!-- Audience ───────────────────────────────────────────────── -->
      <section>
        <label
          for="doc-audience"
          class="block font-mono text-[10.5px] font-normal uppercase tracking-[0.06em] text-muted mb-1.5"
        >
          {{ t('documentPanel.audience.label') }}
        </label>
        <p class="text-xs text-toned mb-2">
          {{ t('documentPanel.audience.help') }}
        </p>
        <USelect
          id="doc-audience"
          v-model="audienceDraft"
          :items="audienceItems"
          :disabled="!canEdit"
          class="w-full"
        />
        <p
          v-if="audienceItems.some(i => i.value === audienceDraft)"
          class="text-xs text-toned mt-1.5"
        >
          {{ audienceItems.find(i => i.value === audienceDraft)?.description }}
        </p>
      </section>
    </div>
  </div>
</template>
