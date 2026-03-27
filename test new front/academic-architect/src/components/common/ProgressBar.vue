<template>
  <div class="w-full bg-[#E1E9EE] h-2 rounded-full overflow-hidden">
    <div
      class="h-full rounded-full transition-all duration-500"
      :class="colorClass"
      :style="{ width: `${percent}%` }"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({
  percent: { type: Number, default: 0 },
  color:   { type: String, default: 'primary' },
})
const colorClass = computed(() => props.color === 'error'
  ? 'bg-[#9F403D]'
  : 'bg-gradient-to-r from-[#3755C3] to-[#2848B7]')
</script>
