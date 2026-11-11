<script setup lang="ts">
// Feature table driven by props, for comparison pages:
//
//   ::compare-table
//   ---
//   columns: [markoto, HackMD]
//   rows:
//     - label: Paged PDF export
//       values: [true, false]
//     - label: Self-hosting
//       values: [true, partial]
//       note: Only the open-source sibling HedgeDoc.
//   ---
//   ::
//
// A value is `true` (yes), `false` (no), `partial`, or any other text,
// shown as written. Icons carry a text label for screen readers.
type Value = boolean | string
interface Cell { icon: string, text: string, tone: 'yes' | 'no' | 'partial' | 'text' }

const props = defineProps<{
  columns: string[]
  rows: Array<{ label: string, values: Value[], note?: string }>
  caption?: string
}>()

const { t } = useI18n()

function cell(value: Value | undefined): Cell {
  if (value === true) return { icon: 'i-lucide-check', text: t('marketing.compare.yes'), tone: 'yes' }
  if (value === false) return { icon: 'i-lucide-minus', text: t('marketing.compare.no'), tone: 'no' }
  if (value === 'partial') return { icon: 'i-lucide-circle-dashed', text: t('marketing.compare.partial'), tone: 'partial' }
  return { icon: '', text: value ?? '', tone: 'text' }
}

const body = computed(() => props.rows.map(row => ({
  ...row,
  cells: props.columns.map((column, i) => ({ column, ...cell(row.values[i]) }))
})))
</script>

<template>
  <div
    class="mk-compare mk-wide not-prose"
    data-testid="marketing-compare-table"
  >
    <!-- Scrolls sideways on its own on narrow screens (focusable, so the
         keyboard can scroll it too); the feature column stays put. -->
    <div
      class="mk-compare__scroll"
      tabindex="0"
      role="region"
      :aria-label="caption ?? columns.join(' · ')"
    >
      <table class="mk-compare__table">
        <caption
          v-if="caption"
          class="sr-only"
        >
          {{ caption }}
        </caption>
        <thead>
          <tr>
            <td />
            <th
              v-for="column in columns"
              :key="column"
              scope="col"
            >
              {{ column }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in body"
            :key="row.label"
          >
            <th scope="row">
              {{ row.label }}
              <span
                v-if="row.note"
                class="mk-compare__note"
              >{{ row.note }}</span>
            </th>
            <td
              v-for="c in row.cells"
              :key="c.column"
              :class="`mk-compare__cell--${c.tone}`"
            >
              <template v-if="c.icon">
                <UIcon
                  :name="c.icon"
                  class="size-4 align-middle"
                  aria-hidden="true"
                />
                <span class="sr-only">{{ c.text }}</span>
              </template>
              <template v-else>
                {{ c.text }}
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <!-- Outside the scroll box, so it stays readable while the table scrolls. -->
    <p
      v-if="caption"
      class="mk-compare__caption"
      aria-hidden="true"
    >
      {{ caption }}
    </p>
  </div>
</template>

<style scoped>
.mk-compare {
  margin: 24px 0 32px;
}
.mk-compare__scroll {
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.mk-compare__scroll:focus-visible {
  outline: 2px solid var(--ui-border-accented);
  outline-offset: 2px;
}
.mk-compare__table {
  width: 100%;
  min-width: 480px;
  border-collapse: collapse;
  font-size: 14px;
}
.mk-compare__caption {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.mk-compare__table :is(th, td) {
  padding: 10px 12px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
  vertical-align: top;
}
.mk-compare__table thead th {
  font-family: var(--font-serif);
  font-weight: 400;
  font-size: 16px;
}
.mk-compare__table tbody th { font-weight: 500; }
/* Feature column: wide enough that short labels stay on one line. */
.mk-compare__table thead td { width: 22%; }
.mk-compare__note {
  display: block;
  margin-top: 2px;
  font-weight: 400;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.mk-compare__cell--no,
.mk-compare__cell--partial { color: var(--ui-text-muted); }

/* Phones: tighter cells, and the feature column stays visible while the
   values scroll under it (page ground behind it, hairline on its edge). */
@media (max-width: 639px) {
  .mk-compare__table {
    min-width: 460px;
    font-size: 13px;
  }
  .mk-compare__table :is(th, td) { padding: 8px 10px; }
  .mk-compare__table :is(thead td, tbody th) {
    position: sticky;
    left: 0;
    z-index: 1;
    width: 112px;
    background: var(--ui-bg-muted);
    box-shadow: inset -1px 0 0 var(--ui-border);
  }
}
</style>
