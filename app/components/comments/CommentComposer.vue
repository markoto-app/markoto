<script setup lang="ts">
import { useFuse } from '@vueuse/integrations/useFuse'
import { formatMentionToken, COMMENT_BODY_MAX } from '~/utils/comments/commentBody'
import type { MentionableEntry } from '~/utils/comments/mentionable'

const props = withDefaults(defineProps<{
  mentionableUsers: readonly MentionableEntry[]
  initialBody?: string
  autoFocus?: boolean
  placeholder?: string
  submitLabel?: string
  cancelLabel?: string
  /** Hides Cancel, e.g. for the always-visible reply composer (no draft to discard). */
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

// `mentionContext` is non-null while the caret sits in an in-progress mention
// (an `@` at start-of-body or after whitespace, no break char before the
// caret). The popover shows when it is set and at least one user matches.
const mentionContext = ref<{ atIndex: number, query: string } | null>(null)
const highlighted = ref(0)
// Caret pixel coords in the textarea; position the popover under the @.
const caretCoords = ref<{ top: number, left: number } | null>(null)
const POPOVER_WIDTH = 240

// Fuzzy match across name + email ("jbar" must find "Joel Barmettler", which
// substring matching missed). Threshold 0.4 (lower = stricter) is tuned by
// feel for first-name and email-prefix typing; results sort by relevance.
const mentionQuery = computed(() => mentionContext.value?.query ?? '')
const { results: fuseResults } = useFuse(
  mentionQuery,
  computed(() => [...props.mentionableUsers]),
  {
    fuseOptions: {
      // `aliases` lets legacy `@ai` (or any shortcut) still surface the
      // markoto entry, whose display name is "markoto". Fuse matches any
      // value of an array key.
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
 * The active mention context if the caret sits inside one. Walks back from
 * the caret to an `@` that is at start or after whitespace; gives up at whitespace.
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
 * Pixel coords of a character index in a textarea via the "mirror div"
 * technique: copy the textarea's styles into a hidden div, copy the text up
 * to `index`, and read a trailing span's offsets (adjusted for the
 * textarea's scroll). Relative to the textarea's top-left, so the popover in
 * the same `relative` parent can use them directly.
 */
function getCaretCoords(textarea: HTMLTextAreaElement, index: number): { top: number, left: number, lineHeight: number } {
  const cs = globalThis.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  // Copy layout-affecting properties. `pre-wrap` matches the textarea's
  // wrapping; `overflow: hidden` keeps a tall mirror from disturbing the page.
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
  // textContent, not innerHTML, so HTML in the body can't escape.
  mirror.textContent = before
  mirror.appendChild(span)
  document.body.appendChild(mirror)
  const top = span.offsetTop - textarea.scrollTop
  const left = span.offsetLeft - textarea.scrollLeft
  const lineHeight = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.2
  mirror.remove()
  return { top, left, lineHeight }
}

// Tapping outside the popover dismisses it (for mouse-only / touch users, where
// Escape isn't available). `ignore` keeps the textarea "inside" so typing
// doesn't re-close it on the next click.
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
    // Anchor under the @ itself; tracking the caret feels less attached.
    const pt = getCaretCoords(ta, ctx.atIndex)
    const taWidth = ta.clientWidth
    // Clamp left so the popover stays inside the right edge.
    const left = Math.max(0, Math.min(pt.left, taWidth - POPOVER_WIDTH - 4))
    caretCoords.value = { top: pt.top + pt.lineHeight + 2, left }
  } else {
    caretCoords.value = null
  }
}

function onInput() {
  // In some browsers input fires before selectionStart updates; defer a tick
  // to read the post-mutation caret.
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
  // The AI token is the bare `@ai` that the server's hasAiMention regex
  // matches; user tokens use `@[Name](user:N)` so the renderer can resolve
  // user_id to a name.
  const token = (entry.kind === 'ai' ? '@markoto' : formatMentionToken(entry.name, entry.id)) + ' '
  body.value = before + token + after
  mentionContext.value = null
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

/** Typeahead keys take priority while the popover is open; returns true if consumed. */
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
  // `maxlength` stops typing past the cap, but a programmatic v-model write
  // could exceed it; slice before emitting.
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
      :aria-label="placeholder || t('comments.composerPlaceholder')"
      :maxlength="maxLength"
      rows="2"
      class="w-full resize-none rounded border border-default bg-default text-sm text-default px-2 py-1.5 outline-none focus:border-primary placeholder:text-muted"
      data-testid="comment-composer-input"
      @input="onInput"
      @keydown="onKeydown"
      @keyup="onSelectionChange"
      @click="onSelectionChange"
    />

    <!-- Anchored to the `@` token via `getCaretCoords`, so it floats below the symbol. -->
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
          <!-- Seal replaces a generic icon for the markoto row. -->
          <span class="flex items-center justify-center size-4 shrink-0">
            <CommonSeal :size="8" />
          </span>
          <span class="truncate font-medium">{{ entry.name }}</span>
          <span class="text-xs text-muted truncate ml-auto">{{ entry.description }}</span>
        </template>
        <template v-else>
          <CommonUserAvatar
            :seed="avatarSeedFor({ id: entry.id })"
            :size="16"
          />
          <span class="truncate">{{ entry.name }}</span>
          <span
            v-if="entry.email"
            class="text-xs text-muted truncate ml-auto"
          >{{ entry.email }}</span>
        </template>
      </button>
    </div>

    <!-- Mono kbd-chip hint, same 0.04em tracking as the status bar; `whitespace-nowrap`
         keeps chips and verbs from breaking in the narrow panel. -->
    <div class="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
      <span class="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.04em] text-muted lowercase whitespace-nowrap">
        <kbd class="font-mono text-[10px] tracking-normal px-1.5 py-px rounded border border-default/70 bg-default text-default normal-case">{{ cmdLabel }}↵</kbd>
        <span>{{ t('comments.hintPost') }}</span>
        <span
          class="opacity-50"
          aria-hidden="true"
        >·</span>
        <kbd class="font-mono text-[10px] tracking-normal px-1.5 py-px rounded border border-default/70 bg-default text-default normal-case">esc</kbd>
        <span>{{ t('comments.hintCancel') }}</span>
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
        <!-- Neutral CTA: shu is reserved for AI presence, and posting a comment isn't an AI invocation. -->
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
/* The markoto typeahead row uses the brand seal, which already says "assistant, not teammate". */
</style>
