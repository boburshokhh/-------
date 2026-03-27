<template>
  <AcademicLayout>
    <main class="max-w-5xl mx-auto px-6 py-12">
      <!-- Асимметричный герой -->
      <section class="grid grid-cols-1 md:grid-cols-12 gap-8 mb-16 items-end">
        <!-- Левая часть -->
        <div class="md:col-span-8">
          <nav class="mb-4 flex items-center text-[#566166] text-sm font-medium">
            <RouterLink to="/itog" class="hover:text-[#3755C3] transition-colors">Результаты</RouterLink>
            <span class="material-symbols-outlined text-sm mx-2">chevron_right</span>
            <span class="text-[#2A3439]">{{ data.quiz }}</span>
          </nav>
          <h1 class="text-4xl md:text-5xl font-extrabold tracking-tight text-[#2A3439] mb-4">
            Анализ успеваемости
          </h1>
          <p class="text-lg text-[#566166] max-w-2xl leading-relaxed">
            Просмотрите степень владения материалом. Используйте объяснения ИИ для углублённого понимания ключевых концепций из ваших источников.
          </p>
        </div>

        <!-- Правая часть — миниатюрный gauge -->
        <div class="md:col-span-4 bg-[#FFFFFF] p-8 rounded-xl flex flex-col items-center justify-center text-center tonal-sculpt-shadow">
          <ScoreGauge :percent="data.score" :size="96" class="mb-4" />
          <div class="text-sm font-semibold text-[#2A3439] mt-4">Оценка: {{ data.grade }}</div>
          <div class="text-xs text-[#566166] mt-1">{{ data.correct }} из {{ data.total }} верно</div>
        </div>
      </section>

      <!-- Список вопросов -->
      <div class="space-y-6">
        <QuestionBreakdownCard
          v-for="q in data.questions"
          :key="q.id"
          :item="q"
        />
      </div>

      <!-- CTA-блок -->
      <section class="mt-16 grid grid-cols-1 md:grid-cols-2 gap-6">
        <!-- Улучшить знания -->
        <div class="bg-[#DDE1FF]/20 p-8 rounded-xl flex flex-col justify-between">
          <div>
            <h4 class="text-xl font-bold text-[#2747B6] mb-2">Закрепить знания</h4>
            <p class="text-sm text-[#435368] mb-6 leading-relaxed">
              Готовы улучшить результат? Сгенерируйте целевое учебное пособие специально по вопросам, в которых вы ошиблись.
            </p>
          </div>
          <button
            class="bg-gradient-to-r from-[#3755C3] to-[#2848B7] text-[#F8F7FF] px-6 py-3 rounded-xl font-bold text-sm self-start transition-all active:scale-95 hover:opacity-90"
          >
            Создать учебное пособие
          </button>
        </div>

        <!-- Обсудить с ИИ -->
        <div class="bg-[#E1E9EE] p-8 rounded-xl flex flex-col justify-between">
          <div>
            <h4 class="text-xl font-bold text-[#2A3439] mb-2">Обсудить с ИИ-архитектором</h4>
            <p class="text-sm text-[#566166] mb-6 leading-relaxed">
              Остались вопросы по результатам? Начните беседу, чтобы детально разобрать любую концепцию прямо сейчас.
            </p>
          </div>
          <button
            class="bg-[#FFFFFF] text-[#3755C3] font-bold px-6 py-3 rounded-xl text-sm self-start transition-all hover:bg-white active:scale-95"
          >
            Начать беседу с ИИ
          </button>
        </div>
      </section>
    </main>
  </AcademicLayout>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AcademicLayout from '@/layouts/AcademicLayout.vue'
import ScoreGauge from '@/components/common/ScoreGauge.vue'
import QuestionBreakdownCard from '@/components/results/QuestionBreakdownCard.vue'
import { API } from '@/lib/api'
import { mapResultDetail } from '@/lib/mappers'
import { useAppStore } from '@/stores/appStore'

const route = useRoute()
const store = useAppStore()

const data = computed(() => store.state.resultDetail || {
  score: 0,
  grade: '—',
  correct: 0,
  total: 0,
  quiz: 'Разбор теста',
  questions: [],
})

onMounted(async () => {
  const resultId = route.query.resultId || store.state.resultSummary?.resultId
  if (!resultId) return
  try {
    const payload = await API.getResultDetail(resultId)
    store.actions.setResultDetail(mapResultDetail(payload))
  } catch (error) {
    store.actions.setResultError(error?.message || 'Не удалось загрузить разбор')
  }
})
</script>
