<template>
  <section class="mb-12">
    <h3 class="font-headline font-bold text-xl mb-6 text-[#2A3439]">Разбивка по темам</h3>
    <div class="space-y-4">
      <div
        v-for="item in items"
        :key="item.topic"
        class="bg-[#FFFFFF] p-6 rounded-xl tonal-sculpt-shadow"
      >
        <div class="flex justify-between mb-2">
          <span class="font-semibold text-sm text-[#2A3439]">{{ item.topic }}</span>
          <span
            class="text-sm font-bold"
            :class="item.color === 'error' ? 'text-[#9F403D]' : 'text-[#3755C3]'"
          >{{ item.percent }}%</span>
        </div>
        <ProgressBar :percent="item.percent" :color="item.color" />
      </div>
    </div>
  </section>
</template>

<script setup>
import ProgressBar from '@/components/common/ProgressBar.vue'
defineProps({
  items: { type: Array, required: true },
})
</script>
