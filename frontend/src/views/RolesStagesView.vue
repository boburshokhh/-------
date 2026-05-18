<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 class="font-headline text-xl font-bold text-[#2A3439]">
            Роли и этапы
          </h2>
          <p class="mt-1 text-sm text-[#566166]">
            Матрица роль → stage: настройки из БД (Configured) и превью эффективной модели (Effective now) при текущих политиках и квотах.
            <RouterLink class="text-[#3755C3] underline" to="/admin/ai/policies">Политики</RouterLink>
            ·
            <RouterLink class="text-[#3755C3] underline" to="/admin/ai/debug">Debug Decisions</RouterLink>
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-xs font-semibold text-[#435368]">Превью режима</label>
          <select
            v-model="previewMode"
            class="field rounded-lg px-3 py-2 text-sm"
            :disabled="loading"
            @change="reloadMatrix"
          >
            <option value="auto">Auto (как в конфиге)</option>
            <option value="economy">Economy</option>
            <option value="balanced">Balanced</option>
            <option value="quality">Quality</option>
            <option value="max_quality">Max Quality</option>
            <option value="manual">Manual</option>
          </select>
          <button
            type="button"
            class="btn-secondary"
            :disabled="loading"
            @click="reloadMatrix"
          >
            Обновить
          </button>
        </div>
      </div>

      <div
        v-if="globalBadges.length"
        class="mb-4 flex flex-wrap gap-2"
      >
        <span
          v-for="b in globalBadges"
          :key="b"
          class="rounded-full border border-[#A9B4B9]/35 bg-[#F8FAFB] px-2 py-0.5 text-xs text-[#435368]"
        >{{ b }}</span>
      </div>

      <p v-if="error" class="mb-3 text-sm text-[#9F403D]">{{ error }}</p>
      <p v-if="successMsg" class="mb-3 text-sm text-green-700">{{ successMsg }}</p>

      <div
        v-if="selectedKeys.length"
        class="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#3755C3]/30 bg-[#F0F4FF] px-4 py-3 text-sm"
      >
        <span>Выбрано: <strong>{{ selectedKeys.length }}</strong></span>
        <label class="flex items-center gap-2">
          <span class="text-[#566166]">Premium</span>
          <input v-model="bulkAllowPremium" type="checkbox" />
        </label>
        <label class="flex items-center gap-2">
          <span class="text-[#566166]">Preview</span>
          <input v-model="bulkAllowPreview" type="checkbox" />
        </label>
        <button
          type="button"
          class="btn-primary-sm"
          :disabled="bulkSaving"
          @click="applyBulk"
        >
          {{ bulkSaving ? '…' : 'Применить к выбранным' }}
        </button>
        <button type="button" class="text-xs text-[#435368] underline" @click="clearSelection">
          Снять выбор
        </button>
      </div>

      <div class="overflow-auto">
        <table class="w-full min-w-[1200px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="w-10 py-2 pr-2">
                <input
                  type="checkbox"
                  :checked="allSelected"
                  @change="toggleSelectAll($event.target.checked)"
                >
              </th>
              <th class="py-2 pr-3">Роль / Stage</th>
              <th class="py-2 pr-3">Configured</th>
              <th class="py-2 pr-3">Effective now</th>
              <th class="py-2 pr-3">Источник / пояснение</th>
              <th class="py-2 pr-3">Последнее решение</th>
              <th class="py-2 pr-3">Действия</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.stage_key"
              class="border-b border-[#A9B4B9]/15 align-top"
            >
              <td class="py-3 pr-2">
                <input
                  v-model="selectedKeys"
                  type="checkbox"
                  :value="row.stage_key"
                >
              </td>
              <td class="py-3 pr-3">
                <div class="font-semibold text-[#2A3439]">
                  {{ labelForStage(row.stage_key) }}
                </div>
                <div class="text-xs text-[#566166]">
                  {{ row.agent_role }}
                </div>
                <div class="font-mono text-[11px] text-[#A9B4B9]">
                  {{ row.stage_key }}
                </div>
              </td>
              <td class="py-3 pr-3">
                <div class="space-y-2 text-xs">
                  <div>
                    <span class="text-[#566166]">Primary:</span>
                    <select
                      v-model="editFor(row).primary"
                      class="field mt-0.5 w-full min-w-[160px]"
                    >
                      <option value="">— auto —</option>
                      <option
                        v-for="m in llmModels"
                        :key="m.api_model_id"
                        :value="m.api_model_id"
                      >
                        {{ m.api_model_id }}
                      </option>
                    </select>
                  </div>
                  <div>
                    <span class="text-[#566166]">Fallback:</span>
                    <select
                      v-model="editFor(row).fallback"
                      class="field mt-0.5 w-full min-w-[160px]"
                    >
                      <option value="">—</option>
                      <option
                        v-for="m in llmModels"
                        :key="'f-'+m.api_model_id"
                        :value="m.api_model_id"
                      >
                        {{ m.api_model_id }}
                      </option>
                    </select>
                  </div>
                  <div class="flex flex-wrap gap-3">
                    <label class="flex items-center gap-1">
                      <input
                        v-model="editFor(row).allowPremium"
                        type="checkbox"
                        :disabled="!row.catalog?.premium_eligible"
                      >
                      Premium
                    </label>
                    <label class="flex items-center gap-1">
                      <input v-model="editFor(row).allowPreview" type="checkbox">
                      Preview
                    </label>
                  </div>
                  <div class="text-[11px] text-[#A9B4B9]">
                    rule #{{ row.configured?.rule_id ?? '—' }}
                  </div>
                </div>
              </td>
              <td class="py-3 pr-3 text-xs">
                <div class="font-mono text-[#2A3439]">
                  {{ row.effective_preview?.effective_api_model_id || '—' }}
                </div>
                <div class="mt-1 text-[#566166]">
                  fallback: {{ (row.effective_preview?.fallback_chain_resolved || []).join(' → ') || '—' }}
                </div>
                <div class="mt-1 flex flex-wrap gap-1">
                  <span v-if="row.effective_preview?.premium_blocked" class="rounded bg-red-50 px-1 text-[#9F403D]">premium off</span>
                  <span v-if="row.effective_preview?.preview_blocked" class="rounded bg-amber-50 px-1 text-amber-900">preview off</span>
                  <span class="rounded bg-[#F0F4F7] px-1">{{ row.effective_preview?.cost_tier || '—' }}</span>
                </div>
              </td>
              <td class="py-3 pr-3 text-xs text-[#566166]">
                <div><strong class="text-[#2A3439]">{{ row.effective_preview?.decision_source }}</strong></div>
                <div class="mt-1 font-mono text-[11px] break-all">
                  {{ row.effective_preview?.reason }}
                </div>
                <ul class="mt-1 list-disc pl-4">
                  <li
                    v-for="(ex, i) in (row.effective_preview?.explain || [])"
                    :key="i"
                  >
                    {{ ex }}
                  </li>
                </ul>
              </td>
              <td class="py-3 pr-3 text-xs">
                <template v-if="row.last_decision">
                  <div>#{{ row.last_decision.id }}</div>
                  <div class="text-[#566166]">
                    {{ formatDt(row.last_decision.created_at) }}
                  </div>
                  <div class="font-mono">
                    {{ row.last_decision.selected_api_model_id }}
                  </div>
                  <div>{{ row.last_decision.decision_source }}</div>
                </template>
                <span v-else class="text-[#A9B4B9]">—</span>
              </td>
              <td class="py-3 pr-3">
                <button
                  type="button"
                  class="btn-primary-sm"
                  :disabled="saving === row.stage_key"
                  @click="saveRow(row)"
                >
                  {{ saving === row.stage_key ? '…' : 'Сохранить' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="mt-4 text-xs text-[#566166]">
        Effective now — превью без записи в лог решений; после смены правил нажмите «Обновить».
        Сохранение меняет <code class="rounded bg-[#F0F4F7] px-1">ai_routing_rules</code> и инвалидирует кэш маршрутизации.
      </p>
    </div>
  </AdminShell>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'
import { labelForStage } from '@/lib/agentStageMap.js'

const loading = ref(false)
const error = ref('')
const successMsg = ref('')
const previewMode = ref('auto')
const matrixPayload = ref(null)
const models = ref([])
const saving = ref(null)
const bulkSaving = ref(false)
const selectedKeys = ref([])
const bulkAllowPremium = ref(false)
const bulkAllowPreview = ref(false)

const edits = reactive({})

const rows = computed(() => matrixPayload.value?.rows || [])

const globalBadges = computed(() => {
  const g = matrixPayload.value?.global_policies
  if (!g) return []
  const out = []
  if (g.stable_only) out.push('stable_only')
  if (g.emergency_downgrade) out.push('emergency_downgrade')
  if (g.premium_guard_enabled) out.push('premium_guard')
  return out
})

const llmModels = computed(() =>
  (models.value || []).filter(
    (m) => m.is_enabled && m.model_role !== 'embedding' && m.api_model_id,
  ),
)

const allSelected = computed(() => {
  const keys = rows.value.map((r) => r.stage_key)
  return keys.length > 0 && keys.every((k) => selectedKeys.value.includes(k))
})

function formatDt(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('ru-RU')
}

function editFor(row) {
  const sk = row.stage_key
  if (!edits[sk]) {
    const c = row.configured || {}
    const fb = Array.isArray(c.fallback_api_model_ids) ? c.fallback_api_model_ids[0] : ''
    edits[sk] = {
      primary: c.primary_api_model_id || '',
      fallback: fb || '',
      allowPremium: !!c.allow_premium,
      allowPreview: !!c.allow_preview,
      ruleId: c.rule_id,
    }
  }
  return edits[sk]
}

function syncEditsFromRows() {
  for (const row of rows.value) {
    const c = row.configured || {}
    const sk = row.stage_key
    const fb = Array.isArray(c.fallback_api_model_ids) ? c.fallback_api_model_ids[0] : ''
    edits[sk] = {
      primary: c.primary_api_model_id || '',
      fallback: fb || '',
      allowPremium: !!c.allow_premium,
      allowPreview: !!c.allow_preview,
      ruleId: c.rule_id,
    }
  }
}

watch(rows, () => syncEditsFromRows(), { immediate: true })

async function reloadMatrix() {
  loading.value = true
  error.value = ''
  successMsg.value = ''
  try {
    const data = await API.adminGetRoutingMatrix({
      previewMode: previewMode.value,
      includeLastDecision: true,
    })
    matrixPayload.value = data
    syncEditsFromRows()
  } catch (e) {
    error.value = e?.message || 'Не удалось загрузить матрицу'
    matrixPayload.value = null
  } finally {
    loading.value = false
  }
}

async function saveRow(row) {
  const e = editFor(row)
  saving.value = row.stage_key
  error.value = ''
  successMsg.value = ''
  try {
    const actions = {}
    if (e.primary) actions.primary_api_model_id = e.primary
    if (e.fallback) actions.fallback_api_model_ids = [e.fallback]
    actions.allow_premium = !!e.allowPremium

    if (e.ruleId) {
      await API.adminUpdateRoutingRule(e.ruleId, {
        actions,
        allow_premium: e.allowPremium,
        allow_preview: e.allowPreview,
        stage_key: row.stage_key,
      })
    } else {
      await API.adminCreateRoutingRule({
        name: `stage_${row.stage_key}_default`,
        phase: row.agent_role || row.stage_key,
        stage_key: row.stage_key,
        priority: 0,
        is_enabled: true,
        conditions: {},
        actions,
        allow_premium: e.allowPremium,
        allow_preview: e.allowPreview,
      })
    }
    successMsg.value = `Сохранено: ${row.stage_key}`
    await reloadMatrix()
  } catch (err) {
    error.value = err?.message || 'Ошибка сохранения'
  } finally {
    saving.value = null
  }
}

function toggleSelectAll(checked) {
  if (checked) {
    selectedKeys.value = rows.value.map((r) => r.stage_key)
  } else {
    selectedKeys.value = []
  }
}

function clearSelection() {
  selectedKeys.value = []
}

async function applyBulk() {
  const items = []
  for (const sk of selectedKeys.value) {
    const row = rows.value.find((r) => r.stage_key === sk)
    if (!row?.configured?.rule_id) continue
    items.push({
      rule_id: row.configured.rule_id,
      patch: {
        allow_premium: bulkAllowPremium.value,
        allow_preview: bulkAllowPreview.value,
      },
    })
  }
  if (!items.length) {
    error.value = 'Нет выбранных строк с сохранённым правилом (rule_id). Сначала сохраните строку по одной.'
    return
  }
  bulkSaving.value = true
  error.value = ''
  successMsg.value = ''
  try {
    const res = await API.adminBulkPatchRoutingRules(items)
    const failed = (res.results || []).filter((x) => !x.ok)
    if (failed.length) {
      error.value = failed.map((f) => `${f.rule_id}: ${f.error}`).join('; ')
    } else {
      successMsg.value = `Обновлено правил: ${items.length}`
    }
    await reloadMatrix()
    selectedKeys.value = []
  } catch (e) {
    error.value = e?.message || 'Bulk patch failed'
  } finally {
    bulkSaving.value = false
  }
}

onMounted(async () => {
  try {
    const snap = await API.adminGetModels()
    models.value = snap.models || []
  } catch {
    models.value = []
  }
  await reloadMatrix()
})
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
