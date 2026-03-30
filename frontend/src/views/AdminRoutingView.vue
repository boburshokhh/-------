<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="font-headline text-xl font-bold text-[#2A3439]">Stage Routing</h2>
        <button class="btn-secondary" @click="loadAll">Refresh</button>
      </div>
      <p v-if="error" class="mb-3 text-sm text-[#9F403D]">{{ error }}</p>
      <p v-if="successMsg" class="mb-3 text-sm text-green-700">{{ successMsg }}</p>

      <div class="overflow-auto">
        <table class="w-full min-w-[1100px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-3">Stage</th>
              <th class="py-2 pr-3">Primary Model</th>
              <th class="py-2 pr-3">Fallback</th>
              <th class="py-2 pr-3">Mode</th>
              <th class="py-2 pr-3">Premium</th>
              <th class="py-2 pr-3">Preview</th>
              <th class="py-2 pr-3">Override</th>
              <th class="py-2 pr-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="stage in stages"
              :key="stage.stage_key"
              class="border-b border-[#A9B4B9]/15 align-top"
            >
              <td class="py-2 pr-3">
                <span class="font-semibold">{{ stage.ui_label }}</span>
                <br />
                <span class="text-xs text-[#566166]">{{ stage.stage_key }}</span>
              </td>
              <td class="py-2 pr-3">
                <select
                  v-model="stageEdits[stage.stage_key].primary"
                  class="field w-full min-w-[180px]"
                >
                  <option value="">— auto —</option>
                  <option v-for="m in llmModels" :key="m.api_model_id" :value="m.api_model_id">
                    {{ m.api_model_id }}
                  </option>
                </select>
              </td>
              <td class="py-2 pr-3">
                <select
                  v-model="stageEdits[stage.stage_key].fallback"
                  class="field w-full min-w-[180px]"
                >
                  <option value="">— auto —</option>
                  <option v-for="m in llmModels" :key="m.api_model_id" :value="m.api_model_id">
                    {{ m.api_model_id }}
                  </option>
                </select>
              </td>
              <td class="py-2 pr-3">{{ routingMode || 'auto' }}</td>
              <td class="py-2 pr-3">
                <input
                  type="checkbox"
                  v-model="stageEdits[stage.stage_key].allowPremium"
                  :disabled="!stage.premium_eligible"
                />
              </td>
              <td class="py-2 pr-3">
                <input
                  type="checkbox"
                  v-model="stageEdits[stage.stage_key].allowPreview"
                />
              </td>
              <td class="py-2 pr-3">
                <div v-if="overrideByStage[stage.stage_key]">
                  {{ overrideByStage[stage.stage_key].api_model_id || 'n/a' }}
                  <span class="ml-1 text-xs text-[#566166]">(id {{ overrideByStage[stage.stage_key].id }})</span>
                </div>
                <div v-else class="text-[#A9B4B9]">—</div>
              </td>
              <td class="py-2 pr-3">
                <button
                  class="btn-primary-sm"
                  :disabled="saving === stage.stage_key"
                  @click="saveStageRule(stage)"
                >
                  {{ saving === stage.stage_key ? '...' : 'Save' }}
                </button>
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

const error = ref('')
const successMsg = ref('')
const routingMode = ref('auto')
const stages = ref([])
const rules = ref([])
const overrides = ref([])
const models = ref([])
const saving = ref(null)

const stageEdits = reactive({})

const llmModels = computed(() =>
  (models.value || []).filter(
    (m) => m.is_enabled && m.model_role !== 'embedding' && m.api_model_id,
  ),
)

const overrideByStage = computed(() => {
  const out = {}
  for (const o of overrides.value || []) {
    if (o.stage_key) out[o.stage_key] = o
    else if (o.scope === 'agent' && o.target) out[o.target] = o
  }
  return out
})

function initEdits() {
  for (const s of stages.value) {
    const existing = stageEdits[s.stage_key]
    if (existing) continue
    const rule = rules.value.find((r) => r.stage_key === s.stage_key)
    stageEdits[s.stage_key] = {
      primary: rule?.actions?.primary_api_model_id || '',
      fallback:
        Array.isArray(rule?.actions?.fallback_api_model_ids)
          ? rule.actions.fallback_api_model_ids[0] || ''
          : '',
      allowPremium: rule?.allow_premium ?? (rule?.actions?.allow_premium ?? false),
      allowPreview: rule?.allow_preview ?? false,
      ruleId: rule?.id || null,
    }
  }
}

async function loadAll() {
  error.value = ''
  successMsg.value = ''
  try {
    const [stageRes, modeRes, ovRes, modelsRes] = await Promise.all([
      API.adminGetStages(),
      API.adminGetRoutingMode(),
      API.adminGetManualOverrides({ include_disabled: false, active_only: true, limit: 500 }),
      API.adminGetModels(),
    ])
    stages.value = stageRes.stages || []
    routingMode.value = modeRes.routing_mode || 'auto'
    overrides.value = ovRes.rows || []
    models.value = modelsRes.models || []

    const ruleResults = await Promise.all(
      stages.value.map((s) => API.adminGetRoutingRulesByStage(s.stage_key, { enabledOnly: false })),
    )
    rules.value = ruleResults.flatMap((r) => r.rules || [])

    initEdits()
  } catch (e) {
    error.value = e?.message || 'Failed to load routing'
  }
}

async function saveStageRule(stage) {
  const edits = stageEdits[stage.stage_key]
  if (!edits) return
  saving.value = stage.stage_key
  error.value = ''
  successMsg.value = ''
  try {
    const actions = {}
    if (edits.primary) actions.primary_api_model_id = edits.primary
    if (edits.fallback) actions.fallback_api_model_ids = [edits.fallback]
    actions.allow_premium = !!edits.allowPremium

    if (edits.ruleId) {
      await API.adminUpdateRoutingRule(edits.ruleId, {
        actions,
        allow_premium: edits.allowPremium,
        allow_preview: edits.allowPreview,
      })
    } else {
      await API.adminCreateRoutingRule({
        name: `stage_${stage.stage_key}_default`,
        phase: stage.stage_key,
        stage_key: stage.stage_key,
        priority: 0,
        is_enabled: true,
        conditions: {},
        actions,
        allow_premium: edits.allowPremium,
        allow_preview: edits.allowPreview,
      })
    }
    successMsg.value = `Saved ${stage.ui_label}`
    await loadAll()
  } catch (e) {
    error.value = e?.message || 'Save failed'
  } finally {
    saving.value = null
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
.btn-primary-sm {
  border-radius: 0.75rem;
  background: linear-gradient(180deg, #3755c3 0%, #2848b7 100%);
  color: #f8f7ff;
  padding: 0.35rem 0.7rem;
  font-weight: 700;
  font-size: 0.8rem;
}
</style>
