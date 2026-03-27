<template>
  <div class="mt-16 p-6 rounded-xl bg-[#F0F4F7] border-l-4 border-[#3755C3]/30">
    <div class="flex items-center gap-3 mb-4">
      <span class="material-symbols-outlined text-[#3755C3]">psychology</span>
      <h3 class="font-headline font-bold text-[#2A3439]">Подсказка ИИ</h3>
    </div>
    <div class="space-y-3">
      <div class="p-3 bg-[#FFFFFF] rounded-xl border-l-4 border-[#DDE1FF] shadow-sm">
        <p class="text-sm text-[#566166]" v-html="text" />
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  text: { type: String, required: true },
})
</script>
