<script setup lang="ts">
import type { EditorView } from '@codemirror/view'
import { useMyWorkspaces } from '~/queries/workspaces'
import type { ExplorerScope } from '~/composables/explorer/useExplorerData'
import type { OutlineHeading } from '~/utils/editor/documentOutline'
import { LEFT_PANEL_TABS, type LeftPanelTab } from '~/utils/editor/leftPanel'

// The editor's left panel: two tabs, the document's outline and the other
// documents of its workspace (or the person's own documents). The layout
// places it (beside the editor, over it, or in the phone's bottom sheet);
// this component is the same in all three.

const props = defineProps<{
  tab: LeftPanelTab
  /** The document text, for the outline. */
  source: string
  view: EditorView | null
  docId: string
  workspaceId: string | null
  /** The caller's role in the document's workspace; null for a guest or a visitor. */
  workspaceRole: string | null
}>()

const emit = defineEmits<{
  'update:tab': [tab: LeftPanelTab]
  'select-heading': [heading: OutlineHeading]
  'close': []
}>()

const { t } = useI18n()
const { loggedIn } = useUserSession()

const TAB_ICONS: Record<LeftPanelTab, string> = {
  outline: 'i-lucide-list-tree',
  workspace: 'i-lucide-folder-tree'
}
const tabs = computed(() => LEFT_PANEL_TABS.map(value => ({
  value,
  icon: TAB_ICONS[value],
  label: t(`leftPanel.tabs.${value}`)
})))

// Arrow keys move between the tabs and select them (automatic activation);
// Home / End jump to the first / last.
const tabButtons = useTemplateRef<HTMLButtonElement[]>('tabButtons')
function onTabKeydown(e: KeyboardEvent) {
  const order = LEFT_PANEL_TABS
  const at = order.indexOf(props.tab)
  let next = -1
  if (e.key === 'ArrowRight') next = (at + 1) % order.length
  else if (e.key === 'ArrowLeft') next = (at - 1 + order.length) % order.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = order.length - 1
  if (next < 0) return
  e.preventDefault()
  const tab = order[next]
  if (!tab) return
  emit('update:tab', tab)
  tabButtons.value?.[next]?.focus()
}

/** Move focus to the selected tab (opening the panel from the keyboard). */
function focusTabs() {
  const at = LEFT_PANEL_TABS.indexOf(props.tab)
  tabButtons.value?.[at]?.focus()
}
defineExpose({ focusTabs })

// What the Workspace tab shows: the workspace's tree for a member, the
// documents shared with a guest, the person's own documents for a
// document outside any workspace.
type WorkspaceView
  = | { kind: 'signed-out' }
    | { kind: 'explorer', scope: ExplorerScope }
    | { kind: 'shared', workspaceId: string }

const workspaceView = computed<WorkspaceView>(() => {
  if (!loggedIn.value) return { kind: 'signed-out' }
  if (props.workspaceId && props.workspaceRole) return { kind: 'explorer', scope: { kind: 'workspace', workspaceId: props.workspaceId } }
  if (props.workspaceId) return { kind: 'shared', workspaceId: props.workspaceId }
  return { kind: 'explorer', scope: { kind: 'personal' } }
})

const workspaces = useMyWorkspaces(() => props.tab === 'workspace' && workspaceView.value.kind === 'explorer' && props.workspaceId !== null)
const scopeTitle = computed(() => {
  const view = workspaceView.value
  if (view.kind !== 'explorer') return ''
  if (view.scope.kind === 'personal') return t('leftPanel.workspace.myDocuments')
  const wsId = view.scope.workspaceId
  return workspaces.data.value?.find(w => w.workspaceId === wsId)?.name ?? t('leftPanel.tabs.workspace')
})
const explorerHref = computed(() => {
  const view = workspaceView.value
  if (view.kind !== 'explorer') return null
  return view.scope.kind === 'workspace' ? `/w/${encodeURIComponent(view.scope.workspaceId)}` : '/'
})
</script>

<template>
  <div
    class="h-full flex flex-col bg-muted"
    data-testid="left-panel"
  >
    <div class="px-2 py-1.5 border-b border-default/60 flex items-center justify-between gap-2 shrink-0">
      <div
        role="tablist"
        :aria-label="t('leftPanel.label')"
        class="flex items-center gap-0.5 min-w-0"
      >
        <button
          v-for="item in tabs"
          :id="`left-panel-tab-${item.value}`"
          ref="tabButtons"
          :key="item.value"
          type="button"
          role="tab"
          :aria-selected="tab === item.value"
          :aria-controls="`left-panel-tabpanel-${item.value}`"
          :tabindex="tab === item.value ? 0 : -1"
          class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm min-w-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--ui-border-inverted)"
          :class="tab === item.value ? 'bg-default text-highlighted' : 'text-muted hover:text-default'"
          :data-testid="`left-panel-tab-${item.value}`"
          @click="emit('update:tab', item.value)"
          @keydown="onTabKeydown"
        >
          <UIcon
            :name="item.icon"
            class="size-4 shrink-0"
          />
          <span class="truncate">{{ item.label }}</span>
        </button>
      </div>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="xs"
        class="mk-panel-close"
        data-testid="left-panel-close"
        :aria-label="t('leftPanel.close')"
        @click="emit('close')"
      />
    </div>

    <div
      :id="`left-panel-tabpanel-${tab}`"
      role="tabpanel"
      :aria-labelledby="`left-panel-tab-${tab}`"
      class="flex-1 min-h-0 overflow-y-auto"
    >
      <EditorLayoutOutlineTree
        v-if="tab === 'outline'"
        :source="source"
        :view="view"
        @select="(h) => emit('select-heading', h)"
      />
      <template v-else>
        <p
          v-if="workspaceView.kind === 'signed-out'"
          class="px-4 py-8 text-center text-sm text-muted"
          data-testid="workspace-docs-signed-out"
        >
          {{ t('leftPanel.workspace.signedOut') }}
        </p>
        <EditorLayoutSharedDocsList
          v-else-if="workspaceView.kind === 'shared'"
          :workspace-id="workspaceView.workspaceId"
          :doc-id="docId"
        />
        <template v-else>
          <div class="px-3 pt-3 flex items-center justify-between gap-2">
            <span
              class="text-xs text-muted truncate"
              data-testid="workspace-docs-scope"
            >{{ scopeTitle }}</span>
            <ULink
              v-if="explorerHref"
              :to="explorerHref"
              class="text-xs text-muted hover:text-default underline underline-offset-2 shrink-0"
              data-testid="workspace-docs-open-explorer"
            >
              {{ workspaceView.scope.kind === 'workspace' ? t('leftPanel.workspace.openWorkspace') : t('leftPanel.workspace.openMyDocuments') }}
            </ULink>
          </div>
          <EditorLayoutWorkspaceDocsTree
            :scope="workspaceView.scope"
            :doc-id="docId"
          />
        </template>
      </template>
    </div>
  </div>
</template>
