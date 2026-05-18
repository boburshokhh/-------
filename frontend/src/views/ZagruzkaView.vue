<template>
  <AcademicLayout>
    <div class="flex-grow">
      <section class="mx-auto max-w-2xl px-6 pb-20 pt-10 md:pt-12">
        <header class="text-center">
          <h1 class="font-headline text-2xl font-extrabold leading-tight tracking-tight text-[#2A3439] sm:text-3xl md:text-4xl">
            Документы → <span class="text-[#3755C3]">тесты</span>
          </h1>
          <p class="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[#566166]">
            Загрузите PDF или DOCX: индексация и генерация вопросов. Сначала выберите режим, затем файл.
          </p>
        </header>

        <div
          v-if="!showProgressInline"
          class="mt-8 space-y-6"
        >
          <AiModeSection
            :is-busy="isBusy"
            :routing-loading="routingLoading"
            :routing-error="routingSnapshotError"
          />

          <div
            id="upload-zone-block"
            class="scroll-mt-24"
          >
            <UploadZone
              :disabled="isBusy"
              :error="store.state.upload.error"
              :file="store.state.upload.file"
              :file-name="store.state.upload.file?.name || ''"
              :accept="uploadAccept"
              :limits-text="uploadLimitsText"
              @file-selected="handleUpload"
            />
          </div>
        </div>

        <GenerationProgress
          v-else
          class="mt-8"
          :percent="store.state.upload.progress.percent"
          :phase="store.state.upload.progress.phase"
          :stage="store.state.upload.progress.stage"
          :detail="store.state.upload.progress.detail"
          :updated-at="store.state.upload.progress.updatedAt"
          :volume-ready="store.state.upload.progress.volumeReady"
          :progress-history="store.state.upload.progress.history"
          :model-label="selectedModelLabel"
          :routing-preview="store.state.generationRouting"
          :routing-result="store.state.upload.routingSummary"
        />

        <div
          v-if="canGoToTest"
          class="mt-10 flex justify-center"
        >
          <button
            class="rounded-xl bg-gradient-to-r from-[#3755C3] to-[#2848B7] px-8 py-3 text-sm font-bold tracking-wide text-[#F8F7FF] shadow-lg transition-all hover:opacity-90 active:scale-95"
            @click="goToTest"
          >
            Перейти к тесту
          </button>
        </div>
      </section>
    </div>
  </AcademicLayout>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AcademicLayout from '@/layouts/AcademicLayout.vue'
import UploadZone from '@/components/upload/UploadZone.vue'
import GenerationProgress from '@/components/upload/GenerationProgress.vue'
import AiModeSection from '@/components/upload/AiModeSection.vue'
import { API, createClientJobId } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'

const router = useRouter()
const store = useAppStore()
const routingLoading = ref(false)
const routingSnapshotError = ref('')
let pollTimer = null
let pollActive = false
/** Подряд 404 при опросе /api/jobs (мульти-инстанс / гонка до регистрации задачи). */
let job404Streak = 0
const JOB_404_GIVE_UP = 45

const isBusy = computed(() => ['uploading', 'processing'].includes(store.state.upload.status))
const showProgressInline = computed(() => ['uploading', 'processing', 'done'].includes(store.state.upload.status))
const canGoToTest = computed(() => store.state.upload.status === 'done' && !!store.state.upload.testId)
const selectedModelLabel = computed(() => {
  if (store.state.modelChoiceMode === 'auto' || !store.state.selectedModel) {
    return 'Авто (сервер)'
  }
  return store.state.selectedModel || store.state.defaultModel || 'LLM'
})

const uploadLimits = computed(() => store.state.diagnostics.health?.uploadLimits || {})
const allowedMimes = computed(() => uploadLimits.value.allowedMimes || [])
const maxPages = computed(() => {
  const n = Number(uploadLimits.value.maxPages)
  return Number.isFinite(n) && n > 0 ? n : null
})
const maxFileSizeMb = computed(() => {
  const n = Number(uploadLimits.value.maxFileSizeMb)
  return Number.isFinite(n) && n > 0 ? n : null
})
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
  const parts = [`Поддерживаются ${formatsLabel}`]
  if (maxPages.value) parts.push(`максимум ${maxPages.value} страниц`)
  if (maxFileSizeMb.value) parts.push(`до ${maxFileSizeMb.value} МБ`)
  return parts.join(', ')
})

