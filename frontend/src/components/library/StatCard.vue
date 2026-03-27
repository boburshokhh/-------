<template>
  <div class="bg-[#F0F4F7] p-6 rounded-xl flex items-center gap-4">
    <div class="w-12 h-12 rounded-full flex items-center justify-center" :class="bg">
      <span class="material-symbols-outlined" :class="iconColor">{{ icon }}</span>
    </div>
    <div>
      <div class="text-xs font-bold uppercase tracking-wider text-[#566166]">{{ label }}</div>
      <div class="text-2xl font-extrabold text-[#2A3439]">{{ value }}</div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  icon:      { type: String, required: true },
  label:     { type: String, required: true },
  value:     { type: String, required: true },
  bg:        { type: String, default: 'bg-[#DDE1FF]' },
  iconColor: { type: String, default: 'text-[#2747B6]' },
})
</script>
