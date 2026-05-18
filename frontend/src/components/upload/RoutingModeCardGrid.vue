<template>
  <div>
    <p class="mb-3 text-[11px] text-[#566166]">
      {{ metricsLegend }}
    </p>

    <div
      class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5"
      role="radiogroup"
      aria-labelledby="ai-mode-heading"
      :aria-disabled="disabled || useServerPolicy"
    >
      <button
        v-for="mode in modes"
        :key="mode"
        type="button"
        role="radio"
        :aria-checked="isCardSelected(mode)"
        :disabled="disabled || useServerPolicy"
        class="group flex flex-col rounded-xl border bg-[#FFFFFF] p-4 text-left transition-all focus:outline-none focus:ring-2 focus:ring-[#3755C3] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        :class="
          isCardSelected(mode)
            ? 'border-[#3755C3] shadow-md ring-1 ring-[#3755C3]/30'
            : 'border-[#A9B4B9]/25 hover:border-[#3755C3]/40'
        "
        @click="$emit('select', mode)"
      >
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="font-headline text-sm font-bold text-[#2A3439]">
              {{ copy[mode].title }}
            </p>
            <p class="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-[#435368]">
              {{ copy[mode].tag }}
            </p>
          </div>
          <span
            v-if="isCardSelected(mode)"
            class="rounded-full bg-[#3755C3]/10 px-2 py-0.5 text-[10px] font-bold text-[#3755C3]"
          >
            Выбрано
          </span>
        </div>

        <p class="mt-2 text-xs leading-snug text-[#566166]">
          {{ copy[mode].subtitle }}
        </p>

        <div class="mt-3 flex flex-wrap gap-1.5" aria-hidden="true">
          <span class="text-[10px] text-[#566166]">Качество</span>
          <span class="text-[#3755C3]">{{ stars(copy[mode].metrics.quality) }}</span>
          <span class="mx-1 text-[#A9B4B9]">·</span>
          <span class="text-[10px] text-[#566166]">Стоимость</span>
          <span class="text-[#3755C3]">{{ stars(copy[mode].metrics.cost) }}</span>
          <span class="mx-1 text-[#A9B4B9]">·</span>
          <span class="text-[10px] text-[#566166]">Скорость</span>
          <span class="text-[#3755C3]">{{ stars(copy[mode].metrics.speed) }}</span>
        </div>

        <div class="mt-3 rounded-lg bg-[#F8FAFB] px-2 py-1.5 text-[11px] leading-snug text-[#435368]">
          <span class="font-semibold text-[#684F9E]">Premium:</span>
          {{ copy[mode].premiumShort }}
        </div>

        <div class="mt-2 flex flex-wrap gap-1">
          <span
            v-for="chip in copy[mode].stageChips"
            :key="chip"
            class="rounded-md border border-[#A9B4B9]/20 bg-white px-2 py-0.5 text-[10px] text-[#566166]"
          >
            {{ chip }}
          </span>
        </div>

        <span class="mt-3 text-[10px] font-medium text-[#3755C3] opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100">
          Как это работает — см. прогноз ниже
        </span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { MODE_CARD_COPY, METRICS_LEGEND } from '@/lib/routingLabels';

const props = defineProps({
  /** Пустая строка, если выбран Auto — ни одна карточка не подсвечивается */
  selectedMode: { type: String, default: '' },
  useServerPolicy: { type: Boolean, default: true },
  disabled: { type: Boolean, default: false },
});

defineEmits(['select']);

function isCardSelected(mode) {
  return !props.useServerPolicy && props.selectedMode === mode;
}

const modes = ['economy', 'balanced', 'quality', 'max_quality', 'manual'];
const copy = MODE_CARD_COPY;
const metricsLegend = METRICS_LEGEND;

function stars(n) {
  const k = Math.min(3, Math.max(1, Number(n) || 1));
  return '★'.repeat(k) + '☆'.repeat(3 - k);
}
</script>
