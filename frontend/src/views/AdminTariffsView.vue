<template>
  <AdminShell>
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6 mb-6">
      <div class="mb-4 flex items-center justify-between">
        <div>
          <h2 class="font-headline text-xl font-bold text-[#2A3439]">Тарифы ИИ (Пакеты Моделей)</h2>
          <p class="text-sm text-[#566166] mt-1">
            Настройка стратегий Fallback и лимитов для каждого продуктового тарифа по стадиям.
          </p>
        </div>
        <button class="btn-secondary" @click="loadData">Обновить</button>
      </div>

      <p v-if="error" class="mb-3 text-sm text-[#9F403D]">{{ error }}</p>
      <p v-if="successMsg" class="mb-3 text-sm text-green-700">{{ successMsg }}</p>

      <div class="overflow-x-auto">
        <table class="w-full text-sm text-left">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-[#566166]">
              <th class="py-2 pr-4 w-48 font-semibold">Этап пайплайна</th>
              <th v-for="profile in profiles" :key="profile.code" class="py-2 px-3 font-semibold text-center border-l border-[#A9B4B9]/20">
                <div class="flex items-center justify-center gap-2">
                  <span class="text-lg">{{ getProfileIcon(profile.code) }}</span>
                  <div class="flex flex-col text-left">
                    <span>{{ profile.name }}</span>
                    <span class="text-[10px] font-normal opacity-70">Приоритет: {{ profile.priority_level }}</span>
                  </div>
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="stage in stageNames" :key="stage" class="border-b border-[#A9B4B9]/15 align-top hover:bg-slate-50">
              <td class="py-4 pr-4 font-medium text-[#2A3439]">
                {{ stage }}
              </td>
              <td v-for="profile in profiles" :key="profile.code + stage" class="py-3 px-3 border-l border-[#A9B4B9]/20">
                <div class="flex flex-col gap-2">
                  <div>
                    <label class="block text-[10px] font-bold text-[#566166] uppercase mb-1">Запасная модель (Fallback)</label>
                     <select 
                      v-model="getRuleRef(profile.code, stage).fallback_model" 
                      class="field w-full text-xs"
                      @change="markDirty(profile.code, stage)"
                    >
                      <option :value="null">— авто / роутер —</option>
                      <option v-for="m in llmModels" :key="m.api_model_id" :value="m.api_model_id">
                        {{ m.api_model_id }}
                      </option>
                    </select>
                  </div>
                  
                  <div>
                    <label class="block text-[10px] font-bold text-[#566166] uppercase mb-1">Действие при лимите</label>
                    <select 
                      v-model="getRuleRef(profile.code, stage).action_strategy"
                      class="field w-full text-xs"
                      @change="markDirty(profile.code, stage)"
                    >
                      <option value="fallback_model">Снизить качество (Fallback)</option>
                      <option value="skip">Пропустить этап (Skip)</option>
                      <option value="fail_fast">Остановить (Ошибка)</option>
                      <option value="queue">В очередь (Ждать)</option>
                    </select>
                  </div>

                  <div class="flex items-center gap-2 mt-1" v-if="dirtyRules[`${profile.code}:${stage}`]">
                    <button class="btn-primary-sm w-full py-1 text-xs" @click="saveRule(profile.code, stage)">Сохранить</button>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Sandbox / Router Simulator -->
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <h3 class="font-headline text-lg font-bold text-[#2A3439] mb-4">Песочница роутера (Sandbox)</h3>
      <p class="text-sm text-[#566166] mb-4">
        Протестируйте, какую модель выберет система при определенных условиях.
      </p>

      <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <div>
          <label class="block mb-1 text-sm font-semibold">Профиль (Тариф)</label>
          <select v-model="sandboxProfile" class="field w-full">
            <option v-for="p in profiles" :key="p.code" :value="p.code">{{ p.name }}</option>
          </select>
        </div>
        <div>
          <label class="block mb-1 text-sm font-semibold">Этап</label>
          <select v-model="sandboxStage" class="field w-full">
             <option v-for="s in stageNames" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
        <div>
          <label class="block mb-1 text-sm font-semibold">Ожидаемый размер контекста (токены)</label>
          <input type="number" v-model="sandboxContext" class="field w-full" placeholder="e.g. 5000" />
        </div>
        <div class="flex items-end">
          <button class="btn-primary-sm w-full h-9" @click="testRoute" :disabled="testingRoute">
            {{ testingRoute ? 'Вычисление...' : 'Проверить маршрут' }}
          </button>
        </div>
      </div>

      <div v-if="sandboxResult" class="bg-gray-50 rounded-lg p-4 font-mono text-sm overflow-auto text-[#2A3439] border border-gray-200">
        <pre>{{ JSON.stringify(sandboxResult, null, 2) }}</pre>
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
const profiles = ref([])
const models = ref([])

// Unique stages from rules
const stageNames = ref([])

const editableRules = reactive({})
const dirtyRules = reactive({})

const sandboxProfile = ref('')
const sandboxStage = ref('')
const sandboxContext = ref(0)
const sandboxResult = ref(null)
const testingRoute = ref(false)

const llmModels = computed(() => {
  return (models.value || []).filter(m => m.is_enabled && m.api_model_id);
})

function getProfileIcon(code) {
  if (code === 'economy') return '🥉';
  if (code === 'standard') return '🥈';
  if (code === 'premium') return '🥇';
  return '📦';
}

function initEdits() {
  const stagesSet = new Set()
  
  for (const p of profiles.value) {
    if (!editableRules[p.code]) editableRules[p.code] = {}
    
    for (const rule of (p.rules || [])) {
      stagesSet.add(rule.stage_name)
      editableRules[p.code][rule.stage_name] = {
        fallback_model: rule.fallback_model,
        action_strategy: rule.action_strategy,
        max_context_size: rule.max_context_size
      }
    }
  }

  // Define global stage order if possible, or just alphabetical
  const stagesArr = Array.from(stagesSet)
  const ordered = ['pipeline', 'language_detection', 'cheap_preprocess', 'batch_generation', 'blueprint_generation', 'question_generation', 'grounding_validation', 'backfill', 'embedding']
  
  stageNames.value = stagesArr.sort((a, b) => {
    let ia = ordered.indexOf(a)
    let ib = ordered.indexOf(b)
    if (ia === -1) ia = 99
    if (ib === -1) ib = 99
    return ia - ib
  })
}

function getRuleRef(profile, stage) {
  if (!editableRules[profile]) editableRules[profile] = {}
  if (!editableRules[profile][stage]) {
    editableRules[profile][stage] = { fallback_model: null, action_strategy: 'fallback_model', max_context_size: null }
  }
  return editableRules[profile][stage]
}

function markDirty(profile, stage) {
  dirtyRules[`${profile}:${stage}`] = true
}

async function loadData() {
  error.value = ''
  successMsg.value = ''
  try {
    const [profilesRes, modelsRes] = await Promise.all([
      API.adminGetRoutingProfiles(),
      API.adminGetModels()
    ])
    profiles.value = profilesRes.profiles || []
    models.value = modelsRes.models || []
    
    initEdits()

    if (profiles.value.length > 0 && !sandboxProfile.value) {
      sandboxProfile.value = profiles.value[0].code
    }
    if (stageNames.value.length > 0 && !sandboxStage.value) {
      sandboxStage.value = stageNames.value[0]
    }
  } catch (e) {
    error.value = e?.message || 'Ошибка загрузки тарифов'
  }
}

async function saveRule(profileCode, stageName) {
  error.value = ''
  successMsg.value = ''
  const ruleData = editableRules[profileCode][stageName]
  try {
    await API.adminUpdateRoutingProfileRule(profileCode, stageName, {
      fallback_model: ruleData.fallback_model || null,
      action_strategy: ruleData.action_strategy,
      max_context_size: ruleData.max_context_size
    })
    dirtyRules[`${profileCode}:${stageName}`] = false
    successMsg.value = `Правило для ${profileCode} / ${stageName} успешно сохранено`
  } catch (e) {
    error.value = e?.message || 'Ошибка сохранения'
  }
}

async function testRoute() {
  testingRoute.value = true
  sandboxResult.value = null
  try {
    const res = await API.adminResolveRoutingProfile({
      profile: sandboxProfile.value,
      stage: sandboxStage.value,
      context_size_estimated: sandboxContext.value || 0
    })
    sandboxResult.value = res.resolution
  } catch(e) {
    sandboxResult.value = { error: e.message }
  } finally {
    testingRoute.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.field {
  border: 1px solid rgba(169, 180, 185, 0.45);
  border-radius: 0.5rem;
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
  background: white;
}
.btn-secondary {
  border-radius: 0.5rem;
  border: 1px solid rgba(169, 180, 185, 0.45);
  padding: 0.4rem 0.8rem;
  color: #435368;
  font-weight: 600;
  font-size: 0.875rem;
}
.btn-secondary:hover {
  background: #f8fafc;
}
.btn-primary-sm {
  border-radius: 0.5rem;
  background: linear-gradient(180deg, #3755c3 0%, #2848b7 100%);
  color: #f8f7ff;
  padding: 0.35rem 0.7rem;
  font-weight: 600;
  font-size: 0.8rem;
  border: none;
  cursor: pointer;
}
.btn-primary-sm:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
</style>
