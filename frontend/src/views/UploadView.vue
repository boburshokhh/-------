<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { API } from '@/lib/api'
import { randomUUID } from '@/lib/randomUUID'
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
const livePhase = ref('')
const liveStage = ref('')
const errorMsg = ref('')

const models = ref<{id: string, label: string}[]>([])
const selectedModel = ref<string>('')

let pollTimer: ReturnType<typeof setInterval> | null = null

function clearPoll() {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function phaseLabel(phase: string): string {
  const p = (phase || '').toLowerCase()
  if (p === 'parse') return 'Документ'
  if (p === 'db') return 'Сохранение'
  if (p === 'index') return 'Индексация'
  if (p === 'generate') return 'Генерация теста'
  if (p === 'done') return 'Готово'
  if (p === 'error') return 'Ошибка'
  return 'Обработка'
}

const activeStep = computed(() => {
  const p = livePhase.value.toLowerCase()
  if (p === 'parse' || p === 'db') return 1
  if (p === 'index') return 2
  if (p === 'generate') return 3
  if (p === 'done') return 4
  if (p === 'error') return -1
  return 0
})

function stepClass(step: number) {
  const p = livePhase.value.toLowerCase()
  const base =
    'inline-flex items-center justify-center rounded-full px-3 py-1 text-xs font-medium transition-colors border border-transparent'
  if (p === 'error') {
    return `${base} bg-red-50 text-red-800 border-red-200`
  }
  const a = activeStep.value
  const done = p === 'done' || (a > step && step >= 1 && step <= 3)
  const active = p !== 'done' && a === step && step <= 3
  if (done && !active) return `${base} bg-primary/15 text-primary`
  if (active) return `${base} bg-blue-600 text-white shadow-sm`
  return `${base} bg-neutral-100 text-neutral-500`
}

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

onUnmounted(() => {
  clearPoll()
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

  const jobId = randomUUID()
  isUploading.value = true
  progressTitle.value = 'Запуск…'
  progressDetail.value = `${file.name} (${formatSize(file.size)})`
  progress.value = 0
  livePhase.value = 'parse'
  liveStage.value = 'reading'

  const poll = async () => {
    try {
      const data = await API.getJobProgress(jobId)
      if (data.ok && typeof data.percent === 'number') {
        progress.value = data.percent
        livePhase.value = data.phase || ''
        liveStage.value = data.stage || ''
        progressTitle.value = phaseLabel(data.phase)
        progressDetail.value = data.detail || data.stage || ''
      }
    } catch {
      /* первые 404 до старта обработки на сервере — норма */
    }
  }

  pollTimer = setInterval(poll, 450)

  try {
    const result = await API.upload(file, {
      modelId: selectedModel.value || null,
      jobId,
    })

    clearPoll()
    progress.value = 100
    progressTitle.value = 'Тест готов!'
    progressDetail.value = `${result.totalQuestions} вопросов создано`
    livePhase.value = 'done'

    setTimeout(() => {
      isUploading.value = false
      router.push(`/quiz/${result.testId}`)
    }, 900)

  } catch (error: any) {
    clearPoll()
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

    <Card v-else class="py-10">
      <CardContent class="flex flex-col items-center justify-center text-center max-w-lg mx-auto px-4">
        <div class="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-6"></div>

        <div class="flex flex-wrap items-center justify-center gap-2 mb-6 text-sm">
          <span :class="stepClass(1)">1. Документ</span>
          <span class="text-neutral-300">→</span>
          <span :class="stepClass(2)">2. Индексация</span>
          <span class="text-neutral-300">→</span>
          <span :class="stepClass(3)">3. Генерация</span>
        </div>

        <div class="text-5xl font-bold tabular-nums text-primary mb-1">{{ Math.round(progress) }}%</div>
        <div class="text-2xl font-semibold mb-2">{{ progressTitle }}</div>
        <p class="text-neutral-500 mb-2 min-h-[2.75rem] text-sm leading-relaxed">{{ progressDetail }}</p>
        <p class="text-xs text-neutral-400 mb-6">
          Этап: {{ liveStage || '—' }} · Подробности в логах сервера (строки <span class="font-mono">[PROGRESS]</span>)
        </p>
        <div class="w-full max-w-md">
          <Progress :model-value="progress" class="h-2.5 w-full" />
        </div>
      </CardContent>
    </Card>
  </div>
</template>
