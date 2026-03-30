<template>
  <AdminShell>
    <div class="grid gap-4 md:grid-cols-4">
      <div class="card">
        <div class="k">Total RPM hits</div>
        <div class="v">{{ totals.rpm }}</div>
      </div>
      <div class="card">
        <div class="k">Total TPM est.</div>
        <div class="v">{{ totals.tpm }}</div>
      </div>
      <div class="card">
        <div class="k">Total RPD req.</div>
        <div class="v">{{ totals.rpd }}</div>
      </div>
      <div class="card">
        <div class="k">Model errors</div>
        <div class="v">{{ totals.errors }}</div>
      </div>
    </div>

    <div class="mt-5 rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="font-headline text-xl font-bold text-[#2A3439]">Usage</h2>
        <button class="btn-secondary" @click="loadUsage">Refresh</button>
      </div>
      <p class="mb-3 text-sm text-[#566166]">
        Premium usage: <strong>{{ premiumUsage }}</strong>
      </p>
      <p v-if="error" class="mb-3 text-sm text-[#9F403D]">{{ error }}</p>
      <div class="overflow-auto">
        <table class="w-full min-w-[860px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-3">model</th>
              <th class="py-2 pr-3">phase</th>
              <th class="py-2 pr-3">rpm</th>
              <th class="py-2 pr-3">tpm</th>
              <th class="py-2 pr-3">rpd(requests)</th>
              <th class="py-2 pr-3">errors</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id" class="border-b border-[#A9B4B9]/15">
              <td class="py-2 pr-3">{{ r.api_model_id || r.ui_name || '—' }}</td>
              <td class="py-2 pr-3">{{ r.phase }}</td>
              <td class="py-2 pr-3">{{ r.rpm_hits || 0 }}</td>
              <td class="py-2 pr-3">{{ r.tpm_estimated || 0 }}</td>
              <td class="py-2 pr-3">{{ r.requests || 0 }}</td>
              <td class="py-2 pr-3">{{ r.failed_requests || 0 }}</td>
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

const rows = ref([])
const error = ref('')

const totals = computed(() => {
  let rpm = 0
  let tpm = 0
  let rpd = 0
  let errors = 0
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
  const fail = premium.reduce((s, r) => s + Number(r.failed_requests || 0), 0)
  return `${req} req / ${fail} fail`
})

async function loadUsage() {
  error.value = ''
  try {
    const payload = await API.adminGetUsage({ limit: 1000 })
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
.btn-secondary {
  border-radius: 0.75rem;
  border: 1px solid rgba(169, 180, 185, 0.45);
  padding: 0.5rem 0.9rem;
  color: #435368;
  font-weight: 600;
}
</style>
