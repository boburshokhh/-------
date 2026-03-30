<template>
  <AcademicLayout>
    <main class="mx-auto max-w-6xl px-4 py-8 sm:px-6 md:py-12">
      <header class="mb-8 md:mb-10">
        <p class="mb-1 text-xs font-bold uppercase tracking-widest text-[#3755C3]">
          Дашборд
        </p>
        <h1 class="font-headline text-2xl font-extrabold tracking-tight text-[#2A3439] md:text-3xl">
          Результаты по тестам
        </h1>
        <p class="mt-2 max-w-xl text-sm leading-relaxed text-[#566166]">
          Средний процент по пройденным тестам и карточка по каждому тесту из библиотеки.
        </p>
      </header>

      <!-- Баннер после только что сданного теста -->
      <div
        v-if="lastSubmitBanner"
        class="mb-8 overflow-hidden rounded-2xl border border-[#3755C3]/20 bg-gradient-to-br from-[#EEF2FF] via-[#F8F7FF] to-[#E8EEF5] p-5 shadow-sm md:p-6"
      >
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-start gap-3">
            <div
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#3755C3] text-[#F8F7FF]"
            >
              <span class="material-symbols-outlined text-[26px]">celebration</span>
            </div>
            <div>
              <p class="font-headline text-base font-bold text-[#2A3439] md:text-lg">
                Отлично, {{ lastSubmitBanner.name }}!
              </p>
              <p class="mt-1 text-sm text-[#566166]">
                Тест
                <span class="font-semibold text-[#3755C3]">«{{ lastSubmitBanner.quizName }}»</span>
                — результат
                <span class="font-bold text-[#2A3439]">{{ Math.round(lastSubmitBanner.score) }}%</span>
              </p>
            </div>
          </div>
          <RouterLink
            v-if="lastSubmitBanner.resultId"
            :to="{ path: '/razbor', query: { resultId: String(lastSubmitBanner.resultId) } }"
            class="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#3755C3] to-[#2848B7] px-5 py-3 text-sm font-bold text-[#F8F7FF] shadow-md transition-opacity hover:opacity-90"
          >
            Подробный разбор
            <span class="material-symbols-outlined text-lg">arrow_forward</span>
          </RouterLink>
        </div>
      </div>

      <p v-if="loadError" class="mb-6 rounded-xl border border-[#F5C6C4] bg-[#FFF5F5] px-4 py-3 text-sm text-[#9F403D]">
        {{ loadError }}
      </p>

      <!-- Загрузка -->
      <div
        v-if="loading"
        class="flex flex-col items-center justify-center gap-4 rounded-2xl border border-[#A9B4B9]/15 bg-[#F7F9FB] py-20"
      >
        <div
          class="h-10 w-10 animate-spin rounded-full border-2 border-[#3755C3] border-t-transparent"
          aria-hidden="true"
        />
        <p class="text-sm font-medium text-[#566166]">Загружаем статистику…</p>
      </div>

      <template v-else-if="dashboard">
        <!-- Верхний блок: средний результат + метрики -->
        <section
          class="mb-10 grid gap-6 lg:grid-cols-12 lg:gap-8"
          aria-label="Сводка"
        >
          <div
            class="flex justify-center lg:col-span-5 xl:col-span-4 lg:justify-start"
          >
            <div class="relative">
              <ScoreGauge
                v-if="hasAverage"
                :percent="Math.round(dashboard.averagePercentage)"
                :size="200"
                label="Средний %"
              />
              <div
                v-else
                class="flex h-[200px] w-[200px] flex-col items-center justify-center rounded-full border-2 border-dashed border-[#A9B4B9]/35 bg-[#F7F9FB] text-center"
              >
                <span class="material-symbols-outlined mb-2 text-4xl text-[#A9B4B9]">pie_chart</span>
                <p class="px-4 text-xs font-semibold text-[#566166]">Нет завершённых<br />попыток</p>
              </div>
            </div>
          </div>

          <div class="grid gap-4 sm:grid-cols-2 lg:col-span-7 xl:col-span-8 lg:content-start">
            <div
              class="rounded-2xl border border-[#A9B4B9]/12 bg-[#FFFFFF] p-5 shadow-sm tonal-sculpt-shadow md:p-6"
            >
              <p class="text-xs font-bold uppercase tracking-wider text-[#566166]">
                Пройдено тестов
              </p>
              <p class="mt-2 font-headline text-3xl font-extrabold tabular-nums text-[#2A3439] md:text-4xl">
                {{ dashboard.completedCount }}
                <span class="text-xl font-bold text-[#A9B4B9]">/</span>
                <span class="text-2xl font-bold text-[#566166]">{{ dashboard.totalTests }}</span>
              </p>
              <p class="mt-2 text-xs text-[#566166]">
                Учитывается последняя попытка по каждому тесту
                <span v-if="filterHint"> (фильтр: {{ filterHint }})</span>
              </p>
            </div>

            <div
              class="rounded-2xl border border-[#A9B4B9]/12 bg-[#FFFFFF] p-5 shadow-sm tonal-sculpt-shadow md:p-6"
            >
              <p class="text-xs font-bold uppercase tracking-wider text-[#566166]">
                Средний процент
              </p>
              <p class="mt-2 font-headline text-3xl font-extrabold tabular-nums text-[#3755C3] md:text-4xl">
                {{ hasAverage ? `${dashboard.averagePercentage}%` : '—' }}
              </p>
              <p class="mt-2 text-xs text-[#566166]">
                По тестам с сохранённым результатом
              </p>
            </div>

            <div
              class="sm:col-span-2 rounded-2xl border border-[#3755C3]/15 bg-gradient-to-r from-[#3755C3]/6 to-transparent p-5 md:p-6"
            >
              <div class="flex flex-wrap items-center gap-3">
                <span class="material-symbols-outlined text-[#3755C3]">lightbulb</span>
                <p class="text-sm leading-relaxed text-[#2A3439]">
                  Откройте <strong>разбор</strong> по карточке теста, чтобы увидеть ошибки по вопросам и закрепить материал.
                </p>
              </div>
            </div>
          </div>
        </section>

        <!-- Сетка тестов -->
        <section aria-label="Тесты">
          <div class="mb-5 flex items-end justify-between gap-4">
            <h2 class="font-headline text-lg font-bold text-[#2A3439] md:text-xl">
              Все тесты
            </h2>
            <RouterLink
              to="/biblioteka"
              class="text-sm font-bold text-[#3755C3] transition-colors hover:text-[#2848B7]"
            >
              Библиотека →
            </RouterLink>
          </div>

          <div
            v-if="!dashboard.items.length"
            class="rounded-2xl border border-dashed border-[#A9B4B9]/35 bg-[#F7F9FB] py-16 text-center"
          >
            <p class="text-sm text-[#566166]">
              Пока нет ни одного теста. Создайте тест на странице загрузки.
            </p>
            <RouterLink
              to="/zagruzka"
              class="mt-4 inline-block text-sm font-bold text-[#3755C3] hover:underline"
            >
              Перейти к загрузке
            </RouterLink>
          </div>

          <div
            v-else
            class="grid gap-4 sm:grid-cols-2 xl:grid-cols-2"
          >
            <TestDashboardCard
              v-for="row in dashboard.items"
              :key="row.testId"
              :item="row"
              :highlighted="isRowHighlighted(row)"
            />
          </div>
        </section>
      </template>

      <div class="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <RouterLink
          to="/biblioteka"
          class="w-full rounded-xl bg-[#E1E9EE] px-6 py-3 text-center text-sm font-bold text-[#435368] transition-colors hover:bg-[#D9E4EA] sm:w-auto"
        >
          В библиотеку
        </RouterLink>
      </div>
    </main>
  </AcademicLayout>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import AcademicLayout from '@/layouts/AcademicLayout.vue';
