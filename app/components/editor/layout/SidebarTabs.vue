<script setup lang="ts">
import type { TabName } from '../tabBarTypes'

// Desktop panel toggles (Document, Comments, Activity, Theme, Knowledge),
// right-aligned above the sidebar column they open. Mobile picks panels in
// the bottom MobileTabBar instead.
defineProps<{
  rightSidebar: TabName | null
  canEditTheme: boolean
  hasKnowledgeAccess: boolean
}>()
const emit = defineEmits<{ toggle: [panel: TabName] }>()
const { t } = useI18n()
</script>

<template>
  <div class="hidden sm:flex items-center gap-0.5 px-2 py-1 shrink-0">
    <UTooltip :text="t('documentPanel.title')">
      <UButton
        icon="i-lucide-info"
        color="neutral"
        :variant="rightSidebar === 'document' ? 'soft' : 'ghost'"
        size="xs"
        :aria-label="t('documentPanel.title')"
        :aria-pressed="rightSidebar === 'document'"
        data-testid="sidebar-tab-document"
        @click="emit('toggle', 'document')"
      />
    </UTooltip>
    <UTooltip :text="t('comments.title')">
      <UButton
        icon="i-lucide-message-circle"
        color="neutral"
        :variant="rightSidebar === 'comments' ? 'soft' : 'ghost'"
        size="xs"
        :aria-label="t('comments.title')"
        :aria-pressed="rightSidebar === 'comments'"
        data-testid="sidebar-tab-comments"
        @click="emit('toggle', 'comments')"
      />
    </UTooltip>
    <UTooltip :text="t('activity.title')">
      <UButton
        icon="i-lucide-activity"
        color="neutral"
        :variant="rightSidebar === 'activity' ? 'soft' : 'ghost'"
        size="xs"
        :aria-label="t('activity.title')"
        :aria-pressed="rightSidebar === 'activity'"
        data-testid="sidebar-tab-activity"
        @click="emit('toggle', 'activity')"
      />
    </UTooltip>
    <UTooltip
      v-if="canEditTheme"
      :text="t('theme.title')"
    >
      <UButton
        icon="i-lucide-palette"
        color="neutral"
        :variant="rightSidebar === 'theme' ? 'soft' : 'ghost'"
        size="xs"
        :aria-label="t('theme.title')"
        :aria-pressed="rightSidebar === 'theme'"
        data-testid="sidebar-tab-theme"
        @click="emit('toggle', 'theme')"
      />
    </UTooltip>
    <UTooltip
      v-if="hasKnowledgeAccess"
      :text="t('knowledge.title')"
    >
      <UButton
        icon="i-lucide-library"
        color="neutral"
        :variant="rightSidebar === 'knowledge' ? 'soft' : 'ghost'"
        size="xs"
        :aria-label="t('knowledge.title')"
        :aria-pressed="rightSidebar === 'knowledge'"
        data-testid="sidebar-tab-knowledge"
        @click="emit('toggle', 'knowledge')"
      />
    </UTooltip>
  </div>
</template>