async function loadRoutingSnapshot() {
  routingSnapshotError.value = ''
  routingLoading.value = true
  try {
    const mode = store.state.routingModeUser || 'auto'
    const data = await API.getGenerationRouting(mode)
    store.actions.setGenerationRouting(data)
  } catch (e) {
    routingSnapshotError.value = e?.message || 'Не удалось загрузить сведения о маршрутизации'
    store.actions.setGenerationRouting(null)
  } finally {
    routingLoading.value = false
  }
}

watch(
  () => store.state.routingModeUser,
  () => {
    void loadRoutingSnapshot()
  },
)

onMounted(async () => {
  const [modelsPayload, generationModesPayload] = await Promise.all([
    API.getModels(),
    API.getGenerationModes(),
    loadHealth(),
    loadRoutingSnapshot(),
  ])
  store.actions.setModels(modelsPayload)
  store.actions.setGenerationModes(generationModesPayload?.modes || [])
  if (isBusy.value && store.state.upload.jobId) {
    startPolling()
  }
})

onUnmounted(() => {
  stopPolling()
})

function startPolling() {
  stopPolling()
  job404Streak = 0
  pollActive = true
  void pollLoop()
}

function stopPolling() {
  pollActive = false
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

/** Один запрос прогресса за раз; следующий — только после ответа (не копим сотни висящих GET). */
async function pollLoop() {
  if (!pollActive) return
  await pollProgress()
  if (!pollActive) return
  pollTimer = setTimeout(() => {
    pollTimer = null
    void pollLoop()
  }, 1800)
}

async function pollProgress() {
  const jobId = store.state.upload.jobId
  if (!jobId) return
  try {
    const progress = await API.getJobProgress(jobId)
    job404Streak = 0
    store.actions.setUploadProgress(progress)
    if (progress.phase === 'done' || progress.phase === 'error') {
      stopPolling()
    }
  } catch (error) {
    if (error?.code === 'FETCH_TIMEOUT') {
      return
    }
    if (error?.status === 404) {
      // Гонка до registerUploadJobStub, балансировщик на другой инстанс, или таблица job_progress не на всех нодах.
      const transient = ['uploading', 'processing'].includes(store.state.upload.status)
      if (transient) {
        job404Streak += 1
        if (job404Streak < JOB_404_GIVE_UP) {
          return
        }
      }
      stopPolling()
      store.actions.failUpload('Прогресс задачи не найден (сервер перезапущен, истёк TTL или запрос не дошёл до приложения). Загрузите файл снова.')
      return
    }
    store.actions.failUpload(error?.message || 'Не удалось обновить прогресс')
    stopPolling()
  }
}

async function loadHealth() {
  try {
    const payload = await API.getHealth()
    store.actions.setHealth(payload)
  } catch (error) {
    store.actions.setHealthError(error?.message || 'Не удалось получить статус сервиса')
  }
}

async function handleUpload(file) {
  if (!file) return
  const jobId = createClientJobId()
  store.actions.startUpload(file, jobId)
  // POST /upload должен уйти раньше GET /jobs/:id: иначе registerUploadJobStub на сервере
  // ещё не выполнится и первый poll вернёт 404 («Задача не найдена»).
  const manualModel = store.state.modelChoiceMode === 'manual' && store.state.selectedModel
    ? store.state.selectedModel
    : null
  const routingMode = store.state.routingModeUser || 'auto'
  const uploadPromise = API.upload(file, {
    jobId,
    modelId: manualModel,
    routingMode,
    forceOffline: file._forceOffline === true,
  })
  startPolling()
  try {
    const result = await uploadPromise
    store.actions.finishUpload(result)
    stopPolling()
  } catch (error) {
    stopPolling()
    if (error?.requiresOfflineConsent) {
      if (confirm(error.message || 'У вас закончилась дневная квота. Перейти в оффлайн-режим (генерация только по тексту, без сложной ИИ аналитики)?')) {
        file._forceOffline = true;
        handleUpload(file);
      } else {
        store.actions.failUpload('Отменено пользователем (недостаточно квоты).');
      }
      return;
    }
    store.actions.failUpload(error?.message || 'Не удалось загрузить файл')
  }
}

function goToTest() {
  if (!store.state.upload.testId) return
  router.push({ path: '/test', query: { testId: String(store.state.upload.testId) } })
}
</script>
