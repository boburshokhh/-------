<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-4 flex items-center justify-between">
        <div>
          <h2 class="font-headline text-xl font-bold text-[#2A3439]">Runs режима</h2>
          <p class="text-sm text-[#566166] mt-1">Запуски, связанные с текущим mode profile.</p>
        </div>
        <button class="btn-secondary" @click="loadRuns">Refresh</button>
      </div>

      <p v-if="error" class="mb-3 text-sm text-[#9F403D]">{{ error }}</p>

      <div class="overflow-auto">
        <table class="w-full min-w-[980px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-3">Run</th>
              <th class="py-2 pr-3">Document</th>
              <th class="py-2 pr-3">Status</th>
              <th class="py-2 pr-3">Mode version</th>
              <th class="py-2 pr-3">Duration</th>
              <th class="py-2 pr-3">Started</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in rows"
              :key="r.id"
              class="border-b border-[#A9B4B9]/15 cursor-pointer hover:bg-[#F7F8FA]"
              @click="$router.push(`/admin/ai/runs/${r.id}`)"
            >
              <td class="py-2 pr-3 font-semibold text-[#2A3439]">#{{ r.id }}</td>
              <td class="py-2 pr-3">{{ r.document_id || '—' }}</td>
              <td class="py-2 pr-3">{{ r.status }}</td>
              <td class="py-2 pr-3">{{ r.mode_profile_version || '—' }}</td>
              <td class="py-2 pr-3">{{ formatDuration(r.duration_ms) }}</td>
              <td class="py-2 pr-3 text-xs">{{ formatTs(r.started_at) }}</td>
            </tr>
            <tr v-if="rows.length === 0">
              <td colspan="6" class="py-6 text-center text-[#A9B4B9]">
                Для режима пока нет запусков.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </AdminShell>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'

const route = useRoute()
const modeId = route.params.id
const rows = ref([])
const error = ref('')

function formatDuration(ms) {
  if (!ms) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}
function formatTs(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return String(ts)
  }
}

async function loadRuns() {
  error.value = ''
  try {
    const res = await API.adminGetModeRuns(modeId, { limit: 100 })
    rows.value = res.rows || []
  } catch (e) {
    error.value = e.message || 'Ошибка загрузки runs режима'
  }
}

onMounted(loadRuns)
</script>

<style scoped>
.btn-secondary {
  border-radius: 0.75rem;
  border: 1px solid rgba(169, 180, 185, 0.45);
  padding: 0.45rem 0.75rem;
  color: #435368;
  font-weight: 600;
}
</style>
