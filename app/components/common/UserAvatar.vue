<script lang="ts">
import { avatarColors } from '~/utils/collab/userAvatar'

// Module scope: one lazy renderer for every avatar on the page.
type Render = (seed: string) => string
let renderer: Render | null = null
let loading: Promise<Render> | null = null

function loadRenderer(): Promise<Render> {
  loading ??= import('~/utils/collab/userAvatarRender').then((m) => {
    renderer = m.renderAvatarDataUri
    return renderer
  })
  return loading
}
</script>

<script setup lang="ts">
/**
 * A person's avatar: a DiceBear "Moods" face rendered locally (see
 * `utils/userAvatar.ts`). Never loads an image from a third party.
 *
 * Seeds: `avatarSeedFor({ id })` for signed-in users (stable
 * everywhere), `avatarSeedFor({ avatarSeed })` for an anonymous
 * visitor's per-session token. The AI never uses this — it keeps the
 * seal disc.
 *
 * SSR + hydration: the server and the first client render show the
 * seed's background disc only (same colour on both sides, no mismatch);
 * the face appears once the lazy renderer has loaded. Avatars mounted
 * after that render the face right away.
 */

const props = withDefaults(defineProps<{
  seed: string
  /** Used as the alt text. Empty = decorative (a name is next to it). */
  name?: string
  /** Edge length in px. Override responsively with a `!size-*` class. */
  size?: number
}>(), {
  name: '',
  size: 24
})

const nuxtApp = useNuxtApp()
const ready = ref(renderer !== null && !nuxtApp.isHydrating)

onMounted(() => {
  if (renderer) {
    ready.value = true
    return
  }
  loadRenderer().then(() => {
    ready.value = true
  }).catch(() => {
    // Chunk failed to load (offline, deploy skew): keep the disc.
  })
})

const background = computed(() => avatarColors(props.seed).background)
const src = computed(() => (ready.value && renderer ? renderer(props.seed) : null))
</script>

<template>
  <span
    class="mk-user-avatar"
    :style="{ width: `${size}px`, height: `${size}px`, backgroundColor: background }"
    :role="name ? 'img' : undefined"
    :aria-label="name || undefined"
    :aria-hidden="name ? undefined : 'true'"
    data-testid="user-avatar"
    :data-avatar-seed="seed"
  >
    <img
      v-if="src"
      :src="src"
      alt=""
      draggable="false"
    >
  </span>
</template>

<style scoped>
.mk-user-avatar {
  display: inline-flex;
  flex-shrink: 0;
  border-radius: 9999px;
  overflow: hidden;
  vertical-align: middle;
}
.mk-user-avatar img {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
