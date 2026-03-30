<template>
  <AcademicLayout>
    <div class="flex-grow">
      <!-- Hero: заголовок + компактное описание снизу -->
      <section class="max-w-7xl mx-auto px-6 pt-12 pb-8 text-center md:pt-14 md:pb-10">
        <h1 class="font-headline font-extrabold text-3xl sm:text-4xl md:text-5xl text-[#2A3439] tracking-tight max-w-3xl mx-auto leading-tight">
          Превратите документы в <span class="text-[#3755C3]">интерактивные тесты</span>
        </h1>
        <p
          class="mx-auto mt-4 max-w-md text-[11px] leading-snug text-[#566166] sm:text-xs sm:max-w-lg sm:leading-relaxed"
        >
          Загрузите PDF или DOCX: система проиндексирует документ и сгенерирует тест. Ниже — режим маршрутизации и выбор модели (или авто).
        </p>
      </section>

      <!-- Два блока рядом: загрузка | модель; при прогрессе — на всю ширину -->
      <section class="max-w-7xl mx-auto px-6 pb-24">
        <div
          v-if="!showProgressInline"
          class="grid grid-cols-1 items-start gap-6 lg:grid-cols-2 lg:gap-8"
        >
          <div class="min-w-0">
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

          <div
            class="flex min-w-0 flex-col gap-4 rounded-xl border border-[#A9B4B9]/25 bg-[#FFFFFF] p-5 tonal-sculpt-shadow md:p-6 lg:min-h-0 lg:self-stretch"
          >
            <div>
              <label for="routing-mode" class="mb-2 block font-headline text-sm font-bold text-[#2A3439]">
                Режим маршрутизации
              </label>
              <p class="mb-2 text-xs text-[#566166]">
                «Auto» подставляет базовый режим из настроек сервера; остальные режимы задают приоритет цены или качества.
              </p>
              <select
                id="routing-mode"
                v-model="routingModeUser"
                :disabled="isBusy"
                class="w-full rounded-xl border border-[#A9B4B9]/35 bg-[#F8FAFB] px-4 py-3 text-sm font-medium text-[#2A3439] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#3755C3] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="auto">Auto (сервер + настройки админа)</option>
                <option value="economy">Economy — минимум стоимости</option>
                <option value="balanced">Balanced</option>
                <option value="quality">Quality — выше качество при необходимости</option>
                <option value="manual">Manual — только выбранная ниже модель</option>
              </select>
            </div>

            <div>
              <label for="model-select" class="mb-2 block font-headline text-sm font-bold text-[#2A3439]">
                Модель для генерации
              </label>
              <p v-if="quotaTierLabel" class="mb-2 text-xs text-[#566166]">
                Квота: {{ quotaTierLabel }}
              </p>
              <select
                id="model-select"
                v-model="modelDropdownValue"
                :disabled="isBusy || !modelOptions.length"
                class="w-full rounded-xl border border-[#A9B4B9]/35 bg-[#F8FAFB] px-4 py-3 text-sm font-medium text-[#2A3439] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#3755C3] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option v-if="!modelOptions.length" value="" disabled>
                  Загрузка списка моделей…
                </option>
                <option value="__AUTO__">Авто — сервер выберет модель по правилам</option>
                <option
                  v-for="m in modelOptions"
                  :key="m.id"
                  :value="m.id"
                >
                  {{ m.label || m.id }}
                </option>
              </select>
              <p v-if="selectedModelLimits" class="mt-2 text-xs leading-relaxed text-[#566166]">
                Free tier (локальный учёт): до {{ selectedModelLimits.rpd }} запросов/сутки (UTC),
                до {{ selectedModelLimits.rpm }} запросов/мин.
              </p>
            </div>

            <div
              v-if="routingSnapshot && !routingSnapshotError"
              class="rounded-lg border border-[#A9B4B9]/20 bg-[#F8FAFB] p-3 text-xs text-[#566166]"
            >
              <p class="font-headline text-[11px] font-bold uppercase tracking-wide text-[#435368]">
                Как сработает генерация
              </p>
              <ul class="mt-2 list-disc space-y-1 pl-4 text-[#2A3439]">
                <li>
                  Эффективный режим:
                  <strong>{{ routingSnapshot.effective_mode }}</strong>
                  <span v-if="routingSnapshot.requested_mode !== routingSnapshot.effective_mode"> (запрошено: {{ routingSnapshot.requested_mode }})</span>
                </li>
                <li v-if="routingSnapshot.requested_mode === 'auto' && routingSnapshot.base_config_routing_mode">
                  Базовый режим в конфиге: <strong>{{ routingSnapshot.base_config_routing_mode }}</strong>
                  — при «auto» он подставляется как основа.
                </li>
                <li v-if="routingSnapshot.downgrade_active" class="text-[#9F403D] font-medium">
                  Включён аварийный downgrade: приоритет у стабильных экономичных моделей.
                </li>
                <li v-if="routingSnapshot.policies?.stable_only && !routingSnapshot.downgrade_active">
                  Только стабильные модели (preview отключены).
                </li>
                <li v-if="routingSnapshot.policies?.premium_guard_enabled && routingSnapshot.premium_budget && !routingSnapshot.premium_budget.allowed">
                  Premium сейчас ограничен политикой дневного бюджета.
                </li>
                <li v-else-if="routingSnapshot.premium_budget?.warning" class="text-amber-800">
                  Premium: приближение к мягкому лимиту (~{{ routingSnapshot.premium_budget.premium_percent ?? '?' }}% вызовов).
                </li>
                <li v-if="routingSnapshot.quota_flags?.flashBudgetTightForCheap" class="text-amber-800">
                  Снижена нагрузка на «flash» для дешёвых стадий — возможен downgrade.
                </li>
                <li v-if="routingSnapshot.quota_flags?.premiumBudgetTight" class="text-amber-800">
                  Сработал soft-limit по premium (premium_budget_tight).
                </li>
                <li v-if="routingSnapshot.quota_flags?.previewRoutingBlocked" class="text-amber-800">
                  Preview-модели временно отключены из‑за ошибок.
                </li>
                <li v-for="(line, i) in routingSnapshot.explanations" :key="'ex'+i">{{ line }}</li>
              </ul>
            </div>
            <p v-if="routingLoading" class="text-xs text-[#566166]">Загрузка сведений о маршрутизации…</p>
            <p v-if="routingSnapshotError" class="text-xs text-[#9F403D]">{{ routingSnapshotError }}</p>
          </div>
        </div>

        <GenerationProgress
          v-else
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

        <div v-if="canGoToTest" class="mt-10 flex flex-col items-center gap-4">
          <div
            v-if="store.state.upload.generationMetrics"
            class="max-w-2xl rounded-xl border border-[#A9B4B9]/25 bg-white p-4 text-left text-sm text-[#566166]"
          >
            <p class="font-headline text-xs font-bold uppercase tracking-wide text-[#435368]">Итог маршрутизации</p>
            <ul class="mt-2 list-disc space-y-1 pl-4">
              <li v-if="store.state.upload.generationMetrics.routing_mode_effective">
                Режим: запрошен <strong>{{ store.state.upload.generationMetrics.routing_mode_requested }}</strong>
                → эффективный <strong>{{ store.state.upload.generationMetrics.routing_mode_effective }}</strong>
              </li>
              <li v-if="store.state.upload.generationMetrics.pipeline_execution_mode">
                Пайплайн: <strong>{{ store.state.upload.generationMetrics.pipeline_execution_mode }}</strong>
                <span v-if="store.state.upload.generationMetrics.quota_offline" class="text-amber-800"> (downgrade: квота)</span>
              </li>
              <li v-if="store.state.upload.generationMetrics.degraded_reasons?.length">
                Деградация: {{ store.state.upload.generationMetrics.degraded_reasons.join(', ') }}
              </li>
            </ul>
          </div>
          <button
            class="rounded-xl bg-gradient-to-r from-[#3755C3] to-[#2848B7] px-8 py-3 text-sm font-bold tracking-wide text-[#F8F7FF] shadow-lg transition-all hover:opacity-90 active:scale-95"
            @click="goToTest"
          >
            Перейти к тесту
          </button>
        </div>
      </section>

      <section class="max-w-7xl mx-auto px-6 pb-12">
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

  </AcademicLayout>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AcademicLayout from '@/layouts/AcademicLayout.vue'
