<script setup lang="ts">
import type { Awareness } from 'y-protocols/awareness'

const props = defineProps<{
  awareness: Awareness
}>()

interface AwarenessUser {
  name: string
  color: string
  avatar?: string
}

const users = ref<Map<number, AwarenessUser>>(new Map())

function updateUsers() {
  const states = props.awareness.getStates()
  const localId = props.awareness.clientID
  const result = new Map<number, AwarenessUser>()

  states.forEach((state, clientId) => {
    if (clientId === localId) return
    if (state.user) {
      result.set(clientId, state.user as AwarenessUser)
    }
  })

  users.value = result
}

onMounted(() => {
  updateUsers()
  props.awareness.on('change', updateUsers)
})

onUnmounted(() => {
  props.awareness.off('change', updateUsers)
})

const userList = computed(() => Array.from(users.value.values()))
</script>

<template>
  <div v-if="userList.length > 0" class="flex items-center gap-1.5">
    <div class="flex -space-x-1.5">
      <UTooltip
        v-for="(u, i) in userList.slice(0, 5)"
        :key="i"
        :text="u.name"
      >
        <div
          class="rounded-full ring-2 shrink-0"
          :style="{ '--tw-ring-color': u.color }"
        >
          <UAvatar
            v-if="u.avatar"
            :src="u.avatar"
            :alt="u.name"
            size="xs"
          />
          <div
            v-else
            class="size-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-white"
            :style="{ backgroundColor: u.color }"
          >
            {{ u.name.charAt(0).toUpperCase() }}
          </div>
        </div>
      </UTooltip>
    </div>
    <span v-if="userList.length > 5" class="text-xs text-muted">
      +{{ userList.length - 5 }}
    </span>
  </div>
</template>