import ScoreGauge from '@/components/common/ScoreGauge.vue';
import TestDashboardCard from '@/components/results/TestDashboardCard.vue';
import { API } from '@/lib/api';
import { mapResultSummary } from '@/lib/mappers';
import { useAppStore } from '@/stores/appStore';
import { useAuthStore } from '@/stores/authStore';

const route = useRoute();
const store = useAppStore();
const authStore = useAuthStore();

const loading = ref(true);
const loadError = ref('');
const dashboard = ref(null);

const filterUserName = computed(() => {
  const u = authStore.state.user;
  const fromAuth = (u?.fullName || u?.email || '').trim();
  if (fromAuth) return fromAuth;
  const n = (store.state.userName || '').trim();
  return n || null;
});

const filterHint = computed(() => {
  if (!filterUserName.value) return '';
  return filterUserName.value.length > 24
    ? `${filterUserName.value.slice(0, 24)}…`
    : filterUserName.value;
});

const hasAverage = computed(
  () => dashboard.value?.averagePercentage != null && dashboard.value.completedCount > 0,
);

const lastSubmitBanner = computed(() => {
  const s = store.state.resultSummary;
  if (!s?.resultId) return null;
  const qRid = route.query.resultId ? String(route.query.resultId) : '';
  if (qRid && String(s.resultId) !== qRid) return null;
  return s;
});

function isRowHighlighted(row) {
  const tid = route.query.testId ? String(route.query.testId) : '';
  if (tid && String(row.testId) === tid) return true;
  const s = store.state.resultSummary;
  if (s?.testId != null && Number(s.testId) === Number(row.testId)) return true;
  return false;
}

async function loadDashboard() {
  loading.value = true;
  loadError.value = '';
  try {
    dashboard.value = await API.getResultsDashboard(filterUserName.value);
  } catch (e) {
    loadError.value = e?.message || 'Не удалось загрузить сводку результатов';
    dashboard.value = null;
  } finally {
    loading.value = false;
  }
}

async function hydrateLegacySingleTest() {
  if (store.state.resultSummary) return;
  const testId = route.query.testId ? Number(route.query.testId) : store.state.upload.testId;
  if (!testId || Number.isNaN(testId)) return;
  try {
    const payload = await API.getResults(testId);
    const latest = payload?.results?.[0];
    if (!latest) return;
    const testDetail = store.state.activeTest?.id === testId ? store.state.activeTest : { id: testId, title: 'Тест' };
    const summary = mapResultSummary(
      {
        resultId: latest.id,
        score: latest.score,
        maxScore: latest.max_score,
        percentage: latest.percentage,
        completedAt: latest.completed_at,
        answers: [],
      },
      { ...testDetail, title: testDetail.title || `Тест #${testId}` },
      latest.user_name || store.state.userName || 'Пользователь',
    );
    store.actions.setResultSummary(summary);
  } catch {
    /* ignore */
  }
}

onMounted(async () => {
  await loadDashboard();
  await hydrateLegacySingleTest();
});

watch(
  () => filterUserName.value,
  () => {
    void loadDashboard();
  },
);
</script>
