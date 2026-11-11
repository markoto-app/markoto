<script setup lang="ts">
/**
 * Mobile "Editor" drawer content. Replaces the always-visible
 * `MobileFormatBar` strip with a categorized panel of every editor
 * command, grouped by purpose:
 *
 *   • Formatting   bold, italic, strikethrough, inline code
 *   • Headings     H1, H2, H3, body
 *   • Lists        bullet, numbered, task
 *   • Insert       link, image, table, code-block, alert, math,
 *                  diagram, page-break, footnote, comment, TOC
 *
 * Tapping any command runs it through the existing
 * `editorCommands.ts` helpers and CLOSES the drawer so the user
 * lands back on the editor with the keyboard already up. Sub-pickers
 * (alert kind, diagram kind) re-use the existing `InsertSheet`'s
 * step machine inline here so the user never has to leave the drawer.
 *
 * The design accepts the 2-tap cost (open drawer → tap action)
 * for two reasons:
 *
 *   1. Markdown is the native input — a writer who knows `**bold**`
 *      doesn't need a button. Buttons are for discovery + occasional
 *      reach, not constant flow.
 *   2. The previous keyboard-anchored bar gated visibility on a
 *      `visualViewport` heuristic that was flaky on iOS Safari, and
 *      the tradeoff for "always reachable + categorized" beat
 *      "single-tap but sometimes invisible".
 *
 * Renders as the slot content for the shared `BottomSheet` (via
 * `RightPanelHost`); no own chrome here, just the grouped grids.
 */
import type { EditorView } from '@codemirror/view'
import {
  toggleWrap,
  toggleCode,
  toggleHeading,
  toggleLinePrefix,
  toggleOrderedList,
  insertBlock,
  insertAlert,
  insertMath,
  insertDiagram,
  insertPageBreak,
  insertFootnote,
  insertToc,
  toggleComment,
  type AlertKind,
  type MermaidKind
} from '~/utils/editor/editorCommands'

const props = defineProps<{
  view: EditorView | null
  /** Hide insert-comment when the user can't anchor a comment
   *  (anonymous on a private doc, etc.). */
  canComment: boolean
}>()

const emit = defineEmits<{
  /** Emitted after any successful action so the host can close the
   *  drawer. The host returns focus to the editor; the keyboard is
   *  already up because we don't blur on emit. */
  'done': []
  /** Emitted when the user explicitly dismisses (× button) without
   *  running an action. The host closes the drawer. */
  'close': []
  /** Forward to the layout-level table-size picker modal — full-grid
   *  picker doesn't fit comfortably in a mobile drawer. */
  'open-table-picker': []
  /** Forward to the layout-level image picker (presigned upload flow). */
  'open-image-picker': []
  /** Open the import dialog (markitdown round-trip) — File menu
   *  equivalent for mobile users who don't have the desktop menubar. */
  'open-import': []
  /** Trigger server-rendered PDF download (Playwright sidecar render
   *  → S3 presigned download). Mirrors File → Save as PDF on desktop. */
  'open-server-pdf': []
  /** Trigger client-side `.md` download. Mirrors File → Save as
   *  Markdown on desktop. */
  'export-markdown': []
}>()

const { t } = useI18n()

// Sub-step state for kind-pickers. Same shape the InsertSheet used.
type Step = 'main' | 'alert' | 'diagram'
const step = ref<Step>('main')
function backToMain() {
  step.value = 'main'
}

function withDone(fn: () => void) {
  return () => {
    fn()
    emit('done')
  }
}

function bold() {
  if (props.view) toggleWrap(props.view, '**')
}
function italic() {
  if (props.view) toggleWrap(props.view, '_')
}
function strike() {
  if (props.view) toggleWrap(props.view, '~~')
}
function code() {
  if (props.view) toggleCode(props.view)
}
function heading(level: number) {
  if (props.view) toggleHeading(props.view, level)
}
function bulletList() {
  if (props.view) toggleLinePrefix(props.view, '- ')
}
function numberedList() {
  if (props.view) toggleOrderedList(props.view)
}
function taskList() {
  if (props.view) toggleLinePrefix(props.view, '- [ ] ')
}
function link() {
  if (!props.view) return
  const sel = props.view.state.selection.main
  const text = props.view.state.doc.sliceString(sel.from, sel.to) || ''
  props.view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `[${text}](url)` },
    selection: { anchor: sel.from + text.length + 3, head: sel.from + text.length + 6 }
  })
  props.view.focus()
}
function codeBlock() {
  if (props.view) insertBlock(props.view, '```\n\n```')
}
function math() {
  if (props.view) insertMath(props.view, 'block')
}
function pageBreak() {
  if (props.view) insertPageBreak(props.view)
}
function footnote() {
  if (props.view) insertFootnote(props.view)
}
function toc() {
  if (props.view) insertToc(props.view)
}
function commentInline() {
  if (props.view) toggleComment(props.view)
}

