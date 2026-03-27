<template>
  <AcademicLayout>
    <div class="max-w-4xl mx-auto px-6 py-12 min-h-[calc(100vh-160px)]">
      <!-- Заголовок теста -->
      <div class="mb-12 text-center">
        <h1 class="font-headline text-3xl font-extrabold text-[#2A3439] mb-2 tracking-tight">
          {{ quizTitle }}
        </h1>
        <p class="text-[#566166] text-sm">{{ quizTopic }}</p>
      </div>
      <div v-if="showDiagnostics" class="mb-8 bg-[#FFFFFF] border border-[#A9B4B9]/20 rounded-xl p-4">
        <h3 class="font-headline font-bold text-[#2A3439] mb-2">Диагностика генерации</h3>
        <p class="text-xs text-[#566166] mb-2">
          Качество извлечения:
          <span class="font-semibold text-[#2A3439]">{{ extractionQualityLabel }}</span>
          <span v-if="store.state.activeTest?.lowTextQuality" class="text-[#9F403D]"> (низкое качество текста)</span>
        </p>
        <p v-if="store.state.activeTest?.parseDiagnostics?.parseMethod" class="text-xs text-[#566166] mb-2">
          Метод парсинга: <span class="font-semibold text-[#2A3439]">{{ store.state.activeTest.parseDiagnostics.parseMethod }}</span>
        </p>
        <div v-if="store.state.activeTest?.generationMetrics" class="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-[#566166]">
          <p>Quality score: <span class="font-semibold text-[#2A3439]">{{ metric('final_quality_score') }}</span></p>
          <p>Grounded rate: <span class="font-semibold text-[#2A3439]">{{ metric('grounded_question_rate') }}</span></p>
          <p>Retrieval hit: <span class="font-semibold text-[#2A3439]">{{ metric('retrieval_hit_rate') }}</span></p>
          <p>Dedup loss: <span class="font-semibold text-[#2A3439]">{{ metric('dedup_loss_ratio') }}</span></p>
        </div>
      </div>

      <!-- Прогресс -->
      <div class="mb-10">
        <div class="flex justify-between items-end mb-3">
          <span class="text-[#2A3439] font-headline font-bold text-lg">
            Вопрос {{ String(currentIndex + 1).padStart(2, '0') }}
            <span class="text-[#566166] font-normal">из {{ totalQuestions }}</span>
          </span>
          <span class="text-[#3755C3] font-bold text-sm tracking-wider">{{ completionPercent }}% ЗАВЕРШЕНО</span>
        </div>
        <ProgressBar :percent="completionPercent" />
      </div>

      <!-- Вопрос -->
      <div class="mb-8">
        <QuestionCard :question="currentQuestion?.text || 'Загрузка вопроса...'" />
      </div>

      <!-- Варианты ответов -->
      <div class="grid grid-cols-1 gap-4 mb-12">
        <AnswerOption
          v-for="opt in currentQuestion?.options || []"
          :key="opt.id"
          :option-id="opt.id"
          :text="opt.text"
          :selected="selectedId === opt.id"
          @select="selectAnswer"
        />
      </div>

      <!-- Навигация -->
      <div class="flex flex-col md:flex-row justify-between items-center gap-4 pt-8 border-t border-[#A9B4B9]/15">
        <button
          class="w-full md:w-auto px-8 py-3 rounded-xl bg-[#E1E9EE] text-[#435368] font-headline font-bold flex items-center justify-center hover:bg-[#D9E4EA] transition-all"
          :disabled="currentIndex <= 0 || loading"
          @click="goPrev"
        >
          <span class="material-symbols-outlined mr-2">arrow_back</span>
          Назад
        </button>
        <div class="flex gap-4 w-full md:w-auto">
          <button
            class="flex-1 md:flex-initial px-8 py-3 rounded-xl text-[#3755C3] font-headline font-bold hover:bg-[#3755C3]/5 transition-all"
            :disabled="loading"
            @click="goNext"
          >
            Пропустить
          </button>
          <button
            class="flex-1 md:flex-initial px-12 py-3 rounded-xl bg-gradient-to-r from-[#3755C3] to-[#2848B7] text-[#F8F7FF] font-headline font-bold shadow-lg flex items-center justify-center hover:opacity-90 active:scale-95 transition-all"
            :disabled="loading"
            @click="goNext"
          >
            {{ isLastQuestion ? 'Завершить' : 'Следующий' }}
            <span class="material-symbols-outlined ml-2">arrow_forward</span>
          </button>
        </div>
      </div>

      <!-- Подсказка ИИ -->
      <AIStudyPrompt :text="currentQuestion?.explanation || defaultHint" />
      <p v-if="store.state.resultError || store.state.activeTestError" class="mt-4 text-sm text-[#9F403D]">
        {{ store.state.resultError || store.state.activeTestError }}
      </p>
    </div>
  </AcademicLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AcademicLayout from '@/layouts/AcademicLayout.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import QuestionCard from '@/components/quiz/QuestionCard.vue'
