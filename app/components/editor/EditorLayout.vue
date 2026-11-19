<script setup lang="ts">
import RightPanelHost from './RightPanelHost.vue'
import MobileTabBar from './MobileTabBar.vue'
import EditorCommandsPanel from './EditorCommandsPanel.vue'
import type { TabName } from './tabBarTypes'
import { customCssForPlan } from '~~/shared/utils/theme/themePresets'
import { applyBrandLock } from '~~/shared/utils/theme/brandLock'
import type { DocTheme } from '~~/shared/types/theme'

/**
 * The editor page: composes the top bar, menu and tool rows, the editor and
 * preview panes, the right sidebar, the AI prompt bar and the status bar
 * (pieces in `./layout/`), and owns the state they share, the document
 * (`useDocument`), the open sidebar panel, the view mode, the modals.
 */
const props = defineProps<{
  docId: string
}>()

const { t } = useI18n()

const {
  ydoc,
  ytext,
  awareness,
  status,
  synced,
  userCount,
  isReadOnly: tokenReadOnly,
  suggestOnly,
  suggestionsRequired,
  contentWriter,
  syncAuthFailed,
  syncRejection,
  syncBusy,
  isOwner,
  hasOwner,
  canDelete,
  deletedByOther,
  setDeletingHere,
  requiresPassword,
  forbidden,
  notFound,
  accessMode,
  workspaceId: docWorkspaceId,
  workspaceRole: docWorkspaceRole,
  customCssAllowed,
  brandFonts,
  brandLockedTheme,
  noDownload,
  shareExpired,
  workspacePlan,
  ssoLoginUrl,
  undoManager,
  title,
  theme,
  description,
  audience,
  language,
  templateId,
  setTemplateId,
  canEditTheme,
  setTheme,
  resetTheme,
  onPasswordVerified,
  setAccessMode,
  getDocJwt
} = useDocument(props.docId)

// Deleted by someone else: the text stays readable but is no longer saved,
// so the editor stops taking edits (they would be lost silently).
const isReadOnly = computed(() => tokenReadOnly.value || deletedByOther.value)

// What the preview and browser print render. The author's custom CSS is
// dropped when the plan doesn't include it (a preset's template CSS stays,
// `customCssForPlan`); it stays in the theme and Y.js, so upgrading applies it
// again, and the server renderer drops it the same way (render-bootstrap).
// A locked workspace design (brand kit) replaces everything but the
// document's cover text, as in the server renderer (shared/utils/theme/brandLock.ts).
const renderTheme = computed(() => {
  const base = applyBrandLock(theme.value as DocTheme, brandLockedTheme.value as DocTheme | null)
  const css = customCssForPlan(base.customCss, customCssAllowed.value)
  return css === base.customCss ? base : { ...base, customCss: css }
})

// AI collaborator: joins the doc as its own Y.js client. `getEditorSelection`
// snapshots the caret/selection at submit time so the model can resolve
// "here" / "this" to a concrete location.
const ai = useAI(computed(() => props.docId), awareness, {
  getEditorSelection: () => snapshotEditorSelection(editorView.value, editorEverFocused.value),
  getSuggest: () => suggestionMode.aiSuggestRequest()
})

const { loggedIn, user: sessionUser } = useUserSession()

const dictation = useEditorDictation({
  docId: () => props.docId,
  view: () => editorView.value,
  ydoc,
  ytext,
  awareness,
  userId: () => sessionUser.value?.id ?? null
})

const { showShareModal, showDeleteModal, showDuplicateModal, showMoveModal, showImportModal, anyOpen: anyModalOpen } = useEditorModals()
// Owner or workspace admin; mirrors server-side canManageDoc. Editors and
// viewers can edit content (`!isReadOnly`) but not move the doc.
const canManageDoc = computed(() =>
  isOwner.value || docWorkspaceRole.value === 'admin'
)
// Right-sidebar slot, mutually exclusive between activity, theme, knowledge,
// document, comments and the mobile-only "editor" drawer (command palette), so
// the layout shift is predictable. Knowledge only appears for workspace docs
// (`hasKnowledgeAccess`).
const rightSidebar = ref<TabName | null>(null)
function toggleSidebar(panel: TabName) {
  rightSidebar.value = rightSidebar.value === panel ? null : panel
}
function closeSidebar() {
  rightSidebar.value = null
}

