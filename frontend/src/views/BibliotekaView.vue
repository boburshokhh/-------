<template>
  <AcademicLayout>
    <div class="max-w-7xl mx-auto px-6 py-12">
      <!-- Заголовок страницы -->
      <section class="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
        <div class="space-y-2">
          <h1 class="text-4xl font-headline font-extrabold text-[#2A3439] tracking-tight">
            Мои сгенерированные тесты
          </h1>
          <p class="text-[#566166] max-w-2xl">
            Управляйте своими оценками, составленными ИИ. Продолжайте прохождение или анализируйте прошлые результаты.
          </p>
        </div>
        <div class="flex flex-col sm:flex-row gap-4">
          <!-- Поле поиска -->
          <div class="relative">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#566166]">search</span>
            <input
              v-model="search"
              type="text"
              placeholder="Поиск документов..."
              class="pl-10 pr-4 py-2.5 w-full sm:w-64 bg-[#F0F4F7] border-b-2 border-transparent focus:border-[#3755C3] outline-none transition-all rounded-t-xl font-medium text-sm text-[#2A3439]"
            />
          </div>
          <!-- Кнопка создать -->
          <button
            class="flex items-center justify-center gap-2 bg-gradient-to-br from-[#3755C3] to-[#2848B7] text-[#F8F7FF] px-6 py-2.5 rounded-xl font-bold text-sm shadow-sm hover:opacity-90 transition-all active:scale-95"
            @click="router.push('/zagruzka')"
          >
            <span class="material-symbols-outlined">add</span>
            Создать новый
          </button>
        </div>
      </section>

      <!-- Статистика -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <StatCard
          v-for="stat in statsData"
          :key="stat.label"
          v-bind="stat"
        />
      </div>

      <!-- Сетка тестов -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <TestCard
          v-for="test in filteredTests"
          :key="test.id"
          :item="test"
          :can-delete="canDeleteTests"
          @open-test="openTest"
          @open-results="openResults"
          @download-test="downloadTest"
          @delete-test="deleteTest"
        />

        <!-- Карточка «Создать из нового документа» -->
        <div
          class="border-2 border-dashed border-[#A9B4B9]/30 p-6 rounded-xl flex flex-col items-center justify-center text-center group hover:bg-[#F0F4F7] transition-colors cursor-pointer"
          @click="router.push('/zagruzka')"
        >
          <div class="w-14 h-14 rounded-full bg-[#E1E9EE] flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
            <span class="material-symbols-outlined text-3xl text-[#3755C3]">upload_file</span>
          </div>
          <h3 class="font-headline font-bold text-[#2A3439]">Создать из нового документа</h3>
          <p class="text-xs text-[#566166] mt-2">Загрузите PDF, презентации или конспекты</p>
        </div>
      </div>
      <p v-if="store.state.testsError" class="mt-6 text-sm text-[#9F403D]">{{ store.state.testsError }}</p>
    </div>
  </AcademicLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AcademicLayout from '@/layouts/AcademicLayout.vue'
import StatCard from '@/components/library/StatCard.vue'
import TestCard from '@/components/library/TestCard.vue'
import { API } from '@/lib/api'
import { buildTestExportFilename, downloadJson } from '@/lib/downloadJson'
import { mapTestListItem } from '@/lib/mappers'
import { useAppStore } from '@/stores/appStore'
import { useAuthStore } from '@/stores/authStore'

const search = ref('')
const router = useRouter()
const store = useAppStore()
const authStore = useAuthStore()
const canDeleteTests = computed(() => authStore.state.user?.role === 'admin')

const filteredTests = computed(() =>
  store.state.tests.filter(t =>
    t.title.toLowerCase().includes(search.value.toLowerCase())
  )
)

const statsData = computed(() => {
  const tests = store.state.tests
  const completed = tests.filter((t) => t.status === 'completed')
  const avgScore = completed.length
    ? Math.round(completed.reduce((acc, item) => acc + (item.score || 0), 0) / completed.length)
    : 0
  const avgQuality = tests.length
    ? Math.round((tests.reduce((acc, t) => acc + (Number(t.extractionQuality) || 0), 0) / tests.length) * 100)
    : 0

  return [
    { icon: 'menu_book', label: 'Всего тестов', value: String(tests.length), bg: 'bg-[#DDE1FF]', iconColor: 'text-[#2747B6]' },
    { icon: 'workspace_premium', label: 'Средний балл', value: `${avgScore}%`, bg: 'bg-[#D3E4FE]', iconColor: 'text-[#435368]' },
    { icon: 'description', label: 'Качество извлечения', value: `${avgQuality}%`, bg: 'bg-[#DFD5F7]', iconColor: 'text-[#4F4964]' },
  ]
})

onMounted(loadTests)

async function loadTests() {
  store.actions.setTestsLoading(true)
  try {
    const { tests } = await API.getTests()
    const mapped = (tests || []).map(mapTestListItem)
    store.actions.setTests(mapped)
  } catch (error) {
    store.actions.setTestsError(error?.message || 'Не удалось загрузить тесты')
  } finally {
    store.actions.setTestsLoading(false)
  }
}

function openTest(item) {
  router.push({ path: '/test', query: { testId: String(item.id) } })
}

async function deleteTest(item) {
  if (!canDeleteTests.value) {
    store.actions.setTestsError('Удаление тестов доступно только администраторам')
    return
  }
  if (!window.confirm(`Удалить тест "${item.title}"?`)) return
  try {
    await API.deleteTest(item.id)
    store.actions.removeTest(item.id)
  } catch (error) {
    store.actions.setTestsError(error?.message || 'Не удалось удалить тест')
  }
}

async function downloadTest(item) {
  try {
    const payload = await API.exportTest(item.id)
    downloadJson(payload, buildTestExportFilename(payload, item.id))
  } catch (error) {
    store.actions.setTestsError(error?.message || 'Не удалось скачать тест')
  }
}

function openResults(item) {
  router.push({ path: '/itog', query: { testId: String(item.id) } })
}
</script>
