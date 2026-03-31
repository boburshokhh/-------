<template>
  <div class="flex min-w-0 flex-col gap-5 rounded-xl border border-[#A9B4B9]/25 bg-[#FFFFFF] p-5 tonal-sculpt-shadow md:p-6 lg:min-h-0 lg:self-stretch">
    <AiModeHero
      heading-id="ai-mode-heading"
      :use-server-policy="useServerPolicy"
      :disabled="isBusy"
      @update:use-server-policy="onToggleServerPolicy"
    />

    <!-- Контекст документа -->
    <p
      v-if="hasFile"
      class="rounded-lg border border-[#A9B4B9]/20 bg-[#F0F7FF] px-3 py-2 text-xs text-[#2A3439]"
    >
      <span class="font-semibold">Файл выбран:</span>
      {{ fileName }} — прогноз моделей уточнится при запуске генерации.
    </p>
    <p
      v-else
      class="rounded-lg border border-dashed border-[#A9B4B9]/35 bg-[#F8FAFB] px-3 py-2 text-xs text-[#566166]"
    >
      Документ ещё не загружен — ниже показан типичный прогноз для выбранного режима.
    </p>

    <RoutingModeCardGrid
      :selected-mode="cardMode"
      :use-server-policy="useServerPolicy"
      :disabled="isBusy"
      @select="onSelectCardMode"
    />

    <!-- Manual: модель -->
    <div
      v-if="!useServerPolicy && cardMode === 'manual'"
      class="space-y-2 rounded-xl border border-amber-200/80 bg-amber-50/50 p-4"
    >
      <p class="font-headline text-sm font-bold text-[#2A3439]">
        Модель для всех этапов
      </p>
      <p class="text-xs leading-relaxed text-[#566166]">
        В режиме Manual одна выбранная модель используется на стадиях пайплайна (если разрешено квотой и политиками), без авто-подбора по этапам.
      </p>
      <label
        for="ai-manual-model"
        class="sr-only"
      >Модель</label>
      <select
        id="ai-manual-model"
        v-model="modelDropdownValue"
        :disabled="isBusy || !modelOptions.length"
        class="w-full rounded-xl border border-[#A9B4B9]/35 bg-white px-4 py-3 text-sm font-medium text-[#2A3439] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#3755C3] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option
          v-if="!modelOptions.length"
          value=""
          disabled
        >
          Загрузка списка моделей…
        </option>
        <option
          v-for="m in modelOptions"
          :key="m.id"
          :value="m.id"
        >
          {{ m.label || m.id }}
        </option>
      </select>
      <p
        v-if="selectedModelLimits"
        class="text-xs leading-relaxed text-[#566166]"
      >
        Free tier (локальный учёт): до {{ selectedModelLimits.rpd }} запросов/сутки (UTC),
        до {{ selectedModelLimits.rpm }} запросов/мин.
      </p>
      <button
        type="button"
        class="w-full rounded-xl border border-[#3755C3]/40 bg-white py-2.5 text-sm font-semibold text-[#3755C3] transition hover:bg-[#3755C3]/5"
        :disabled="isBusy || !store.state.selectedModel"
        @click="scrollToUpload"
      >
        Зафиксировать модель и продолжить
      </button>
    </div>

    <RoutingForecastPanel
      :snapshot="routingSnapshot"
      :loading="routingLoading"
      :error="routingError"
      :has-file="hasFile"
      :health-status="healthStatus"
    />

    <div class="flex flex-col gap-2 border-t border-[#A9B4B9]/20 pt-4 sm:flex-row sm:items-center sm:justify-between">
      <button
        type="button"
        class="rounded-xl bg-gradient-to-r from-[#3755C3] to-[#2848B7] px-5 py-2.5 text-sm font-bold text-[#F8F7FF] shadow-md transition hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="isBusy"
        @click="scrollToUpload"
      >
        {{ primaryCtaLabel }}
      </button>
      <button
        type="button"
        class="text-sm font-medium text-[#435368] underline-offset-2 hover:underline"
        :disabled="isBusy"
        @click="resetToAuto"
      >
        Вернуться к политике сервера (Auto)
      </button>
    </div>

    <p
      v-if="quotaTierLabel"
      class="text-center text-[11px] text-[#566166]"
    >
      Квота: {{ quotaTierLabel }}
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import AiModeHero from '@/components/upload/AiModeHero.vue';
import RoutingModeCardGrid from '@/components/upload/RoutingModeCardGrid.vue';
import RoutingForecastPanel from '@/components/upload/RoutingForecastPanel.vue';
import { useAppStore } from '@/stores/appStore';

defineProps({
  isBusy: { type: Boolean, default: false },
  routingLoading: { type: Boolean, default: false },
  routingError: { type: String, default: '' },
});

const store = useAppStore();

const hasFile = computed(() => !!store.state.upload.file);
const fileName = computed(() => store.state.upload.file?.name || '');
const routingSnapshot = computed(() => store.state.generationRouting);
const modelOptions = computed(() => store.state.models || []);

const healthStatus = computed(() => store.state.diagnostics.health?.status || '');

const quotaTierLabel = computed(() => {
  const q = store.state.diagnostics.health?.geminiQuota?.tier;
  return q ? String(q).toUpperCase() : '';
});

const selectedModelLimits = computed(() => {
  if (store.state.modelChoiceMode !== 'manual' || !store.state.selectedModel) return null;
  const m = modelOptions.value.find((x) => x.id === store.state.selectedModel);
  return m?.limits || null;
});

const useServerPolicy = computed(() => store.state.routingModeUser === 'auto');

/** Пустая строка при Auto — ни одна карточка не подсвечивается */
const cardMode = computed(() => {
  const m = store.state.routingModeUser || 'auto';
  if (m === 'auto') return '';
  return m;
});

const primaryCtaLabel = computed(() => {
  if (!useServerPolicy.value && cardMode.value === 'manual' && !store.state.selectedModel) {
    return 'Выберите модель выше';
  }
  return 'Продолжить к загрузке файла';
});

const modelDropdownValue = computed({
  get() {
    return store.state.selectedModel || store.state.defaultModel || '';
  },
  set(val) {
    store.actions.setModelChoice('manual', val || '');
  },
});

function onToggleServerPolicy(checked) {
  if (checked) {
    store.actions.setRoutingModeUser('auto');
    store.actions.setModelChoice('auto', '');
  } else {
    const cur = store.state.routingModeUser;
    const next = cur === 'auto' ? 'balanced' : cur;
    store.actions.setRoutingModeUser(next);
    if (next === 'manual') {
      const m = store.state.selectedModel || store.state.defaultModel;
      if (m) store.actions.setModelChoice('manual', m);
    } else {
      store.actions.setModelChoice('auto', '');
    }
  }
}

function onSelectCardMode(mode) {
  store.actions.setRoutingModeUser(mode);
  if (mode === 'manual') {
    const m = store.state.selectedModel || store.state.defaultModel;
    store.actions.setModelChoice('manual', m || '');
  } else {
    store.actions.setModelChoice('auto', '');
  }
}

function resetToAuto() {
  store.actions.setRoutingModeUser('auto');
  store.actions.setModelChoice('auto', '');
}

function scrollToUpload() {
  const el = document.getElementById('upload-zone-block');
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
</script>
