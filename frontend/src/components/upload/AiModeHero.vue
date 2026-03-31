<template>
  <header class="space-y-3">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="space-y-1">
        <h2
          :id="headingId || undefined"
          class="font-headline text-lg font-bold text-[#2A3439] md:text-xl"
        >
          Режим ИИ
        </h2>
        <p class="text-xs leading-relaxed text-[#566166] md:text-sm">
          Выберите баланс цены, скорости и качества на этапах пайплайна. Система покажет, где возможен Premium и что изменится по сравнению с базовой политикой.
        </p>
      </div>

      <div
        class="flex shrink-0 flex-col items-end gap-1 rounded-xl border border-[#A9B4B9]/25 bg-[#F8FAFB] px-3 py-2 sm:max-w-[220px]"
      >
        <label class="flex cursor-pointer items-center gap-2 text-xs font-medium text-[#2A3439]">
          <input
            type="checkbox"
            class="h-4 w-4 rounded border-[#A9B4B9] text-[#3755C3] focus:ring-[#3755C3]"
            :checked="useServerPolicy"
            :disabled="disabled"
            @change="onToggleAuto($event.target.checked)"
          />
          <span>Политика сервера (Auto)</span>
        </label>
        <p class="text-[10px] leading-snug text-[#566166]">
          Включено: базовый режим из настроек администратора. Выключите, чтобы задать Economy / Balanced / Quality / Manual вручную.
        </p>
      </div>
    </div>
  </header>
</template>

<script setup>
defineProps({
  /** Для aria-labelledby у radiogroup карточек */
  headingId: { type: String, default: '' },
  useServerPolicy: { type: Boolean, required: true },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:useServerPolicy'])

function onToggleAuto(checked) {
  emit('update:useServerPolicy', checked)
}
</script>