function applyAlert(kind: AlertKind) {
  if (!props.view) return
  insertAlert(props.view, kind)
  emit('done')
}

function applyDiagram(kind: MermaidKind) {
  if (!props.view) return
  insertDiagram(props.view, kind)
  emit('done')
}
</script>

<template>
  <div class="ecp h-full flex flex-col bg-muted">
    <!-- Panel header — matches the icon-title-× pattern the Activity,
         Knowledge, Comments, Theme and Document panels all use, so
         every drawer reads with one consistent voice. The
         `<BottomSheet>` host now intentionally renders no header of
         its own; this is the single title surface the user sees. -->
    <div class="p-3 border-b border-default/60 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-2">
        <UIcon
          name="i-lucide-pencil"
          class="size-4 text-muted"
        />
        <h3 class="font-serif text-base font-normal tracking-tight">
          {{ t('mobileTabBar.editor') }}
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

    <div class="ecp__body">
      <!-- ── MAIN ─────────────────────────────────────────────────── -->
      <template v-if="step === 'main'">
        <!-- Formatting -->
        <section class="ecp__section">
          <h3 class="ecp__heading">
            {{ t('editorCommands.formatting') }}
          </h3>
          <div class="ecp__grid">
            <button
              class="ecp__btn"
              :aria-label="t('editorCommands.bold')"
              @click="withDone(bold)()"
            >
              <UIcon
                name="i-lucide-bold"
                class="size-5"
              />
              <span>{{ t('editorCommands.bold') }}</span>
            </button>
            <button
              class="ecp__btn"
              :aria-label="t('editorCommands.italic')"
              @click="withDone(italic)()"
            >
              <UIcon
                name="i-lucide-italic"
                class="size-5"
              />
              <span>{{ t('editorCommands.italic') }}</span>
            </button>
            <button
              class="ecp__btn"
              :aria-label="t('editorCommands.strike')"
              @click="withDone(strike)()"
            >
              <UIcon
                name="i-lucide-strikethrough"
                class="size-5"
              />
              <span>{{ t('editorCommands.strike') }}</span>
            </button>
            <button
              class="ecp__btn"
              :aria-label="t('editorCommands.code')"
              @click="withDone(code)()"
            >
              <UIcon
                name="i-lucide-code"
                class="size-5"
              />
              <span>{{ t('editorCommands.code') }}</span>
            </button>
          </div>
        </section>

        <!-- Headings -->
        <section class="ecp__section">
          <h3 class="ecp__heading">
            {{ t('editorCommands.headings') }}
          </h3>
          <div class="ecp__grid">
            <button
              class="ecp__btn ecp__btn--text"
              @click="withDone(() => heading(1))()"
            >
              <span class="ecp__heading-mark">H1</span>
              <span>{{ t('editorCommands.heading1') }}</span>
            </button>
            <button
              class="ecp__btn ecp__btn--text"
              @click="withDone(() => heading(2))()"
            >
              <span class="ecp__heading-mark">H2</span>
              <span>{{ t('editorCommands.heading2') }}</span>
            </button>
            <button
              class="ecp__btn ecp__btn--text"
              @click="withDone(() => heading(3))()"
            >
              <span class="ecp__heading-mark">H3</span>
              <span>{{ t('editorCommands.heading3') }}</span>
            </button>
            <button
              class="ecp__btn ecp__btn--text"
              @click="withDone(() => heading(0))()"
            >
              <span class="ecp__heading-mark">¶</span>
              <span>{{ t('editorCommands.body') }}</span>
            </button>
          </div>
        </section>

        <!-- Lists -->
        <section class="ecp__section">
          <h3 class="ecp__heading">
            {{ t('editorCommands.lists') }}
          </h3>
          <div class="ecp__grid">
            <button
              class="ecp__btn"
              @click="withDone(bulletList)()"
            >
              <UIcon
                name="i-lucide-list"
                class="size-5"
              />
              <span>{{ t('editorCommands.bulletList') }}</span>
            </button>
            <button
              class="ecp__btn"
              @click="withDone(numberedList)()"
            >
              <UIcon
                name="i-lucide-list-ordered"
                class="size-5"
              />
              <span>{{ t('editorCommands.numberedList') }}</span>
            </button>
            <button
              class="ecp__btn"
              @click="withDone(taskList)()"
            >
              <UIcon
                name="i-lucide-list-checks"
                class="size-5"
              />
              <span>{{ t('editorCommands.taskList') }}</span>
            </button>
          </div>
        </section>

        <!-- Insert -->
        <section class="ecp__section">
          <h3 class="ecp__heading">
            {{ t('editorCommands.insert') }}
          </h3>
          <div class="ecp__grid">
            <button
              class="ecp__btn"
              @click="withDone(link)()"
            >
              <UIcon
                name="i-lucide-link"
                class="size-5"
              />
              <span>{{ t('editorCommands.link') }}</span>
            </button>
            <button
              class="ecp__btn"
              @click="emit('open-image-picker'); emit('done')"
            >
              <UIcon
                name="i-lucide-image"
                class="size-5"
              />
              <span>{{ t('editor.image') }}</span>
            </button>
            <button
              class="ecp__btn"
              @click="emit('open-table-picker'); emit('done')"
            >
              <UIcon
                name="i-lucide-table"
                class="size-5"
              />
              <span>{{ t('table.title') }}</span>
            </button>
            <button
              class="ecp__btn"
              data-testid="ecp-insert-code-block"
              @click="withDone(codeBlock)()"
            >
              <UIcon
                name="i-lucide-code-2"
                class="size-5"
              />
              <span>{{ t('menubar.insert.codeBlock') }}</span>
            </button>
            <button
              class="ecp__btn"
              data-testid="ecp-insert-alert"
              @click="step = 'alert'"
            >
              <UIcon
                name="i-lucide-alert-circle"
                class="size-5"
              />
              <span>{{ t('menubar.insert.alert') }}</span>
            </button>
            <button
              class="ecp__btn"
              data-testid="ecp-insert-math"
              @click="withDone(math)()"
            >
              <UIcon
                name="i-lucide-sigma"
                class="size-5"
              />
              <span>{{ t('menubar.insert.math') }}</span>
            </button>
            <button
              class="ecp__btn"
              data-testid="ecp-insert-diagram"
              @click="step = 'diagram'"
            >
              <UIcon
                name="i-lucide-workflow"
                class="size-5"
              />
              <span>{{ t('menubar.insert.diagram') }}</span>
            </button>
            <button
              class="ecp__btn"
              @click="withDone(pageBreak)()"
            >
              <UIcon
                name="i-lucide-scissors-line-dashed"
                class="size-5"
              />
              <span>{{ t('editor.pageBreak') }}</span>
            </button>
            <button
              class="ecp__btn"
              @click="withDone(footnote)()"
            >
              <UIcon
                name="i-lucide-asterisk"
                class="size-5"
              />
              <span>{{ t('editorCommands.footnote') }}</span>
            </button>
            <button
              class="ecp__btn"
              @click="withDone(toc)()"
            >
              <UIcon
                name="i-lucide-list-tree"
                class="size-5"
              />
              <span>{{ t('editorCommands.toc') }}</span>
            </button>
            <button
              v-if="canComment"
              class="ecp__btn"
              @click="withDone(commentInline)()"
            >
              <UIcon
                name="i-lucide-message-square-dashed"
                class="size-5"
              />
              <span>{{ t('editorCommands.hiddenComment') }}</span>
            </button>
          </div>
        </section>

        <!-- File. Mobile equivalent of the desktop File menu — Import,
           Save as PDF, Save as Markdown. Without these, mobile users
           lose feature parity with desktop on the import/export
           surface. The Print item is desktop-only because mobile
           browsers' print dialog is not interactively useful, but
           "Save as PDF" gives the same end result via the renderer
           sidecar. -->
        <section class="ecp__section">
          <h3 class="ecp__heading">
            {{ t('menubar.file.title') }}
          </h3>
          <div class="ecp__grid">
            <button
              class="ecp__btn"
              data-testid="ecp-file-import"
              @click="emit('open-import'); emit('done')"
            >
              <UIcon
                name="i-lucide-file-up"
                class="size-5"
              />
              <span>{{ t('menubar.file.import') }}</span>
            </button>
            <button
              class="ecp__btn"
              data-testid="ecp-file-export-pdf"
              @click="emit('open-server-pdf'); emit('done')"
            >
              <UIcon
                name="i-lucide-file-output"
                class="size-5"
              />
              <span>{{ t('export.pdf') }}</span>
            </button>
            <button
              class="ecp__btn"
              data-testid="ecp-file-export-md"
              @click="emit('export-markdown'); emit('done')"
            >
              <UIcon
                name="i-lucide-file-text"
                class="size-5"
              />
              <span>{{ t('export.markdown') }}</span>
            </button>
          </div>
        </section>
      </template>

      <!-- ── ALERT KIND PICKER ──────────────────────────────────────── -->
      <template v-else-if="step === 'alert'">
        <button
          class="ecp__back"
          type="button"
          @click="backToMain"
        >
          <UIcon
            name="i-lucide-arrow-left"
            class="size-4"
          />
          {{ t('common.back') }}
        </button>
        <div class="ecp__grid ecp__grid--2col">
          <button
            v-for="kind in (['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const)"
            :key="kind"
            class="ecp__btn ecp__btn--alert"
            :data-testid="`ecp-alert-${kind.toLowerCase()}`"
            @click="applyAlert(kind)"
          >
            <span class="ecp__alert-tag">[!{{ kind }}]</span>
            <span>{{ t(`menubar.insert.alert${kind.charAt(0) + kind.slice(1).toLowerCase()}`) }}</span>
          </button>
        </div>
      </template>

      <!-- ── DIAGRAM KIND PICKER ────────────────────────────────────── -->
      <template v-else-if="step === 'diagram'">
        <button
          class="ecp__back"
          type="button"
          @click="backToMain"
        >
          <UIcon
            name="i-lucide-arrow-left"
            class="size-4"
          />
          {{ t('common.back') }}
        </button>
        <div class="ecp__grid ecp__grid--2col">
          <button
            v-for="kind in (['flowchart', 'sequence', 'class', 'er', 'gantt', 'pie'] as const)"
            :key="kind"
            class="ecp__btn ecp__btn--alert"
            :data-testid="`ecp-diagram-${kind}`"
            @click="applyDiagram(kind)"
          >
            <span class="ecp__alert-tag">{{ kind }}</span>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Outer wrapper provides chrome (bg-muted, full-height column). The
   actual command grid sits in `.ecp__body` below so padding only
   applies to the scrollable content, not the sticky header. */