// Global Escape closes the open sidebar panel, except while a modal-like layer
// (delete/duplicate/move/import/share) is up: Nuxt UI modals own Escape in
// their stack, and it must not also reach the sidebar after dismissing the modal.
onKeyStroke('Escape', () => {
  if (anyModalOpen.value) return
  if (rightSidebar.value) closeSidebar()
})

const { commentRanges, commentsPanelRef, onCommentClickInEditor, triggerCreateComment, onCommentPanelFocus } = useEditorComments({
  ydoc,
  awareness,
  docId: props.docId,
  title,
  isReadOnly,
  rightSidebar,
  flashRange: (from, to) => editorPaneRef.value?.flashCommentRange?.(from, to)
})

// Suggestion mode: Editing / Suggesting (fixed on Suggesting when the token
// says so), marks, the suggestions panel, the AI's "suggest" switch.
const suggestionMode = useEditorSuggestions({
  ydoc,
  awareness,
  docId: props.docId,
  isReadOnly,
  suggestOnly,
  rightSidebar,
  flashRange: (from, to) => editorPaneRef.value?.flashCommentRange?.(from, to)
})
const { api: suggestions, suggestingChosen, suggesting, panelRef: suggestionsPanelRef } = suggestionMode

const { hasKnowledgeAccess } = useDocWorkspaceContext(docWorkspaceId, docWorkspaceRole, rightSidebar)

const { passwordModalOpen, deletedNoticeOpen } = useDocAccessPrompts(requiresPassword, deletedByOther)

// Page count from the paged.js preview, shown in the status bar.
const pageCount = ref(0)

const { textContent, wordCount, charCount } = useDocTextStats({ docId: props.docId, ydoc, ytext, synced, isOwner, requiresPassword })

const { exportPdf, exportMarkdown, exportMarkdownWithSuggestions, openServerPdf } = useEditorExports({
  docId: props.docId,
  ytext,
  renderTheme,
  theme,
  textContent,
  title,
  description,
  audience,
  language,
  templateId,
  noDownload,
  brandFonts,
  getDocJwt
})

const applyImportedProperties = useImportedProperties({ isReadOnly, title, description, audience, language, setTemplateId, canEditTheme, setTheme: theme => setTheme(theme) })

const { tableModalOpen, onTableModalSelect, openImagePicker } = useEditorInserts(props.docId, () => editorView.value, isReadOnly)

// "Created by a markoto user, not by markoto · Report" on documents without
// an owner account (anonymous creations). Waits for the first sync, when the
// token endpoint has told us who owns the doc (no flash on owned docs).
const { legalSurfaces } = useInstanceConfig()
const showUserContentBar = computed(() =>
  legalSurfaces.value
  && synced.value
  && !forbidden.value
  && !notFound.value
  && !hasOwner.value
  && !docWorkspaceId.value
)

// Dispatched on the local UndoManager, same as the keyboard shortcut, so menu and keyboard agree.
function undo() {
  undoManager.undo()
}
function redo() {
  undoManager.redo()
}

// Sharing → Password opens the share modal (no scroll to the password section).
function openShareAtPassword() {
  showShareModal.value = true
}

// The access level picks the layout; a deletion keeps the one on screen.
const { viewMode, isMobile } = useEditorViewMode(tokenReadOnly)

const { syncRejectionMessage } = useSyncProblemToasts(syncAuthFailed, syncRejection)

const { editorPaneRef, editorView, editorEverFocused } = useEditorViewRef()

const { newDocument, handleLogout, openDocs } = useEditorActions(awareness)

const showShortcuts = ref(false)

// First-run tour (EditorTour.vue): shown once per account (per browser when signed out) when the editor is
// ready to write in; Help → "Take the tour" re-opens it.
const editorTour = useTemplateRef<{ start: () => void }>('editorTour')
const tourReady = computed(() => synced.value && !isReadOnly.value && !requiresPassword.value && editorView.value !== null)

// Tab title follows the live doc title so several open docs can be told apart.
// `useHead` with a getter is the SSR-safe idiom: Y.js syncs `title` after
// hydration. Falls back to "Untitled" while loading or when cleared.
useHead({
  title: () => title.value || t('editor.untitled')
})
</script>

