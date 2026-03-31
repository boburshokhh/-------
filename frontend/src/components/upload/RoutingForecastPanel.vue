<template>
  <div
    class="space-y-4"
    aria-live="polite"
  >
    <!-- Прогноз -->
    <div class="rounded-xl border border-[#A9B4B9]/20 bg-[#F8FAFB] p-4">
      <p class="font-headline text-[11px] font-bold uppercase tracking-wide text-[#435368]">
        Прогноз для вашего запуска
      </p>
      <p
        v-if="snapshot && snapshot.requested_mode !== snapshot.effective_mode"
        class="mt-2 text-sm text-[#2A3439]"
      >
        Запрошено:
        <strong>{{ snapshot.requested_mode }}</strong>
        → эффективно:
        <strong class="text-[#3755C3]">{{ snapshot.effective_mode }}</strong>
      </p>
      <p
        v-else-if="snapshot"
        class="mt-2 text-sm text-[#2A3439]"
      >
        Эффективный режим:
        <strong>{{ snapshot.effective_mode }}</strong>
      </p>
      <p
        v-if="snapshot?.requested_mode === 'auto' && snapshot?.base_config_routing_mode"
        class="mt-1 text-xs text-[#566166]"
      >
        Базовый режим в конфиге:
        <strong>{{ snapshot.base_config_routing_mode }}</strong>
        — при Auto используется как основа.
      </p>

      <p
        v-if="!hasFile"
        class="mt-3 rounded-lg border border-dashed border-[#A9B4B9]/40 bg-white/80 px-3 py-2 text-xs text-[#566166]"
      >
        {{ emptyStateNoFile }}
      </p>
    </div>

    <!-- Модели по этапам -->
    <div class="rounded-xl border border-[#A9B4B9]/20 bg-white p-4">
      <p class="font-headline text-[11px] font-bold uppercase tracking-wide text-[#435368]">
        Какие модели ожидаются
      </p>
      <p class="mt-1 text-xs text-[#566166]">
        Итоговый выбор может измениться из‑за лимитов, здоровья сервиса и политики Premium.
      </p>
      <p class="mt-2 text-[11px] text-[#566166] italic">
        {{ stagePreviewDisclaimer }}
      </p>

      <div
        v-if="stagePreviewError"
        class="mt-2 text-xs text-[#9F403D]"
      >
        Не удалось построить оценку по этапам: {{ stagePreviewError }}
      </div>
      <ul
        v-else-if="stageRows.length"
        class="mt-3 space-y-2 text-sm"
      >
        <li
          v-for="row in stageRows"
          :key="row.key"
          class="flex flex-col gap-0.5 rounded-lg border border-[#A9B4B9]/15 bg-[#F8FAFB] px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <span class="font-medium text-[#2A3439]">{{ row.label }}</span>
          <span class="font-mono text-xs text-[#435368]">
            {{ row.selected }}
            <span
              v-if="row.premium_blocked"
              class="text-[#9F403D]"
            >[premium off]</span>
            <span
              v-if="row.preview_blocked"
              class="text-amber-800"
            >[preview off]</span>
          </span>
        </li>
      </ul>
      <p
        v-else-if="snapshot && !loading"
        class="mt-2 text-xs text-[#566166]"
      >
        Нет данных предпросмотра по стадиям для текущего режима.
      </p>
    </div>

    <!-- Объяснения сервера -->
    <div
      v-if="snapshot?.explanations?.length"
      class="rounded-xl border border-[#A9B4B9]/20 bg-white p-4"
    >
      <p class="font-headline text-[11px] font-bold uppercase tracking-wide text-[#435368]">
        Изменения по этапам (пояснения)
      </p>
      <ul class="mt-2 list-disc space-y-1 pl-4 text-xs text-[#2A3439]">
        <li
          v-for="(line, i) in snapshot.explanations"
          :key="'exp-' + i"
        >
          {{ line }}
        </li>
      </ul>
    </div>

    <!-- Ограничения -->
    <div class="rounded-xl border border-[#A9B4B9]/20 bg-white p-4">
      <p class="font-headline text-[11px] font-bold uppercase tracking-wide text-[#435368]">
        Что может повлиять на результат
      </p>
      <ul class="mt-2 space-y-2 text-xs">
        <li
          v-for="(item, idx) in constraintItems"
          :key="idx"
          class="flex flex-col gap-1 rounded-lg px-2 py-2 sm:flex-row sm:items-start sm:gap-2"
          :class="item.tone"
        >
          <span class="shrink-0 font-semibold">{{ item.title }}</span>
          <span class="text-[#566166]">{{ item.detail }}</span>
          <span
            v-if="item.hint"
            class="text-[11px] text-[#3755C3]"
          >{{ item.hint }}</span>
        </li>
        <li
          v-if="healthStatus && healthStatus !== 'ok'"
          class="rounded-lg bg-amber-50/80 px-2 py-2 text-amber-900"
        >
          <span class="font-semibold">Сервис:</span>
          статус {{ healthStatus }}. Повторите после восстановления или смените режим.
        </li>
      </ul>
    </div>

    <p
      v-if="loading"
      class="text-xs text-[#566166]"
    >
      Загрузка сведений о маршрутизации…
    </p>
    <p
      v-if="error"
      class="text-xs text-[#9F403D]"
    >
      {{ error }}
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { getStageLabelRu, STAGE_PREVIEW_DISCLAIMER, EMPTY_STATE_NO_FILE } from '@/lib/routingLabels';

const props = defineProps({
  snapshot: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  hasFile: { type: Boolean, default: false },
  healthStatus: { type: String, default: '' },
});

const stagePreviewDisclaimer = STAGE_PREVIEW_DISCLAIMER;
const emptyStateNoFile = EMPTY_STATE_NO_FILE;

const stagePreviewError = computed(() => {
  const sp = props.snapshot?.stage_preview;
  if (!sp || typeof sp !== 'object') return '';
  return sp._error || '';
});

const stageRows = computed(() => {
  const sp = props.snapshot?.stage_preview;
  if (!sp || typeof sp !== 'object') return [];
  const { _error, ...rest } = sp;
  if (_error) return [];
  return Object.entries(rest).map(([key, info]) => ({
    key,
    label: getStageLabelRu(key),
    selected: info?.selected || '—',
    premium_blocked: !!info?.premium_blocked,
    preview_blocked: !!info?.preview_blocked,
  }));
});

const constraintItems = computed(() => {
  const s = props.snapshot;
  if (!s) return [];
  const out = [];

  if (s.downgrade_active) {
    out.push({
      title: 'Аварийный downgrade',
      detail: 'Приоритет у стабильных экономичных моделей.',
      hint: 'Дождитесь снятия политики администратором или используйте Экономию.',
      tone: 'bg-red-50/90 text-[#9F403D]',
    });
  }
  if (s.policies?.stable_only && !s.downgrade_active) {
    out.push({
      title: 'Только стабильные модели',
      detail: 'Preview-модели не используются.',
      hint: null,
      tone: 'bg-[#F8FAFB] text-[#2A3439]',
    });
  }
  if (s.policies?.premium_guard_enabled && s.premium_budget && !s.premium_budget.allowed) {
    out.push({
      title: 'Premium ограничен',
      detail: 'Политика дневного бюджета не разрешает premium сейчас.',
      hint: 'Выберите Экономию или дождитесь сброса лимита.',
      tone: 'bg-red-50/90 text-[#9F403D]',
    });
  } else if (s.premium_budget?.warning) {
    out.push({
      title: 'Premium: мягкий лимит',
      detail: `Приближение к лимиту (~${s.premium_budget.premium_percent ?? '?'}% вызовов).`,
      hint: 'Рассмотрите режим Экономия.',
      tone: 'bg-amber-50/80 text-amber-900',
    });
  }
  const q = s.quota_flags || {};
  if (q.flashBudgetTightForCheap) {
    out.push({
      title: 'Flash под нагрузкой',
      detail: 'Дешёвые стадии могут перейти на другую модель.',
      hint: null,
      tone: 'bg-amber-50/80 text-amber-900',
    });
  }
  if (q.premiumBudgetTight) {
    out.push({
      title: 'Premium budget tight',
      detail: 'Снижено использование premium из‑за лимитов.',
      hint: 'Смените режим или подождите.',
      tone: 'bg-amber-50/80 text-amber-900',
    });
  }
  if (q.previewRoutingBlocked) {
    out.push({
      title: 'Preview отключены',
      detail: 'Высокая ошибка preview — маршрутизация без preview-моделей.',
      hint: null,
      tone: 'bg-amber-50/80 text-amber-900',
    });
  }
  return out;
});
</script>
