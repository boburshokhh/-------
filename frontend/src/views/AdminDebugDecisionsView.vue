<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="font-headline text-xl font-bold text-[#2A3439]">Debug Decisions</h2>
        <button class="btn-secondary" :disabled="loading" @click="loadAll">Refresh</button>
      </div>
      <p class="mb-3 text-sm text-[#566166]">
        routing decisions, reason, fallback reason.
      </p>
      <p v-if="error" class="mb-2 text-sm text-[#9F403D]">{{ error }}</p>

      <div class="overflow-auto">
        <table class="w-full min-w-[940px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-3">ts</th>
              <th class="py-2 pr-3">agent/stage</th>
              <th class="py-2 pr-3">selected</th>
              <th class="py-2 pr-3">fallback</th>
              <th class="py-2 pr-3">reason</th>
              <th class="py-2 pr-3">fallback reason</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id" class="border-b border-[#A9B4B9]/15 align-top">
              <td class="py-2 pr-3">{{ formatTs(r.ts) }}</td>
              <td class="py-2 pr-3">
                {{ r.metadata?.agent_role || 'n/a' }} / {{ r.metrics?.stage || 'n/a' }}
              </td>
              <td class="py-2 pr-3">{{ r.metrics?.selected_model || r.metadata?.selected_model || '—' }}</td>
              <td class="py-2 pr-3">{{ r.metrics?.fallback_model || r.metadata?.fallback_model || '—' }}</td>
              <td class="py-2 pr-3">{{ r.metrics?.reason || r.metadata?.reason || '—' }}</td>
              <td class="py-2 pr-3">{{ deriveFallbackReason(r) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </AdminShell>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'

const loading = ref(false)
const error = ref('')
const rows = ref([])

function parseJsonLine(line) {
  try { return JSON.parse(line) } catch { return null }
}

function formatTs(ts) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString() } catch { return String(ts) }
}

function deriveFallbackReason(r) {
  const reason = String(r?.metrics?.reason || r?.metadata?.reason || '')
  if (!reason) return '—'
  if (reason.includes('fallback')) return reason
  return 'none'
}

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const [logsRes, auditRes] = await Promise.all([
      API.getLogs(400),
      API.adminGetAudit({ entity_type: 'ai_routing_rule', limit: 100 }),
    ])
    const lines = Array.isArray(logsRes?.lines) ? logsRes.lines : []
    const parsed = lines.map((l) => parseJsonLine(l)).filter(Boolean)
    const decisions = parsed.filter((x) => x.event === 'model_router_decision')
    const auditRows = (auditRes.rows || []).map((a) => ({
      id: `audit-${a.id}`,
      ts: a.created_at,
      metrics: { reason: a.action, stage: a.entity_type },
      metadata: { agent_role: null, selected_model: null, fallback_model: null },
    }))
    rows.value = [...decisions.slice(0, 200), ...auditRows].slice(0, 250)
  } catch (e) {
    error.value = e?.message || 'Failed to load debug decisions'
  } finally {
    loading.value = false
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
