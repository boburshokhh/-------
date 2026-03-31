<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <h2 class="font-headline text-xl font-bold text-[#2A3439]">Тест режима</h2>
      <p class="text-sm text-[#566166] mt-1 mb-4">
        Dry-run покажет effective routing plan до запуска.
      </p>

      <div class="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
        <div>
          <label class="field-label">Mode ID</label>
          <input class="field w-full" :value="modeId" disabled />
        </div>
        <div>
          <label class="field-label">Document ID</label>
          <input v-model.number="documentId" class="field w-full" type="number" />
        </div>
        <div>
          <label class="field-label">Target count</label>
          <input v-model.number="targetCount" class="field w-full" type="number" />
        </div>
      </div>

      <div class="flex gap-2 mb-4">
        <button class="btn-secondary" @click="runDry">Dry-run preview</button>
        <button class="btn-primary-sm" @click="runTest">Запустить test run</button>
      </div>

      <p v-if="error" class="mb-3 text-sm text-[#9F403D]">{{ error }}</p>
      <p v-if="successMsg" class="mb-3 text-sm text-green-700">{{ successMsg }}</p>

      <div v-if="planRows.length" class="overflow-auto">
        <table class="w-full min-w-[1000px] text-xs">
          <thead>
            <tr class="border-b border-[#A9B4B9]/25 text-left text-[#566166]">
              <th class="py-2 pr-2">Stage</th>
              <th class="py-2 pr-2">Configured</th>
              <th class="py-2 pr-2">Effective</th>
              <th class="py-2 pr-2">Fallback</th>
              <th class="py-2 pr-2">Blocked</th>
              <th class="py-2 pr-2">Rejected</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in planRows" :key="r.stage_key" class="border-b border-[#A9B4B9]/10">
              <td class="py-2 pr-2">{{ r.stage_key }}</td>
              <td class="py-2 pr-2">{{ r.configured_primary || '—' }}</td>
              <td class="py-2 pr-2">{{ r.effective_primary || '—' }}</td>
              <td class="py-2 pr-2">{{ r.was_fallback ? 'yes' : 'no' }}</td>
              <td class="py-2 pr-2">{{ (r.blocked_by || []).join(', ') || '—' }}</td>
              <td class="py-2 pr-2">{{ (r.rejected_candidates || []).length }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </AdminShell>
</template>

<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'

const route = useRoute()
const router = useRouter()
const modeId = route.params.id
const documentId = ref(null)
const targetCount = ref(10)
const planRows = ref([])
const error = ref('')
const successMsg = ref('')

async function runDry() {
  error.value = ''
  successMsg.value = ''
  try {
    const res = await API.adminDryRunMode(modeId, { document_id: documentId.value || undefined })
    planRows.value = res.routing_plan || []
    successMsg.value = 'Dry-run готов'
  } catch (e) {
    error.value = e.message || 'Ошибка dry-run'
  }
}

async function runTest() {
  error.value = ''
  successMsg.value = ''
  try {
    if (!documentId.value) {
      error.value = 'Укажите document_id'
      return
    }
    const res = await API.adminTestRunMode(modeId, {
      document_id: documentId.value,
      target_count: targetCount.value || 10,
      language: 'ru',
    })
    planRows.value = res.routing_plan_snapshot || []
    successMsg.value = `Test run создан: #${res.run_id}`
    setTimeout(() => router.push(`/admin/ai/runs/${res.run_id}`), 700)
  } catch (e) {
    error.value = e.message || 'Ошибка test run'
  }
}
</script>

<style scoped>
.field-label {
  display: block;
  font-size: 0.72rem;
  color: #566166;
  text-transform: uppercase;
  margin-bottom: 0.3rem;
  font-weight: 700;
}
.field {
  border: 1px solid rgba(169, 180, 185, 0.45);
  border-radius: 0.75rem;
  padding: 0.4rem 0.6rem;
  font-size: 0.82rem;
}
.btn-secondary {
  border-radius: 0.75rem;
  border: 1px solid rgba(169, 180, 185, 0.45);
  padding: 0.45rem 0.75rem;
  color: #435368;
  font-weight: 600;
}
.btn-primary-sm {
  border-radius: 0.75rem;
  background: linear-gradient(180deg, #3755c3 0%, #2848b7 100%);
  color: #f8f7ff;
  padding: 0.45rem 0.75rem;
  font-weight: 700;
}
</style>
