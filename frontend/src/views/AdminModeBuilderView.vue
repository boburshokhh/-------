<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 class="font-headline text-xl font-bold text-[#2A3439]">Конструктор режима</h2>
          <p class="text-sm text-[#566166] mt-1">
            Настройка mission / role / stage с primary и fallback chain.
          </p>
        </div>
        <div class="flex gap-2">
          <button class="btn-secondary" @click="validateMode">Проверить</button>
          <button class="btn-primary-sm" @click="saveMode">Сохранить</button>
        </div>
      </div>

      <p v-if="error" class="mb-3 text-sm text-[#9F403D]">{{ error }}</p>
      <p v-if="successMsg" class="mb-3 text-sm text-green-700">{{ successMsg }}</p>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        <div>
          <label class="field-label">Название</label>
          <input v-model.trim="form.name" class="field w-full" />
        </div>
        <div>
          <label class="field-label">Код</label>
          <input v-model.trim="form.code" class="field w-full" />
        </div>
        <div>
          <label class="field-label">Родительский режим</label>
          <input v-model.trim="form.parent_mode" class="field w-full" />
        </div>
        <div class="md:col-span-3">
          <label class="field-label">Описание</label>
          <textarea v-model="form.description" class="field w-full min-h-[80px]" />
        </div>
      </div>

      <div class="mb-6 grid grid-cols-2 md:grid-cols-4 gap-2">
        <label class="check"><input type="checkbox" v-model="form.allow_premium" /> Разрешить premium</label>
        <label class="check"><input type="checkbox" v-model="form.allow_preview" /> Разрешить preview</label>
        <label class="check"><input type="checkbox" v-model="form.stable_only" /> Только стабильные</label>
        <label class="check"><input type="checkbox" v-model="form.emergency_fallback" /> Аварийный fallback</label>
      </div>

      <div class="overflow-auto">
        <table class="w-full min-w-[1300px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-3">Миссия / Этап / Роль</th>
              <th class="py-2 pr-3">Основная модель</th>
              <th class="py-2 pr-3">Цепочка fallback</th>
              <th class="py-2 pr-3">Тариф</th>
              <th class="py-2 pr-3">Premium</th>
              <th class="py-2 pr-3">Preview</th>
              <th class="py-2 pr-3">Стабильность</th>
              <th class="py-2 pr-3">Приоритет</th>
              <th class="py-2 pr-3">Включено</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in assignments" :key="`${row.stage_key}-${row.agent_role}`" class="border-b border-[#A9B4B9]/15">
              <td class="py-2 pr-3">
                <div class="font-semibold">{{ translateMission(row.mission_key) }}</div>
                <div class="text-xs text-[#566166]">{{ translateStage(row.stage_key) }} / {{ translateRole(row.agent_role) }}</div>
              </td>
              <td class="py-2 pr-3">
                <select v-model.number="row.primary_model_id" class="field w-full min-w-[220px]">
                  <option :value="null">— авто —</option>
                  <option v-for="m in llmModels" :key="m.id" :value="m.id">
                    {{ m.api_model_id || `id:${m.id}` }}
                  </option>
                </select>
              </td>
              <td class="py-2 pr-3">
                <input
                  class="field w-full min-w-[260px]"
                  :value="toCsv(row.fallback_model_ids)"
                  @change="onFallbackCsvChange($event, row)"
                  placeholder="id,id,id (например: 2,7,9)"
                />
              </td>
              <td class="py-2 pr-3">
                <select v-model="row.preferred_cost_tier" class="field w-28">
                  <option value="">авто</option>
                  <option value="economy">Эконом</option>
                  <option value="standard">Стандарт</option>
                  <option value="premium">Премиум</option>
                </select>
              </td>
              <td class="py-2 pr-3"><input type="checkbox" v-model="row.allow_premium" /></td>
              <td class="py-2 pr-3"><input type="checkbox" v-model="row.allow_preview" /></td>
              <td class="py-2 pr-3"><input type="checkbox" v-model="row.stable_only" /></td>
              <td class="py-2 pr-3">
                <select v-model="row.override_strength" class="field w-24">
                  <option value="soft">Мягкий</option>
                  <option value="hard">Жёсткий</option>
                </select>
              </td>
              <td class="py-2 pr-3"><input type="checkbox" v-model="row.enabled" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="preview" class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6 mt-6">
      <h3 class="font-semibold text-[#2A3439] mb-2">Предпросмотр: настроено vs эффективно</h3>
      <p class="text-xs text-[#566166] mb-2">Можно публиковать: {{ preview.can_publish ? 'да' : 'нет' }}</p>
      <div class="overflow-auto">
        <table class="w-full min-w-[1100px] text-xs">
          <thead>
            <tr class="border-b border-[#A9B4B9]/25 text-left text-[#566166]">
              <th class="py-2 pr-2">Этап</th>
              <th class="py-2 pr-2">Настроенная основная</th>
              <th class="py-2 pr-2">Эффективная основная</th>
              <th class="py-2 pr-2">Блокировки</th>
              <th class="py-2 pr-2">Fallback</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in preview.rows" :key="`p-${r.stage_key}`" class="border-b border-[#A9B4B9]/10">
              <td class="py-2 pr-2">{{ r.stage_key }}</td>
              <td class="py-2 pr-2">{{ r.configured_primary || '—' }}</td>
              <td class="py-2 pr-2">{{ r.effective_primary || '—' }}</td>
              <td class="py-2 pr-2">{{ (r.blocked_by || []).join(', ') || '—' }}</td>
              <td class="py-2 pr-2">{{ r.was_fallback ? (r.fallback_reason || 'yes') : 'no' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="(preview.warnings || []).length" class="mt-3 text-xs text-[#9F403D]">
        <div v-for="(w, idx) in preview.warnings" :key="idx">- {{ w.stage_key }}: {{ w.message }}</div>
      </div>
    </div>
  </AdminShell>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'

const route = useRoute()
const router = useRouter()
const modeId = computed(() => route.params.id || null)
const isCreate = computed(() => !modeId.value || modeId.value === 'new')

const loading = ref(false)
const error = ref('')
const successMsg = ref('')
const form = ref({
  code: '',
  name: '',
  description: '',
  parent_mode: 'quality',
  allow_premium: false,
  allow_preview: false,
  stable_only: true,
  emergency_fallback: true,
  status: 'draft',
})
const assignments = ref([])
const models = ref([])
const stages = ref([])
const preview = ref(null)

const llmModels = computed(() =>
  (models.value || []).filter((m) => m.model_role !== 'embedding' && m.api_model_id),
)

const MISSION_LABELS = {
  generation: 'Генерация',
  evidence: 'Факты',
}

const STAGE_LABELS = {
  embedding: 'Векторизация',
  cheap_preprocess: 'Быстрая предобработка',
  facts_enrichment: 'Обогащение фактами',
  theme_extraction: 'Извлечение тем',
  blueprint_generation: 'Генерация структуры',
  question_generation: 'Генерация вопросов',
  grounding_validation: 'Проверка обоснованности',
  backfill_generation: 'Догенерация пропусков',
  audit_debug: 'Аудит и отладка',
}

function translateMission(key) {
  return MISSION_LABELS[key] || key || '—'
}

function translateStage(key) {
  return STAGE_LABELS[key] || key || '—'
}

function translateRole(key) {
  // Пока role совпадает со stage_key, но оставляем отдельную функцию
  // на случай разделения семантики в будущем.
  return STAGE_LABELS[key] || key || '—'
}

function toCsv(list) {
  if (!Array.isArray(list)) return ''
  return list.join(',')
}

function onFallbackCsvChange(evt, row) {
  const raw = String(evt?.target?.value || '')
  row.fallback_model_ids = raw
    .split(',')
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
}

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [stagesRes, modelsRes] = await Promise.all([API.adminGetStages(), API.adminGetModels()])
    stages.value = stagesRes.stages || []
    models.value = modelsRes.models || []

    if (isCreate.value) {
      assignments.value = (stages.value || []).map((s) => ({
        mission_key: s.task_type === 'embedding' ? 'evidence' : 'generation',
        stage_key: s.stage_key,
        agent_role: s.stage_key,
        primary_model_id: null,
        fallback_model_ids: [],
        preferred_cost_tier: s.default_cost_tier || '',
        allow_premium: !!s.premium_eligible,
        allow_preview: false,
        stable_only: true,
        override_strength: 'soft',
        enabled: true,
      }))
    } else {
      const res = await API.adminGetMode(modeId.value)
      const m = res.mode
      form.value = {
        code: m.code,
        name: m.name,
        description: m.description || '',
        parent_mode: m.parent_mode || 'quality',
        allow_premium: !!m.allow_premium,
        allow_preview: !!m.allow_preview,
        stable_only: !!m.stable_only,
        emergency_fallback: !!m.emergency_fallback,
        status: m.status || 'draft',
      }
      assignments.value = (m.assignments || []).map((a) => ({
        mission_key: a.mission_key,
        stage_key: a.stage_key,
        agent_role: a.agent_role,
        primary_model_id: a.primary_model_id ?? null,
        fallback_model_ids: Array.isArray(a.fallback_model_ids) ? a.fallback_model_ids : [],
        preferred_cost_tier: a.preferred_cost_tier || '',
        allow_premium: a.allow_premium,
        allow_preview: a.allow_preview,
        stable_only: a.stable_only,
        override_strength: a.override_strength || 'soft',
        enabled: a.enabled !== false,
      }))
    }
  } catch (e) {
    error.value = e.message || 'Ошибка загрузки страницы конструктора'
  } finally {
    loading.value = false
  }
}

function payload() {
  return {
    ...form.value,
    assignments: assignments.value.map((a) => ({
      ...a,
      primary_model_id: a.primary_model_id || null,
      fallback_model_ids: Array.isArray(a.fallback_model_ids) ? a.fallback_model_ids : [],
    })),
  }
}

async function saveMode() {
  error.value = ''
  successMsg.value = ''
  try {
    if (isCreate.value) {
      const res = await API.adminCreateMode(payload())
      successMsg.value = 'Режим создан'
      router.replace(`/admin/ai/modes/${res.mode.id}`)
      return
    }
    await API.adminUpdateMode(modeId.value, payload())
    successMsg.value = 'Изменения сохранены'
  } catch (e) {
    error.value = e.message || 'Ошибка сохранения'
  }
}

async function validateMode() {
  error.value = ''
  try {
    let id = modeId.value
    if (isCreate.value) {
      const res = await API.adminCreateMode(payload())
      id = res.mode.id
      router.replace(`/admin/ai/modes/${id}`)
    } else {
      await API.adminUpdateMode(id, payload())
    }
    const res = await API.adminValidateMode(id, {})
    preview.value = res
    successMsg.value = 'Проверка выполнена'
  } catch (e) {
    error.value = e.message || 'Ошибка проверки'
  }
}

onMounted(loadData)
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
.check {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
  color: #435368;
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
