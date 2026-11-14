<script setup lang="ts">
/**
 * Mobile bottom tab bar: the single navigation surface on `<sm` for opening
 * the panel drawers and toggling live dictation.
 *
 * Tabs: Document, Comments, Activity, Theme (gated on canEditTheme), Knowledge
 * (gated), Editor (formatting / inserts drawer), Mic (toggles dictation, no
 * drawer; pulses shu while recording).
 *
 * Non-mic tabs are drawer toggles: tapping the active one closes it. Active =
 * shu underline + text-default; inactive = text-muted. The Editor drawer is
 * the home of the formatting buttons; typing markdown directly is the
 * recommended mobile flow.
 *
 * Fixed at `bottom: 0`, full-width. The AI prompt bar's `bottomOffset` is
 * offset by this bar's height (~56px) so the two stack.
 */
import type { TabName } from './tabBarTypes'

const props = defineProps<{
  /** Currently-open panel; null when no drawer is open. */
  activePanel: 'document' | 'comments' | 'activity' | 'theme' | 'knowledge' | 'editor' | null
  /** Hides Theme tab when the user can't edit theme. */
  canEditTheme: boolean
  /** Hides Knowledge tab when the doc isn't in a workspace with files. */
  hasKnowledgeAccess: boolean
  /** Live-dictation state (from `useVoiceDictation`). 'recording' /
   *  'connecting' style the mic active. */
  dictationState: 'idle' | 'requesting-permission' | 'connecting' | 'recording' | 'finishing' | 'error'
}>()

const emit = defineEmits<{
  'select': [TabName]
  'toggle-dictation': []
}>()

const { t } = useI18n()

const dictationActive = computed(() =>
  props.dictationState === 'recording' || props.dictationState === 'connecting'
)
// Microphone off, the last words are still being written in.
const dictationFinishing = computed(() => props.dictationState === 'finishing')
const dictationAria = computed(() => {
  if (dictationFinishing.value) return t('ai.dictateFinishing')
  return dictationActive.value ? t('ai.dictateStop') : t('ai.dictateStart')
})
const dictationShort = computed(() => {
  if (dictationFinishing.value) return t('mobileTabBar.dictateFinishing')
  return dictationActive.value ? t('mobileTabBar.dictateStop') : t('mobileTabBar.dictateStart')
})
// Live dictation needs a Mistral transcription provider (own key or instance
// default); the tab is hidden otherwise (kept while recording).
const { liveDictationAvailable, transcriptionLocked } = useAiAvailability()
const { explainLocked } = useAiLockedPrompt()
const dictationLocked = computed(() => !liveDictationAvailable.value && transcriptionLocked.value && !dictationActive.value)
const showDictation = computed(() => liveDictationAvailable.value || dictationActive.value || dictationFinishing.value || dictationLocked.value)
function onDictationClick() {
  if (dictationLocked.value) explainLocked('aiVoice')
  else emit('toggle-dictation')
}

interface TabDef {
  name: TabName
  icon: string
  label: string
  visible: boolean
  /** Drawer-toggling tabs; the mic tab is excluded (handled separately). */
  isPanel: true
}

// Editor + Dictation come first (writing-flow tools); the most frequent tools
// sit on the left half, which one-handed right-handed users reach most easily.
// Labels use the short `mobileTabBar.*Short` i18n keys to fit a 50-60px column.
const tabs = computed<TabDef[]>(() => [
  { name: 'editor', icon: 'i-lucide-pencil', label: t('mobileTabBar.editor'), visible: true, isPanel: true },
  { name: 'document', icon: 'i-lucide-info', label: t('mobileTabBar.documentShort'), visible: true, isPanel: true },
  { name: 'comments', icon: 'i-lucide-message-circle', label: t('mobileTabBar.commentsShort'), visible: true, isPanel: true },
  { name: 'activity', icon: 'i-lucide-activity', label: t('mobileTabBar.activityShort'), visible: true, isPanel: true },
  { name: 'theme', icon: 'i-lucide-palette', label: t('mobileTabBar.themeShort'), visible: props.canEditTheme, isPanel: true },
  { name: 'knowledge', icon: 'i-lucide-library', label: t('mobileTabBar.knowledgeShort'), visible: props.hasKnowledgeAccess, isPanel: true }
])

