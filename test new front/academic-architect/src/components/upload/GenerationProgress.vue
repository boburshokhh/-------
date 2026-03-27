<template>
  <div class="max-w-3xl mx-auto w-full">
    <!-- Трек с шагами -->
    <div class="relative mb-12">
      <!-- Фоновая линия -->
      <div class="absolute top-5 left-0 w-full h-1 bg-[#E1E9EE] rounded-full"></div>
      <!-- Активная часть -->
      <div
        class="absolute top-5 left-0 h-1 bg-[#3755C3] rounded-full transition-all duration-1000"
        :style="{ width: progressLineWidth }"
        style="box-shadow: 0 0 8px rgba(55,85,195,0.4);"
      ></div>

      <div class="relative flex justify-between items-start">
        <div
          v-for="(step, i) in steps"
          :key="step.label"
          class="flex flex-col items-center group"
        >
          <div
            class="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm ring-4 ring-[#F7F9FB] z-10 transition-transform group-hover:scale-110"
            :class="stepClass(i)"
          >
            <span v-if="step.done" class="material-symbols-outlined text-sm">check</span>
            <span v-else>{{ i + 1 }}</span>
          </div>
          <div class="mt-3 text-center">
            <p class="font-headline font-bold text-[#2A3439] text-sm">{{ step.label }}</p>
            <p
              class="text-[10px] uppercase tracking-wider font-bold"
              :class="[stepStatusClass(i), { 'animate-pulse': step.active }]"
            >{{ step.status }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Блок живого лога -->
    <div class="bg-[#FFFFFF] border border-[#A9B4B9]/20 rounded-xl p-6 tonal-sculpt-shadow">
      <div class="flex items-center justify-between mb-4 border-b border-[#A9B4B9]/10 pb-3">
        <div class="flex items-center space-x-2">
          <span class="relative flex h-2 w-2">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#3755C3] opacity-75"></span>
            <span class="relative inline-flex rounded-full h-2 w-2 bg-[#3755C3]"></span>
          </span>
          <h4 class="text-xs font-bold uppercase tracking-widest text-[#2A3439]">
            Статус движка: живой анализ
          </h4>
        </div>
        <span class="text-[10px] font-mono text-[#566166] bg-[#E1E9EE] px-2 py-0.5 rounded">{{ modelLabel }}</span>
      </div>

      <div class="space-y-3 font-mono text-xs">
        <div v-for="log in logItems" :key="log.text" class="flex items-center text-[#4D5D73]">
          <span
            class="material-symbols-outlined text-sm mr-2"
            :class="[log.colorClass, log.spin ? 'animate-spin' : '']"
          >{{ log.icon }}</span>
          <span :class="{ 'font-bold text-[#2A3439]': log.active }">
            {{ log.text }}
            <span v-if="log.value" :class="log.valueClass">{{ log.value }}</span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  percent: { type: Number, default: 0 },
  phase: { type: String, default: '' },
  detail: { type: String, default: '' },
  modelLabel: { type: String, default: 'LLM' },
});

const steps = computed(() => ([
  { label: 'Загрузка', status: props.percent >= 5 ? 'Завершено' : 'В процессе', done: props.percent >= 5, active: props.percent < 5 },
  { label: 'Анализ ИИ', status: props.percent >= 99 ? 'Завершено' : (props.percent >= 5 ? 'Обработка' : 'Ожидание'), done: props.percent >= 99, active: props.percent >= 5 && props.percent < 99 },
  { label: 'Тест готов', status: props.percent >= 100 ? 'Готово' : 'Ожидание', done: props.percent >= 100, active: props.percent >= 99 && props.percent < 100 },
]));

const progressLineWidth = computed(() => `${Math.max(0, Math.min(100, props.percent))}%`);

function stepClass(i) {
  if (steps.value[i].done || steps.value[i].active) return 'bg-[#3755C3] text-[#F8F7FF] shadow-lg'
  return 'bg-[#E1E9EE] text-[#566166]'
}

function stepStatusClass(i) {
  if (steps.value[i].done || steps.value[i].active) return 'text-[#3755C3]'
  return 'text-[#566166]/50'
}

const logItems = computed(() => ([
  {
    icon: props.percent >= 10 ? 'check_circle' : 'sync',
    text: 'Подготовка и извлечение текста... ',
    value: props.percent >= 10 ? 'Готово' : `${Math.min(props.percent, 10)}%`,
    colorClass: props.percent >= 10 ? 'text-green-500' : 'text-[#3755C3]',
    valueClass: props.percent >= 10 ? 'text-green-500' : 'text-[#3755C3]',
    spin: props.percent < 10,
  },
  {
    icon: props.percent >= 60 ? 'check_circle' : 'sync',
    text: 'Индексация и RAG-анализ... ',
    value: props.percent >= 60 ? 'Готово' : `${Math.min(Math.max(props.percent, 10), 60)}%`,
    colorClass: props.percent >= 60 ? 'text-green-500' : 'text-[#3755C3]',
    valueClass: props.percent >= 60 ? 'text-green-500' : 'text-[#3755C3]',
    spin: props.percent >= 10 && props.percent < 60,
  },
  {
    icon: props.percent >= 99 ? 'check_circle' : 'sync',
    text: 'Генерация теста... ',
    value: props.percent >= 99 ? 'Готово' : `${Math.min(Math.max(props.percent, 60), 99)}%`,
    colorClass: props.percent >= 99 ? 'text-green-500' : 'text-[#3755C3]',
    valueClass: props.percent >= 99 ? 'text-green-500' : 'text-[#3755C3]',
    spin: props.percent >= 60 && props.percent < 99,
    active: props.percent >= 60 && props.percent < 99,
  },
  {
    icon: props.percent >= 100 ? 'check_circle' : 'circle',
    text: props.detail || `Фаза: ${props.phase || 'ожидание'}`,
    value: props.percent >= 100 ? 'Завершено' : '',
    colorClass: props.percent >= 100 ? 'text-green-500' : 'text-[#566166]',
    valueClass: props.percent >= 100 ? 'text-green-500' : 'text-[#566166]',
  },
]))
</script>
