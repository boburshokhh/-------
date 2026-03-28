<template>
  <AcademicLayout>
    <div class="flex-grow">
      <!-- Hero-секция -->
      <section class="max-w-7xl mx-auto px-6 pt-16 pb-12 text-center">
        <h1 class="font-headline font-extrabold text-4xl md:text-6xl text-[#2A3439] mb-6 tracking-tight max-w-3xl mx-auto">
          Превратите документы в <span class="text-[#3755C3]">интерактивные тесты</span>
        </h1>
      </section>

      <!-- Зона загрузки / inline-прогресс -->
      <section class="max-w-4xl mx-auto px-6 pb-24">
        <div class="grid grid-cols-1 gap-12">
          <!-- Выбор модели LLM -->
          <div
            v-if="!showProgressInline"
            class="bg-[#FFFFFF] rounded-xl border border-[#A9B4B9]/25 p-5 md:p-6 tonal-sculpt-shadow"
          >
            <label for="model-select" class="block font-headline font-bold text-[#2A3439] text-sm mb-2">
              Модель для генерации
            </label>
            <p v-if="quotaTierLabel" class="text-xs text-[#566166] mb-3">
              Квота: {{ quotaTierLabel }}
            </p>
            <select
              id="model-select"
              v-model="selectedModelId"
              :disabled="isBusy || !modelOptions.length"
              class="w-full max-w-xl rounded-xl border border-[#A9B4B9]/35 bg-[#F8FAFB] px-4 py-3 text-sm text-[#2A3439] font-medium focus:outline-none focus:ring-2 focus:ring-[#3755C3] focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option v-if="!modelOptions.length" value="" disabled>
                Загрузка списка моделей…
              </option>
              <option
                v-for="m in modelOptions"
                :key="m.id"
                :value="m.id"
              >
                {{ m.label }}
              </option>
            </select>
            <p v-if="selectedModelLimits" class="text-xs text-[#566166] mt-3 leading-relaxed">
              Free tier (локальный учёт): до {{ selectedModelLimits.rpd }} запросов/сутки (UTC),
              до {{ selectedModelLimits.rpm }} запросов/мин.
            </p>
          </div>

          <UploadZone
            v-if="!showProgressInline"
            :disabled="isBusy"
            :error="store.state.upload.error"
            :file-name="store.state.upload.file?.name || ''"
            :accept="uploadAccept"
            :limits-text="uploadLimitsText"
            @file-selected="handleUpload"
          />

          <GenerationProgress
            v-else
            :percent="store.state.upload.progress.percent"
            :phase="store.state.upload.progress.phase"
            :stage="store.state.upload.progress.stage"
            :detail="store.state.upload.progress.detail"
            :updated-at="store.state.upload.progress.updatedAt"
            :model-label="selectedModelLabel"
          />

          <div v-if="canGoToTest" class="flex justify-center">
            <button
              class="bg-gradient-to-r from-[#3755C3] to-[#2848B7] text-[#F8F7FF] px-8 py-3 rounded-xl font-bold text-sm tracking-wide shadow-lg hover:opacity-90 active:scale-95 transition-all"
              @click="goToTest"
            >
              Перейти к тесту
            </button>
          </div>
        </div>
      </section>

      <section class="max-w-4xl mx-auto px-6 pb-12">
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div class="bg-[#FFFFFF] rounded-xl border border-[#A9B4B9]/25 p-5">
            <div class="flex items-center justify-between mb-2">
              <h3 class="font-headline font-bold text-[#2A3439]">Статус backend</h3>
              <button
                class="text-xs px-3 py-1 rounded-lg bg-[#E1E9EE] text-[#435368] hover:bg-[#D9E4EA]"
                :disabled="healthLoading"
                @click="loadHealth"
              >
                Обновить
              </button>
            </div>
            <p v-if="store.state.diagnostics.healthError" class="text-sm text-[#9F403D]">
              {{ store.state.diagnostics.healthError }}
            </p>
            <template v-else>
              <p class="text-sm text-[#566166]">Сервис: <span class="font-semibold text-[#2A3439]">{{ healthStatus }}</span></p>
              <p class="text-sm text-[#566166]">API-ключ: <span class="font-semibold text-[#2A3439]">{{ hasApiKeyLabel }}</span></p>
              <p class="text-xs text-[#566166] mt-1">Последняя проверка: {{ healthTimestamp }}</p>
            </template>
          </div>

          <div class="bg-[#FFFFFF] rounded-xl border border-[#A9B4B9]/25 p-5">
            <div class="flex items-center justify-between mb-2">
              <h3 class="font-headline font-bold text-[#2A3439]">Backend логи</h3>
              <button
                class="text-xs px-3 py-1 rounded-lg bg-[#E1E9EE] text-[#435368] hover:bg-[#D9E4EA]"
                :disabled="logsLoading"
                @click="loadLogs"
              >
                Обновить
              </button>
            </div>
            <p v-if="store.state.diagnostics.logsError" class="text-sm text-[#9F403D]">
              {{ store.state.diagnostics.logsError }}
            </p>
            <template v-else>
              <p class="text-xs text-[#566166] mb-2">Обновлено: {{ logsUpdatedAtLabel }}</p>
              <div class="max-h-56 overflow-auto rounded-lg bg-[#F0F4F7] p-3 space-y-2">
                <p
                  v-for="(row, idx) in logsPreview"
                  :key="`${row.ts || ''}-${idx}`"
                  class="text-xs text-[#2A3439] font-mono break-all"
                >
                  [{{ row.level || 'INFO' }}] {{ row.message || '' }}
                </p>
                <p v-if="!logsPreview.length" class="text-xs text-[#566166]">Логи пока недоступны</p>
              </div>
            </template>
          </div>
        </div>
      </section>

      <!-- Bento-секция с фичами -->
      <BentoFeatures />
    </div>

    <FloatingStatus />
  </AcademicLayout>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AcademicLayout from '@/layouts/AcademicLayout.vue'