.ecp__body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 12px 24px 12px;
  -webkit-overflow-scrolling: touch;
}

.ecp__section + .ecp__section {
  margin-top: 18px;
}

.ecp__heading {
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 400;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ui-text-muted);
  margin: 0 0 8px 4px;
}

.ecp__grid {
  display: grid;
  /* minmax(0, 1fr): a long label must not widen its column (a 1fr
     track's minimum is its content, which pushed the grid past the
     sheet's edge). */
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.ecp__grid--2col {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.ecp__btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 12px 6px;
  border-radius: 12px;
  background: transparent;
  border: 1px solid var(--ui-border);
  color: var(--ui-text);
  font-size: 11px;
  cursor: pointer;
  transition: background 120ms ease, transform 80ms ease;
  text-align: center;
  min-height: 64px;
}
.ecp__btn:active {
  background: var(--ui-bg-elevated);
  transform: scale(0.97);
}
.ecp__btn--text .ecp__heading-mark {
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 400;
  letter-spacing: -0.01em;
  color: var(--ui-text);
}
.ecp__btn span:last-child {
  font-size: 11px;
  line-height: 1.25;
  color: var(--ui-text-muted);
  /* Up to two lines ("Table of contents", German labels), then an ellipsis. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: break-word;
  max-width: 100%;
}

.ecp__back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-bottom: 12px;
  border-radius: 8px;
  background: transparent;
  border: 0;
  color: var(--ui-text-muted);
  cursor: pointer;
  font-size: 13px;
}
.ecp__back:hover { color: var(--ui-text); }

.ecp__btn--alert {
  align-items: flex-start;
  text-align: left;
}
.ecp__alert-tag {
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ui-text-muted);
}
</style>
