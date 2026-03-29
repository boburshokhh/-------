<template>
  <AcademicLayout>
    <div class="max-w-md mx-auto px-6 py-16">
      <div class="bg-[#F8F7FF] border border-[#A9B4B9]/20 rounded-2xl p-8 shadow-sm">
        <h1 class="text-2xl font-headline font-extrabold text-[#2A3439] tracking-tight mb-2">
          Регистрация
        </h1>
        <p class="text-[#566166] text-sm mb-8">
          Создайте аккаунт, чтобы пользоваться сервисом с любого устройства.
        </p>

        <form class="space-y-5" @submit.prevent="onSubmit">
          <div>
            <label class="block text-xs font-bold text-[#566166] uppercase tracking-wide mb-1.5">Имя</label>
            <input
              v-model.trim="fullName"
              type="text"
              autocomplete="name"
              required
              class="w-full px-4 py-3 rounded-xl bg-[#F0F4F7] border border-transparent focus:border-[#3755C3] outline-none text-sm text-[#2A3439]"
              placeholder="Как к вам обращаться"
            />
          </div>
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
              autocomplete="new-password"
              required
              minlength="6"
              class="w-full px-4 py-3 rounded-xl bg-[#F0F4F7] border border-transparent focus:border-[#3755C3] outline-none text-sm text-[#2A3439]"
            />
            <p class="text-xs text-[#566166] mt-1">Минимум 6 символов</p>
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
            {{ submitting ? 'Создание…' : 'Зарегистрироваться' }}
          </BtnPrimary>
        </form>

        <p class="mt-6 text-center text-sm text-[#566166]">
          Уже есть аккаунт?
          <RouterLink to="/login" class="font-bold text-[#3755C3] hover:underline">
            Войти
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
const { register } = useAuthStore()

const fullName = ref('')
const email = ref('')
const password = ref('')
const errorMsg = ref('')
const submitting = ref(false)

async function onSubmit() {
  errorMsg.value = ''
  if (password.value.length < 6) {
    errorMsg.value = 'Пароль должен содержать минимум 6 символов'
    return
  }
  submitting.value = true
  try {
    await register({
      email: email.value,
      password: password.value,
      fullName: fullName.value,
    })
    router.push('/biblioteka')
  } catch (e) {
    errorMsg.value = e?.message || 'Не удалось зарегистрироваться'
  } finally {
    submitting.value = false
  }
}
</script>
