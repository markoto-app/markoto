<script setup lang="ts">
/**
 * Mobile bottom tab bar. The single navigation surface on `<sm` for
 * opening the document's panel drawers + toggling live dictation.
 *
 * Tabs:
 *   Document — opens the document-info drawer
 *   Comments — opens the comments drawer
 *   Activity — opens the activity-log drawer
 *   Theme    — opens the theme-editor drawer (gated on canEditTheme)
 *   Knowledge — opens the workspace-knowledge drawer (gated)
 *   Editor   — opens the editor-commands drawer (formatting / inserts)
 *   Mic      — TOGGLES live dictation (no drawer); pulses shu while
 *              recording so users see at-a-glance whether dictation
 *              is on
 *
 * Each non-mic tab is a "drawer toggle": tapping the active one
 * closes it. Active state = shu underline + text-default. Inactive =
 * text-muted.
 *
 * The bar replaces TWO older mobile surfaces:
 *   1. The top-left panel-picker dropdown (the `i-lucide-panel-right`
 *      button) — folded into the always-visible tab strip.
 *   2. The `MobileFormatBar` keyboard-anchored row — its bold/italic/
 *      heading/list/link buttons move to the new "Editor" drawer
 *      (the design accepts the 2-tap cost: typing markdown directly
 *      is the recommended writing flow on mobile, the drawer is for
 *      when you want a button).
 *
 * Sits at `bottom: 0` of the viewport, fixed, full-width. The AI
 * prompt bar's `bottomOffset` is offset by this bar's height (~56px)
 * so the two stack instead of overlapping.
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
  dictationState: 'idle' | 'requesting-permission' | 'connecting' | 'recording' | 'error'
}>()

const emit = defineEmits<{
  'select': [TabName]
  'toggle-dictation': []
}>()

const { t } = useI18n()

const dictationActive = computed(() =>
  props.dictationState === 'recording' || props.dictationState === 'connecting'
)

interface TabDef {
  name: TabName
  icon: string
  label: string
  visible: boolean
  /** Drawer-toggling tabs; the mic tab is excluded (handled separately). */
  isPanel: true
}

// Order: Editor + Dictation first (writing-flow tools, the user's
// primary actions), then the panel surfaces. Right-handed users land
// their thumb on the LEFT half easiest at one-handed reach, so the
// most-frequent tools live there. Labels use the short i18n keys
// under `mobileTabBar.*Short` so they fit in a 50-60px column without
// truncation.
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
  <nav
    class="sm:hidden fixed left-0 right-0 bottom-0 z-30 flex items-stretch border-t border-default"
    style="background: var(--ui-bg-muted);"
    role="tablist"
    :aria-label="t('mobileTabBar.label')"
    data-testid="mobile-tab-bar"
  >
    <!-- First tab: Editor (drawer-toggling). Always present. -->
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

    <!-- Second tab: Dictation (TOGGLE — not a drawer). Sits next to
         Editor since both are writing-flow tools the user reaches for
         most while composing. Active state pulses shu so users see
         recording status without opening anything. Short label fits
         the 50-60px column on phones. -->
    <button
      type="button"
      class="mk-tab"
      :class="{ 'mk-tab--dictation-active': dictationActive }"
      :aria-label="dictationActive ? t('ai.dictateStop') : t('ai.dictateStart')"
      :aria-pressed="dictationActive"
      data-testid="mobile-tab-dictate"
      @click="emit('toggle-dictation')"
    >
      <UIcon
        :name="dictationActive ? 'i-lucide-square' : 'i-lucide-mic'"
        class="size-5"
      />
      <span class="mk-tab__label">{{ dictationActive ? t('mobileTabBar.dictateStop') : t('mobileTabBar.dictateStart') }}</span>
    </button>

    <!-- Remaining panel tabs: Document, Comments, Activity, Theme,
         Knowledge (each gated by its visibility flag in `tabs`
         above). Same drawer-toggle behaviour as the first tab. -->
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
  </nav>
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
  /* Height target: 24px icon + 12px label + 12px vertical padding ≈ 56px */
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

/* Active-tab indicator: 2px shu line at the top edge. Mirrors how
   browsers and most mobile apps mark the active tab. The seal would
   be too brand-loud here — a thin shu underline communicates "this
   surface is in focus" without competing with the AI seal that lives
   in the prompt bar. */
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
:global(.dark) .mk-tab--active::before {
  background: var(--color-shu-400);
}

/* Dictation: while a session is live, the mic icon pulses shu.
   Reuses the editor's `mk-pulse` keyframe vocabulary (declared in
   AIPromptBar) — the brand has ONE "AI is working" animation. The
   keyframe exists at the document level so it's safe to reference
   here. */
.mk-tab--dictation-active {
  color: var(--color-shu-500);
  animation: mk-pulse 2.4s ease-in-out infinite;
}
:global(.dark) .mk-tab--dictation-active {
  color: var(--color-shu-400);
}
</style>
