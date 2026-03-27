<template>
  <div
    class="tonal-sculpt-card group bg-[#FFFFFF] p-6 rounded-xl flex flex-col justify-between"
    :class="{ 'border-l-4 border-[#3755C3]': item.status === 'progress' }"
  >
    <div>
      <!-- Заголовок строки -->
      <div class="flex justify-between items-start mb-4">
        <span
          class="px-3 py-1 text-[10px] font-bold uppercase tracking-widest rounded-full"
          :class="badgeClass"
        >{{ badgeLabel }}</span>
        <span class="text-[#566166] text-xs font-medium">{{ item.date }}</span>
      </div>

      <!-- Название теста -->
      <h3 class="text-xl font-headline font-bold text-[#2A3439] mb-2 leading-tight">
        {{ item.title }}
      </h3>

      <!-- Мета -->
      <div class="flex items-center gap-4 text-sm text-[#566166] mb-4">
        <div class="flex items-center gap-1">
          <span class="material-symbols-outlined text-sm">quiz</span>
          {{ item.questions }} вопросов
        </div>
        <div v-if="item.score" class="flex items-center gap-1 text-[#3755C3] font-bold">
          <span class="material-symbols-outlined text-sm">workspace_premium</span>
          {{ item.score }}%
        </div>
      </div>

      <!-- Прогресс-бар для "В процессе" -->
      <div
        v-if="item.status === 'progress'"
        class="w-full bg-[#E1E9EE] h-1.5 rounded-full mb-4"
      >
        <div
          class="bg-[#3755C3] h-full rounded-full"
          :style="{ width: item.progressPercent + '%' }"
        />
      </div>
    </div>

    <!-- Кнопки действий -->
    <div class="flex gap-2 pt-2">
      <template v-if="item.status === 'completed'">
        <button
          class="flex-1 bg-[#E1E9EE] text-[#435368] py-2 rounded-xl text-sm font-bold hover:bg-[#D9E4EA] transition-colors"
          @click="$emit('open-results', item)"
        >
          Результаты
        </button>
      </template>
      <template v-else>
        <button
          class="flex-1 bg-gradient-to-br from-[#3755C3] to-[#2848B7] text-[#F8F7FF] py-2 rounded-xl text-sm font-bold shadow-sm active:scale-95 transition-all"
          @click="$emit('open-test', item)"
        >
          {{ item.status === 'progress' ? 'Продолжить' : 'Начать тест' }}
        </button>
      </template>
      <button
        class="p-2 text-[#566166] hover:text-[#9F403D] transition-colors"
        aria-label="Удалить"
        @click="$emit('delete-test', item)"
      >
        <span class="material-symbols-outlined">delete</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  item: { type: Object, required: true },
})
defineEmits(['open-test', 'open-results', 'delete-test'])

const badgeClass = computed(() => ({
  completed: 'bg-[#D3E4FE] text-[#435368]',
  progress:  'bg-[#DDE1FF] text-[#2747B6]',
  ready:     'bg-[#E1E9EE] text-[#566166]',
}[props.item.status]))

const badgeLabel = computed(() => ({
  completed: 'Завершён',
  progress:  'В процессе',
  ready:     'Готов',
}[props.item.status]))
</script>
