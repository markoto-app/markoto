<script setup lang="ts">
// Access-mode button: closed lock when restricted (private or
// password-protected), open lock when anyone with the link gets in. A
// binary icon avoids clashing with nearby icons (the eye is the
// preview/split toggle); the tooltip says view-only vs open-edit. Also under
// Sharing → Access; kept here because the lock doubles as an indicator.
const props = defineProps<{
  accessMode: string
}>()
const emit = defineEmits<{ 'open-share': [] }>()
const { t } = useI18n()

const ACCESS_LABELS: Record<string, string> = {
  'private': 'share.private',
  'open-edit': 'share.openEdit',
  'open-view': 'share.openView',
  'password-protected': 'share.passwordProtected'
}
const LOCKED_MODES = new Set(['private', 'password-protected'])
const accessIcon = computed(() => LOCKED_MODES.has(props.accessMode) ? 'i-lucide-lock' : 'i-lucide-lock-open')
const accessLabelKey = computed(() => ACCESS_LABELS[props.accessMode] ?? 'share.openEdit')
</script>

<template>
  <UTooltip :text="`${t('share.accessMode')}: ${t(accessLabelKey)}`">
    <UButton
      :icon="accessIcon"
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-label="`${t('share.accessMode')}: ${t(accessLabelKey)}`"
      data-testid="access-lock-button"
      @click="emit('open-share')"
    />
  </UTooltip>
</template>
