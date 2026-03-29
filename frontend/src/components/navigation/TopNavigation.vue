<template>
  <header
    class="nav-header sticky top-0 z-50 w-full border-b border-[#A9B4B9]/20 bg-[#F0F4F7]/92 backdrop-blur-md supports-[backdrop-filter]:bg-[#F0F4F7]/85"
  >
    <nav
      class="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-5 sm:py-3.5 md:px-6 md:py-4"
      aria-label="Основная навигация"
    >
      <!-- Логотип -->
      <RouterLink
        to="/biblioteka"
        class="group flex min-w-0 shrink items-center gap-2 rounded-lg py-1 outline-none ring-[#3755C3] ring-offset-2 ring-offset-[#F0F4F7] focus-visible:ring-2"
        @click="closeMobileMenu"
      >
        <span
          class="font-headline text-lg font-extrabold tracking-tight text-[#3755C3] transition-colors group-hover:text-[#2848B7] sm:text-xl"
        >
          Academic Architect
        </span>
      </RouterLink>

      <!-- Desktop nav -->
      <div class="hidden md:flex md:flex-1 md:justify-center md:px-4">
        <div class="inline-flex items-center gap-1 rounded-xl bg-white/60 p-1 shadow-sm ring-1 ring-[#A9B4B9]/15">
          <RouterLink
            v-for="link in navLinks"
            :key="link.to"
            :to="link.to"
            class="nav-pill font-headline text-sm font-bold tracking-tight transition-colors duration-200"
            :class="isActive(link) ? 'nav-pill--active' : 'nav-pill--idle'"
          >
            {{ link.label }}
          </RouterLink>
        </div>
      </div>

      <!-- Правая колонка: иконки + пользователь / вход -->
      <div class="flex shrink-0 items-center gap-1 sm:gap-2 md:gap-3">
        <div class="hidden items-center gap-0.5 sm:flex">
          <button
            type="button"
            class="icon-btn"
            aria-label="Уведомления"
          >
            <span class="material-symbols-outlined text-[22px] text-[#566166]">notifications</span>
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label="Справка"
          >
            <span class="material-symbols-outlined text-[22px] text-[#566166]">help_outline</span>
          </button>
        </div>

        <template v-if="isAuthenticated">
          <div class="hidden min-w-0 max-w-[11rem] flex-col items-end text-right lg:flex">
            <span class="w-full truncate text-xs font-bold text-[#2A3439]">
              {{ displayName }}
            </span>
            <span class="w-full truncate text-[10px] leading-tight text-[#566166]">
              {{ state.user?.email }}
            </span>
          </div>
          <div
            class="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#3755C3]/25 bg-[#3755C3]/12 font-headline text-xs font-extrabold text-[#3755C3] sm:flex"
            :title="displayName"
          >
            {{ initials }}
          </div>
          <button
            type="button"
            class="hidden rounded-lg px-2.5 py-2 text-sm font-bold text-[#566166] transition-colors hover:bg-[#E1E9EE] hover:text-[#3755C3] sm:inline-flex"
            @click="onLogout"
          >
            Выйти
          </button>
        </template>
        <template v-else>
          <RouterLink
            to="/login"
            class="hidden rounded-lg px-2.5 py-2 text-sm font-bold text-[#566166] transition-colors hover:bg-[#E1E9EE] hover:text-[#3755C3] sm:inline-flex"
            @click="closeMobileMenu"
          >
            Войти
          </RouterLink>
          <RouterLink
            to="/register"
            class="btn-primary hidden sm:inline-flex"
            @click="closeMobileMenu"
          >
            Регистрация
          </RouterLink>
        </template>

        <!-- Мобильное меню -->
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-xl text-[#2A3439] transition-colors hover:bg-[#E1E9EE] md:hidden"
          :aria-expanded="mobileMenuOpen"
          aria-controls="mobile-nav-panel"
          aria-label="Открыть меню"
          @click="toggleMobileMenu"
        >
          <span class="material-symbols-outlined text-[26px]">
            {{ mobileMenuOpen ? 'close' : 'menu' }}
          </span>
        </button>
      </div>
    </nav>

    <!-- Мобильная панель -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0 -translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <div
        v-if="mobileMenuOpen"
        id="mobile-nav-panel"
        class="border-t border-[#A9B4B9]/20 bg-[#F7F9FB] px-4 py-4 shadow-[0_12px_24px_-8px_rgba(42,52,57,0.12)] md:hidden"
      >
        <div class="mx-auto flex max-w-7xl flex-col gap-1">
          <RouterLink
            v-for="link in navLinks"
            :key="'m-' + link.to"
            :to="link.to"
            class="mobile-link font-headline text-[15px] font-bold"
            :class="isActive(link) ? 'mobile-link--active' : 'mobile-link--idle'"
            @click="closeMobileMenu"
          >
            {{ link.label }}
          </RouterLink>
        </div>

        <div class="mx-auto mt-4 max-w-7xl border-t border-[#A9B4B9]/20 pt-4">
          <div class="flex items-center justify-between gap-3 sm:hidden">
            <button type="button" class="icon-btn" aria-label="Уведомления">
              <span class="material-symbols-outlined text-[#566166]">notifications</span>
            </button>
            <button type="button" class="icon-btn" aria-label="Справка">
              <span class="material-symbols-outlined text-[#566166]">help_outline</span>
            </button>
          </div>

          <template v-if="isAuthenticated">
            <div class="mt-4 flex items-center gap-3 rounded-xl border border-[#A9B4B9]/20 bg-white p-3 sm:mt-0 sm:hidden">
              <div
                class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#3755C3]/25 bg-[#3755C3]/12 font-headline text-sm font-extrabold text-[#3755C3]"
              >
                {{ initials }}
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-bold text-[#2A3439]">
                  {{ displayName }}
                </p>
                <p class="truncate text-xs text-[#566166]">
                  {{ state.user?.email }}
                </p>
              </div>
            </div>
            <button
              type="button"
              class="btn-mobile-secondary mt-3 w-full sm:hidden"
              @click="onLogoutAndClose"
            >
              Выйти
            </button>
          </template>
          <template v-else>
            <div class="mt-4 flex flex-col gap-2 sm:mt-0 sm:hidden">
              <RouterLink to="/login" class="btn-mobile-secondary w-full text-center" @click="closeMobileMenu">
                Войти
              </RouterLink>
              <RouterLink to="/register" class="btn-primary w-full justify-center text-center" @click="closeMobileMenu">
                Регистрация
              </RouterLink>
            </div>
          </template>
        </div>
      </div>
    </Transition>

    <Teleport to="body">
      <Transition
        enter-active-class="transition-opacity duration-200"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-active-class="transition-opacity duration-150"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div
          v-if="mobileMenuOpen"
          class="fixed inset-0 z-40 bg-[#2A3439]/25 backdrop-blur-[2px] md:hidden"
          aria-hidden="true"
          @click="closeMobileMenu"
        />
      </Transition>
    </Teleport>
  </header>
</template>

<script setup>
import { useRoute, useRouter } from 'vue-router'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/authStore'

const route = useRoute()
const router = useRouter()
const { state, isAuthenticated, logout } = useAuthStore()

const mobileMenuOpen = ref(false)

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

function closeMobileMenu() {
  mobileMenuOpen.value = false
}

function toggleMobileMenu() {
  mobileMenuOpen.value = !mobileMenuOpen.value
}

function onLogout() {
  logout()
  router.push('/biblioteka')
}

function onLogoutAndClose() {
  closeMobileMenu()
  onLogout()
}

watch(() => route.path, () => {
  closeMobileMenu()
})

function onKeydown(e) {
  if (e.key === 'Escape') closeMobileMenu()
}

watch(mobileMenuOpen, (open) => {
  if (typeof document === 'undefined') return
  document.body.style.overflow = open ? 'hidden' : ''
})

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})