import AnswerOption from '@/components/quiz/AnswerOption.vue'
import AIStudyPrompt from '@/components/quiz/AIStudyPrompt.vue'
import { API } from '@/lib/api'
import { mapTestDetail, mapSubmitAnswersPayload, mapResultSummary } from '@/lib/mappers'
import { useAppStore } from '@/stores/appStore'

const route = useRoute()
const router = useRouter()
const store = useAppStore()

const currentIndex = ref(0)
const loading = ref(false)
const defaultHint = 'Выберите вариант ответа, который лучше всего соответствует содержанию документа.'

const quizTitle = computed(() => store.state.activeTest?.title || 'Тест по документу')
const quizTopic = computed(() => store.state.activeTest?.topic || 'Сгенерированный тест')
const showDiagnostics = computed(() => Boolean(
  store.state.activeTest?.generationMetrics
  || store.state.activeTest?.parseDiagnostics
  || (store.state.activeTest?.extractionQuality !== null && typeof store.state.activeTest?.extractionQuality !== 'undefined')
))
const extractionQualityLabel = computed(() => {
  const value = store.state.activeTest?.extractionQuality
  if (value === null || typeof value === 'undefined') return '—'
  const num = Number(value)
  if (Number.isNaN(num)) return String(value)
  return `${Math.round(num * 100)}%`
})
const totalQuestions = computed(() => store.state.activeTest?.questions?.length || 0)
const currentQuestion = computed(() => store.state.activeTest?.questions?.[currentIndex.value] || null)
const completionPercent = computed(() => store.getters.progressPercent.value)
const isLastQuestion = computed(() => currentIndex.value >= Math.max(0, totalQuestions.value - 1))
const selectedId = computed(() => {
  const q = currentQuestion.value
  if (!q) return null
  const value = store.state.answers[q.id]
  const option = q.options.find((opt) => opt.value === value)
  return option?.id ?? null
})

function metric(key) {
  const value = store.state.activeTest?.generationMetrics?.[key]
  if (typeof value === 'number') return value.toFixed(3)
  return value ?? '—'
}

onMounted(loadTest)

async function loadTest() {
  const queryId = route.query.testId ? Number(route.query.testId) : null
  const testId = queryId || store.state.upload.testId
  if (!testId) {
    router.replace('/biblioteka')
    return
  }

  loading.value = true
  store.actions.setActiveTestLoading(true)
  try {
    const payload = await API.getTest(testId)
    const mapped = mapTestDetail(payload)
    store.actions.setActiveTest(mapped)
  } catch (error) {
    store.actions.setActiveTestError(error?.message || 'Не удалось загрузить тест')
    router.replace('/biblioteka')
  } finally {
    loading.value = false
    store.actions.setActiveTestLoading(false)
  }
}

function selectAnswer(optionId) {
  const q = currentQuestion.value
  if (!q) return
  const selectedOption = q.options.find((opt) => opt.id === optionId)
  if (!selectedOption) return
  store.actions.setAnswer(q.id, selectedOption.value)
}

function goPrev() {
  if (currentIndex.value > 0) currentIndex.value -= 1
}

async function goNext() {
  if (!isLastQuestion.value) {
    currentIndex.value += 1
    return
  }
  await submitResult()
}

async function submitResult() {
  if (!store.state.activeTest) return
  loading.value = true
  try {
    const payload = mapSubmitAnswersPayload(store.state.activeTest, store.state.answers)
    const response = await API.submitResults(
      payload.testId,
      store.state.userName || 'Пользователь',
      payload.answers,
    )
    const summary = mapResultSummary(response, store.state.activeTest, store.state.userName || 'Пользователь')
    store.actions.setResultSummary(summary)
    router.push({
      path: '/itog',
      query: {
        resultId: String(response.resultId),
        testId: String(payload.testId),
      },
    })
  } catch (error) {
    store.actions.setResultError(error?.message || 'Не удалось сохранить результат')
  } finally {
    loading.value = false
  }
}
</script>
