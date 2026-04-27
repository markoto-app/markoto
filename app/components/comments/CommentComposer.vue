<script setup lang="ts">
import { formatMentionToken, COMMENT_BODY_MAX } from '~/utils/commentBody'

interface MentionableUser {
  id: number
  name: string
  email: string | null
  avatarUrl: string | null
}

const props = withDefaults(defineProps<{
  mentionableUsers: readonly MentionableUser[]
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

const filteredMentionUsers = computed<MentionableUser[]>(() => {
  if (!mentionContext.value) return []
  const q = mentionContext.value.query.toLowerCase()
  if (q.length === 0) return props.mentionableUsers.slice(0, 8)
  return props.mentionableUsers
    .filter(u => u.name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q))
    .slice(0, 8)
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
  const cs = window.getComputedStyle(textarea)
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
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2
  document.body.removeChild(mirror)
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

function pickMention(user: MentionableUser) {
  const ctx = mentionContext.value
  const ta = textareaRef.value
  if (!ctx || !ta) return
  const caret = ta.selectionStart ?? body.value.length
  const before = body.value.slice(0, ctx.atIndex)
  const after = body.value.slice(caret)
  const token = formatMentionToken(user.name, user.id) + ' '
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
  // Typeahead-level keys take priority when the popover is open.
  if (mentionContext.value && filteredMentionUsers.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      highlighted.value = (highlighted.value + 1) % filteredMentionUsers.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      highlighted.value = (highlighted.value - 1 + filteredMentionUsers.value.length) % filteredMentionUsers.value.length
      return
    }
    if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      const pick = filteredMentionUsers.value[highlighted.value]
      if (pick) pickMention(pick)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      mentionContext.value = null
      return
    }
  }

  // Composer-level keys.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    submit()
    return
  }
  if (e.key === 'Escape') {
    // Don't bubble to the modal/sidebar close handler — we just want
    // to discard our local draft.
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
        v-for="(user, idx) in filteredMentionUsers"
        :key="user.id"
        type="button"
        class="w-full flex items-center gap-2 px-2 py-1 text-left text-sm hover:bg-muted/40"
        :class="idx === highlighted ? 'bg-primary-500/15' : ''"
        role="option"
        :aria-selected="idx === highlighted"
        @click="pickMention(user)"
        @mouseenter="highlighted = idx"
      >
        <UAvatar
          :src="user.avatarUrl ?? undefined"
          :alt="user.name"
          size="2xs"
        />
        <span class="truncate">{{ user.name }}</span>
        <span
          v-if="user.email"
          class="text-xs text-muted truncate ml-auto"
        >{{ user.email }}</span>
      </button>
    </div>

    <div class="mt-1.5 flex items-center justify-between gap-2">
      <span class="text-[11px] text-muted">
        {{ t('comments.submitHint', { cmd: cmdLabel }) }}
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
        <UButton
          color="primary"
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
