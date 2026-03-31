<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 class="font-headline text-xl font-bold text-[#2A3439]">Модели ИИ</h2>
        <div class="flex gap-2">
          <button class="btn-secondary" :disabled="loading" @click="loadAll">Обновить</button>
          <button class="btn-primary" :disabled="syncing" @click="syncModels">
            {{ syncing ? 'Синхронизация...' : 'Синхронизировать' }}
          </button>
        </div>
      </div>
      <p v-if="error" class="mb-3 text-sm text-[#9F403D]">{{ error }}</p>

      <div class="overflow-auto">
        <table class="w-full min-w-[980px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-3">Имя в UI</th>
              <th class="py-2 pr-3">API ID модели</th>
              <th class="py-2 pr-3">Категория</th>
              <th class="py-2 pr-3">Статус</th>
              <th class="py-2 pr-3">Включена</th>
              <th class="py-2 pr-3">Лимиты</th>
              <th class="py-2 pr-3">Статистика</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in rows" :key="m.id" class="border-b border-[#A9B4B9]/15 align-top">
              <td class="py-2 pr-3 font-semibold text-[#2A3439]">{{ m.ui_name }}</td>
              <td class="py-2 pr-3 text-[#435368]">{{ m.api_model_id || '—' }}</td>
              <td class="py-2 pr-3">{{ m.category }}</td>
              <td class="py-2 pr-3">
                <span :class="m.is_preview ? 'text-[#9F403D]' : 'text-green-700'">
                  {{ m.is_preview ? 'preview (бета)' : 'stable (стабил.)' }}
                </span>
              </td>
              <td class="py-2 pr-3">
                <label class="inline-flex cursor-pointer items-center gap-2">
                  <input type="checkbox" :checked="!!m.is_enabled" @change="toggleEnabled(m, $event)" />
                  <span>{{ m.is_enabled ? 'вкл' : 'выкл' }}</span>
                </label>
              </td>
              <td class="py-2 pr-3 text-[#435368]">
                <div>RPM: {{ m.rpm ?? '—' }}</div>
                <div>TPM: {{ m.tpm ?? '—' }}</div>
                <div>RPD: {{ m.rpd ?? '—' }}</div>
              </td>
              <td class="py-2 pr-3 text-[#435368]">
                <div>зап: {{ usageByModel[m.api_model_id]?.requests ?? 0 }}</div>
                <div>ошиб: {{ usageByModel[m.api_model_id]?.failed_requests ?? 0 }}</div>
                <div>фаза: {{ usageByModel[m.api_model_id]?.phase ?? '—' }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </AdminShell>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'

const loading = ref(false)
const syncing = ref(false)
const error = ref('')
const models = ref([])
const usageRows = ref([])

const rows = computed(() => models.value || [])
const usageByModel = computed(() => {
  const out = {}
  for (const r of usageRows.value || []) {
    if (!r.api_model_id) continue
    const prev = out[r.api_model_id] || { requests: 0, failed_requests: 0, phase: r.phase || 'mixed' }
    prev.requests += Number(r.requests || 0)
    prev.failed_requests += Number(r.failed_requests || 0)
    out[r.api_model_id] = prev
  }
  return out
})

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const [m, u] = await Promise.all([
      API.adminGetModels(),
      API.adminGetUsage({ limit: 1000 }),
    ])
    models.value = m.models || []
    usageRows.value = u.rows || []
  } catch (e) {
    error.value = e?.message || 'Ошибка загрузки моделей'
  } finally {
    loading.value = false
  }
}

async function syncModels() {
  syncing.value = true
  error.value = ''
  try {
    await API.adminSyncModels({ disableMissingFromApi: false })
    await loadAll()
  } catch (e) {
    error.value = e?.message || 'Ошибка синхронизации'
  } finally {
    syncing.value = false
  }
}

async function toggleEnabled(model, event) {
  const checked = !!event.target.checked
  try {
    await API.adminPatchModel(model.id, { is_enabled: checked })
    model.is_enabled = checked
  } catch (e) {
    event.target.checked = !!model.is_enabled
    error.value = e?.message || 'Ошибка переключения состояния'
  }
}

onMounted(loadAll)
</script>

<style scoped>
.btn-primary {
  border-radius: 0.75rem;
  background: linear-gradient(180deg, #3755c3 0%, #2848b7 100%);
  color: #f8f7ff;
  padding: 0.5rem 0.9rem;
  font-weight: 700;
}
.btn-secondary {
  border-radius: 0.75rem;
  border: 1px solid rgba(169, 180, 185, 0.45);
  padding: 0.5rem 0.9rem;
  color: #435368;
  font-weight: 600;
}
</style>
