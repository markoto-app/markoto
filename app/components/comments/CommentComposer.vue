<script setup lang="ts">
import { useFuse } from '@vueuse/integrations/useFuse'
import { formatMentionToken, COMMENT_BODY_MAX } from '~/utils/commentBody'

// Mentionable items in the typeahead. Two kinds:
//   - `user` — a workspace member; inserts `@[Name](user:N)`.
//   - `ai`   — the AI assistant pseudo-user; inserts the literal `@ai`
//     trigger token. Synthesized by `CommentsPanel` and prepended to
//     the typeahead source so users can type "@" + arrow-down to
//     summon the AI without remembering the bare `@ai` syntax.
type MentionableEntry
  = | { kind: 'user', id: number, name: string, email: string | null, avatarUrl: string | null }
    | { kind: 'ai', id: 'ai', name: string, email: null, avatarUrl: null, description: string, aliases?: readonly string[] }

const props = withDefaults(defineProps<{
  mentionableUsers: readonly MentionableEntry[]
  initialBody?: string
  autoFocus?: boolean
  placeholder?: string
  submitLabel?: string
  cancelLabel?: string
  /**
   * When true, hide the Cancel button. Useful for the always-visible
   * reply composer at the bottom of a thread (no draft to discard).
   */
  hideCancel?: boolean
  /** Hard cap on body length. Defaults to the comment-grade cap. */
  maxLength?: number
}>(), {
  initialBody: '',
  autoFocus: false,
  placeholder: '',
  submitLabel: '',
  cancelLabel: '',
  hideCancel: false,
  maxLength: COMMENT_BODY_MAX
})

const emit = defineEmits<{
  submit: [body: string]
  cancel: []
}>()

const { t } = useI18n()

const body = ref(props.initialBody)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const mentionPopoverRef = ref<HTMLElement | null>(null)

// — @-mention typeahead state ────────────────────────────────────────
//
// `mentionContext` is non-null iff the caret currently sits inside an
// in-progress mention (after an `@` that's at start-of-body or
// preceded by whitespace, with no break char between `@` and the
// caret). The typeahead popover is rendered iff this is non-null AND
// at least one user matches the current query.
const mentionContext = ref<{ atIndex: number, query: string } | null>(null)
const highlighted = ref(0)
// Pixel coords of the caret inside the textarea — drives the popover's
// floating position so it appears under the @ rather than spanning the
// composer's full width.
const caretCoords = ref<{ top: number, left: number } | null>(null)
const POPOVER_WIDTH = 240

// Fuzzy match across name + email. Substring matching ("includes")
// failed for common abbreviations — "jbar" wouldn't match "Joel
// Barmettler". `useFuse` handles transposition + partial-token match
// at threshold 0.4 (lower = stricter; tuned by feel for first-name +
// email-prefix typeahead). `shouldSort: true` orders by relevance so
// the closest match shows up first under the highlighter.
const mentionQuery = computed(() => mentionContext.value?.query ?? '')
const { results: fuseResults } = useFuse(
  mentionQuery,
  computed(() => [...props.mentionableUsers]),
  {
    fuseOptions: {
      // `aliases` is the markoto-row's escape hatch: typing legacy
      // `@ai` (or any future shortcut) still surfaces the markoto
      // entry even though its display name is "markoto". Fuse treats
      // arrays for a key as multi-value and matches against any.
      keys: ['name', 'email', 'aliases'],
      threshold: 0.4,
      ignoreLocation: true,
      shouldSort: true
    },
    matchAllWhenSearchEmpty: true,
    resultLimit: 8
  }
)
const filteredMentionUsers = computed<MentionableEntry[]>(() => {
  if (!mentionContext.value) return []
  return fuseResults.value.map(r => r.item)
})

watch(filteredMentionUsers, (next) => {
  if (highlighted.value >= next.length) highlighted.value = 0
})

/**
 * Returns the active mention context if the caret sits inside one.
 * Walks backwards from the caret looking for `@`; gives up on
 * whitespace or if `@` isn't at-start / preceded by whitespace.
 */
