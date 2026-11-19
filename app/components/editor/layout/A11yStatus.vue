<script setup lang="ts">
import { checkAccessibility, type AccessibilityIssue } from '~/utils/editor/accessibilityCheck'

// Status-bar entry of the accessibility check: hidden while the document
// has no issue, otherwise a count that opens the list. A click on an issue
// jumps to it in the editor.
const props = defineProps<{ text: string }>()
const emit = defineEmits<{ jump: [from: number, to: number] }>()
const { t } = useI18n()

// The check runs on a debounced copy: it scans the whole text.
const debounced = refDebounced(toRef(props, 'text'), 600)
const issues = computed(() => checkAccessibility(debounced.value))
const open = ref(false)

function describe(issue: AccessibilityIssue): string {
  switch (issue.kind) {
    case 'image-alt': return t('a11yCheck.imageAlt')
    case 'empty-link': return t('a11yCheck.emptyLink')
    case 'heading-skip': return t('a11yCheck.headingSkip', { level: issue.level, previous: issue.previousLevel })
  }
}

function jump(issue: AccessibilityIssue) {
  open.value = false
  emit('jump', issue.from, issue.to)
}
</script>

<template>
  <UPopover
    v-if="issues.length > 0"
    v-model:open="open"
    :content="{ align: 'start', side: 'top', sideOffset: 6 }"
  >
    <button
      type="button"
      class="inline-flex items-center gap-1 hover:text-default transition-colors"
      data-testid="a11y-check-status"
    >
      <UIcon
        name="i-lucide-accessibility"
        class="size-3"
      />
      {{ t('a11yCheck.issues', { n: issues.length }, issues.length) }}
    </button>
    <template #content>
      <div
        class="w-80 max-h-80 overflow-y-auto p-2 font-sans"
        data-testid="a11y-check-panel"
      >
        <p class="px-2 pt-1 pb-2 text-xs text-muted">
          {{ t('a11yCheck.intro') }}
        </p>
        <ul class="flex flex-col">
          <li
            v-for="issue in issues"
            :key="`${issue.kind}-${issue.from}`"
          >
            <button
              type="button"
              class="w-full text-left rounded px-2 py-1.5 text-sm hover:bg-muted flex items-baseline gap-2"
              data-testid="a11y-check-issue"
              :data-kind="issue.kind"
              @click="jump(issue)"
            >
              <span class="font-mono text-[11px] text-muted shrink-0">{{ t('a11yCheck.line', { line: issue.line }) }}</span>
              <span>{{ describe(issue) }}</span>
            </button>
          </li>
        </ul>
      </div>
    </template>
  </UPopover>
</template>
