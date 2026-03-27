<template>
  <div class="flex flex-col md:flex-row items-center justify-between px-4 max-w-2xl mx-auto w-full gap-8">
    <template v-for="(step, index) in steps" :key="step.label">
      <div class="flex flex-col items-center text-center space-y-3 flex-1">
        <div
          class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-md ring-4 ring-[#F7F9FB]"
          :class="stepCircleClass(index)"
        >
          {{ index + 1 }}
        </div>
        <div>
          <p class="font-headline font-bold text-[#2A3439] text-sm">{{ step.label }}</p>
          <p class="text-xs text-[#566166]">{{ step.sub }}</p>
        </div>
      </div>
      <!-- Разделитель -->
      <div
        v-if="index < steps.length - 1"
        class="hidden md:block h-px bg-[#A9B4B9]/20 flex-grow mx-4"
      />
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
const props = defineProps({
  activeStep: { type: Number, default: 0 },
  steps: {
    type: Array,
    default: () => [
      { label: 'Загрузка',   sub: 'Ваши документы' },
      { label: 'Анализ ИИ',  sub: 'Извлечение знаний' },
      { label: 'Тест готов', sub: 'Интерактивный тест' },
    ],
  },
})

function stepCircleClass(index) {
  if (index < props.activeStep) return 'bg-[#3755C3] text-[#F8F7FF]'
  if (index === props.activeStep) return 'bg-[#3755C3] text-[#F8F7FF]'
  return 'bg-[#E1E9EE] text-[#566166]'
}
</script>
