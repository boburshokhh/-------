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

      <!-- Bento-секция с фичами -->
      <BentoFeatures />
    </div>

    <FloatingStatus />
  </AcademicLayout>
</template>

<script setup>
import { computed, onMounted } from 'vue'
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

const isBusy = computed(() => ['uploading', 'processing'].includes(store.state.upload.status))

onMounted(async () => {
  const models = await API.getModels()
  store.actions.setModels(models)
})

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