function detectMentionContext(text: string, caret: number): { atIndex: number, query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i] ?? ''
    if (ch === '@') {
      if (i === 0 || /\s/.test(text[i - 1] ?? '')) {
        return { atIndex: i, query: text.slice(i + 1, caret) }
      }
      return null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

/**
 * Pixel coords of an arbitrary character index inside a textarea. Uses
 * the standard "mirror div" technique: copy the textarea's styles into
 * a hidden div, copy the content up to `index`, and place a span at
 * the end. The span's offsetTop / offsetLeft give us the caret's
 * pixel position, which we adjust for the textarea's own scroll.
 *
 * Coordinates are relative to the textarea's top-left corner, so the
 * popover (positioned in the same `relative` parent as the textarea)
 * can use them directly.
 */
function getCaretCoords(textarea: HTMLTextAreaElement, index: number): { top: number, left: number, lineHeight: number } {
  const cs = globalThis.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  // Copy properties that affect text layout. `white-space: pre-wrap`
  // matches the textarea's wrapping. `overflow: hidden` so the mirror
  // doesn't disturb the page even if it momentarily lays out tall.
  const props = [
    'boxSizing', 'width', 'height', 'paddingTop', 'paddingRight',
    'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
    'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize',
    'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'tabSize',
    'textIndent', 'textTransform', 'wordSpacing', 'whiteSpace', 'wordWrap'
  ] as const
  for (const p of props) {
    mirror.style.setProperty(p.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), cs.getPropertyValue(p.replace(/[A-Z]/g, m => '-' + m.toLowerCase())))
  }
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.overflow = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.wordWrap = 'break-word'

  const before = textarea.value.slice(0, index)
  const span = document.createElement('span')
  span.textContent = '​'
  // Use textContent (not innerHTML) so embedded HTML in the body
  // doesn't escape.
  mirror.textContent = before
  mirror.appendChild(span)
  document.body.appendChild(mirror)
  const top = span.offsetTop - textarea.scrollTop
  const left = span.offsetLeft - textarea.scrollLeft
  const lineHeight = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.2
  mirror.remove()
  return { top, left, lineHeight }
}

// Tap outside the popover (on the textarea, on a sibling, on the page
// background) dismisses the typeahead — complements the Escape key
// for mouse-only / touch users. `ignore` keeps the textarea OUT of
// "outside" so typing inside doesn't immediately re-close the popover
// on the next click.
onClickOutside(mentionPopoverRef, () => {
  if (mentionContext.value) mentionContext.value = null
}, { ignore: [textareaRef] })

function refreshMentionContext() {
  const ta = textareaRef.value
  if (!ta) {
    mentionContext.value = null
    caretCoords.value = null
    return
  }
  const caret = ta.selectionStart ?? 0
  const ctx = detectMentionContext(body.value, caret)
  mentionContext.value = ctx
  if (ctx) {
    // Anchor the popover under the @ symbol itself — feels more
    // "attached" than tracking the caret as the user types.
    const pt = getCaretCoords(ta, ctx.atIndex)
    const taWidth = ta.clientWidth
    // Clamp left so the popover doesn't overflow the right edge.
    const left = Math.max(0, Math.min(pt.left, taWidth - POPOVER_WIDTH - 4))
    caretCoords.value = { top: pt.top + pt.lineHeight + 2, left }
  } else {
    caretCoords.value = null
  }
}

function onInput() {
  // input fires AFTER the value updates but BEFORE selectionStart updates
  // in some browsers — defer one tick so we read the post-mutation caret.
  nextTick(() => refreshMentionContext())
}

function onSelectionChange() {
  refreshMentionContext()
}

function pickMention(entry: MentionableEntry) {
  const ctx = mentionContext.value
  const ta = textareaRef.value
  if (!ctx || !ta) return
  const caret = ta.selectionStart ?? body.value.length
  const before = body.value.slice(0, ctx.atIndex)
  const after = body.value.slice(caret)
  // Token shape depends on entry kind. The AI token is the bare `@ai`
  // string the server's hasAiMention regex matches; user tokens use
  // the structured `@[Name](user:N)` form so the renderer can resolve
  // user_id → avatar.
  const token = (entry.kind === 'ai' ? '@markoto' : formatMentionToken(entry.name, entry.id)) + ' '
  body.value = before + token + after
  mentionContext.value = null
  // Move caret to right after the inserted token + trailing space.
  const newCaret = (before + token).length
  nextTick(() => {
    ta.focus()
    ta.setSelectionRange(newCaret, newCaret)
  })
}

function onKeydown(e: KeyboardEvent) {
  if (mentionContext.value && filteredMentionUsers.value.length > 0 && handleMentionKey(e)) return
  handleComposerKey(e)
}

/** Typeahead-level keys take priority when the popover is open. Returns true if the key was consumed. */
function handleMentionKey(e: KeyboardEvent): boolean {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlighted.value = (highlighted.value + 1) % filteredMentionUsers.value.length
    return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlighted.value = (highlighted.value - 1 + filteredMentionUsers.value.length) % filteredMentionUsers.value.length
    return true
  }
  if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    const pick = filteredMentionUsers.value[highlighted.value]
    if (pick) pickMention(pick)
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    mentionContext.value = null
    return true
  }
  return false
}

/** Composer-level keys: Cmd/Ctrl+Enter submits; Escape discards the local draft (e.preventDefault keeps the modal/sidebar from closing too). */
function handleComposerKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    submit()
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  }
}

function submit() {
  const trimmed = body.value.trim()
  if (trimmed.length === 0) return
  // The textarea's `maxlength` attribute prevents typing past the cap,
  // but a programmatic v-model write could exceed it — slice as a
  // belt-and-braces guard before emitting.
  emit('submit', trimmed.slice(0, props.maxLength))
}

