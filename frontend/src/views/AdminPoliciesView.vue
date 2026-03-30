<template>
  <AdminShell>
    <div class="grid gap-5 lg:grid-cols-2">
      <!-- Global Routing Mode -->
      <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
        <h2 class="font-headline text-xl font-bold text-[#2A3439]">Global Routing Mode</h2>
        <p class="mt-1 text-sm text-[#566166]">Базовый режим маршрутизации по умолчанию.</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <button
            v-for="m in modes"
            :key="m"
            class="mode-chip"
            :class="policies.routing_mode === m ? 'mode-chip--active' : ''"
            @click="policies.routing_mode = m"
          >
            {{ m }}
          </button>
        </div>
      </div>

      <!-- Policy Flags -->
      <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
        <h2 class="font-headline text-xl font-bold text-[#2A3439]">Policy Flags</h2>
        <div class="mt-3 grid gap-3">
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" v-model="policies.stable_only" />
            <span>Stable Only (block all preview models)</span>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" v-model="policies.premium_guard_enabled" />
            <span>Premium Guard (smart premium limiting)</span>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" v-model="policies.emergency_downgrade" />
            <span class="text-[#9F403D] font-semibold">Emergency Downgrade (force economy on all stages)</span>
          </label>
        </div>
      </div>

      <!-- Premium Controls -->
      <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
        <h2 class="font-headline text-lg font-bold text-[#2A3439]">Premium Controls</h2>
        <div class="mt-3 grid gap-3">
          <label class="text-sm">
            Premium soft limit (%):
            <input type="number" v-model.number="policies.premium_soft_limit_percent" class="field ml-2 w-20" min="0" max="100" />
          </label>
          <label class="text-sm">
            Max premium % per day:
            <input type="number" v-model.number="policies.max_premium_percent_per_day" class="field ml-2 w-20" min="0" max="100" />
          </label>
          <label class="text-sm">
            Max pro calls per run:
            <input type="number" v-model.number="policies.max_pro_calls_per_run" class="field ml-2 w-20" min="0" max="100" />
          </label>
        </div>
      </div>

      <!-- Preview / Canary -->
      <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
        <h2 class="font-headline text-lg font-bold text-[#2A3439]">Preview / Canary</h2>
        <div class="mt-3 grid gap-3">
          <label class="text-sm">
            Canary percent (0 = disabled):
            <input type="number" v-model.number="policies.preview_canary_percent" class="field ml-2 w-20" min="0" max="100" />
          </label>
          <p class="text-xs text-[#566166]">
            When > 0, this percentage of requests for preview-eligible stages will route to preview models for testing.
          </p>
        </div>
      </div>
    </div>

    <!-- Save -->
    <div class="mt-5">
      <p v-if="error" class="mb-2 text-sm text-[#9F403D]">{{ error }}</p>
      <p v-if="success" class="mb-2 text-sm text-green-700">{{ success }}</p>
      <button class="btn-primary" :disabled="savingPolicies" @click="savePolicies">
        {{ savingPolicies ? 'Saving...' : 'Save All Policies' }}
      </button>
    </div>

    <!-- Manual Overrides -->
    <div class="mt-6 rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <h2 class="font-headline text-xl font-bold text-[#2A3439]">Manual Override</h2>
      <div class="mt-3 grid gap-3 lg:grid-cols-2">
        <select v-model="form.scope" class="field">
          <option value="global">global</option>
          <option value="agent">agent</option>
          <option value="phase">stage / phase</option>
          <option value="document">document</option>
        </select>
        <input v-model.trim="form.target" class="field" placeholder="target (stage_key / agent / doc id)" />
        <select v-model="form.model_id" class="field">
          <option :value="null">Select model...</option>
          <option v-for="m in enabledModels" :key="m.id" :value="m.id">
            {{ m.api_model_id }} ({{ m.ui_name }})
          </option>
        </select>
        <input v-model.number="form.priority" class="field" placeholder="priority (0)" />
        <input v-model="form.expires_at" class="field" placeholder="expires_at ISO (optional)" />
        <input v-model.trim="form.reason" class="field" placeholder="reason" />
        <div class="lg:col-span-2">
          <button class="btn-primary" :disabled="savingOverride" @click="createOverride">
            {{ savingOverride ? 'Creating...' : 'Create override' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Current Overrides -->
    <div class="mt-5 rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="font-headline text-lg font-bold text-[#2A3439]">Current overrides</h3>
        <button class="btn-secondary" @click="loadAll">Refresh</button>
      </div>
      <div class="overflow-auto">
        <table class="w-full min-w-[900px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-3">id</th>
              <th class="py-2 pr-3">scope / target</th>
              <th class="py-2 pr-3">model</th>
              <th class="py-2 pr-3">priority</th>
              <th class="py-2 pr-3">enabled</th>
              <th class="py-2 pr-3">expires</th>
              <th class="py-2 pr-3">actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in overrides" :key="o.id" class="border-b border-[#A9B4B9]/15">
              <td class="py-2 pr-3">{{ o.id }}</td>
              <td class="py-2 pr-3">{{ o.scope }} / {{ o.target || o.stage_key || '—' }}</td>
              <td class="py-2 pr-3">{{ o.api_model_id || o.model_id }}</td>
              <td class="py-2 pr-3">{{ o.priority }}</td>
              <td class="py-2 pr-3">{{ o.is_enabled ? 'on' : 'off' }}</td>
              <td class="py-2 pr-3 text-xs">{{ o.expires_at || '—' }}</td>
              <td class="py-2 pr-3">
                <button class="btn-secondary-sm" @click="toggleOverride(o)">
                  {{ o.is_enabled ? 'Disable' : 'Enable' }}
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

const modes = ['auto', 'economy', 'balanced', 'quality', 'manual']
const error = ref('')
const success = ref('')
const savingPolicies = ref(false)
const savingOverride = ref(false)
const overrides = ref([])
const models = ref([])

const policies = reactive({
  routing_mode: 'auto',
  stable_only: false,
  premium_guard_enabled: true,
  premium_soft_limit_percent: 20,
  max_premium_percent_per_day: 25,
  max_pro_calls_per_run: 10,
  preview_canary_percent: 0,
  emergency_downgrade: false,
})

const form = reactive({
  scope: 'global',
  target: '',
  model_id: null,
  priority: 0,
  expires_at: '',
  reason: '',
})

const enabledModels = computed(() =>
  (models.value || []).filter((m) => m.is_enabled && m.api_model_id),
)

async function loadAll() {
  error.value = ''
  success.value = ''
  try {
    const [polRes, ovRes, modelsRes] = await Promise.all([
      API.adminGetGlobalPolicies(),
      API.adminGetManualOverrides({ include_disabled: true, limit: 300 }),
      API.adminGetModels(),
    ])
    if (polRes.policies) Object.assign(policies, polRes.policies)
    overrides.value = ovRes.rows || []
    models.value = modelsRes.models || []
  } catch (e) {
    error.value = e?.message || 'Failed to load policies'
  }
}

async function savePolicies() {
  savingPolicies.value = true
  error.value = ''
  success.value = ''
  try {
    await API.adminUpdateGlobalPolicies({
      routing_mode: policies.routing_mode,
      stable_only: policies.stable_only,
      premium_guard_enabled: policies.premium_guard_enabled,
      premium_soft_limit_percent: policies.premium_soft_limit_percent,
      max_premium_percent_per_day: policies.max_premium_percent_per_day,
      max_pro_calls_per_run: policies.max_pro_calls_per_run,
      preview_canary_percent: policies.preview_canary_percent,
      emergency_downgrade: policies.emergency_downgrade,
    })
    success.value = 'Policies saved'
  } catch (e) {
    error.value = e?.message || 'Save failed'
  } finally {
    savingPolicies.value = false
  }
}

async function createOverride() {
  if (!form.model_id) { error.value = 'Select a model'; return }
  savingOverride.value = true
  error.value = ''
  try {
    await API.adminCreateManualOverride({
      scope: form.scope,
      target: form.scope === 'global' ? '' : form.target,
      model_id: Number(form.model_id),
      priority: Number(form.priority || 0),
      expires_at: form.expires_at || null,
      reason: form.reason || null,
      is_enabled: true,
      conditions: {},
    })
    await loadAll()
  } catch (e) {
    error.value = e?.message || 'Create override failed'
  } finally {
    savingOverride.value = false
  }
}

async function toggleOverride(o) {
  error.value = ''
  try {
    await API.adminUpdateManualOverride(o.id, { is_enabled: !o.is_enabled })
    await loadAll()
  } catch (e) {
    error.value = e?.message || 'Toggle override failed'
  }
}

onMounted(loadAll)
</script>

<style scoped>
.field {
  border: 1px solid rgba(169, 180, 185, 0.45);
  border-radius: 0.75rem;
  padding: 0.6rem 0.75rem;
}
.mode-chip {
  border: 1px solid rgba(169, 180, 185, 0.45);
  color: #435368;
  border-radius: 0.75rem;
  padding: 0.4rem 0.7rem;
  font-size: 0.85rem;
}
.mode-chip--active {
  background: #3755c3;
  color: white;
  border-color: #3755c3;
}
.btn-primary {
  border-radius: 0.75rem;
  background: linear-gradient(180deg, #3755c3 0%, #2848b7 100%);
  color: #f8f7ff;
  padding: 0.5rem 0.9rem;
  font-weight: 700;
}
.btn-secondary,
.btn-secondary-sm {
  border-radius: 0.75rem;
  border: 1px solid rgba(169, 180, 185, 0.45);
  padding: 0.45rem 0.8rem;
  color: #435368;
  font-weight: 600;
}
</style>
