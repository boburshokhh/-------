<template>
  <AcademicLayout>
    <main class="max-w-5xl mx-auto px-6 py-12">
      <!-- Hero-блок с результатом -->
      <section class="flex flex-col items-center mb-16 text-center">
        <div class="relative w-64 h-64 flex items-center justify-center mb-8">
          <ScoreGauge :percent="data.score" :size="256" :label="data.label" />
        </div>
        <h1 class="text-4xl font-extrabold font-headline text-[#2A3439] mb-2">
          Отличная работа, {{ data.name }}!
        </h1>
        <p class="text-lg text-[#566166] max-w-xl">
          Вы успешно прошли
          <span class="text-[#3755C3] font-semibold">{{ data.quizName }}</span>.
          Ваше понимание рыночных структур впечатляет.
        </p>
        <p v-if="data.completedAt" class="text-xs text-[#566166] mt-2">
          Завершено: {{ completedAtLabel }}
        </p>
      </section>

      <!-- Статистика и обратная связь -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <!-- Статкарточка -->
        <div class="md:col-span-1 bg-[#FFFFFF] rounded-xl p-8 tonal-sculpt-shadow">
          <h3 class="font-headline font-bold text-lg mb-6 text-[#2A3439]">Статистика теста</h3>
          <div class="space-y-6">
            <div
              v-for="stat in data.stats"
              :key="stat.label"
              class="flex items-center space-x-4"
            >
              <div class="w-10 h-10 rounded-full flex items-center justify-center" :class="stat.bg">
                <span class="material-symbols-outlined text-xl" :class="stat.iconColor">{{ stat.icon }}</span>
              </div>
              <div>
                <p class="text-xs text-[#566166] font-medium">{{ stat.label }}</p>
                <p class="text-lg font-bold text-[#2A3439]">{{ stat.value }}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- ИИ-отзыв -->
        <div class="md:col-span-2">
          <InsightCard
            :feedback="data.aiFeedback"
            :strength="data.strength"
            :improve="data.improve"
          />
        </div>
      </div>

      <!-- Прогресс по темам -->
      <KnowledgeBreakdown :items="data.breakdown" />

      <!-- Кнопки действий -->
      <div class="flex flex-col sm:flex-row items-center justify-center space-y-4 sm:space-y-0 sm:space-x-4 pt-4">
        <RouterLink
          :to="razborLink"
          class="w-full sm:w-auto px-8 py-4 rounded-xl bg-gradient-to-r from-[#3755C3] to-[#2848B7] text-[#F8F7FF] font-bold shadow-lg hover:opacity-90 transition-all flex items-center justify-center space-x-2"
        >
          <span>Подробный разбор</span>
          <span class="material-symbols-outlined text-sm">arrow_forward</span>
        </RouterLink>
        <RouterLink
          to="/biblioteka"
          class="w-full sm:w-auto px-8 py-4 rounded-xl bg-[#E1E9EE] text-[#435368] font-bold hover:bg-[#D9E4EA] transition-all flex items-center justify-center"
        >
          В библиотеку
        </RouterLink>
      </div>
    </main>
  </AcademicLayout>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AcademicLayout from '@/layouts/AcademicLayout.vue'
import ScoreGauge from '@/components/common/ScoreGauge.vue'
import InsightCard from '@/components/results/InsightCard.vue'
import KnowledgeBreakdown from '@/components/results/KnowledgeBreakdown.vue'
import { API } from '@/lib/api'
import { mapResultSummary } from '@/lib/mappers'
import { useAppStore } from '@/stores/appStore'

const route = useRoute()
const store = useAppStore()

const data = computed(() => store.state.resultSummary || {
  score: 0,
  label: 'Достигнутый балл',
  name: 'Пользователь',
  quizName: 'Тест',
  stats: [],
  aiFeedback: 'Результат пока недоступен.',
  strength: '—',
  improve: '—',
  breakdown: [],
})

const razborLink = computed(() => {
  const resultId = route.query.resultId || store.state.resultSummary?.resultId
  return resultId ? { path: '/razbor', query: { resultId: String(resultId) } } : '/razbor'
})
const completedAtLabel = computed(() => {
  if (!data.value.completedAt) return '—'
  const dt = new Date(data.value.completedAt)
  return Number.isNaN(dt.getTime()) ? String(data.value.completedAt) : dt.toLocaleString('ru-RU')
})

onMounted(async () => {
  if (store.state.resultSummary) return
  const testId = route.query.testId ? Number(route.query.testId) : store.state.upload.testId
  if (!testId) return
  try {
    const payload = await API.getResults(testId)
    const latest = payload?.results?.[0]
    if (!latest) return
    const summary = mapResultSummary(
      {
        resultId: latest.id,
        score: latest.score,
        maxScore: latest.max_score,
        percentage: latest.percentage,
        completedAt: latest.completed_at,
        answers: [],
      },
      store.state.activeTest,
      latest.user_name || store.state.userName || 'Пользователь',
    )
    store.actions.setResultSummary(summary)
  } catch (error) {
    store.actions.setResultError(error?.message || 'Не удалось загрузить итог')
  }
})
</script>
