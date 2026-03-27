<template>
  <header class="w-full top-0 sticky z-50 bg-[#F0F4F7]">
    <nav class="flex justify-between items-center px-6 py-4 max-w-7xl mx-auto">
      <!-- Логотип -->
      <RouterLink
        to="/biblioteka"
        class="text-xl font-extrabold text-[#3755C3] font-headline tracking-tight"
      >
        Academic Architect
      </RouterLink>

      <!-- Основная навигация (desktop) -->
      <div class="hidden md:flex items-center space-x-8">
        <RouterLink
          v-for="link in navLinks"
          :key="link.to"
          :to="link.to"
          class="font-headline font-bold text-sm tracking-tight transition-colors duration-200"
          :class="isActive(link)
            ? 'text-[#3755C3] border-b-2 border-[#3755C3] pb-1'
            : 'text-[#566166] hover:text-[#3755C3]'"
        >
          {{ link.label }}
        </RouterLink>
      </div>

      <!-- Правый блок -->
      <div class="flex items-center space-x-4">
        <button
          class="p-2 rounded-full hover:bg-[#E1E9EE] transition-colors duration-200"
          aria-label="Уведомления"
        >
          <span class="material-symbols-outlined text-[#566166]">notifications</span>
        </button>
        <button
          class="p-2 rounded-full hover:bg-[#E1E9EE] transition-colors duration-200"
          aria-label="Справка"
        >
          <span class="material-symbols-outlined text-[#566166]">help_outline</span>
        </button>
        <div class="w-8 h-8 rounded-full overflow-hidden bg-[#E1E9EE] border border-[#A9B4B9]/15">
          <img
            src="https://lh3.googleusercontent.com/aida-public/AB6AXuBmkTQuc6H_j0b4wgLdD-jqfrIyprXLbeihvoAQ_Fo4rp3uR7tco58jAtIpSKm_nNKxbBHpOXc6VonMBSBnPiqjdDr5E1NaHDJDyEK8YQo6cU_Gkw5c6uxxbt8XtCrRQ2c9Dqs4RDwvzT_qTc0HJohaXimQ5b6uma4vSYFmY82Fb91lFQ1rVadwEaWvSS2Wqn1gBmtdXwoSR5EOA6g5VhooucSwecGg5gJFWrxJp6xHA1-HQtqRXDJqgUBrMCysjQOQY73qIgfFCVx9"
            alt="Фото профиля"
            class="w-full h-full object-cover"
          />
        </div>
      </div>
    </nav>
  </header>
</template>

<script setup>
import { useRoute } from 'vue-router'
import { computed } from 'vue'

const route = useRoute()

const navLinks = [
  { to: '/biblioteka', label: 'Библиотека', match: ['/biblioteka'] },
  { to: '/zagruzka',   label: 'Загрузка',   match: ['/zagruzka', '/progress'] },
  { to: '/itog',       label: 'Результаты', match: ['/itog', '/razbor'] },
]

function isActive(link) {
  return link.match.some(m => route.path.startsWith(m))
}
</script>
