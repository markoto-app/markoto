<script setup lang="ts">
// Mobile top-bar menu: file actions (the desktop File menu's counterpart),
// view mode, colour mode, help and the account, in one place to reduce
// top-bar clutter.
const props = defineProps<{
  noDownload: boolean
  /** Owner or workspace admin: Move and Duplicate (the menu bar's gate). */
  canManage: boolean
  /** The server's `canDelete` (also true for the browser that created an anonymous doc). */
  canDelete: boolean
}>()
const viewMode = defineModel<'edit' | 'preview' | 'split'>('viewMode', { required: true })
const emit = defineEmits<{
  'new-document': []
  'open-import': []
  'export-markdown': []
  'print': []
  'open-server-pdf': []
  'duplicate-document': []
  'move-document': []
  'delete-document': []
  'open-docs': []
  'start-tour': []
  'logout': []
}>()
const { t } = useI18n()

// The color-mode read is deferred to onMounted: useColorMode() returns
// 'light' on SSR, so a top-level read mismatches on hydration for dark-mode
// users (see app/AGENTS.md "Common Vue conventions").
const colorMode = useColorMode()
const colorModeValue = ref<'light' | 'dark'>('light')
onMounted(() => {
  colorModeValue.value = colorMode.value === 'dark' ? 'dark' : 'light'
})
watch(() => colorMode.value, (v) => {
  colorModeValue.value = v === 'dark' ? 'dark' : 'light'
})
const { loggedIn, user: sessionUser } = useUserSession()
// Login entries only for providers this instance has configured.
const { loginOptions } = useLoginOptions()

function fileGroup() {
  return [
    { label: t('menubar.file.new'), icon: 'i-lucide-file-plus', onSelect: () => emit('new-document') },
    { label: t('menubar.file.import'), icon: 'i-lucide-upload', onSelect: () => emit('open-import') },
    ...(props.noDownload
      ? []
      : [
          { label: t('menubar.file.export'), icon: 'i-lucide-file-down', onSelect: () => emit('export-markdown') },
          { label: t('menubar.file.print'), icon: 'i-lucide-printer', onSelect: () => emit('print') },
          { label: t('export.pdf'), icon: 'i-lucide-file-output', onSelect: () => emit('open-server-pdf') }
        ]),
    ...(props.canManage
      ? [
          { label: t('menubar.file.duplicate'), icon: 'i-lucide-copy', onSelect: () => emit('duplicate-document') },
          { label: t('menubar.file.move'), icon: 'i-lucide-folder-input', onSelect: () => emit('move-document') }
        ]
      : []),
    ...(props.canDelete
      ? [{ label: t('menubar.file.delete'), icon: 'i-lucide-trash-2', onSelect: () => emit('delete-document') }]
      : [])
  ]
}

function authGroup() {
  if (!loggedIn.value) {
    return loginOptions.value.map(option => ({ label: option.label, icon: option.icon, to: option.to, external: true }))
  }
  return [
    { label: sessionUser.value?.name || t('menu.account'), icon: 'i-lucide-user', disabled: true },
    { label: t('auth.logout'), icon: 'i-lucide-log-out', onSelect: () => emit('logout') }
  ]
}

const mobileMenuItems = computed(() => {
  const viewModeGroup = [
    { label: t('editor.edit'), icon: 'i-lucide-code-2', checked: viewMode.value === 'edit', type: 'checkbox' as const, onSelect: () => { viewMode.value = 'edit' } },
    { label: t('editor.preview'), icon: 'i-lucide-eye', checked: viewMode.value === 'preview', type: 'checkbox' as const, onSelect: () => { viewMode.value = 'preview' } }
  ]
  const themeGroup = [{
    label: colorModeValue.value === 'dark' ? t('menu.lightMode') : t('menu.darkMode'),
    icon: colorModeValue.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon',
    onSelect: () => {
      colorMode.preference = colorModeValue.value === 'dark' ? 'light' : 'dark'
    }
  }]
  // Help: the phone's stand-in for the desktop Help menu (shortcuts need a keyboard).
  const helpGroup = [
    { label: t('menubar.help.docs'), icon: 'i-lucide-book-open', onSelect: () => emit('open-docs') },
    { label: t('menubar.help.tour'), icon: 'i-lucide-map', onSelect: () => emit('start-tour') }
  ]
  return [fileGroup(), viewModeGroup, themeGroup, helpGroup, authGroup()]
})
</script>

<template>
  <UDropdownMenu
    class="sm:hidden"
    :items="mobileMenuItems"
    :content="{ align: 'end' }"
  >
    <UButton
      icon="i-lucide-menu"
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-label="t('common.menu')"
    />
  </UDropdownMenu>
</template>
