<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { API } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { UploadCloud, AlertCircle } from 'lucide-vue-next'

const router = useRouter()

const fileInput = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)
const isUploading = ref(false)
const progress = ref(0)
const progressTitle = ref('')
const progressDetail = ref('')
const errorMsg = ref('')

const models = ref<{id: string, label: string}[]>([])
const selectedModel = ref<string>('')

onMounted(async () => {
  try {
    const data = await API.getModels()
    if (data.models && data.models.length > 0) {
      models.value = data.models
      selectedModel.value = data.defaultModel || data.models[0].id
    }
  } catch (e) {
    console.error('Failed to load models', e)
  }
})

const handleDragOver = (e: DragEvent) => {
  e.preventDefault()
  isDragging.value = true
}

const handleDragLeave = () => {
  isDragging.value = false
}

const handleDrop = (e: DragEvent) => {
  e.preventDefault()
  isDragging.value = false
  if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
    processFile(e.dataTransfer.files[0])
  }
}

const handleFileSelect = (e: Event) => {
  const target = e.target as HTMLInputElement
  if (target.files && target.files.length > 0) {
    processFile(target.files[0])
  }
}

const processFile = async (file: File) => {
  errorMsg.value = ''
  
  const allowedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]

  if (!allowedTypes.includes(file.type)) {
    errorMsg.value = 'Неподдерживаемый формат. Используйте PDF или DOCX.'
    return
  }

  if (file.size > 10 * 1024 * 1024) {
    errorMsg.value = 'Файл слишком большой (максимум 10 МБ)'
    return
  }

  isUploading.value = true
  progressTitle.value = 'Загрузка файла...'
  progressDetail.value = `${file.name} (${formatSize(file.size)})`
  progress.value = 10

  try {
    setTimeout(() => {
      progressTitle.value = 'Обработка документа и генерация теста...'
      progressDetail.value = 'ИИ анализирует текст, это может занять 1–2 минуты'
      progress.value = 30
    }, 500)

    const result = await API.upload(file, selectedModel.value || null)

    progressTitle.value = 'Тест готов!'
    progressDetail.value = `${result.totalQuestions} вопросов создано`
    progress.value = 100

    setTimeout(() => {
      isUploading.value = false
      router.push(`/quiz/${result.testId}`)
    }, 1000)

  } catch (error: any) {
    isUploading.value = false
    errorMsg.value = error.message || 'Ошибка при обработке файла'
  }

  if (fileInput.value) {
    fileInput.value.value = ''
  }
}

const formatSize = (bytes: number) => {
  if (bytes < 1024) return bytes + ' Б'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ'
  return (bytes / (1024 * 1024)).toFixed(1) + ' МБ'
}
</script>

<template>
  <div class="max-w-2xl mx-auto py-8">
    <div class="mb-8">
      <h1 class="text-3xl font-bold tracking-tight mb-2">Загрузите документ</h1>
      <p class="text-neutral-500 text-lg">PDF или Word файл (до 30 страниц) — ИИ создаст тест за минуту</p>
    </div>

    <Alert variant="destructive" class="mb-6" v-if="errorMsg">
      <AlertCircle class="h-4 w-4" />
      <AlertTitle>Ошибка</AlertTitle>
      <AlertDescription>
        {{ errorMsg }}
      </AlertDescription>
    </Alert>

    <div class="mb-6" v-if="models.length > 0 && !isUploading">
      <label class="block text-sm font-medium mb-2">Модель ИИ</label>
      <Select v-model="selectedModel">
        <SelectTrigger class="w-full bg-white">
          <SelectValue placeholder="Выберите модель" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="m in models" :key="m.id" :value="m.id">
            {{ m.label }}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>

    <Card v-if="!isUploading" 
          @dragover="handleDragOver" 
          @dragleave="handleDragLeave" 
          @drop="handleDrop"
          @click="fileInput?.click()"
          class="border-2 border-dashed cursor-pointer hover:bg-neutral-50 transition-colors"
          :class="{'border-blue-500 bg-blue-50/50': isDragging}">
      <CardContent class="flex flex-col items-center justify-center py-16 text-center">
        <div class="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center mb-4 text-blue-600">
          <UploadCloud class="w-8 h-8" />
        </div>
        <h3 class="text-xl font-semibold mb-2">Перетащите файл сюда</h3>
        <p class="text-neutral-500 mb-4">или нажмите для выбора</p>
        <Button variant="secondary" class="pointer-events-none mb-6">Выбрать файл</Button>
        <p class="text-sm text-neutral-400 max-w-sm">
          Поддерживаемые форматы: PDF, DOCX.<br/>
          Для отсканированных PDF используется распознавание текста (OCR).
        </p>
        <input type="file" ref="fileInput" class="hidden" accept=".pdf,.docx" @change="handleFileSelect" />
      </CardContent>
    </Card>

    <Card v-else class="py-12">
      <CardContent class="flex flex-col items-center justify-center text-center">
        <div class="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-6"></div>
        <h3 class="text-xl font-semibold mb-2">{{ progressTitle }}</h3>
        <p class="text-neutral-500 mb-8">{{ progressDetail }}</p>
        <div class="w-full max-w-md">
          <Progress :model-value="progress" class="h-2 w-full" />
        </div>
      </CardContent>
    </Card>
  </div>
</template>
