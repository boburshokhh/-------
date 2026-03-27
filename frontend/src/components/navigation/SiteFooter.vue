<template>
  <footer class="w-full border-t border-[#A9B4B9]/15 bg-[#F7F9FB]">
    <div class="flex flex-col md:flex-row justify-between items-center px-8 py-12 space-y-4 md:space-y-0 max-w-7xl mx-auto">
      <p class="font-body text-xs text-[#566166]">
        © 2024 Academic Architect. Обучение через тональную лепку.
      </p>
      <div class="flex flex-wrap justify-center gap-6">
        <a
          v-for="link in footerLinks"
          :key="link.label"
          href="#"
          class="font-body text-xs text-[#566166] hover:text-[#3755C3] transition-colors"
        >
          {{ link.label }}
        </a>
      </div>
    </div>
  </footer>
</template>

<script setup>
const footerLinks = [
  { label: 'Конфиденциальность' },
  { label: 'Условия использования' },
  { label: 'Документация' },
  { label: 'Поддержка' },
]
</script>
