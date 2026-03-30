<template>
  <div class="relative">
    <div
      role="button"
      :tabindex="disabled ? -1 : 0"
      :aria-disabled="disabled ? 'true' : 'false'"
      class="rounded-xl border-2 border-dashed border-[#A9B4B9]/30 bg-[#FFFFFF] tonal-sculpt-shadow transition-colors duration-200"
      :class="zoneClass"
      @dragover.prevent="onDragOver"
      @dragleave.prevent="onDragLeave"
      @drop.prevent="onDrop"
      @click="onZoneClick"
      @keydown.enter.prevent="onZoneClick"
      @keydown.space.prevent="onZoneClick"
    >
      <!-- Файл выбран: карточка внутри зоны (как на типичных сервисах) -->
      <div
        v-if="hasFilePreview"
        class="flex items-center gap-3 p-4 md:p-5"
      >
        <div
          class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#E8EEF5] text-[#3755C3]"
          aria-hidden="true"
        >
          <span class="material-symbols-outlined text-[28px] leading-none">{{ fileIcon }}</span>
        </div>
        <div class="min-w-0 flex-1 text-left">
          <p class="truncate font-headline text-sm font-bold text-[#2A3439]" :title="displayName">
            {{ displayName }}
          </p>
          <p v-if="displaySize" class="mt-0.5 text-xs text-[#566166]">
            {{ displaySize }}
          </p>
          <p v-if="error" class="mt-2 text-xs font-medium text-[#9F403D]">
            {{ error }}
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 rounded-lg px-3 py-2 text-xs font-bold text-[#3755C3] transition-colors hover:bg-[#3755C3]/10 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="disabled"
          @click.stop="triggerSelect"
        >
          Заменить
        </button>
      </div>

      <!-- Пустое состояние: компактная зона -->
      <div v-else class="flex flex-col items-center px-4 py-6 text-center md:px-6 md:py-8">
        <div
          class="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[#DDE1FF] transition-transform duration-200 group-hover:scale-105"
        >
          <span class="material-symbols-outlined text-[#3755C3] text-[26px] leading-none">upload_file</span>
        </div>
        <p class="font-headline text-sm font-bold text-[#2A3439] md:text-base">
          Перетащите файл или нажмите
        </p>
        <p class="mt-1 max-w-xs text-xs leading-snug text-[#566166]">
          {{ limitsText }}
        </p>
        <button
          type="button"
          :disabled="disabled"
          class="mt-4 rounded-xl bg-gradient-to-r from-[#3755C3] to-[#2848B7] px-5 py-2.5 text-xs font-bold tracking-wide text-[#F8F7FF] shadow-md transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          @click.stop="triggerSelect"
        >
          Выбрать файл
        </button>
        <p v-if="error" class="mt-3 max-w-sm text-xs font-medium text-[#9F403D]">
          {{ error }}
        </p>
      </div>

      <input
        ref="inputRef"
        type="file"
        class="hidden"
        :accept="accept"
        @change="onFileInput"
      />
    </div>

    <div
      class="pointer-events-none absolute -bottom-8 -left-8 -z-10 h-36 w-36 rounded-full bg-[#DDE1FF] opacity-25 blur-3xl"
      aria-hidden="true"
    />
    <div
      class="pointer-events-none absolute -right-4 -top-4 -z-10 h-28 w-28 rounded-full bg-[#DFD5F7] opacity-20 blur-3xl"
      aria-hidden="true"
    />
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  disabled: { type: Boolean, default: false },
  error: { type: String, default: '' },
  fileName: { type: String, default: '' },
  /** Экземпляр File — для размера, MIME и иконки */
  file: { type: Object, default: null },
  accept: { type: String, default: '.pdf,application/pdf' },
  limitsText: { type: String, default: 'Поддерживаются PDF, максимум 30 страниц и до 10 МБ' },
});

const emit = defineEmits(['file-selected']);
const inputRef = ref(null);
const isDragging = ref(false);

const hasFilePreview = computed(() => {
  const n = (props.file?.name || props.fileName || '').trim();
  return n.length > 0;
});

const displayName = computed(() => {
  return (props.file?.name || props.fileName || '').trim() || 'Файл';
});

const displaySize = computed(() => {
  const s = props.file?.size;
  if (s == null || Number.isNaN(Number(s)) || s <= 0) return '';
  return formatFileSize(Number(s));
});

const fileIcon = computed(() => {
  const mime = String(props.file?.type || '');
  const name = displayName.value.toLowerCase();
  if (mime.includes('pdf') || name.endsWith('.pdf')) return 'picture_as_pdf';
  if (mime.includes('word') || mime.includes('officedocument') || /\.docx?$/.test(name)) return 'article';
  return 'draft';
});

const zoneClass = computed(() => {
  const base = 'group';
  if (props.disabled) {
    return `${base} cursor-not-allowed opacity-60`;
  }
  if (isDragging.value) {
    return `${base} cursor-pointer border-[#3755C3] bg-[#3755C3]/5 ring-2 ring-[#3755C3]/20`;
  }
  return `${base} cursor-pointer hover:border-[#3755C3]/50 hover:bg-[#F8FAFB]/80`;
});

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} КБ`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} МБ`;
}

function triggerSelect() {
  if (props.disabled) return;
  inputRef.value?.click();
}

function onZoneClick() {
  if (props.disabled) return;
  triggerSelect();
}

function onDragOver() {
  if (!props.disabled) isDragging.value = true;
}

function onDragLeave() {
  isDragging.value = false;
}

function emitFile(file) {
  if (!file || props.disabled) return;
  isDragging.value = false;
  emit('file-selected', file);
}

function onDrop(e) {
  isDragging.value = false;
  const file = e?.dataTransfer?.files?.[0];
  emitFile(file);
}

function onFileInput(e) {
  const file = e?.target?.files?.[0];
  emitFile(file);
  e.target.value = '';
}
</script>