import UploadZone from '@/components/upload/UploadZone.vue'
import GenerationProgress from '@/components/upload/GenerationProgress.vue'
import BentoFeatures from '@/components/upload/BentoFeatures.vue'
import FloatingStatus from '@/components/upload/FloatingStatus.vue'
import { API, createClientJobId } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'

const router = useRouter()
const store = useAppStore()
const healthLoading = ref(false)
const logsLoading = ref(false)
let pollTimer = null

const isBusy = computed(() => ['uploading', 'processing'].includes(store.state.upload.status))
const showProgressInline = computed(() => ['uploading', 'processing', 'done'].includes(store.state.upload.status))
const canGoToTest = computed(() => store.state.upload.status === 'done' && !!store.state.upload.testId)
const selectedModelLabel = computed(() => store.state.selectedModel || store.state.defaultModel || 'LLM')

const modelOptions = computed(() => store.state.models || [])

const quotaTierLabel = computed(() => {
  const h = store.state.diagnostics.health
  const q = h?.geminiQuota?.tier
  if (q) return String(q).toUpperCase()
  return ''
})

const selectedModelId = computed({
  get() {
    return store.state.selectedModel || store.state.defaultModel || ''
  },
  set(value) {
    store.actions.setSelectedModel(value)
  },
})

const selectedModelLimits = computed(() => {
  const id = store.state.selectedModel || store.state.defaultModel
  const m = modelOptions.value.find((x) => x.id === id)
  return m?.limits || null
})
const healthStatus = computed(() => store.state.diagnostics.health?.status || 'unknown')
const hasApiKeyLabel = computed(() => store.state.diagnostics.health?.hasApiKey ? 'настроен' : 'не настроен')
const uploadLimits = computed(() => store.state.diagnostics.health?.uploadLimits || {})
const allowedMimes = computed(() => uploadLimits.value.allowedMimes || [])
const maxPages = computed(() => Number(uploadLimits.value.maxPages || 30))
const maxFileSizeMb = computed(() => Number(uploadLimits.value.maxFileSizeMb || 10))
const uploadAccept = computed(() => {
  const mimes = allowedMimes.value
  if (!mimes.length) {
    return '.pdf,application/pdf'
  }
  return mimes.join(',')
})
const uploadLimitsText = computed(() => {
  const labels = []
  if (allowedMimes.value.includes('application/pdf')) labels.push('PDF')
  if (allowedMimes.value.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document')) labels.push('DOCX')
  const formatsLabel = labels.length ? labels.join(', ') : 'PDF'
  return `Поддерживаются ${formatsLabel}, максимум ${maxPages.value} страниц и до ${maxFileSizeMb.value} МБ`
})
const healthTimestamp = computed(() => {
  const ts = store.state.diagnostics.health?.timestamp
  if (!ts) return '—'
  const dt = new Date(ts)
  return Number.isNaN(dt.getTime()) ? String(ts) : dt.toLocaleString('ru-RU')
})
const logsUpdatedAtLabel = computed(() => {
  if (!store.state.diagnostics.logsUpdatedAt) return '—'
  return new Date(store.state.diagnostics.logsUpdatedAt).toLocaleTimeString('ru-RU')
})
const logsPreview = computed(() => (store.state.diagnostics.logs || []).slice(-20))

onMounted(async () => {
  const [modelsPayload] = await Promise.all([
    API.getModels(),
    loadHealth(),
    loadLogs(),
  ])
  store.actions.setModels(modelsPayload)
  if (isBusy.value && store.state.upload.jobId) {
    startPolling()
  }
})

onUnmounted(() => {
  stopPolling()
})

function startPolling() {
  stopPolling()
  pollProgress()
  pollTimer = setInterval(pollProgress, 1800)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function pollProgress() {
  const jobId = store.state.upload.jobId
  if (!jobId) return
  try {
    const progress = await API.getJobProgress(jobId)
    store.actions.setUploadProgress(progress)
    if (progress.phase === 'done' || progress.phase === 'error') {
      stopPolling()
    }
  } catch (error) {
    if (error?.status === 404) {
      stopPolling()
      return
    }
    store.actions.failUpload(error?.message || 'Не удалось обновить прогресс')
    stopPolling()
  }
}

async function loadHealth() {
  healthLoading.value = true
  try {
    const payload = await API.getHealth()
    store.actions.setHealth(payload)
  } catch (error) {
    store.actions.setHealthError(error?.message || 'Не удалось получить статус сервиса')
  } finally {
    healthLoading.value = false
  }
}

async function loadLogs() {
  logsLoading.value = true
  try {
    const payload = await API.getLogs(100)
    store.actions.setLogs(payload?.logs || [])
  } catch (error) {
    store.actions.setLogsError(error?.message || 'Не удалось получить логи')
  } finally {
    logsLoading.value = false
  }
}

async function handleUpload(file) {
  if (!file) return
  const jobId = createClientJobId()
  store.actions.startUpload(file, jobId)
  startPolling()
  try {
    const result = await API.upload(file, {
      jobId,
      modelId: store.state.selectedModel || null,
    })
    store.actions.finishUpload(result)
    stopPolling()
  } catch (error) {
    stopPolling()
    store.actions.failUpload(error?.message || 'Не удалось загрузить файл')
  }
}

function goToTest() {
  if (!store.state.upload.testId) return
  router.push({ path: '/test', query: { testId: String(store.state.upload.testId) } })
}
</script>
