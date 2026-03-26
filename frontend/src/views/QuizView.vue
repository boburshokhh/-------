<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { API } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertCircle, CheckCircle2, XCircle, ArrowLeft, ArrowRight, Check } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()

const testData = ref<any>(null)
const currentIndex = ref(0)
const answers = ref<Record<string, any>>({})
const loading = ref(true)
const submitting = ref(false)
const errorMsg = ref('')

onMounted(async () => {
  const id = route.params.id as string
  try {
    testData.value = await API.getTest(id)
  } catch (error: any) {
    errorMsg.value = error.message || 'Ошибка загрузки теста'
  } finally {
    loading.value = false
  }
})

const currentQuestion = computed(() => {
  if (!testData.value || !testData.value.questions) return null
  return testData.value.questions[currentIndex.value]
})

const totalQuestions = computed(() => {
  return testData.value?.questions?.length || 0
})

const progress = computed(() => {
  if (totalQuestions.value === 0) return 0
  return ((currentIndex.value + 1) / totalQuestions.value) * 100
})

const answeredCount = computed(() => {
  return Object.values(answers.value).filter(v => v !== null && v !== undefined && v !== '').length
})

const isLast = computed(() => {
  return currentIndex.value === totalQuestions.value - 1
})

const selectOption = (qId: number, val: any) => {
  answers.value[qId] = val
}

const next = () => {
  if (!isLast.value) {
    currentIndex.value++
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

const prev = () => {
  if (currentIndex.value > 0) {
    currentIndex.value--
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

const submit = async () => {
  if (answeredCount.value < totalQuestions.value) {
    if (!confirm(`Вы ответили на ${answeredCount.value} из ${totalQuestions.value} вопросов. Завершить тест?`)) {
      return
    }
  }

  submitting.value = true
  try {
    const answersArray = testData.value.questions.map((q: any) => ({
      questionId: q.id,
      answer: answers.value[q.id] !== undefined ? answers.value[q.id] : null
    }))

    const result = await API.submitResults(testData.value.id, 'Аноним', answersArray)
    router.push(`/results/detail/${result.resultId}`)
  } catch (error: any) {
    errorMsg.value = error.message || 'Ошибка сохранения'
    submitting.value = false
  }
}

const getQuestionTypeLabel = (type: string) => {
  const map: Record<string, string> = {
    'multiple_choice': 'Выбор ответа',
    'true_false': 'Верно / Неверно',
    'open_ended': 'Открытый вопрос'
  }
  return map[type] || type
}
</script>

<template>
  <div class="max-w-3xl mx-auto py-8">
    <Alert variant="destructive" class="mb-6" v-if="errorMsg">
      <AlertCircle class="h-4 w-4" />
      <AlertDescription>{{ errorMsg }}</AlertDescription>
    </Alert>

    <div v-if="loading" class="space-y-4">
      <div class="h-8 bg-neutral-200 rounded animate-pulse w-3/4"></div>
      <div class="h-4 bg-neutral-200 rounded animate-pulse w-full"></div>
      <div class="h-64 bg-neutral-200 rounded-xl animate-pulse w-full mt-8"></div>
    </div>

    <div v-else-if="testData && currentQuestion">
      <!-- Header -->
      <div class="mb-8">
        <h1 class="text-2xl font-bold tracking-tight mb-6">{{ testData.title }}</h1>
        <div class="flex justify-between text-sm text-neutral-500 font-medium mb-2">
          <span>Вопрос {{ currentIndex + 1 }} из {{ totalQuestions }}</span>
          <span>Отвечено {{ answeredCount }} из {{ totalQuestions }}</span>
        </div>
        <Progress :model-value="progress" class="h-2" />
      </div>

      <!-- Question Card -->
      <Card class="mb-8 shadow-sm">
        <CardContent class="p-6 md:p-8">
          <Badge variant="outline" class="mb-4">{{ getQuestionTypeLabel(currentQuestion.type) }}</Badge>
          <h2 class="text-xl font-medium mb-8 leading-relaxed">{{ currentQuestion.question }}</h2>

          <!-- Answers -->
          <div v-if="currentQuestion.type === 'multiple_choice'" class="space-y-3">
            <button 
              v-for="(opt, i) in currentQuestion.options" :key="i"
              @click="selectOption(currentQuestion.id, i)"
              class="w-full text-left px-4 py-4 rounded-lg border transition-colors flex items-start gap-4"
              :class="answers[currentQuestion.id] === i ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600' : 'border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50'"
            >
              <div class="w-6 h-6 shrink-0 rounded-full border flex items-center justify-center text-sm font-medium mt-0.5"
                   :class="answers[currentQuestion.id] === i ? 'border-blue-600 bg-blue-600 text-white' : 'border-neutral-300 text-neutral-500'">
                {{ String.fromCharCode(65 + Number(i)) }}
              </div>
              <span class="text-base">{{ opt }}</span>
            </button>
          </div>

          <div v-else-if="currentQuestion.type === 'true_false'" class="grid grid-cols-2 gap-4">
            <button 
              @click="selectOption(currentQuestion.id, true)"
              class="py-6 rounded-lg border transition-colors flex flex-col items-center gap-2"
              :class="answers[currentQuestion.id] === true ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600' : 'border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50'"
            >
              <CheckCircle2 class="w-8 h-8" :class="answers[currentQuestion.id] === true ? 'text-blue-600' : 'text-neutral-400'" />
              <span class="font-medium text-lg">Верно</span>
            </button>
            <button 
              @click="selectOption(currentQuestion.id, false)"
              class="py-6 rounded-lg border transition-colors flex flex-col items-center gap-2"
              :class="answers[currentQuestion.id] === false ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600' : 'border-neutral-200 hover:border-neutral-300 hover:bg-neutral-50'"
            >
              <XCircle class="w-8 h-8" :class="answers[currentQuestion.id] === false ? 'text-blue-600' : 'text-neutral-400'" />
              <span class="font-medium text-lg">Неверно</span>
            </button>
          </div>

          <div v-else-if="currentQuestion.type === 'open_ended'">
            <textarea
              v-model="answers[currentQuestion.id]"
              class="w-full min-h-[150px] p-4 rounded-lg border border-neutral-200 focus:border-blue-600 focus:ring-1 focus:ring-blue-600 outline-none resize-y transition-shadow"
              placeholder="Введите ваш развернутый ответ здесь..."
            ></textarea>
          </div>
        </CardContent>
      </Card>

      <!-- Navigation -->
      <div class="flex justify-between items-center pt-4 border-t border-neutral-100">
        <Button variant="outline" size="lg" @click="prev" :disabled="currentIndex === 0" class="gap-2">
          <ArrowLeft class="w-4 h-4" /> Назад
        </Button>
        
        <Button v-if="!isLast" size="lg" @click="next" class="gap-2">
          Далее <ArrowRight class="w-4 h-4" />
        </Button>
        <Button v-else size="lg" @click="submit" :disabled="submitting" class="gap-2 px-8">
          <Check class="w-4 h-4" v-if="!submitting" />
          {{ submitting ? 'Отправка...' : 'Завершить тест' }}
        </Button>
      </div>
    </div>
  </div>
</template>
