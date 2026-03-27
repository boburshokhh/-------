<template>
  <span
    :class="['flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider', colorClass]"
  >
    <span
      v-if="icon"
      class="material-symbols-outlined text-sm mr-1"
      :style="iconFill ? \"font-variation-settings: 'FILL' 1\" : ''"
    >{{ icon }}</span>
    <slot />
  </span>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  variant: { type: String, default: 'correct' },
  icon:    { type: String, default: '' },
  iconFill: { type: Boolean, default: false },
})

const colorClass = computed(() => ({
  correct:    'bg-[#3755C3]/10 text-[#2848B7]',
  incorrect:  'bg-[#FE8983]/20 text-[#9F403D]',
  completed:  'bg-[#D3E4FE] text-[#435368]',
  progress:   'bg-[#DDE1FF] text-[#2747B6]',
  ready:      'bg-[#E1E9EE] text-[#566166]',
}[props.variant] || 'bg-[#E1E9EE] text-[#566166]'))
</script>
