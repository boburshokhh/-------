<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="font-headline text-xl font-bold text-[#2A3439]">Режимы ИИ</h2>
          <p class="text-sm text-[#566166] mt-1">Системные и кастомные профили маршрутизации.</p>
        </div>
        <div class="flex gap-2">
          <button class="btn-secondary" @click="openImport">Импорт JSON</button>
          <button class="btn-primary-sm" @click="createMode">Создать режим</button>
        </div>
      </div>

      <div class="mb-4 flex flex-wrap gap-3">
        <input v-model.trim="filters.search" class="field w-56" placeholder="Поиск code/name..." />
        <select v-model="filters.status" class="field w-40">
          <option value="">Все статусы</option>
          <option value="active">active</option>
          <option value="draft">draft</option>
          <option value="archived">archived</option>
          <option value="disabled">disabled</option>
        </select>
        <button class="btn-secondary" @click="loadModes">Применить</button>
      </div>

      <p v-if="error" class="mb-3 text-sm text-[#9F403D]">{{ error }}</p>
      <p v-if="successMsg" class="mb-3 text-sm text-green-700">{{ successMsg }}</p>

      <div class="overflow-auto">
        <table class="w-full min-w-[1200px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-3">Mode</th>
              <th class="py-2 pr-3">Type</th>
              <th class="py-2 pr-3">Status</th>
              <th class="py-2 pr-3">Parent</th>
              <th class="py-2 pr-3">Version</th>
              <th class="py-2 pr-3">Updated</th>
              <th class="py-2 pr-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="mode in rows" :key="mode.id" class="border-b border-[#A9B4B9]/15">
              <td class="py-2 pr-3">
                <div class="font-semibold text-[#2A3439]">{{ mode.name }}</div>
                <div class="text-xs text-[#566166]">{{ mode.code }}</div>
              </td>
              <td class="py-2 pr-3">
                <span class="chip" :class="mode.is_system ? 'chip-sys' : 'chip-custom'">
                  {{ mode.is_system ? 'system' : 'custom' }}
                </span>
              </td>
              <td class="py-2 pr-3">
                <span class="chip" :class="statusClass(mode.status)">{{ mode.status }}</span>
              </td>
              <td class="py-2 pr-3">{{ mode.parent_mode || '—' }}</td>
              <td class="py-2 pr-3">v{{ mode.config_version || 1 }}</td>
              <td class="py-2 pr-3 text-xs">{{ formatTs(mode.updated_at) }}</td>
              <td class="py-2 pr-3">
                <div class="flex flex-wrap gap-1">
                  <button class="btn-inline" @click="openBuilder(mode.id)">Редактировать</button>
                  <button class="btn-inline" @click="cloneMode(mode)">Клонировать</button>
                  <button class="btn-inline" @click="openTest(mode.id)">Тест</button>
                  <button class="btn-inline" @click="openRuns(mode.id)">Runs</button>
                  <button class="btn-inline" @click="exportMode(mode.id)">Экспорт</button>
                  <button v-if="!mode.is_system" class="btn-inline" @click="toggleDisable(mode)">
                    {{ mode.is_disabled ? 'Включить' : 'Отключить' }}
                  </button>
                  <button v-if="!mode.is_system" class="btn-inline" @click="archiveMode(mode)">
                    {{ mode.is_archived ? 'Восстановить' : 'Архивировать' }}
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="rows.length === 0 && !loading">
              <td colspan="7" class="py-7 text-center text-[#A9B4B9]">
                Нет режимов. Создайте первый кастомный режим из quality.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="importOpen" class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6 mt-6">
      <h3 class="font-semibold text-[#2A3439] mb-2">Импорт режима (JSON)</h3>
      <textarea v-model="importText" class="field w-full min-h-[180px] font-mono text-xs" />
      <div class="mt-3 flex gap-2">
        <button class="btn-primary-sm" @click="submitImport">Импортировать</button>
        <button class="btn-secondary" @click="importOpen = false">Закрыть</button>
      </div>
    </div>
  </AdminShell>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'

const router = useRouter()
const loading = ref(false)
const error = ref('')
const successMsg = ref('')
const rows = ref([])
const importOpen = ref(false)
const importText = ref('')
const filters = reactive({ status: '', search: '' })

function statusClass(st) {
  if (st === 'active') return 'chip-ok'
  if (st === 'draft') return 'chip-draft'
  if (st === 'archived') return 'chip-arch'
  if (st === 'disabled') return 'chip-dis'
  return 'chip-draft'
}

function formatTs(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return String(ts)
  }
}

