<script setup lang="ts">
/**
 * One card of the picture pickers (designs in ThemePresetGrid, templates in
 * TemplateGrid): a picture of the first page, the name in the design's
 * heading font, two lines of description. Without a picture it shows a
 * brand stripe + "Aa" in the heading font (saved designs, a workspace
 * default, presets not rendered yet).
 */
withDefaults(defineProps<{
  testid: string
  name: string
  description: string
  selected?: boolean
  image?: string | null
  brand: string
  headingFont: string
  /** data-testid of the description line, when a test needs it. */
  descriptionTestid?: string
}>(), { selected: false, image: null, descriptionTestid: undefined })

defineEmits<{ click: [] }>()

const fontStack = (font: string) => `'${font}', system-ui, sans-serif`
</script>

<template>
  <button
    type="button"
    :data-testid="testid"
    class="text-left rounded-md border p-1.5 bg-default hover:bg-elevated/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inverted"
    :class="selected ? 'border-inverted bg-elevated/40' : 'border-default'"
    :aria-pressed="selected"
    @click="$emit('click')"
  >
    <div class="aspect-[3/4] rounded-sm ring-1 ring-default bg-white overflow-hidden flex flex-col">
      <img
        v-if="image"
        :src="image"
        alt=""
        loading="lazy"
        decoding="async"
        class="w-full h-full object-cover object-top"
      >
      <template v-else>
        <div
          class="h-2 shrink-0"
          :style="{ backgroundColor: brand }"
        />
        <span
          class="m-auto text-3xl text-neutral-800"
          :style="{ fontFamily: fontStack(headingFont) }"
        >Aa</span>
      </template>
    </div>
    <div
      class="mt-1.5 px-0.5 text-xs font-semibold truncate"
      :style="{ fontFamily: fontStack(headingFont) }"
    >
      {{ name }}
    </div>
    <p
      class="px-0.5 text-[11px] text-muted leading-snug line-clamp-2 break-words"
      :data-testid="descriptionTestid"
    >
      {{ description }}
    </p>
  </button>
</template>
