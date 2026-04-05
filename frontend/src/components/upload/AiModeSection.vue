<template>
  <div
    class="rounded-xl border border-[#A9B4B9]/25 bg-[#FFFFFF] p-5 tonal-sculpt-shadow md:p-6"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2
        id="ai-mode-heading"
        class="font-headline text-base font-bold text-[#2A3439] md:text-lg"
      >
        Режим генерации
      </h2>
      <span
        v-if="routingLoading"
        class="text-xs text-[#566166]"
        aria-live="polite"
      >Обновление…</span>
    </div>
    <p class="mt-1 text-xs text-[#566166]">
      Авто — политика сервера. Остальное — явный баланс стоимости и качества.
    </p>

    <!-- Сегменты: переносятся на узком экране -->
    <div
      class="mt-4 flex flex-wrap gap-2"
      role="radiogroup"
      aria-labelledby="ai-mode-heading"
    >
      <button
        v-for="item in presetItems"
        :key="item.mode"
        type="button"
        role="radio"
        :aria-checked="isSegmentSelected(item.mode)"
        :disabled="isBusy"
        class="min-h-[40px] rounded-xl border px-3 py-2 text-left text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-[#3755C3] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        :class="
          isSegmentSelected(item.mode)
            ? 'border-[#3755C3] bg-[#3755C3]/8 text-[#2A3439] shadow-sm ring-1 ring-[#3755C3]/25'
            : 'border-[#A9B4B9]/35 bg-[#F8FAFB] text-[#2A3439] hover:border-[#3755C3]/40'
        "
        @click="selectPreset(item.mode)"
      >
        {{ item.label }}
      </button>
    </div>

    <p
      v-if="isCustomActive && activeCustomLabel"
      class="mt-3 text-xs text-[#435368]"
    >
      Активен профиль админки: <strong>{{ activeCustomLabel }}</strong>
    </p>

    <!-- Ручная модель -->
    <div
      v-if="showManualModel"
      class="mt-4 space-y-2 rounded-xl border border-amber-200/80 bg-amber-50/50 p-4"
    >
      <p class="font-headline text-sm font-bold text-[#2A3439]">
        Модель для этапов
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
        Локальные лимиты: до {{ selectedModelLimits.rpd }} запросов/сутки (UTC),
        до {{ selectedModelLimits.rpm }} запросов/мин.
      </p>
    </div>

    <!-- Кастомные режимы из админки -->
    <details
      v-if="customModeOptions.length"
      class="mt-4 rounded-xl border border-[#A9B4B9]/25 bg-[#F8FAFB] p-4"
    >
      <summary class="cursor-pointer select-none font-headline text-sm font-semibold text-[#2A3439]">
        Дополнительно: кастомный режим
      </summary>
      <p class="mt-2 text-xs leading-relaxed text-[#566166]">
        Профиль из админки передаётся в генерацию как запрошенный режим.
      </p>
      <label
        for="custom-mode-select"
        class="sr-only"
      >Кастомный режим</label>
      <select
        id="custom-mode-select"
        v-model="customModeCode"
        :disabled="isBusy"
        class="mt-3 w-full rounded-xl border border-[#A9B4B9]/35 bg-white px-4 py-3 text-sm font-medium text-[#2A3439] focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#3755C3] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="">
          — не использовать кастомный профиль —
        </option>
        <option
          v-for="m in customModeOptions"
          :key="m.code"
          :value="String(m.code).toLowerCase()"
        >
          {{ m.name || m.code }} ({{ m.code }})
        </option>
      </select>
    </details>

    <p
      v-if="routingError"
      class="mt-3 text-xs text-[#9F403D]"
      role="alert"
    >
      {{ routingError }}
    </p>

    <button
      v-if="!useServerPolicy || isCustomActive"
      type="button"
      class="mt-4 text-sm font-medium text-[#435368] underline-offset-2 hover:underline disabled:opacity-50"
      :disabled="isBusy"
      @click="resetToAuto"
    >
      Сбросить в «Авто (сервер)»
    </button>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useAppStore } from '@/stores/appStore';

const PRESET_CODES = ['auto', 'economy', 'balanced', 'quality', 'manual'];

defineProps({
  isBusy: { type: Boolean, default: false },
  routingLoading: { type: Boolean, default: false },
  routingError: { type: String, default: '' },
});

const store = useAppStore();

const presetItems = [
  { mode: 'auto', label: 'Авто' },
  { mode: 'economy', label: 'Эконом' },
  { mode: 'balanced', label: 'Баланс' },
  { mode: 'quality', label: 'Качество' },
  { mode: 'manual', label: 'Вручную' },
];

const modelOptions = computed(() => store.state.models || []);
const generationModes = computed(() => store.state.generationModes || []);
const customModeOptions = computed(() =>
  generationModes.value.filter((m) => !PRESET_CODES.includes(String(m?.code || '').toLowerCase())),
);

const routingMode = computed(() => String(store.state.routingModeUser || 'auto').toLowerCase());

const isCustomActive = computed(() =>
  customModeOptions.value.some((m) => String(m.code).toLowerCase() === routingMode.value),
);

const activeCustomLabel = computed(() => {
  if (!isCustomActive.value) return '';
  const m = customModeOptions.value.find((x) => String(x.code).toLowerCase() === routingMode.value);
  return m ? (m.name || m.code) : '';
});

const useServerPolicy = computed(() => routingMode.value === 'auto');

const showManualModel = computed(
  () => !isCustomActive.value && routingMode.value === 'manual',
);

const selectedModelLimits = computed(() => {
  if (store.state.modelChoiceMode !== 'manual' || !store.state.selectedModel) return null;
  const m = modelOptions.value.find((x) => x.id === store.state.selectedModel);
  return m?.limits || null;
});

function isSegmentSelected(mode) {
  const m = String(mode).toLowerCase();
  if (isCustomActive.value) return false;
  return routingMode.value === m;
}

function selectPreset(mode) {
  const m = String(mode).toLowerCase();
  store.actions.setRoutingModeUser(m);
  if (m === 'manual') {
    const sel = store.state.selectedModel || store.state.defaultModel;
    store.actions.setModelChoice('manual', sel || '');
  } else {
    store.actions.setModelChoice('auto', '');
  }
}

const customModeCode = computed({
  get() {
    const current = routingMode.value;
    return customModeOptions.value.some((x) => String(x.code).toLowerCase() === current) ? current : '';
  },
  set(val) {
    const code = String(val || '').trim().toLowerCase();
    if (!code) {
      store.actions.setRoutingModeUser('balanced');
      store.actions.setModelChoice('auto', '');
      return;
    }
    store.actions.setRoutingModeUser(code);
    store.actions.setModelChoice('auto', '');
  },
});

const modelDropdownValue = computed({
  get() {
    return store.state.selectedModel || store.state.defaultModel || '';
  },
  set(val) {
    store.actions.setModelChoice('manual', val || '');
  },
});

function resetToAuto() {
  store.actions.setRoutingModeUser('auto');
  store.actions.setModelChoice('auto', '');
}
</script>