<template>
  <EditorLayoutDocNotFound v-if="notFound" />

  <EditorLayoutDocForbidden
    v-else-if="forbidden"
    :share-expired="shareExpired"
    :sso-login-url="ssoLoginUrl"
  />

  <!-- h-dvh, not h-screen: 100vh ignores the mobile address bar, so the shell
       overran the screen and the AI bar slid under the fixed MobileTabBar. -->
  <div
    v-else
    class="h-dvh flex flex-col"
  >
    <!-- Header: three-column flex so the view-mode group sits visually centered;
         left and right own equal flex space and align inward. -->
    <!-- `bg-muted` shares the gentler chrome field with the right sidebar and the
         preview surround; white cards and paper sheets pop against it. -->
    <header class="border-b border-default/60 bg-muted px-4 py-2 flex items-center gap-3 shrink-0">
      <EditorLayoutDocIdentity
        v-model:title="title"
        :doc-id="docId"
        :workspace-plan="workspacePlan"
        :awareness="awareness"
        :status="status"
        :user-count="userCount"
      />

      <!-- View-mode toggle in its own zero-flex column so left and right groups balance around it. -->
      <EditorLayoutViewModeToggle v-model="viewMode" />

      <!-- Lock shortcut, identity, mobile menu and the right-sidebar toggles.
           From `sm` up, `flex-1 justify-end` mirrors the left group so the
           view-mode group stays centered. On a phone there is no view-mode
           group to center and only two icons here: they take their own
           width and the title gets the rest. -->
      <div class="shrink-0 sm:shrink sm:flex-1 min-w-0 flex items-center gap-2 justify-end">
        <!-- Editing / Suggesting. Hidden for read-only viewers. -->
        <EditorLayoutEditModeToggle
          v-if="!isReadOnly"
          v-model="suggestingChosen"
          :forced="suggestOnly"
          :required="suggestionsRequired"
        />

        <!-- Also under Sharing → Access; kept here because the open/closed lock doubles as an access indicator. -->
        <EditorLayoutAccessButton
          :access-mode="accessMode"
          @open-share="showShareModal = true"
        />

        <div class="hidden sm:flex items-center gap-2">
          <AuthUserMenu />
          <UColorModeButton />
        </div>

        <EditorLayoutMobileMenu
          v-model:view-mode="viewMode"
          :no-download="noDownload"
          :can-manage="canManageDoc"
          :can-delete="canDelete"
          @new-document="newDocument"
          @open-import="showImportModal = true"
          @export-markdown="exportMarkdown"
          @print="exportPdf"
          @open-server-pdf="openServerPdf"
          @duplicate-document="showDuplicateModal = true"
          @move-document="showMoveModal = true"
          @delete-document="showDeleteModal = true"
          @open-docs="openDocs"
          @start-tour="editorTour?.start()"
          @logout="handleLogout"
        />
      </div>
    </header>

    <template v-if="!requiresPassword">
      <!-- File / Edit / View / Insert / Format / Sharing / Help. The header icons
           duplicate the most common ones for speed; the menus aid findability.
           Hidden on mobile: formatting moves to the "Editor" tab, file/auth
           actions to the topbar dropdown. -->
      <div class="hidden sm:block">
        <EditorMenuBar
          :view="editorView"
          :doc-id="docId"
          :is-read-only="isReadOnly"
          :logged-in="loggedIn"
          :can-manage="canManageDoc"
          :can-delete="canDelete"
          :no-download="noDownload"
          :right-sidebar="rightSidebar"
          :has-knowledge-access="hasKnowledgeAccess"
          :view-mode="viewMode"
          :dictation-state="dictation.state.value"
          @open-import="showImportModal = true"
          @open-share="showShareModal = true"
          @open-share-password="openShareAtPassword"
          @export-markdown="exportMarkdown"
          @export-pdf="exportPdf"
          @open-server-pdf="openServerPdf"
          @new-document="newDocument"
          @duplicate-document="showDuplicateModal = true"
          @move-document="showMoveModal = true"
          @delete-document="showDeleteModal = true"
          @set-view-mode="(m) => viewMode = m"
          @toggle-sidebar="toggleSidebar"
          @undo="undo"
          @redo="redo"
          @open-image-picker="openImagePicker"
          @open-table-picker="tableModalOpen = true"
          @toggle-dictation="dictation.toggle()"
          @create-comment="triggerCreateComment"
          @open-docs="openDocs"
          @open-shortcuts="showShortcuts = true"
          @start-tour="editorTour?.start()"
        />
      </div>

      <EditorLayoutSyncBanners
        :sync-auth-failed="syncAuthFailed"
        :sync-rejection-message="syncRejectionMessage"
        :sync-busy="syncBusy"
      />

      <!-- Docs created without an account are written by anonymous visitors,
           not the operator. Links the report form (prefilled with this URL);
           only where legal surfaces exist, and not on owned or workspace docs. -->
      <EditorLayoutUserContentBar
        v-if="showUserContentBar"
        :doc-id="docId"
      />

      <!-- Left: formatting actions, kept as an icon row (faster once learned)
                 even though the Format / Insert menus have them.
           Right: panel toggles (Activity, Theme), right-aligned above the
                  sidebar column they open. -->
      <div class="border-b border-default shrink-0 flex items-center justify-between">
        <!-- Hidden below `sm`; mobile reaches the same commands through the
             "Editor" tab (EditorCommandsPanel drawer). -->
        <div class="hidden sm:block flex-1 min-w-0">
          <EditorToolbar
            v-if="viewMode !== 'preview'"
            :view="editorView"
            :read-only="isReadOnly"
            :doc-id="docId"
            :dictation-state="dictation.state.value"
            @open-table-picker="tableModalOpen = true"
            @toggle-dictation="dictation.toggle()"
            @create-comment="triggerCreateComment"
          />
        </div>
        <!-- Mobile: the panel picker is the bottom MobileTabBar, outside this header. -->

        <!-- Desktop: 5-button strip; hidden on mobile, where it plus the title would overflow at 390px. -->
        <EditorLayoutSidebarTabs
          :right-sidebar="rightSidebar"
          :suggestion-count="suggestionMode.count.value"
          :can-edit-theme="canEditTheme"
          :has-knowledge-access="hasKnowledgeAccess"
          @toggle="toggleSidebar"
        />
      </div>

      <EditorLayoutAccessBanner
        :deleted="deletedByOther"
        :read-only="isReadOnly"
        @download="exportMarkdown()"
      />

      <!-- Flex siblings with `flex-1` / `min-w-0` share the width. Triple-split
           (editor + preview + sidebar) starts at `xl` (1280px); below that the
           sidebar replaces the preview. `relative` anchors the floating AI
           prompt bar to the bottom of this zone, not the page. -->
      <main class="flex-1 flex min-h-0 relative">
        <!-- ImageDropZone handles drag-drop and paste uploads -->
        <EditorImageDropZone
          v-if="viewMode !== 'preview'"
          :doc-id="docId"
          :editor-view="editorView"
          :read-only="isReadOnly"
          :class="[
            // Flex member: shares remaining width with preview / sidebar.
            // `min-w-0` lets the pane shrink past its intrinsic content width.
            'flex-1 min-w-0',
            // Right border only when something visible sits to its right.
            (viewMode === 'split' || rightSidebar) ? 'border-r border-default' : ''
            // Never hide the pane on mobile: the bottom sheet covers only the lower
            // part of the viewport and the editor must stay visible above it.
          ]"
          class="h-full"
        >
          <EditorPane
            ref="editorPaneRef"
            :ytext="ytext"
            :awareness="awareness"
            :undo-manager="undoManager"
            :read-only="isReadOnly"
            :comment-ranges="commentRanges"
            :on-comment-click="onCommentClickInEditor"
            :suggesting="suggesting"
            :suggestion-marks="suggestions.marks.value"
            :on-suggestion-plan="suggestions.applyPlan"
            :on-suggestion-click="suggestionMode.onSuggestionClick"
          />
        </EditorImageDropZone>

        <!-- Hidden by CSS (not v-if) while the sidebar is open below xl, so it
             reappears on resize past xl without re-mounting the markdown-it pipeline. -->
        <div
          v-if="viewMode !== 'edit'"
          :class="[
            'flex-1 min-w-0 h-full',
            rightSidebar ? 'hidden xl:block' : ''
          ]"
        >
          <PreviewPane
            v-model:page-count="pageCount"
            :source="textContent"
            :title="title"
            :language="language"
            :theme="renderTheme"
            :doc-id="docId"
            :get-doc-jwt="getDocJwt"
            :brand-fonts="brandFonts"
            :zoom-control="!isMobile"
            @print-shortcut="exportPdf"
          />
        </div>

        <!-- One slot for all sidebar panels, mutually exclusive via `toggleSidebar`.
             - edit mode:           fixed sidebar (w-80), full-width on xs
             - split/preview, <xl:  right half (flex-1); preview hidden
             - split/preview, xl+:  fixed 320px sidebar (triple-split) -->
        <RightPanelHost
          :open="!!rightSidebar"
          :view-mode="viewMode"
          @close="closeSidebar"
        >
          <DocumentEditorPanel
            v-if="rightSidebar === 'document'"
            :description="description"
            :audience="audience"
            :language="language"
            :can-edit="!isReadOnly"
            @update:description="(v: string) => description = v"
            @update:audience="(v: string) => audience = v"
            @update:language="(v: string) => language = v"
            @close="closeSidebar"
          />
          <CommentsPanel
            v-else-if="rightSidebar === 'comments'"
            ref="commentsPanelRef"
            :ytext="ytext"
            :awareness="awareness"
            :view="editorView"
            :doc-id="docId"
            :doc-workspace-id="docWorkspaceId"
            :read-only="isReadOnly"
            @focus="onCommentPanelFocus"
            @close="closeSidebar"
          />
          <SuggestionsSuggestionsPanel
            v-else-if="rightSidebar === 'suggestions'"
            ref="suggestionsPanelRef"
            :doc-id="docId"
            :awareness="awareness"
            :can-review="suggestionMode.canReview.value"
            :can-write="!isReadOnly"
            @focus="suggestionMode.onSuggestionFocus"
            @export="exportMarkdownWithSuggestions(suggestions.suggestions.value)"
            @close="closeSidebar"
          />
          <EditorLayoutActivitySidebar
            v-else-if="rightSidebar === 'activity'"
            :doc-id="docId"
            :ydoc="ydoc"
            :read-only="isReadOnly"
            @close="closeSidebar"
          />
          <DocumentThemeEditorPanel
            v-else-if="rightSidebar === 'theme'"
            :theme="theme as DocTheme"
            :doc-id="docId"
            :can-edit="canEditTheme"
            :custom-css-allowed="customCssAllowed"
            :workspace-id="docWorkspaceRole ? docWorkspaceId : null"
            :brand-locked="brandLockedTheme !== null"
            :can-manage-brand="docWorkspaceRole === 'admin'"
            @update:theme="setTheme"
            @reset="resetTheme"
            @close="closeSidebar"
          />
          <!-- Same upload/list/delete surface as the workspace overview, scoped to
               this doc's workspace. Rendered only with hasKnowledgeAccess, so
               workspaceId / docWorkspaceRole are non-null here. -->
          <EditorLayoutKnowledgeSidebar
            v-else-if="rightSidebar === 'knowledge' && docWorkspaceId && docWorkspaceRole"
            :workspace-id="docWorkspaceId"
            :role="docWorkspaceRole"
            @close="closeSidebar"
          />
          <!-- Mobile only (the desktop toolbar covers `>=sm`). Actions run through
               the editorCommands.ts helpers and emit `done` to close the sheet and
               refocus the editor; table-size and image picker handoffs are forwarded. -->
          <EditorCommandsPanel
            v-else-if="rightSidebar === 'editor'"
            :view="editorView"
            :can-comment="!isReadOnly"
            @done="closeSidebar"
            @close="closeSidebar"
            @open-table-picker="tableModalOpen = true"
            @open-image-picker="openImagePicker"
            @open-import="showImportModal = true"
            @open-server-pdf="openServerPdf"
            @export-markdown="exportMarkdown"
          />
        </RightPanelHost>

        <!-- Overlay at the bottom of the content area (editor + preview + sidebar), hidden in
             preview-only mode and read-only; absolutely positioned, so `<main>` stays `relative`. -->
        <AIPromptBar
          v-if="!isReadOnly && contentWriter && viewMode !== 'preview'"
          :ai="ai"
          :workspace-id="docWorkspaceId"
          :doc-id="docId"
        />

        <!-- The only panel navigation below `sm`. Tabs: Document, Comments,
             Activity, Theme, Knowledge, Editor (commands drawer), Mic (toggles
             dictation directly). Hidden when read-only or in preview mode. -->
        <MobileTabBar
          v-if="!isReadOnly && viewMode !== 'preview'"
          :active-panel="rightSidebar"
          :suggestion-count="suggestionMode.count.value"
          :can-edit-theme="canEditTheme"
          :has-knowledge-access="hasKnowledgeAccess"
          :dictation-state="dictation.state.value"
          @select="toggleSidebar"
          @toggle-dictation="dictation.toggle()"
        />

        <!-- Mobile view-mode toggle. The desktop group lives in the topbar
             (`hidden sm:flex`); on mobile it floats top-right of the content
             area, since the bottom holds the AIResponsePanel + AIPromptBar +
             MobileTabBar stack. Offers only edit and preview (no useful 50/50
             at 390px). Hidden on `>=sm`. -->
        <EditorLayoutMobileViewModeBar v-model="viewMode" />
      </main>

      <!-- Mono micro-meta (10.5px, lowercase, 0.04em tracking, middot separators), like a colophon strip. -->
      <EditorLayoutStatusFooter
        :word-count="wordCount"
        :char-count="charCount"
        :page-count="pageCount"
        :view-mode="viewMode"
        :synced="synced && !deletedByOther"
        :read-only="isReadOnly"
        :suggesting="suggesting"
      />
    </template>

    <div
      v-else
      class="flex-1 flex items-center justify-center"
    >
      <div class="text-center text-muted">
        <UIcon
          name="i-lucide-lock"
          class="size-12 mb-4"
        />
        <p class="text-sm">
          {{ t('share.passwordRequiredDesc') }}
        </p>
      </div>
    </div>
    <DocumentImportModal
      v-model:open="showImportModal"
      :ytext="ytext"
      :read-only="isReadOnly || suggesting"
      :doc-id="docId"
      @apply-properties="applyImportedProperties"
    />

    <EditorKeyboardShortcutsModal v-model:open="showShortcuts" />
    <EditorTour
      ref="editorTour"
      :ready="tourReady"
      :is-mobile="isMobile"
    />

    <SharingShareModal
      v-model:open="showShareModal"
      :doc-id="docId"
      :doc-title="title"
      :is-owner="isOwner"
      :current-access-mode="accessMode"
      :can-manage="canManageDoc"
      :can-share-with-guests="!!docWorkspaceId && (docWorkspaceRole === 'admin' || docWorkspaceRole === 'editor')"
      :in-workspace="!!docWorkspaceId"
      @updated="(mode: string) => { setAccessMode(mode); showShareModal = false }"
    />

    <!-- Creates a new doc owned by the current user (same content, theme and images) and redirects to it. -->
    <DocumentDuplicateDocModal
      v-model:open="showDuplicateModal"
      :doc-id="docId"
      :source-title="title"
      @duplicated="(newDocId) => navigateTo(`/d/${newDocId}`)"
    />

    <!-- Reassigns the doc's workspace; owner or workspace admin only. -->
    <DocumentMoveWorkspaceModal
      v-model:open="showMoveModal"
      :doc-id="docId"
      :doc-title="title"
      :current-workspace-id="docWorkspaceId"
    />

    <!-- Owner-only entry from File → Delete. -->
    <DocumentDeleteConfirmModal
      v-model:open="showDeleteModal"
      :doc-id="docId"
      :title="title"
      @deleting="setDeletingHere(true)"
      @failed="setDeletingHere(false)"
      @deleted="navigateTo('/')"
    />

    <SharingPasswordModal
      v-model:open="passwordModalOpen"
      :doc-id="docId"
      @verified="onPasswordVerified"
      @cancel="navigateTo('/')"
    />

    <!-- From the menu bar's Insert → Table or the toolbar's Table button. -->
    <EditorLayoutTableDialog
      v-model:open="tableModalOpen"
      @select="onTableModalSelect"
    />

    <!-- Floating "Comment" pill on text selection; click runs the toolbar's create-comment handler. -->
    <CommentsCommentSelectionPopup
      v-if="!requiresPassword"
      :view="editorView"
      :disabled="isReadOnly"
      @trigger="triggerCreateComment"
    />

    <!-- Someone else deleted the document: keep the text, offer a copy. -->
    <EditorLayoutDeletedNotice
      v-model:open="deletedNoticeOpen"
      @download="exportMarkdown()"
    />
  </div>
</template>
