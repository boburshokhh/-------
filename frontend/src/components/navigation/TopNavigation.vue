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
      <div class="flex items-center gap-3 md:gap-4">
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

        <template v-if="isAuthenticated">
          <div class="hidden sm:flex flex-col items-end max-w-[10rem]">
            <span class="text-xs font-bold text-[#2A3439] truncate w-full text-right">
              {{ displayName }}
            </span>
            <span class="text-[10px] text-[#566166] truncate w-full text-right">
              {{ state.user?.email }}
            </span>
          </div>
          <div
            class="w-8 h-8 shrink-0 rounded-full bg-[#3755C3]/15 border border-[#3755C3]/25 flex items-center justify-center font-headline font-extrabold text-xs text-[#3755C3]"
            :title="displayName"
          >
            {{ initials }}
          </div>
          <button
            type="button"
            class="text-sm font-headline font-bold text-[#566166] hover:text-[#3755C3] transition-colors"
            @click="onLogout"
          >
            Выйти
          </button>
        </template>
        <template v-else>
          <RouterLink
            to="/login"
            class="text-sm font-headline font-bold text-[#566166] hover:text-[#3755C3] transition-colors"
          >
            Войти
          </RouterLink>
          <RouterLink
            to="/register"
            class="text-sm font-headline font-bold text-[#3755C3] hover:opacity-90"
          >
            Регистрация
          </RouterLink>
        </template>
      </div>
    </nav>
  </header>
</template>

<script setup>
import { useRoute, useRouter } from 'vue-router'
import { computed } from 'vue'
import { useAuthStore } from '@/stores/authStore'

const route = useRoute()
const router = useRouter()
const { state, isAuthenticated, logout } = useAuthStore()

const displayName = computed(() => {
  const u = state.user
  if (!u) return ''
  return u.fullName || u.email || 'Пользователь'
})

const initials = computed(() => {
  const name = state.user?.fullName || state.user?.email || '?'
  const parts = String(name).trim().split(/\s+/)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return String(name).slice(0, 2).toUpperCase()
})

function onLogout() {
  logout()
  router.push('/biblioteka')
}

const navLinks = [
  { to: '/biblioteka', label: 'Библиотека', match: ['/biblioteka'] },
  { to: '/zagruzka',   label: 'Загрузка',   match: ['/zagruzka', '/progress'] },
  { to: '/itog',       label: 'Результаты', match: ['/itog', '/razbor'] },
]

function isActive(link) {
  return link.match.some(m => route.path.startsWith(m))
}
</script>
