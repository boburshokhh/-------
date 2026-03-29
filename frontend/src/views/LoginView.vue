<template>
  <AcademicLayout>
    <div class="max-w-md mx-auto px-6 py-16">
      <div class="bg-[#F8F7FF] border border-[#A9B4B9]/20 rounded-2xl p-8 shadow-sm">
        <h1 class="text-2xl font-headline font-extrabold text-[#2A3439] tracking-tight mb-2">
          Вход
        </h1>
        <p class="text-[#566166] text-sm mb-8">
          Войдите, чтобы сохранять прогресс на разных устройствах.
        </p>

        <form class="space-y-5" @submit.prevent="onSubmit">
          <div>
            <label class="block text-xs font-bold text-[#566166] uppercase tracking-wide mb-1.5">Email</label>
            <input
              v-model.trim="email"
              type="email"
              autocomplete="email"
              required
              class="w-full px-4 py-3 rounded-xl bg-[#F0F4F7] border border-transparent focus:border-[#3755C3] outline-none text-sm text-[#2A3439]"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-[#566166] uppercase tracking-wide mb-1.5">Пароль</label>
            <input
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              minlength="6"
              class="w-full px-4 py-3 rounded-xl bg-[#F0F4F7] border border-transparent focus:border-[#3755C3] outline-none text-sm text-[#2A3439]"
            />
          </div>

          <p v-if="errorMsg" class="text-sm text-red-600 font-medium">
            {{ errorMsg }}
          </p>

          <BtnPrimary
            type="submit"
            class="w-full"
            size="lg"
            :disabled="submitting"
          >
            {{ submitting ? 'Вход…' : 'Войти' }}
          </BtnPrimary>
        </form>

        <p class="mt-6 text-center text-sm text-[#566166]">
          Нет аккаунта?
          <RouterLink to="/register" class="font-bold text-[#3755C3] hover:underline">
            Регистрация
          </RouterLink>
        </p>
      </div>
    </div>
  </AcademicLayout>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AcademicLayout from '@/layouts/AcademicLayout.vue'
import BtnPrimary from '@/components/common/BtnPrimary.vue'
import { useAuthStore } from '@/stores/authStore'

const router = useRouter()
const { login } = useAuthStore()

const email = ref('')
const password = ref('')
const errorMsg = ref('')
const submitting = ref(false)

async function onSubmit() {
  errorMsg.value = ''
  submitting.value = true
  try {
    await login(email.value, password.value)
    router.push('/biblioteka')
  } catch (e) {
    errorMsg.value = e?.message || 'Не удалось войти'
  } finally {
    submitting.value = false
  }
}
</script>
