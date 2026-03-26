<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { API } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AlertCircle, FileText, Clock, PlayCircle, BarChart2, Trash2 } from 'lucide-vue-next'

const router = useRouter()
const tests = ref<any[]>([])
const loading = ref(true)
const errorMsg = ref('')

const loadTests = async () => {
  loading.value = true
  errorMsg.value = ''
  try {
    const data = await API.getTests()
    tests.value = data.tests
  } catch (error: any) {
    errorMsg.value = error.message || 'Ошибка загрузки тестов'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadTests()
})

const deleteTest = async (id: number) => {
  if (!confirm('Удалить этот тест и все его результаты?')) return
  try {
    await API.deleteTest(id)
    loadTests()
  } catch (error: any) {
    errorMsg.value = error.message || 'Ошибка при удалении'
  }
}

const viewResults = async (id: number) => {
  try {
    const { results } = await API.getResults(id)
    if (results.length === 0) {
      alert('Пока нет результатов для этого теста')
      return
    }
    router.push(`/results/detail/${results[0].id}`)
  } catch (error: any) {
    errorMsg.value = error.message || 'Ошибка загрузки результатов'
  }
}

const formatDate = (dateStr: string) => {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}
</script>

<template>
  <div class="py-8">
    <div class="mb-8 flex items-center justify-between">
      <div>
        <h1 class="text-3xl font-bold tracking-tight mb-2">Доступные тесты</h1>
        <p class="text-neutral-500">Выберите тест для прохождения</p>
      </div>
      <Button @click="router.push('/')">Новый тест</Button>
    </div>

    <Alert variant="destructive" class="mb-6" v-if="errorMsg">
      <AlertCircle class="h-4 w-4" />
      <AlertDescription>{{ errorMsg }}</AlertDescription>
    </Alert>

    <div v-if="loading" class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <Card v-for="i in 3" :key="i">
        <CardHeader>
          <Skeleton class="h-6 w-3/4 mb-2" />
        </CardHeader>
        <CardContent>
          <Skeleton class="h-4 w-1/2 mb-4" />
          <div class="flex gap-2">
            <Skeleton class="h-9 w-24" />
            <Skeleton class="h-9 w-24" />
          </div>
        </CardContent>
      </Card>
    </div>

    <div v-else-if="tests.length === 0" class="text-center py-16 bg-white rounded-lg border border-neutral-200">
      <div class="w-16 h-16 bg-neutral-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <FileText class="w-8 h-8 text-neutral-400" />
      </div>
      <h3 class="text-xl font-semibold mb-2">Тестов пока нет</h3>
      <p class="text-neutral-500 mb-6">Загрузите документ, чтобы создать первый тест</p>
      <Button @click="router.push('/')">Загрузить документ</Button>
    </div>

    <div v-else class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <Card v-for="test in tests" :key="test.id" class="flex flex-col hover:border-blue-200 transition-colors cursor-pointer" @click="router.push(`/quiz/${test.id}`)">
        <CardHeader class="pb-3">
          <div class="flex justify-between items-start gap-4">
            <CardTitle class="text-lg line-clamp-2 leading-tight">{{ test.title }}</CardTitle>
            <Badge variant="secondary" class="whitespace-nowrap shrink-0">{{ test.total_questions }} вопр.</Badge>
          </div>
        </CardHeader>
        <CardContent class="mt-auto">
          <div class="text-sm text-neutral-500 space-y-1 mb-6">
            <div class="flex items-center gap-2">
              <FileText class="w-4 h-4" />
              <span class="truncate">{{ test.document_name || 'Документ' }}</span>
            </div>
            <div class="flex items-center gap-2">
              <Clock class="w-4 h-4" />
              <span>{{ formatDate(test.created_at) }}</span>
            </div>
          </div>
          <div class="flex gap-2" @click.stop>
            <Button size="sm" class="flex-1 gap-1" @click="router.push(`/quiz/${test.id}`)">
              <PlayCircle class="w-4 h-4" /> Пройти
            </Button>
            <Button size="sm" variant="outline" title="Результаты" @click="viewResults(test.id)">
              <BarChart2 class="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" class="text-red-600 hover:text-red-700 hover:bg-red-50" title="Удалить" @click="deleteTest(test.id)">
              <Trash2 class="w-4 h-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
