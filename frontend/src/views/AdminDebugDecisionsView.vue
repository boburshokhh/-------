<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="font-headline text-xl font-bold text-[#2A3439]">Routing Decisions</h2>
        <button class="btn-secondary" :disabled="loading" @click="loadAll">Refresh</button>
      </div>

      <!-- Filters -->
      <div class="mb-4 flex flex-wrap gap-2">
        <select v-model="filter.stage_key" class="field" @change="loadAll">
          <option value="">All stages</option>
          <option v-for="s in stages" :key="s.stage_key" :value="s.stage_key">
            {{ s.ui_label }}
          </option>
        </select>
        <input v-model.trim="filter.run_id" class="field w-24" placeholder="Run ID" @change="loadAll" />
        <input v-model.trim="filter.document_id" class="field w-24" placeholder="Doc ID" @change="loadAll" />
        <input v-model.trim="filter.model_id" class="field w-36" placeholder="Model ID" @change="loadAll" />
      </div>

      <p v-if="error" class="mb-2 text-sm text-[#9F403D]">{{ error }}</p>

      <div class="overflow-auto">
        <table class="w-full min-w-[1200px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-2">id</th>
              <th class="py-2 pr-2">time</th>
              <th class="py-2 pr-2">stage</th>
              <th class="py-2 pr-2">agent</th>
              <th class="py-2 pr-2">selected</th>
              <th class="py-2 pr-2">fallback chain</th>
              <th class="py-2 pr-2">reason</th>
              <th class="py-2 pr-2">source</th>
              <th class="py-2 pr-2">tier</th>
              <th class="py-2 pr-2">flags</th>
              <th class="py-2 pr-2">ms</th>
              <th class="py-2 pr-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="d in decisions"
              :key="d.id"
              class="border-b border-[#A9B4B9]/15 align-top cursor-pointer hover:bg-[#F0F2F5]"
              @click="toggleExpand(d.id)"
            >
              <td class="py-2 pr-2">{{ d.id }}</td>
              <td class="py-2 pr-2 text-xs">{{ formatTs(d.created_at) }}</td>
              <td class="py-2 pr-2 font-semibold">{{ d.stage_key }}</td>
              <td class="py-2 pr-2 text-xs">{{ d.agent_role || '—' }}</td>
              <td class="py-2 pr-2">{{ d.selected_api_model_id || '—' }}</td>
              <td class="py-2 pr-2 text-xs">
                {{ Array.isArray(d.fallback_chain) ? d.fallback_chain.join(' > ') : '—' }}
              </td>
              <td class="py-2 pr-2 text-xs">{{ d.decision_reason }}</td>
              <td class="py-2 pr-2 text-xs">{{ d.decision_source }}</td>
              <td class="py-2 pr-2">
                <span
                  class="inline-block rounded-md px-1.5 py-0.5 text-xs font-bold"
                  :class="tierClass(d.cost_tier)"
                >{{ d.cost_tier }}</span>
              </td>
              <td class="py-2 pr-2 text-xs">
                <span v-if="d.premium_blocked" class="text-[#9F403D]">prem-blocked </span>
                <span v-if="d.preview_blocked" class="text-orange-600">prev-blocked </span>
                <span v-if="d.was_fallback" class="text-amber-600">fallback </span>
                <span v-if="d.is_preview" class="text-purple-600">preview </span>
              </td>
              <td class="py-2 pr-2 text-xs">{{ d.latency_ms ?? '—' }}</td>
              <td class="py-2 pr-2 text-xs">
                <button class="text-blue-600 font-semibold underline hover:bg-blue-50 px-2 py-1 rounded" @click.stop="openExplain(d.id)">Explain</button>
              </td>
            </tr>

            <!-- Expanded detail -->
            <tr v-for="d in decisions" :key="'detail-' + d.id" v-show="expanded === d.id">
              <td colspan="11" class="bg-[#F7F8FA] p-3 text-xs">
                <div class="grid gap-2 md:grid-cols-3">
                  <div>
                    <strong>Quota snapshot:</strong>
                    <pre class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">{{ fmt(d.quota_snapshot) }}</pre>
                  </div>
                  <div>
                    <strong>Rejected candidates:</strong>
                    <pre class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">{{ fmt(d.candidate_snapshot) }}</pre>
                  </div>
                  <div>
                    <strong>Policy snapshot:</strong>
                    <pre class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">{{ fmt(d.policy_snapshot) }}</pre>
                  </div>
                </div>
                <div v-if="d.manual_override_id" class="mt-2">
                  <strong>Manual override ID:</strong> {{ d.manual_override_id }}
                </div>
                <div v-if="d.fallback_reason" class="mt-1">
                  <strong>Fallback reason:</strong> {{ d.fallback_reason }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="decisions.length === 0 && !loading" class="mt-4 text-center text-sm text-[#A9B4B9]">
        No routing decisions found.
      </div>
    </div>
    
    <ExplainDecisionPanel 
      :is-open="explainOpen" 
      :decision-id="explainId" 
      @close="explainOpen = false" 
    />
  </AdminShell>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'
import ExplainDecisionPanel from '@/components/admin/ExplainDecisionPanel.vue'

const loading = ref(false)
const error = ref('')
const decisions = ref([])
const stages = ref([])
const expanded = ref(null)

const explainOpen = ref(false)
const explainId = ref(null)

const filter = reactive({
  stage_key: '',
  run_id: '',
  document_id: '',
  model_id: '',
})

function formatTs(ts) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString() } catch { return String(ts) }
}

function fmt(obj) {
  if (!obj) return '—'
  try { return JSON.stringify(obj, null, 2) } catch { return String(obj) }
}

function tierClass(tier) {
  if (tier === 'premium') return 'bg-purple-100 text-purple-800'
  if (tier === 'economy') return 'bg-green-100 text-green-800'
  return 'bg-blue-100 text-blue-800'
}

function toggleExpand(id) {
  expanded.value = expanded.value === id ? null : id
}

function openExplain(id) {
  explainId.value = id
  explainOpen.value = true
}

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const [stageRes, decRes] = await Promise.all([
      API.adminGetStages(),
      API.adminGetRoutingDecisions({
        stage_key: filter.stage_key || undefined,
        run_id: filter.run_id || undefined,
        document_id: filter.document_id || undefined,
        model_id: filter.model_id || undefined,
        limit: 200,
      }),
    ])
    stages.value = stageRes.stages || []
    decisions.value = decRes.rows || []
  } catch (e) {
    error.value = e?.message || 'Failed to load debug decisions'
  } finally {
    loading.value = false
  }
}

onMounted(loadAll)
</script>

<style scoped>
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