const navLinks = [
  { to: '/biblioteka', label: 'Библиотека', match: ['/biblioteka'] },
  { to: '/zagruzka', label: 'Загрузка', match: ['/zagruzka', '/progress'] },
  { to: '/itog', label: 'Результаты', match: ['/itog', '/razbor'] },
]

function isActive(link) {
  return link.match.some(m => route.path.startsWith(m))
}
</script>

<style scoped>
.nav-header {
  box-shadow: 0 1px 0 rgba(169, 180, 185, 0.12);
}

.nav-pill {
  border-radius: 0.625rem;
  padding: 0.5rem 1rem;
  white-space: nowrap;
}

.nav-pill--active {
  background: linear-gradient(180deg, #3755c3 0%, #2848b7 100%);
  color: #f8f7ff;
  box-shadow: 0 2px 8px rgba(55, 85, 195, 0.28);
}

.nav-pill--idle {
  color: #566166;
}

.nav-pill--idle:hover {
  color: #3755c3;
  background: rgba(55, 85, 195, 0.06);
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 0.75rem;
  color: inherit;
  transition: background-color 0.15s ease;
}

.icon-btn:hover {
  background: #e1e9ee;
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  border-radius: 0.75rem;
  background: linear-gradient(180deg, #3755c3 0%, #2848b7 100%);
  padding: 0.5rem 1rem;
  font-family: 'Manrope', sans-serif;
  font-size: 0.875rem;
  font-weight: 700;
  color: #f8f7ff;
  box-shadow: 0 2px 8px rgba(55, 85, 195, 0.22);
  transition: opacity 0.15s ease, box-shadow 0.15s ease;
}

.btn-primary:hover {
  opacity: 0.95;
  box-shadow: 0 4px 12px rgba(55, 85, 195, 0.3);
}

.mobile-link {
  display: block;
  border-radius: 0.75rem;
  padding: 0.75rem 0.875rem;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.mobile-link--active {
  background: rgba(55, 85, 195, 0.12);
  color: #3755c3;
}

.mobile-link--idle {
  color: #2a3439;
}

.mobile-link--idle:hover {
  background: #e8eff3;
}

.btn-mobile-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.75rem;
  border: 1px solid #a9b4b9;
  background: #fff;
  padding: 0.625rem 1rem;
  font-family: 'Manrope', sans-serif;
  font-size: 0.875rem;
  font-weight: 700;
  color: #566166;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.btn-mobile-secondary:hover {
  border-color: #3755c3;
  color: #3755c3;
  background: rgba(55, 85, 195, 0.04);
}
</style>
