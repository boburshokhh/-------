<template>
  <AcademicLayout>
    <div class="flex-grow">
      <!-- Hero-секция -->
      <section class="max-w-7xl mx-auto px-6 pt-16 pb-12 text-center">
        <div class="inline-flex items-center px-4 py-1.5 rounded-full bg-[#DDE1FF] text-[#2747B6] text-xs font-semibold mb-6 tracking-wide uppercase">
          Обучение с поддержкой ИИ
        </div>
        <h1 class="font-headline font-extrabold text-4xl md:text-6xl text-[#2A3439] mb-6 tracking-tight max-w-3xl mx-auto">
          Превратите документы в <span class="text-[#3755C3]">интерактивные тесты</span>
        </h1>
        <p class="text-[#566166] text-lg md:text-xl max-w-2xl mx-auto mb-12 leading-relaxed">
          Загрузите научные статьи, учебники или конспекты лекций. ИИ проанализирует содержимое и создаст индивидуальные задания за секунды.
        </p>
      </section>

      <!-- Зона загрузки и шаги -->
      <section class="max-w-4xl mx-auto px-6 pb-24">
        <div class="grid grid-cols-1 gap-12">
          <UploadZone
            :disabled="isBusy"
            :error="store.state.upload.error"
            :file-name="store.state.upload.file?.name || ''"
            @file-selected="handleUpload"
          />
          <StepsIndicator :active-step="0" />
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
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AcademicLayout from '@/layouts/AcademicLayout.vue'
import UploadZone from '@/components/upload/UploadZone.vue'
import StepsIndicator from '@/components/upload/StepsIndicator.vue'
import BentoFeatures from '@/components/upload/BentoFeatures.vue'
import FloatingStatus from '@/components/upload/FloatingStatus.vue'
import { API, createClientJobId } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'

const router = useRouter()
const store = useAppStore()
const healthLoading = ref(false)
const logsLoading = ref(false)

const isBusy = computed(() => ['uploading', 'processing'].includes(store.state.upload.status))
const healthStatus = computed(() => store.state.diagnostics.health?.status || 'unknown')
const hasApiKeyLabel = computed(() => store.state.diagnostics.health?.hasApiKey ? 'настроен' : 'не настроен')
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
  const models = await API.getModels()
  store.actions.setModels(models)
  await Promise.all([loadHealth(), loadLogs()])
})

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
  router.push({ path: '/progress' })
  try {
    const result = await API.upload(file, {
      jobId,
      modelId: store.state.selectedModel || null,
    })
    store.actions.finishUpload(result)
    router.push({ path: '/test', query: { testId: String(result.testId) } })
  } catch (error) {
    store.actions.failUpload(error?.message || 'Не удалось загрузить файл')
  }
}
</script>
