<template>
  <div class="relative" :style="{ width: size + 'px', height: size + 'px' }">
    <svg class="w-full h-full transform -rotate-90" :viewBox="`0 0 ${diameter} ${diameter}`">
      <!-- Track -->
      <circle
        class="text-[#E1E9EE]"
        :cx="r" :cy="r" fill="transparent"
        :r="strokeR"
        stroke="currentColor"
        :stroke-width="strokeW"
      />
      <!-- Gradient progress -->
      <defs>
        <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#3755C3" />
          <stop offset="100%" style="stop-color:#2848B7" />
        </linearGradient>
      </defs>
      <circle
        :cx="r" :cy="r" fill="transparent"
        :r="strokeR"
        stroke="url(#gaugeGrad)"
        :stroke-width="strokeW"
        stroke-linecap="round"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="dashOffset"
      />
    </svg>
    <!-- Center content -->
    <div class="absolute inset-0 flex flex-col items-center justify-center">
      <span class="font-headline font-extrabold text-[#2A3439]" :class="scoreClass">
        {{ percent }}<span :class="percentSignClass" class="text-[#3755C3]">%</span>
      </span>
      <span v-if="label" class="text-xs font-semibold tracking-widest text-[#566166] uppercase mt-1">
        {{ label }}
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  percent:  { type: Number, default: 0 },
  size:     { type: Number, default: 256 },
  label:    { type: String, default: '' },
})

const diameter   = computed(() => 100)
const r          = computed(() => 50)
const strokeW    = 8
const strokeR    = computed(() => r.value - strokeW / 2)
const circumference = computed(() => 2 * Math.PI * strokeR.value)
const dashOffset = computed(() => circumference.value * (1 - props.percent / 100))

const scoreClass       = computed(() => props.size >= 200 ? 'text-6xl' : 'text-2xl font-headline font-extrabold')
const percentSignClass = computed(() => props.size >= 200 ? 'text-3xl' : 'text-xl')
</script>