import UploadZone from '@/components/upload/UploadZone.vue'
import GenerationProgress from '@/components/upload/GenerationProgress.vue'
import BentoFeatures from '@/components/upload/BentoFeatures.vue'
import { API, createClientJobId } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'

const router = useRouter()
const store = useAppStore()
const healthLoading = ref(false)
const logsLoading = ref(false)
const routingLoading = ref(false)
const routingSnapshotError = ref('')
let pollTimer = null
let pollActive = false

const isBusy = computed(() => ['uploading', 'processing'].includes(store.state.upload.status))
const showProgressInline = computed(() => ['uploading', 'processing', 'done'].includes(store.state.upload.status))
const canGoToTest = computed(() => store.state.upload.status === 'done' && !!store.state.upload.testId)
const selectedModelLabel = computed(() => {
  if (store.state.modelChoiceMode === 'auto' || !store.state.selectedModel) {
    return 'Авто (сервер)'
  }
  return store.state.selectedModel || store.state.defaultModel || 'LLM'
})

const modelOptions = computed(() => store.state.models || [])

const routingModeUser = computed({
  get() {
    return store.state.routingModeUser || 'auto'
  },
  set(v) {
    store.actions.setRoutingModeUser(v || 'auto')
  },
})

const routingSnapshot = computed(() => store.state.generationRouting)

const modelDropdownValue = computed({
  get() {
    return store.state.modelChoiceMode === 'auto' ? '__AUTO__' : (store.state.selectedModel || '')
  },
  set(val) {
    if (val === '__AUTO__') {
      store.actions.setModelChoice('auto', '')
    } else {
      store.actions.setModelChoice('manual', val)
    }
  },
})

const quotaTierLabel = computed(() => {
  const h = store.state.diagnostics.health
  const q = h?.geminiQuota?.tier
  if (q) return String(q).toUpperCase()
  return ''
})

const selectedModelLimits = computed(() => {
  if (store.state.modelChoiceMode === 'auto' || !store.state.selectedModel) return null
  const id = store.state.selectedModel
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
  const [modelsPayload] = await Promise.all([
    API.getModels(),
    loadHealth(),
    loadLogs(),
    loadRoutingSnapshot(),
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
    store.actions.setUploadProgress(progress)
    if (progress.phase === 'done' || progress.phase === 'error') {
      stopPolling()
    }
  } catch (error) {
    if (error?.code === 'FETCH_TIMEOUT') {
      return
    }
    if (error?.status === 404) {
      // Пока ждём первый ответ по задаче, 404 возможен из‑за гонки сети; после успешного poll статус станет processing.
      if (store.state.upload.status === 'uploading') {
        return
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
