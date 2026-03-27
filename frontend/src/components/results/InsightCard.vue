<template>
  <div class="bg-[#F0F4F7] rounded-xl p-8 relative overflow-hidden">
    <div class="relative z-10">
      <div class="flex items-center space-x-3 mb-6">
        <span
          class="material-symbols-outlined text-[#3755C3]"
          style="font-variation-settings: 'FILL' 1;"
        >auto_awesome</span>
        <h3 class="font-headline font-bold text-lg text-[#2A3439]">ИИ-выводы и обратная связь</h3>
      </div>
      <div class="space-y-4">
        <!-- Цитата -->
        <div class="bg-[#FFFFFF] p-5 rounded-xl border-l-4 border-[#3755C3]">
          <p class="text-[#2A3439] leading-relaxed italic" v-html="feedback" />
        </div>
        <!-- Сильная сторона и зона роста -->
        <div class="pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div class="p-4 rounded-xl bg-[#FFFFFF]/50">
            <span class="text-xs font-bold text-[#3755C3] block mb-1">СИЛЬНАЯ СТОРОНА</span>
            <p class="text-sm font-medium text-[#2A3439]">{{ strength }}</p>
          </div>
          <div class="p-4 rounded-xl bg-[#FFFFFF]/50">
            <span class="text-xs font-bold text-[#625B77] block mb-1">ЗОНА РОСТА</span>
            <p class="text-sm font-medium text-[#2A3439]">{{ improve }}</p>
          </div>
        </div>
      </div>
    </div>
    <!-- Декоративный элемент -->
    <div class="absolute -bottom-12 -right-12 w-48 h-48 bg-[#3755C3]/5 rounded-full blur-3xl pointer-events-none"></div>
  </div>
</template>

<script setup>
defineProps({
  feedback: { type: String, required: true },
  strength: { type: String, required: true },
  improve:  { type: String, required: true },
})
</script>
