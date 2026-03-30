<template>
  <article
    class="group relative flex flex-col overflow-hidden rounded-2xl border border-[#A9B4B9]/20 bg-[#FFFFFF] p-5 shadow-sm transition-all duration-200 hover:border-[#3755C3]/25 hover:shadow-md"
    :class="{ 'ring-2 ring-[#3755C3] ring-offset-2 ring-offset-[#F7F9FB]': highlighted }"
  >
    <div class="mb-4 flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <h3 class="font-headline text-base font-bold leading-snug text-[#2A3439] md:text-lg">
          {{ item.testTitle }}
        </h3>
        <p v-if="item.completedAt && hasResult" class="mt-1 text-xs text-[#566166]">
          {{ completedLabel }}
        </p>
      </div>
      <span
        v-if="hasResult"
        class="shrink-0 rounded-full px-2.5 py-1 text-xs font-bold"
        :class="badgeClass"
      >
        {{ gradeLabel }}
      </span>
      <span
        v-else
        class="shrink-0 rounded-full bg-[#F0F4F7] px-2.5 py-1 text-xs font-semibold text-[#566166]"
      >
        Не начато
      </span>
    </div>

    <div v-if="hasResult" class="mb-4">
      <div class="mb-1.5 flex items-end justify-between gap-2">
        <span class="font-headline text-2xl font-extrabold tabular-nums" :class="percentTextClass">
          {{ Math.round(item.percentage) }}%
        </span>
        <span class="text-xs font-medium text-[#566166]">
          {{ item.score }} / {{ item.maxScore }} верных
        </span>
      </div>
      <div class="h-2 overflow-hidden rounded-full bg-[#E8EEF3]">
        <div
          class="h-full rounded-full transition-all duration-500 ease-out"
          :class="barClass"
          :style="{ width: `${Math.min(100, Math.max(0, item.percentage))}%` }"
        />
      </div>
    </div>

    <div v-else class="mb-4 flex flex-1 items-center rounded-xl bg-[#F7F9FB] py-6 text-center">
      <p class="w-full text-sm text-[#566166]">
        Пройдите тест, чтобы увидеть результат здесь
      </p>
    </div>

    <div class="mt-auto flex flex-wrap gap-2 pt-1">
      <RouterLink
        v-if="hasResult && item.latestResultId"
        :to="{ path: '/razbor', query: { resultId: String(item.latestResultId) } }"
        class="inline-flex flex-1 items-center justify-center gap-1 rounded-xl bg-gradient-to-r from-[#3755C3] to-[#2848B7] px-4 py-2.5 text-xs font-bold text-[#F8F7FF] shadow-sm transition-opacity hover:opacity-90 sm:flex-none"
      >
        <span>Разбор</span>
        <span class="material-symbols-outlined text-[16px]">analytics</span>
      </RouterLink>
      <RouterLink
        :to="{ path: '/test', query: { testId: String(item.testId) } }"
        class="inline-flex flex-1 items-center justify-center rounded-xl border border-[#A9B4B9]/35 bg-white px-4 py-2.5 text-xs font-bold text-[#435368] transition-colors hover:border-[#3755C3]/40 hover:text-[#3755C3] sm:flex-none"
      >
        {{ hasResult ? 'Пройти снова' : 'Начать тест' }}
      </RouterLink>
    </div>
  </article>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  item: {
    type: Object,
    required: true,
  },
  highlighted: { type: Boolean, default: false },
});

const hasResult = computed(
  () =>
    props.item.latestResultId != null &&
    props.item.percentage != null &&
    props.item.maxScore != null,
);

const completedLabel = computed(() => {
  if (!props.item.completedAt) return '';
  const dt = new Date(props.item.completedAt);
  return Number.isNaN(dt.getTime())
    ? String(props.item.completedAt)
    : dt.toLocaleString('ru-RU', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
});

const pct = computed(() => (hasResult.value ? Number(props.item.percentage) : 0));

const gradeLabel = computed(() => {
  const p = pct.value;
  if (p >= 85) return 'Отлично';
  if (p >= 70) return 'Хорошо';
  if (p >= 50) return 'Средне';
  return 'Повторить';
});

const badgeClass = computed(() => {
  const p = pct.value;
  if (p >= 85) return 'bg-emerald-50 text-emerald-800';
  if (p >= 70) return 'bg-[#DDE1FF] text-[#2747B6]';
  if (p >= 50) return 'bg-amber-50 text-amber-900';
  return 'bg-rose-50 text-rose-800';
});

const barClass = computed(() => {
  const p = pct.value;
  if (p >= 85) return 'bg-gradient-to-r from-emerald-500 to-teal-500';
  if (p >= 70) return 'bg-gradient-to-r from-[#3755C3] to-[#2848B7]';
  if (p >= 50) return 'bg-gradient-to-r from-amber-400 to-amber-600';
  return 'bg-gradient-to-r from-rose-400 to-rose-600';
});

const percentTextClass = computed(() => {
  const p = pct.value;
  if (p >= 85) return 'text-emerald-700';
  if (p >= 70) return 'text-[#3755C3]';
  if (p >= 50) return 'text-amber-800';
  return 'text-rose-700';
});
</script>
