<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { API } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertCircle, ArrowLeft, Lightbulb } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const data = ref<any>(null)
const loading = ref(true)
const errorMsg = ref('')

onMounted(async () => {
  try {
    data.value = await API.getResultDetail(route.params.id as string)
  } catch (error: any) {
    errorMsg.value = error.message || 'Ошибка загрузки результатов'
  } finally {
    loading.value = false
  }
})

const formatDate = (dateStr: string) => {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

const getQuestionTypeLabel = (type: string) => {
  const map: Record<string, string> = {
    'multiple_choice': 'Выбор ответа',
    'true_false': 'Верно / Неверно',
    'open_ended': 'Открытый вопрос'
  }
  return map[type] || type
}

const formatAnswer = (answer: any, question: any) => {
  if (answer === null || answer === undefined) return 'Нет ответа'

  if (question.type === 'multiple_choice' && typeof answer === 'number') {
    const letter = String.fromCharCode(65 + answer)
    const text = question.options ? question.options[answer] : ''
    return `${letter}) ${text}`
  }

  if (question.type === 'true_false') {
    return answer ? 'Верно' : 'Неверно'
  }

  return String(answer)
}

const getQuestion = (questionId: number) => {
  if (!data.value || !data.value.questions) return {}
  return data.value.questions.find((q: any) => q.id === questionId) || {}
}
</script>

<template>
  <div class="max-w-4xl mx-auto py-8">
    <Button variant="ghost" class="mb-6 -ml-4 text-neutral-500 hover:text-neutral-900" @click="router.push('/tests')">
      <ArrowLeft class="w-4 h-4 mr-2" /> Вернуться к тестам
    </Button>

    <Alert variant="destructive" class="mb-6" v-if="errorMsg">
      <AlertCircle class="h-4 w-4" />
      <AlertDescription>{{ errorMsg }}</AlertDescription>
    </Alert>

    <div v-if="loading" class="space-y-6">
      <div class="h-40 bg-neutral-100 rounded-xl animate-pulse"></div>
      <div class="space-y-4">
        <div v-for="i in 3" :key="i" class="h-32 bg-neutral-50 rounded-xl border animate-pulse"></div>
      </div>
    </div>

    <div v-else-if="data">
      <!-- Summary Header -->
      <Card class="mb-8 border-none bg-neutral-50">
        <CardContent class="p-8 text-center">
          <h1 class="text-2xl font-bold mb-2">{{ data.testTitle }}</h1>
          <p class="text-neutral-500 mb-8">{{ data.userName || 'Аноним' }} • {{ formatDate(data.completedAt) }}</p>
          
          <div class="inline-flex items-center justify-center w-32 h-32 rounded-full mb-4 border-8"
               :class="data.percentage >= 70 ? 'border-green-500 text-green-600' : (data.percentage >= 40 ? 'border-yellow-500 text-yellow-600' : 'border-red-500 text-red-600')">
            <span class="text-4xl font-bold">{{ data.percentage }}%</span>
          </div>
          <p class="text-lg font-medium text-neutral-700">{{ data.score }} из {{ data.maxScore }} правильных ответов</p>
        </CardContent>
      </Card>

      <!-- Details -->
      <h2 class="text-xl font-semibold mb-6">Детальный разбор</h2>
      <div class="space-y-6">
        <Card v-for="(answer, i) in data.answers" :key="i" 
              class="border-l-4 overflow-hidden"
              :class="answer.isCorrect ? 'border-l-green-500' : 'border-l-red-500'">
          <CardContent class="p-6">
            <div class="flex items-center justify-between mb-3 text-sm text-neutral-500 font-medium">
              <span>Вопрос {{ Number(i) + 1 }}</span>
              <span>{{ getQuestionTypeLabel(getQuestion(answer.questionId).type) }}</span>
            </div>
            <p class="text-lg font-medium mb-6 leading-relaxed">{{ getQuestion(answer.questionId).question }}</p>

            <div class="bg-neutral-50 p-4 rounded-lg space-y-4 text-sm">
              <div class="grid md:grid-cols-[1fr_2fr] gap-2">
                <span class="text-neutral-500">Ваш ответ:</span>
                <span class="font-medium" :class="answer.isCorrect ? 'text-green-700' : 'text-red-700'">
                  {{ formatAnswer(answer.userAnswer, getQuestion(answer.questionId)) }}
                </span>
              </div>
              
              <div v-if="!answer.isCorrect" class="grid md:grid-cols-[1fr_2fr] gap-2 pt-3 border-t border-neutral-200">
                <span class="text-neutral-500">Правильный ответ:</span>
                <span class="font-medium text-green-700">
                  {{ formatAnswer(answer.correctAnswer, getQuestion(answer.questionId)) }}
                </span>
              </div>
            </div>

            <div v-if="answer.explanation" class="mt-4 p-4 bg-blue-50/50 text-blue-900 rounded-lg text-sm flex gap-3 leading-relaxed">
              <Lightbulb class="w-5 h-5 text-blue-600 shrink-0" />
              <div>{{ answer.explanation }}</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
</template>