onMounted(() => {
  if (props.autoFocus) {
    nextTick(() => {
      textareaRef.value?.focus()
    })
  }
})

const isMacPlatform = (): boolean => {
  if (typeof navigator === 'undefined') return false
  const uad = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData
  if (uad?.platform) return /mac/i.test(uad.platform)
  return /Mac|iPhone|iPad/.test(navigator.platform)
}
const cmdLabel = computed(() => isMacPlatform() ? '⌘' : 'Ctrl')

const submitDisabled = computed(() => body.value.trim().length === 0)
</script>

<template>
  <div class="relative">
    <textarea
      ref="textareaRef"
      v-model="body"
      :placeholder="placeholder || t('comments.composerPlaceholder')"
      :maxlength="maxLength"
      rows="2"
      class="w-full resize-none rounded border border-default bg-default text-sm text-default px-2 py-1.5 outline-none focus:border-primary placeholder:text-muted"
      data-testid="comment-composer-input"
      @input="onInput"
      @keydown="onKeydown"
      @keyup="onSelectionChange"
      @click="onSelectionChange"
    />

    <!-- Mention typeahead popover. Anchored to the `@` token's pixel
         position via `getCaretCoords`, so it floats just below the
         symbol rather than spanning the composer's full width. -->
    <div
      v-if="mentionContext && filteredMentionUsers.length > 0 && caretCoords"
      ref="mentionPopoverRef"
      class="absolute z-20 rounded border border-default bg-elevated shadow-lg overflow-hidden"
      :style="{
        top: caretCoords.top + 'px',
        left: caretCoords.left + 'px',
        width: POPOVER_WIDTH + 'px'
      }"
      role="listbox"
    >
      <button
        v-for="(entry, idx) in filteredMentionUsers"
        :key="entry.kind === 'ai' ? 'ai' : entry.id"
        type="button"
        class="w-full flex items-center gap-2 px-2 py-1 text-left text-sm hover:bg-muted/40"
        :class="idx === highlighted ? 'bg-primary-500/15' : ''"
        role="option"
        :aria-selected="idx === highlighted"
        :data-testid="entry.kind === 'ai' ? 'mention-typeahead-ai' : `mention-typeahead-user-${entry.id}`"
        @click="pickMention(entry)"
        @mouseenter="highlighted = idx"
      >
        <template v-if="entry.kind === 'ai'">
          <!-- markoto row in the @-mention typeahead. Seal directly
               replaces the gradient sparkles icon. -->
          <span class="flex items-center justify-center size-4 shrink-0">
            <CommonSeal :size="8" />
          </span>
          <span class="truncate font-medium">{{ entry.name }}</span>
          <span class="text-xs text-muted truncate ml-auto">{{ entry.description }}</span>
        </template>
        <template v-else>
          <UAvatar
            :src="entry.avatarUrl ?? undefined"
            :alt="entry.name"
            size="2xs"
            referrerpolicy="no-referrer"
          />
          <span class="truncate">{{ entry.name }}</span>
          <span
            v-if="entry.email"
            class="text-xs text-muted truncate ml-auto"
          >{{ entry.email }}</span>
        </template>
      </button>
    </div>

    <!-- Composer footer. Compact kbd-chip hint in JetBrains Mono — same
         0.04em tracking register as the status bar and comment actions.
         `whitespace-nowrap` on the hint prevents the chips and verbs
         from line-breaking in the narrow comments panel. -->
    <div class="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
      <span class="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.04em] text-muted lowercase whitespace-nowrap">
        <kbd class="font-mono text-[10px] tracking-normal px-1.5 py-px rounded border border-default/70 bg-default text-default normal-case">{{ cmdLabel }}↵</kbd>
        <span>post</span>
        <span
          class="opacity-50"
          aria-hidden="true"
        >·</span>
        <kbd class="font-mono text-[10px] tracking-normal px-1.5 py-px rounded border border-default/70 bg-default text-default normal-case">esc</kbd>
        <span>cancel</span>
      </span>
      <div class="flex gap-1">
        <UButton
          v-if="!hideCancel"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="emit('cancel')"
        >
          {{ cancelLabel || t('comments.cancel') }}
        </UButton>
        <!-- Submit button uses neutral (sumi-950 in light, sumi-50
             in dark). Shu is reserved for AI presence — posting a
             comment is a regular CTA, not an AI invocation. -->
        <UButton
          color="neutral"
          variant="solid"
          size="xs"
          :disabled="submitDisabled"
          data-testid="comment-composer-submit"
          @click="submit"
        >
          {{ submitLabel || t('comments.post') }}
        </UButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* markoto typeahead row uses the brand seal directly — no separate
 * gradient chip needed. The seal already carries the "this is the
 * assistant, not a teammate" cue. */
</style>
