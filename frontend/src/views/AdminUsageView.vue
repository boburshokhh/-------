<template>
  <AdminShell>
    <!-- Summary cards -->
    <div class="grid gap-4 md:grid-cols-5">
      <div class="card">
        <div class="k">Total RPM</div>
        <div class="v">{{ totals.rpm }}</div>
      </div>
      <div class="card">
        <div class="k">Total TPM</div>
        <div class="v">{{ totals.tpm }}</div>
      </div>
      <div class="card">
        <div class="k">Total Requests</div>
        <div class="v">{{ totals.rpd }}</div>
      </div>
      <div class="card">
        <div class="k">Errors</div>
        <div class="v text-[#9F403D]">{{ totals.errors }}</div>
      </div>
      <div class="card">
        <div class="k">Premium Burn</div>
        <div class="v text-purple-700">{{ premiumUsage }}</div>
      </div>
    </div>

    <!-- Filters + Table -->
    <div class="mt-5 rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="font-headline text-xl font-bold text-[#2A3439]">Usage Detail</h2>
        <button class="btn-secondary" @click="loadUsage">Refresh</button>
      </div>

      <div class="mb-3 flex flex-wrap gap-2">
        <select v-model="filter.phase" class="field" @change="loadUsage">
          <option value="">All phases</option>
          <option v-for="p in phases" :key="p" :value="p">{{ p }}</option>
        </select>
        <input v-model.trim="filter.model_id" class="field w-40" placeholder="Model ID" @change="loadUsage" />
        <input v-model="filter.from" type="date" class="field" @change="loadUsage" />
        <input v-model="filter.to" type="date" class="field" @change="loadUsage" />
      </div>

      <p v-if="error" class="mb-3 text-sm text-[#9F403D]">{{ error }}</p>

      <div class="overflow-auto">
        <table class="w-full min-w-[900px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-3">model</th>
              <th class="py-2 pr-3">phase</th>
              <th class="py-2 pr-3">date</th>
              <th class="py-2 pr-3">rpm</th>
              <th class="py-2 pr-3">tpm</th>
              <th class="py-2 pr-3">requests</th>
              <th class="py-2 pr-3">errors</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id" class="border-b border-[#A9B4B9]/15">
              <td class="py-2 pr-3">{{ r.api_model_id || r.ui_name || '—' }}</td>
              <td class="py-2 pr-3">{{ r.phase }}</td>
              <td class="py-2 pr-3 text-xs">{{ r.usage_date }}</td>
              <td class="py-2 pr-3">{{ r.rpm_hits || 0 }}</td>
              <td class="py-2 pr-3">{{ r.tpm_estimated || 0 }}</td>
              <td class="py-2 pr-3">{{ r.requests || 0 }}</td>
              <td class="py-2 pr-3" :class="Number(r.failed_requests) > 0 ? 'text-[#9F403D] font-bold' : ''">
                {{ r.failed_requests || 0 }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </AdminShell>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'

const rows = ref([])
const error = ref('')
const phases = [
  'embedding', 'cheap_generation', 'standard_generation', 'premium_reasoning',
  'default',
]

const filter = reactive({
  phase: '',
  model_id: '',
  from: '',
  to: '',
})

const totals = computed(() => {
  let rpm = 0, tpm = 0, rpd = 0, errors = 0
  for (const r of rows.value || []) {
    rpm += Number(r.rpm_hits || 0)
    tpm += Number(r.tpm_estimated || 0)
    rpd += Number(r.requests || 0)
    errors += Number(r.failed_requests || 0)
  }
  return { rpm, tpm, rpd, errors }
})

const premiumUsage = computed(() => {
  const premium = (rows.value || []).filter((r) => String(r.api_model_id || '').includes('pro'))
  const req = premium.reduce((s, r) => s + Number(r.requests || 0), 0)
  const total = totals.value.rpd || 1
  const pct = total > 0 ? ((req / total) * 100).toFixed(1) : '0'
  return `${req} req (${pct}%)`
})

async function loadUsage() {
  error.value = ''
  try {
    const params = { limit: 1000 }
    if (filter.phase) params.phase = filter.phase
    if (filter.model_id) params.model_id = filter.model_id
    if (filter.from) params.from = filter.from
    if (filter.to) params.to = filter.to
    const payload = await API.adminGetUsage(params)
    rows.value = payload.rows || []
  } catch (e) {
    error.value = e?.message || 'Failed to load usage'
  }
}

onMounted(loadUsage)
</script>

<style scoped>
.card {
  border: 1px solid rgba(169, 180, 185, 0.25);
  background: white;
  border-radius: 1rem;
  padding: 0.9rem;
}
.k {
  color: #566166;
  font-size: 0.8rem;
  margin-bottom: 0.25rem;
}
.v {
  color: #2a3439;
  font-family: 'Manrope', sans-serif;
  font-weight: 800;
  font-size: 1.2rem;
}
.field {
  border: 1px solid rgba(169, 180, 185, 0.45);
  border-radius: 0.75rem;
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
}
.btn-secondary {
  border-radius: 0.75rem;
  border: 1px solid rgba(169, 180, 185, 0.45);
  padding: 0.5rem 0.9rem;
  color: #435368;
  font-weight: 600;
}
</style>
