<template>
  <button
    :class="[
      'bg-gradient-to-r from-[#3755C3] to-[#2848B7] text-[#F8F7FF]',
      'font-bold rounded-xl transition-all active:scale-95 hover:opacity-90',
      sizeClasses,
    ]"
    v-bind="$attrs"
  >
    <slot />
  </button>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({
  size: { type: String, default: 'md' },
})
const sizeClasses = computed(() => ({
  sm:  'px-4 py-2 text-xs',
  md:  'px-6 py-3 text-sm',
  lg:  'px-8 py-4 text-sm',
}[props.size]))
</script>
