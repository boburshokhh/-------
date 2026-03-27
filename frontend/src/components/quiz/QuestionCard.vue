<template>
  <div class="bg-[#FFFFFF] p-8 md:p-12 rounded-xl shadow-sm border-l-4 border-[#3755C3]">
    <p class="font-headline text-2xl md:text-3xl font-bold leading-snug text-[#2A3439]">
      {{ question }}
    </p>
  </div>
</template>

<script setup>
defineProps({
  question: { type: String, required: true },
})
</script>
