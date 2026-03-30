<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="font-headline text-xl font-bold text-[#2A3439]">Routing</h2>
        <button class="btn-secondary" @click="loadAll">Refresh</button>
      </div>
      <p v-if="error" class="mb-3 text-sm text-[#9F403D]">{{ error }}</p>

      <div class="overflow-auto">
        <table class="w-full min-w-[900px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-3">stage</th>
              <th class="py-2 pr-3">primary model</th>
              <th class="py-2 pr-3">fallback model</th>
              <th class="py-2 pr-3">mode</th>
              <th class="py-2 pr-3">manual override</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="stage in stages" :key="stage" class="border-b border-[#A9B4B9]/15 align-top">
              <td class="py-2 pr-3 font-semibold">{{ stage }}</td>
              <td class="py-2 pr-3">{{ byStage[stage]?.primary || '—' }}</td>
              <td class="py-2 pr-3">{{ byStage[stage]?.fallback || '—' }}</td>
              <td class="py-2 pr-3">{{ routingMode || 'auto' }}</td>
              <td class="py-2 pr-3">
                <div v-if="overrideByStage[stage]">
                  model: {{ overrideByStage[stage].api_model_id || 'n/a' }}
                  <span class="ml-1 text-xs text-[#566166]">(id {{ overrideByStage[stage].id }})</span>
                </div>
                <div v-else>—</div>
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

const stages = [
  'structuring_agent',
  'evidence_agent',
  'blueprint_agent',
  'generator_agent',
  'quality_agent',
  'backfill_agent',
  'evaluation_agent',
]

const error = ref('')
const routingMode = ref('auto')
const rules = ref([])
const overrides = ref([])

const byStage = computed(() => {
  const out = {}
  for (const r of rules.value || []) {
    const phase = r.phase
    const current = out[phase]
    if (current && Number(current.priority || 0) >= Number(r.priority || 0)) continue
    out[phase] = {
      priority: Number(r.priority || 0),
      primary: r?.actions?.primary_api_model_id || '—',
      fallback: Array.isArray(r?.actions?.fallback_api_model_ids) ? (r.actions.fallback_api_model_ids[0] || '—') : '—',
    }
  }
  return out
})

const overrideByStage = computed(() => {
  const out = {}
  for (const o of overrides.value || []) {
    if (o.scope === 'agent' && o.target) out[o.target] = o
  }
  return out
})

async function loadAll() {
  error.value = ''
  try {
    const [modeRes, ovRes, ...rulesRes] = await Promise.all([
      API.adminGetRoutingMode(),
      API.adminGetManualOverrides({ include_disabled: false, active_only: true, limit: 500 }),
      ...stages.map((s) => API.adminGetRoutingRules(s, { enabledOnly: true })),
    ])
    routingMode.value = modeRes.routing_mode || 'auto'
    overrides.value = ovRes.rows || []
    rules.value = rulesRes.flatMap((x) => x.rules || [])
  } catch (e) {
    error.value = e?.message || 'Failed to load routing'
  }
}

onMounted(loadAll)
</script>

<style scoped>
.btn-secondary {
  border-radius: 0.75rem;
  border: 1px solid rgba(169, 180, 185, 0.45);
  padding: 0.5rem 0.9rem;
  color: #435368;
  font-weight: 600;
}
</style>
