<script setup lang="ts">
import { comboKeys, currentShortcutPlatform, shortcutGroups, type ShortcutPlatform } from '~/utils/keyboardShortcuts'

/**
 * Help → Keyboard shortcuts. The list comes from `utils/keyboardShortcuts`
 * (resolved from the editor's real keymaps). Keys render as mono chips:
 * ⌘ ⌥ ⇧ on a Mac, Ctrl / Alt / Shift elsewhere. The platform is read when
 * the dialog opens (client only), so SSR never guesses it.
 */
defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const { t } = useI18n()
const platform = ref<ShortcutPlatform>('windows')
onMounted(() => {
  platform.value = currentShortcutPlatform()
})
const groups = computed(() => shortcutGroups(platform.value))
</script>

<template>
  <UModal
    :open="open"
    :title="t('shortcuts.title')"
    :description="t('shortcuts.subtitle')"
    :ui="{ content: 'max-w-2xl' }"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <template #body>
      <div
        class="sm:columns-2 gap-x-10"
        data-testid="shortcuts-modal"
      >
        <section
          v-for="group in groups"
          :key="group.titleKey"
          class="break-inside-avoid mb-6 last:mb-0"
        >
          <h3 class="mk-shortcuts__eyebrow">
            {{ t(group.titleKey) }}
          </h3>
          <dl>
            <div
              v-for="row in group.rows"
              :key="row.labelKey"
              class="mk-shortcuts__row"
            >
              <dt class="text-[13px] text-default">
                {{ t(row.labelKey) }}
              </dt>
              <dd class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                <span
                  v-for="(combo, ci) in row.combos"
                  :key="combo"
                  class="inline-flex items-center gap-1"
                >
                  <span
                    v-if="ci > 0"
                    class="text-muted text-xs"
                    aria-hidden="true"
                  >/</span>
                  <kbd
                    v-for="(k, ki) in comboKeys(combo, platform)"
                    :key="ki"
                    class="mk-kbd"
                  >{{ k }}</kbd>
                </span>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.mk-shortcuts__eyebrow {
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 400;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ui-text-muted);
  margin-bottom: 6px;
}
.mk-shortcuts__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 7px 0;
  border-bottom: 1px solid var(--ui-border);
}
.mk-shortcuts__row:last-child { border-bottom: 0; }
.mk-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--ui-border-accented);
  border-radius: 4px;
  background: var(--ui-bg-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  color: var(--ui-text);
}
</style>
