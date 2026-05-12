<script setup lang="ts">
/**
 * Word-style table-size picker. Shows an N×N grid of small squares;
 * hovering a square highlights every cell from the top-left to the
 * cursor and the label above reports the current dimensions
 * ("3 × 4"). Clicking emits the selection so the parent can insert
 * a table of that size and close the popover.
 *
 * Why this instead of two number inputs: it's the muscle-memory
 * pattern users have from Word/Docs/Notion. Two number inputs
 * disclose the same data but ask the user to read, focus, type,
 * tab — instead of a single hover-and-click motion.
 */

const MAX_ROWS = 8
const MAX_COLS = 8

const emit = defineEmits<{
  select: [{ rows: number, cols: number }]
}>()

// -1 means nothing highlighted yet (initial state and after mouseleave).
// Cleaner than 0 because 0,0 would always show one cell highlighted on
// mount, suggesting a default selection that doesn't exist.
const hoverRow = ref(-1)
const hoverCol = ref(-1)

function isHighlighted(row: number, col: number): boolean {
  return row <= hoverRow.value && col <= hoverCol.value
}

function onSelect(row: number, col: number) {
  emit('select', { rows: row + 1, cols: col + 1 })
}

const labelText = computed(() => {
  if (hoverRow.value < 0) return '\u00A0' // non-breaking space — keeps the row height stable while empty
  return `${hoverCol.value + 1} × ${hoverRow.value + 1}`
})
</script>

<template>
  <div class="p-2.5 select-none">
    <div class="text-xs text-center mb-2 font-medium text-default tabular-nums">
      {{ labelText }}
    </div>
    <table
      class="border-separate"
      style="border-spacing: 2px;"
      :aria-label="`Table size picker, up to ${MAX_ROWS} by ${MAX_COLS}`"
      @mouseleave="hoverRow = -1; hoverCol = -1"
    >
      <!-- Visually-hidden column headers (column index 1..N). The
           picker is a 2D button grid; the headers exist so screen
           readers + Sonar can both confirm the table has scope. -->
      <thead class="sr-only">
        <tr>
          <th
            v-for="col in MAX_COLS"
            :key="col"
            scope="col"
          >
            {{ col }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in MAX_ROWS"
          :key="row"
        >
          <td
            v-for="col in MAX_COLS"
            :key="col"
            class="p-0"
          >
            <button
              type="button"
              :aria-pressed="isHighlighted(row - 1, col - 1)"
              :aria-label="`${col} columns by ${row} rows`"
              class="size-[18px] rounded-sm border transition-colors"
              :class="isHighlighted(row - 1, col - 1)
                ? 'bg-primary border-primary'
                : 'bg-elevated border-default'"
              @mouseenter="hoverRow = row - 1; hoverCol = col - 1"
              @click="onSelect(row - 1, col - 1)"
            />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
