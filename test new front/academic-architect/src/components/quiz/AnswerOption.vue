<template>
  <button
    class="group flex items-center p-6 rounded-xl text-left transition-all border-none w-full"
    :class="selected
      ? 'bg-[#DDE1FF] ring-2 ring-[#3755C3]'
      : 'tonal-sculpt-card ring-1 ring-[#A9B4B9]/15 hover:ring-[#3755C3]/40'"
    @click="$emit('select', optionId)"
  >
    <!-- Буква опции -->
    <div
      class="w-10 h-10 rounded-full flex items-center justify-center mr-4 shrink-0 transition-colors font-headline font-bold"
      :class="selected
        ? 'bg-[#3755C3] text-[#F8F7FF]'
        : 'bg-[#E1E9EE] text-[#566166] group-hover:bg-[#DDE1FF] group-hover:text-[#2747B6]'"
    >
      {{ optionId.toUpperCase() }}
    </div>
    <!-- Текст -->
    <div class="flex-1">
      <span
        class="font-body text-lg"
        :class="selected ? 'font-semibold text-[#2747B6]' : 'text-[#2A3439]'"
        v-html="text"
      />
    </div>
    <!-- Иконка выбора -->
    <span
      v-if="selected"
      class="material-symbols-outlined text-[#3755C3] ml-4"
      style="font-variation-settings: 'FILL' 1;"
    >check_circle</span>
  </button>
</template>

<script setup>
defineProps({
  optionId: { type: String, required: true },
  text:     { type: String, required: true },
  selected: { type: Boolean, default: false },
})
defineEmits(['select'])
</script>
