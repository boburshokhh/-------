<template>
  <div
    class="bg-[#FFFFFF] rounded-xl overflow-hidden transition-all duration-200 hover:shadow-md"
    :class="{ 'border-l-4 border-[#9F403D]/20': item.status === 'incorrect' }"
  >
    <div class="p-6 md:p-8">
      <!-- Шапка карточки -->
      <div class="flex items-start justify-between gap-4 mb-4">
        <div class="flex items-center gap-3">
          <span class="flex items-center justify-center w-8 h-8 rounded-full bg-[#F0F4F7] text-xs font-bold font-headline">
            {{ String(item.id).padStart(2, '0') }}
          </span>
          <h3 class="text-lg font-bold text-[#2A3439]">{{ item.text }}</h3>
        </div>
        <!-- Бейдж статуса -->
        <span
          class="flex items-center shrink-0 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider"
          :class="item.status === 'correct'
            ? 'bg-[#3755C3]/10 text-[#2848B7]'
            : 'bg-[#FE8983]/20 text-[#9F403D]'"
        >
          <span
            class="material-symbols-outlined text-sm mr-1"
            style="font-variation-settings: 'FILL' 1;"
          >{{ item.status === 'correct' ? 'check_circle' : 'cancel' }}</span>
          {{ item.status === 'correct' ? 'Верно' : 'Неверно' }}
        </span>
      </div>

      <!-- Ответы -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <!-- Ваш ответ -->
        <div
          class="p-4 rounded-xl"
          :class="item.status === 'incorrect' ? 'bg-[#FE8983]/10' : 'bg-[#F0F4F7]'"
        >
          <span
            class="block text-[10px] font-bold uppercase mb-1"
            :class="item.status === 'incorrect' ? 'text-[#9F403D]' : 'text-[#566166]'"
          >Ваш ответ</span>
          <p class="text-sm font-medium text-[#2A3439]">{{ item.yourAnswer }}</p>
        </div>
        <!-- Правильный ответ -->
        <div class="bg-[#DDE1FF]/30 p-4 rounded-xl">
          <span class="block text-[10px] font-bold text-[#2747B6] uppercase mb-1">Правильный ответ</span>
          <p class="text-sm font-medium text-[#2747B6]">{{ item.correctAnswer }}</p>
        </div>
      </div>

      <!-- ИИ-рассуждение -->
      <div class="space-y-2 mt-4">
        <AIReasoningBlock>{{ item.reasoning }}</AIReasoningBlock>
      </div>
    </div>
  </div>
</template>

<script setup>
import AIReasoningBlock from '@/components/common/AIReasoningBlock.vue'
defineProps({
  item: { type: Object, required: true },
})
</script>