async function loadModes() {
  loading.value = true
  error.value = ''
  try {
    const res = await API.adminGetModes(filters)
    rows.value = res.items || []
  } catch (e) {
    error.value = e.message || 'Ошибка загрузки режимов'
  } finally {
    loading.value = false
  }
}

function createMode() {
  router.push('/admin/ai/modes/new')
}

function openBuilder(id) {
  router.push(`/admin/ai/modes/${id}`)
}

function openTest(id) {
  router.push(`/admin/ai/modes/${id}/test`)
}

function openRuns(id) {
  router.push(`/admin/ai/modes/${id}/runs`)
}

async function cloneMode(mode) {
  const code = prompt('Новый code', `${mode.code}_copy`)
  if (!code) return
  const name = prompt('Новое имя', `${mode.name} (Copy)`) || `${mode.name} (Copy)`
  try {
    await API.adminCloneMode(mode.id, { code, name })
    successMsg.value = 'Режим склонирован'
    await loadModes()
  } catch (e) {
    error.value = e.message || 'Ошибка clone'
  }
}

async function archiveMode(mode) {
  try {
    await API.adminArchiveMode(mode.id, !mode.is_archived)
    successMsg.value = mode.is_archived ? 'Режим восстановлен' : 'Режим архивирован'
    await loadModes()
  } catch (e) {
    error.value = e.message || 'Ошибка архивации'
  }
}

async function toggleDisable(mode) {
  try {
    await API.adminDisableMode(mode.id, !mode.is_disabled)
    successMsg.value = mode.is_disabled ? 'Режим включен' : 'Режим отключен'
    await loadModes()
  } catch (e) {
    error.value = e.message || 'Ошибка переключения disabled'
  }
}

async function exportMode(id) {
  try {
    const data = await API.adminExportMode(id)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mode-${id}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    error.value = e.message || 'Ошибка экспорта'
  }
}

function openImport() {
  importOpen.value = true
  importText.value = ''
}

async function submitImport() {
  try {
    const payload = JSON.parse(importText.value || '{}')
    await API.adminImportMode(payload)
    successMsg.value = 'Режим импортирован'
    importOpen.value = false
    await loadModes()
  } catch (e) {
    error.value = e.message || 'Ошибка импорта'
  }
}

onMounted(loadModes)
</script>

<style scoped>
.field {
  border: 1px solid rgba(169, 180, 185, 0.45);
  border-radius: 0.75rem;
  padding: 0.45rem 0.65rem;
  font-size: 0.85rem;
}
.btn-primary-sm {
  border-radius: 0.75rem;
  background: linear-gradient(180deg, #3755c3 0%, #2848b7 100%);
  color: #f8f7ff;
  padding: 0.4rem 0.75rem;
  font-weight: 700;
}
.btn-secondary {
  border-radius: 0.75rem;
  border: 1px solid rgba(169, 180, 185, 0.45);
  padding: 0.4rem 0.75rem;
  color: #435368;
  font-weight: 600;
}
.btn-inline {
  border-radius: 0.6rem;
  border: 1px solid rgba(169, 180, 185, 0.35);
  padding: 0.2rem 0.45rem;
  font-size: 0.75rem;
  color: #3d4f63;
}
.chip {
  border-radius: 999px;
  padding: 0.15rem 0.5rem;
  font-size: 0.72rem;
  font-weight: 700;
}
.chip-sys { background: #eef2ff; color: #3045a3; }
.chip-custom { background: #edf7f4; color: #1f6a54; }
.chip-ok { background: #e8f7ee; color: #2c7a4b; }
.chip-draft { background: #fff4dd; color: #7d5c00; }
.chip-arch { background: #eceff3; color: #596575; }
.chip-dis { background: #fde9e7; color: #9f403d; }
</style>
