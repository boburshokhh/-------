<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6 mb-6">
      <div class="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 class="font-headline text-xl font-bold text-[#2A3439]">Generation Runs</h2>
          <p class="text-sm text-[#566166] mt-1">Обозреватель всех запусков генерации тестов и пайплайнов.</p>
        </div>
        <button class="btn-secondary flex items-center gap-2" @click="loadRuns" :disabled="loading">
          <svg v-if="loading" class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg>
          Refresh
        </button>
      </div>

      <!-- Filters -->
      <div class="mb-6 flex flex-wrap items-end gap-3 px-1">
        <div>
          <label class="block text-xs font-bold text-[#566166] uppercase mb-1">Status</label>
          <select v-model="filter.status" class="field w-32" @change="loadRuns">
            <option value="">All</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="degraded">Degraded</option>
            <option value="failed">Failed</option>
          </select>
        </div>
        <div>
           <label class="block text-xs font-bold text-[#566166] uppercase mb-1">Doc ID</label>
           <input v-model.trim="filter.document_id" type="number" class="field w-24" placeholder="ID..." @change="loadRuns" />
        </div>
        <div class="ml-auto flex items-center gap-2 text-sm text-[#566166]">
          Total: <strong class="text-[#2A3439]">{{ totalRows }}</strong> runs
        </div>
      </div>

      <p v-if="error" class="mb-4 text-sm text-[#9F403D]">{{ error }}</p>

      <div class="overflow-x-auto">
        <table class="w-full text-sm text-left align-middle border-collapse">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-[#566166]">
              <th class="py-3 pr-4 font-semibold w-24">Run ID</th>
              <th class="py-3 pr-4 font-semibold w-24">Doc ID</th>
              <th class="py-3 pr-4 font-semibold">Status</th>
              <th class="py-3 pr-4 font-semibold">Targets</th>
              <th class="py-3 pr-4 font-semibold">Duration</th>
              <th class="py-3 pr-4 font-semibold">Started At</th>
              <th class="py-3 pr-4 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="runs.length === 0 && !loading">
               <td colspan="7" class="py-8 text-center text-[#A9B4B9]">No runs found matching filters.</td>
            </tr>
            <tr 
              v-for="run in runs" 
              :key="run.id" 
              class="border-b border-[#A9B4B9]/15 hover:bg-[#F7F8FA] transition-colors group cursor-pointer"
              @click="$router.push(`/admin/ai/runs/${run.id}`)"
            >
              <td class="py-3.5 pr-4 font-mono font-medium text-[#2A3439]">#{{ run.id }}</td>
              <td class="py-3.5 pr-4 text-[#566166]">
                <span v-if="run.document_id">{{ run.document_id }}</span>
                <span v-else class="text-[#A9B4B9] italic">—</span>
              </td>
              <td class="py-3.5 pr-4">
                <div class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider" :class="getStatusClass(run.status)">
                   <span class="w-1.5 h-1.5 rounded-full bg-current"></span>
                   {{ run.status }}
                </div>
                <div v-if="run.summary.fallback_triggered" class="mt-1 text-[10px] text-amber-600 font-bold px-1" title="Fallback was triggered during pipeline">
                  + FALLBACK
                </div>
              </td>
              <td class="py-3.5 pr-4 text-[#2A3439]">
                <span v-if="run.target_count">{{ run.target_count }} q's</span>
                <span v-else class="text-[#A9B4B9]">—</span>
                <span v-if="run.language" class="ml-2 text-xs text-[#566166] opacity-70">({{ run.language.toUpperCase() }})</span>
              </td>
              <td class="py-3.5 pr-4 font-mono text-xs text-[#566166]">
                {{ formatDuration(run.duration_ms) }}
              </td>
              <td class="py-3.5 pr-4 text-xs text-[#566166]">
                {{ formatTs(run.created_at) }}
              </td>
              <td class="py-3.5 pr-4 text-right">
                <button class="text-blue-600 font-semibold opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-end w-full gap-1" @click.stop="$router.push(`/admin/ai/runs/${run.id}`)">
                  Details ➔
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      
      <!-- Simple pagination -->
      <div v-if="totalRows > limit" class="mt-6 flex justify-center gap-2">
         <button class="btn-secondary px-3 py-1" :disabled="offset === 0" @click="changePage(-1)">Prev</button>
         <div class="px-4 py-1 text-sm text-[#566166] flex items-center">
            Page {{ Math.floor(offset / limit) + 1 }}
         </div>
         <button class="btn-secondary px-3 py-1" :disabled="(offset + limit) >= totalRows" @click="changePage(1)">Next</button>
      </div>
    </div>
  </AdminShell>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'

const loading = ref(false)
const error = ref('')
const runs = ref([])
const totalRows = ref(0)
const limit = 50
const offset = ref(0)

const filter = reactive({
  status: '',
  document_id: ''
})

async function loadRuns() {
  loading.value = true
  error.value = ''
  try {
    const res = await API.adminGetRuns({ ...filter, limit, offset: offset.value })
    runs.value = res.runs || []
    totalRows.value = res.total || 0
  } catch (e) {
    error.value = e.message || 'Ошибка загрузки Runs'
  } finally {
    loading.value = false
  }
}

function changePage(dir) {
  const newOffset = offset.value + (dir * limit)
  if (newOffset >= 0 && newOffset < totalRows.value) {
    offset.value = newOffset
    loadRuns()
  }
}

function getStatusClass(st) {
  if (st === 'completed') return 'bg-green-100 text-green-800'
  if (st === 'degraded') return 'bg-yellow-100 text-yellow-800'
  if (st === 'running') return 'bg-blue-100 text-blue-800'
  if (st === 'failed') return 'bg-red-100 text-red-800'
  return 'bg-gray-100 text-gray-800'
}

function formatDuration(ms) {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

function formatTs(ts) {
  if (!ts) return '—'
  try {
    const d = new Date(ts)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute:'2-digit' })
  } catch {
    return String(ts)
  }
}

onMounted(() => {
  loadRuns()
})
</script>

<style scoped>
.field {
  border: 1px solid rgba(169, 180, 185, 0.45);
  border-radius: 0.5rem;
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
  background: white;
  transition: border-color 0.2s;
}
.field:focus {
  outline: none;
  border-color: #3755c3;
}
.btn-secondary {
  border-radius: 0.5rem;
  border: 1px solid rgba(169, 180, 185, 0.45);
  padding: 0.4rem 0.8rem;
  color: #435368;
  font-weight: 600;
  font-size: 0.875rem;
  background: white;
}
.btn-secondary:hover:not(:disabled) {
  background: #f8fafc;
}
.btn-secondary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
