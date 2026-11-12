<script setup lang="ts">
/**
 * Word-style table-size picker: an N×N grid where hovering highlights every
 * cell from the top-left to the cursor and the label above shows the size
 * ("3 × 4"). Clicking emits the selection. Chosen over two number inputs
 * because it is the familiar Word/Docs/Notion pattern and takes one
 * hover-and-click instead of read, focus, type, tab.
 */

const MAX_ROWS = 8
const MAX_COLS = 8

const emit = defineEmits<{
  select: [{ rows: number, cols: number }]
}>()

// -1 = nothing highlighted (initial state and after mouseleave); 0 would
// always highlight one cell on mount, suggesting a default that doesn't exist.
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
  <!-- Presentation only: the hover preview mirrors what focus does on the buttons below. -->
  <div
    role="presentation"
    class="p-2.5 select-none"
    @mouseleave="hoverRow = -1; hoverCol = -1"
    @focusout="hoverRow = -1; hoverCol = -1"
  >
    <div class="text-xs text-center mb-2 font-medium text-default tabular-nums">
      {{ labelText }}
    </div>
    <table
      class="border-separate"
      style="border-spacing: 2px;"
      :aria-label="`Table size picker, up to ${MAX_ROWS} by ${MAX_COLS}`"
    >
      <!-- Visually-hidden column headers (1..N) so screen readers and Sonar can confirm the grid has scope. -->
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
              @focus="hoverRow = row - 1; hoverCol = col - 1"
              @click="onSelect(row - 1, col - 1)"
            />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
