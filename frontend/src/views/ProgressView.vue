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

      <!-- Загружаем зону + прогресс -->
      <section class="max-w-4xl mx-auto px-6 pb-24">
        <div class="grid grid-cols-1 gap-12">
          <UploadZone
            :disabled="true"
            :error="store.state.upload.error"
            :file-name="store.state.upload.file?.name || ''"
          />
          <GenerationProgress
            :percent="store.state.upload.progress.percent"
            :phase="store.state.upload.progress.phase"
            :stage="store.state.upload.progress.stage"
            :detail="store.state.upload.progress.detail"
            :updated-at="store.state.upload.progress.updatedAt"
            :volume-ready="store.state.upload.progress.volumeReady"
            :progress-history="store.state.upload.progress.history"
            :model-label="modelLabel"
          />
        </div>
      </section>

      <!-- Bento-секция -->
      <BentoFeatures />
    </div>

    <FloatingStatus />
  </AcademicLayout>
</template>

<script setup>
import { computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import AcademicLayout from '@/layouts/AcademicLayout.vue'
import UploadZone from '@/components/upload/UploadZone.vue'
import GenerationProgress from '@/components/upload/GenerationProgress.vue'
import BentoFeatures from '@/components/upload/BentoFeatures.vue'
import FloatingStatus from '@/components/upload/FloatingStatus.vue'
import { API } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'

const router = useRouter()
const store = useAppStore()

const modelLabel = computed(() => store.state.selectedModel || store.state.defaultModel || 'LLM')

let pollTimer = null
let pollActive = false

function stopPolling() {
  pollActive = false
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

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
    if (progress.phase === 'done' && store.state.upload.testId) {
      stopPolling()
      router.replace({ path: '/test', query: { testId: String(store.state.upload.testId) } })
    }
    if (progress.phase === 'error') {
      stopPolling()
      store.actions.failUpload(progress.detail || 'Ошибка генерации')
    }
  } catch (error) {
    if (error?.code === 'FETCH_TIMEOUT') {
      return
    }
    if (error?.status === 404) {
      stopPolling()
      if (store.state.upload.testId) {
        router.replace({ path: '/test', query: { testId: String(store.state.upload.testId) } })
      } else {
        store.actions.failUpload('Прогресс задачи не найден. Откройте страницу загрузки и запустите генерацию снова.')
      }
    } else {
      store.actions.failUpload(error?.message || 'Не удалось обновить прогресс')
      stopPolling()
    }
  }
}

onMounted(async () => {
  if (!store.state.upload.jobId) {
    router.replace('/zagruzka')
    return
  }
  pollActive = true
  void pollLoop()
})

onUnmounted(() => {
  stopPolling()
})
</script>
