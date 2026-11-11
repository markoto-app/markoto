<script setup lang="ts">
// Renders a structured unified diff; the caller owns fetching and loading
// states. Unified rather than side-by-side because the sidebar is narrow. The
// gutter shows the new-file line number for context/add lines and `−` for
// removed lines.

interface DiffLine {
  kind: 'context' | 'add' | 'remove'
  text: string
}

interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

defineProps<{
  hunks: DiffHunk[]
  truncated?: boolean
  totalHunks?: number
}>()

const { t } = useI18n()

function lineNumber(hunk: DiffHunk, lineIndex: number): string {
  // Counts from hunk.newStart over lines present in the new file (context + add).
  let n = hunk.newStart
  for (const line of hunk.lines.slice(0, lineIndex)) {
    if (line.kind !== 'remove') n += 1
  }
  return hunk.lines[lineIndex]?.kind === 'remove' ? '−' : String(n)
}
</script>

<template>
  <div
    v-if="hunks.length === 0"
    class="text-xs text-muted italic px-2 py-3"
  >
    {{ t('activity.diff.empty') }}
  </div>
  <div v-else>
    <div
      v-if="truncated"
      class="text-[11px] text-amber-500 mb-1.5 flex items-center gap-1"
    >
      <UIcon
        name="i-lucide-alert-triangle"
        class="size-3"
      />
      {{ t('activity.diff.truncated', { shown: hunks.length, total: totalHunks }) }}
    </div>

    <div
      v-for="(hunk, hi) in hunks"
      :key="hi"
      class="diff-hunk font-mono text-[11px] leading-snug rounded border border-default/60 overflow-hidden mb-1.5 last:mb-0 bg-default"
    >
      <!-- Git-style "@@ -oldStart,oldLines +newStart,newLines @@" header. -->
      <div class="px-2 py-0.5 text-muted bg-muted/40 border-b border-default/60 select-none">
        @@ -{{ hunk.oldStart }},{{ hunk.oldLines }} +{{ hunk.newStart }},{{ hunk.newLines }} @@
      </div>

      <div
        v-for="(line, li) in hunk.lines"
        :key="li"
        class="flex"
        :class="{
          'bg-green-500/10': line.kind === 'add',
          'bg-red-500/10': line.kind === 'remove'
        }"
      >
        <span
          class="select-none w-8 shrink-0 text-right pr-1.5 text-muted/70 border-r border-default/40"
          :class="{
            'text-green-600 dark:text-green-400': line.kind === 'add',
            'text-red-600 dark:text-red-400': line.kind === 'remove'
          }"
        >{{ lineNumber(hunk, li) }}</span>
        <span
          class="select-none w-3 shrink-0 text-center"
          :class="{
            'text-green-600 dark:text-green-400': line.kind === 'add',
            'text-red-600 dark:text-red-400': line.kind === 'remove'
          }"
        >{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ' }}</span>
        <!-- `whitespace-pre-wrap` wraps long lines instead of overflowing the narrow sidebar. -->
        <span class="flex-1 min-w-0 whitespace-pre-wrap break-words pl-1.5">{{ line.text }}</span>
      </div>
    </div>
  </div>
</template>