const visibleTabs = computed(() => tabs.value.filter(t => t.visible))
</script>

<template>
  <div
    class="sm:hidden fixed left-0 right-0 bottom-0 z-30 flex items-stretch border-t border-default"
    style="background: var(--ui-bg-muted);"
    role="tablist"
    :aria-label="t('mobileTabBar.label')"
    data-testid="mobile-tab-bar"
  >
    <button
      v-if="visibleTabs[0]"
      type="button"
      role="tab"
      :aria-selected="activePanel === visibleTabs[0].name"
      :aria-label="visibleTabs[0].label"
      class="mk-tab"
      :class="{ 'mk-tab--active': activePanel === visibleTabs[0].name }"
      @click="emit('select', visibleTabs[0].name)"
    >
      <UIcon
        :name="visibleTabs[0].icon"
        class="size-5"
      />
      <span class="mk-tab__label">{{ visibleTabs[0].label }}</span>
    </button>

    <!-- Dictation TOGGLES (no drawer). Next to Editor since both are writing-flow
         tools; the active state pulses shu so recording status is visible. -->
    <button
      v-if="showDictation"
      type="button"
      class="mk-tab"
      :class="{ 'mk-tab--dictation-active': dictationActive }"
      :aria-label="dictationAria"
      :aria-pressed="dictationActive"
      :disabled="dictationFinishing"
      data-testid="mobile-tab-dictate"
      :data-locked="dictationLocked ? 'true' : undefined"
      @click="onDictationClick"
    >
      <UIcon
        :name="dictationFinishing ? 'i-lucide-loader-circle' : dictationActive ? 'i-lucide-square' : 'i-lucide-mic'"
        class="size-5"
        :class="{ 'animate-spin': dictationFinishing }"
      />
      <span class="mk-tab__label">{{ dictationShort }}</span>
    </button>

    <!-- Document, Comments, Activity, Theme, Knowledge, each gated by its flag in `tabs`. -->
    <button
      v-for="tab in visibleTabs.slice(1)"
      :key="tab.name"
      type="button"
      role="tab"
      :aria-selected="activePanel === tab.name"
      :aria-label="tab.label"
      class="mk-tab"
      :class="{ 'mk-tab--active': activePanel === tab.name }"
      @click="emit('select', tab.name)"
    >
      <UIcon
        :name="tab.icon"
        class="size-5"
      />
      <span class="mk-tab__label">{{ tab.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.mk-tab {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 6px 4px calc(6px + env(safe-area-inset-bottom, 0px)) 4px;
  color: var(--ui-text-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease;
  position: relative;
  /* 24px icon + 12px label + 12px vertical padding ≈ 56px */
}

.mk-tab:active {
  background: var(--ui-bg-elevated);
}

.mk-tab__label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 400;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.mk-tab--active {
  color: var(--ui-text);
}

/* Active tab: 2px shu line at the top edge. The seal would be too brand-loud
   here and would compete with the AI seal in the prompt bar. */
.mk-tab--active::before {
  content: '';
  position: absolute;
  top: 0;
  left: 12%;
  right: 12%;
  height: 2px;
  background: var(--color-shu-500);
  border-radius: 1px;
}
html.dark .mk-tab--active::before {
  background: var(--color-shu-400);
}

/* While a session is live the mic icon pulses shu, reusing the `mk-pulse`
   keyframe from AIPromptBar (the brand has one "AI is working" animation;
   it exists at document level, so referencing it here is safe). */
.mk-tab--dictation-active {
  color: var(--color-shu-500);
  animation: mk-pulse 2.4s ease-in-out infinite;
}
html.dark .mk-tab--dictation-active {
  color: var(--color-shu-400);
}
</style>
