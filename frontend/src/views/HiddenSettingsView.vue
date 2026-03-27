<template>
  <AcademicLayout>
    <section class="max-w-2xl mx-auto px-6 py-14">
      <div class="bg-white border border-[#A9B4B9]/25 rounded-2xl p-6 md:p-8">
        <h1 class="font-headline font-extrabold text-2xl text-[#2A3439] mb-2">
          Скрытые настройки
        </h1>
        <p class="text-sm text-[#566166] mb-6">
          Управление runtime-конфигом Gemini API ключа (хранение в БД).
        </p>

        <div class="mb-4 text-sm">
          <span class="text-[#566166]">Текущий статус ключа:</span>
          <span class="font-semibold ml-2" :class="hasKey ? 'text-green-700' : 'text-[#9F403D]'">
            {{ hasKey ? 'настроен' : 'не настроен' }}
          </span>
        </div>

        <label class="block text-sm font-semibold text-[#2A3439] mb-2" for="gemini-key">
          GEMINI_API_KEY
        </label>
        <input
          id="gemini-key"
          v-model.trim="geminiApiKey"
          type="password"
          autocomplete="off"
          class="w-full rounded-xl border border-[#A9B4B9]/35 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#3755C3]"
          placeholder="AIza..."
        />
        <p class="text-xs text-[#566166] mt-2">
          Ключ сохраняется в SQLite и используется backend во время генерации.
        </p>

        <p v-if="error" class="text-sm text-[#9F403D] mt-4">{{ error }}</p>
        <p v-if="success" class="text-sm text-green-700 mt-4">{{ success }}</p>

        <div class="mt-6 flex gap-3">
          <button
            class="bg-gradient-to-r from-[#3755C3] to-[#2848B7] text-[#F8F7FF] px-6 py-2.5 rounded-xl font-bold text-sm tracking-wide shadow-lg hover:opacity-90 active:scale-95 transition-all"
            :disabled="saving || !geminiApiKey"
            @click="saveKey"
          >
            {{ saving ? 'Сохранение...' : 'Сохранить ключ' }}
          </button>
          <button
            class="px-6 py-2.5 rounded-xl font-semibold text-sm border border-[#A9B4B9]/40 text-[#435368] hover:bg-[#F4F7FA] transition-all"
            :disabled="loading"
            @click="loadState"
          >
            {{ loading ? 'Обновление...' : 'Обновить статус' }}
          </button>
        </div>
      </div>
    </section>
  </AcademicLayout>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import AcademicLayout from '@/layouts/AcademicLayout.vue'
import { API } from '@/lib/api'

const loading = ref(false)
const saving = ref(false)
const hasKey = ref(false)
const geminiApiKey = ref('')
const error = ref('')
const success = ref('')

async function loadState() {
  loading.value = true
  error.value = ''
  success.value = ''
  try {
    const payload = await API.getRuntimeSettings()
    hasKey.value = !!payload?.settings?.hasGeminiApiKey
  } catch (e) {
    error.value = e?.message || 'Не удалось получить runtime-настройки'
  } finally {
    loading.value = false
  }
}

async function saveKey() {
  if (!geminiApiKey.value) return
  saving.value = true
  error.value = ''
  success.value = ''
  try {
    const payload = await API.setGeminiApiKey(geminiApiKey.value)
    hasKey.value = !!payload?.settings?.hasGeminiApiKey
    success.value = 'Ключ успешно сохранен'
    geminiApiKey.value = ''
  } catch (e) {
    error.value = e?.message || 'Не удалось сохранить ключ'
  } finally {
    saving.value = false
  }
}

onMounted(loadState)
</script>
