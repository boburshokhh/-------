<template>
  <div class="flex items-start gap-4 p-4 bg-[#F0F4F7] rounded-lg relative overflow-hidden">
    <div class="w-1 absolute left-0 top-0 bottom-0 bg-[#3755C3]"></div>
    <span class="material-symbols-outlined text-[#2848B7] mt-0.5">psychology</span>
    <div>
      <span class="text-xs font-bold text-[#3755C3] tracking-wide block mb-1 uppercase">ИИ-рассуждение</span>
      <p class="text-sm text-[#2A3439] leading-relaxed"><slot /></p>
    </div>
  </div>
</template>
