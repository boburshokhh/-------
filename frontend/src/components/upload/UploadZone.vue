<template>
  <div class="relative">
    <div
      class="bg-[#FFFFFF] rounded-xl p-8 md:p-12 tonal-sculpt-shadow text-center group border-2 border-dashed border-[#A9B4B9]/30 hover:border-[#3755C3]/50 transition-all duration-300"
      @dragover.prevent
      @drop.prevent="onDrop"
    >
      <div class="flex flex-col items-center justify-center">
        <div class="w-20 h-20 bg-[#DDE1FF] rounded-full flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300">
          <span class="material-symbols-outlined text-[#3755C3] text-4xl">cloud_upload</span>
        </div>
        <h3 class="font-headline font-bold text-2xl text-[#2A3439] mb-2">
          Перетащите файлы сюда
        </h3>
        <p class="text-[#566166] mb-8">Поддерживаются PDF, DOCX и TXT-файлы до 50 МБ</p>
        <button
          :disabled="disabled"
          class="bg-gradient-to-r from-[#3755C3] to-[#2848B7] text-[#F8F7FF] px-8 py-3 rounded-xl font-bold text-sm tracking-wide shadow-lg hover:opacity-90 active:scale-95 transition-all"
          :class="{ 'opacity-50 cursor-not-allowed': disabled }"
          @click="triggerSelect"
        >
          Выбрать файл
        </button>
        <input
          ref="inputRef"
          type="file"
          class="hidden"
          accept=".pdf,.doc,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          @change="onFileInput"
        />
        <p v-if="fileName" class="mt-4 text-sm text-[#435368]">
          Выбран файл: <span class="font-semibold">{{ fileName }}</span>
        </p>
        <p v-if="error" class="mt-3 text-sm text-[#9F403D]">{{ error }}</p>
      </div>
    </div>
    <!-- Декоративные элементы -->
    <div class="absolute -z-10 -top-6 -right-6 w-32 h-32 bg-[#DFD5F7] rounded-full opacity-20 blur-3xl pointer-events-none"></div>
    <div class="absolute -z-10 -bottom-10 -left-10 w-48 h-48 bg-[#DDE1FF] rounded-full opacity-30 blur-3xl pointer-events-none"></div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const props = defineProps({
  disabled: { type: Boolean, default: false },
  error: { type: String, default: '' },
  fileName: { type: String, default: '' },
});

const emit = defineEmits(['file-selected']);
const inputRef = ref(null);

function triggerSelect() {
  if (props.disabled) return;
  inputRef.value?.click();
}

function emitFile(file) {
  if (!file || props.disabled) return;
  emit('file-selected', file);
}

function onDrop(e) {
  const file = e?.dataTransfer?.files?.[0];
  emitFile(file);
}

function onFileInput(e) {
  const file = e?.target?.files?.[0];
  emitFile(file);
  e.target.value = '';
}
</script>
