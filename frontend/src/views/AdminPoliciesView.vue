<template>
  <AdminShell>
    <div class="grid gap-5 lg:grid-cols-2">
      <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
        <h2 class="font-headline text-xl font-bold text-[#2A3439]">Global Routing Mode</h2>
        <p class="mt-1 text-sm text-[#566166]">Базовый режим маршрутизации по умолчанию.</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <button
            v-for="m in modes"
            :key="m"
            class="mode-chip"
            :class="selectedMode === m ? 'mode-chip--active' : ''"
            @click="selectedMode = m"
          >
            {{ m }}
          </button>
        </div>
        <div class="mt-4">
          <button class="btn-primary" :disabled="savingMode" @click="saveMode">
            {{ savingMode ? 'Saving...' : 'Save mode' }}
          </button>
        </div>
      </div>

      <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
        <h2 class="font-headline text-xl font-bold text-[#2A3439]">Manual Override</h2>
        <div class="mt-3 grid gap-3">
          <select v-model="form.scope" class="field">
            <option value="global">global</option>
            <option value="agent">agent</option>
            <option value="phase">phase</option>
            <option value="document">document</option>
          </select>
          <input v-model.trim="form.target" class="field" placeholder="target (agent/stage/doc id)" />
          <input v-model.number="form.model_id" class="field" placeholder="model_id (ai_models.id)" />
          <input v-model.number="form.priority" class="field" placeholder="priority" />
          <input v-model="form.expires_at" class="field" placeholder="expires_at ISO (optional)" />
          <input v-model.trim="form.reason" class="field" placeholder="reason" />
          <button class="btn-primary" :disabled="savingOverride" @click="createOverride">
            {{ savingOverride ? 'Creating...' : 'Create override' }}
          </button>
        </div>
      </div>
    </div>

    <div class="mt-5 rounded-2xl border border-[#A9B4B9]/25 bg-white p-4 md:p-6">
      <div class="mb-3 flex items-center justify-between">
        <h3 class="font-headline text-lg font-bold text-[#2A3439]">Current overrides</h3>
        <button class="btn-secondary" @click="loadAll">Refresh</button>
      </div>
      <p v-if="error" class="mb-2 text-sm text-[#9F403D]">{{ error }}</p>
      <div class="overflow-auto">
        <table class="w-full min-w-[800px] text-sm">
          <thead>
            <tr class="border-b border-[#A9B4B9]/30 text-left text-[#566166]">
              <th class="py-2 pr-3">id</th>
              <th class="py-2 pr-3">scope/target</th>
              <th class="py-2 pr-3">model</th>
              <th class="py-2 pr-3">priority</th>
              <th class="py-2 pr-3">enabled</th>
              <th class="py-2 pr-3">actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in overrides" :key="o.id" class="border-b border-[#A9B4B9]/15">
              <td class="py-2 pr-3">{{ o.id }}</td>
              <td class="py-2 pr-3">{{ o.scope }} / {{ o.target || '—' }}</td>
              <td class="py-2 pr-3">{{ o.api_model_id || o.model_id }}</td>
              <td class="py-2 pr-3">{{ o.priority }}</td>
              <td class="py-2 pr-3">{{ o.is_enabled ? 'on' : 'off' }}</td>
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
import { onMounted, reactive, ref } from 'vue'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'

const modes = ['auto', 'economy', 'balanced', 'quality', 'manual']
const selectedMode = ref('auto')
const savingMode = ref(false)
const savingOverride = ref(false)
const error = ref('')
const overrides = ref([])

const form = reactive({
  scope: 'global',
  target: '',
  model_id: null,
  priority: 0,
  expires_at: '',
  reason: '',
})

async function loadAll() {
  error.value = ''
  try {
    const [modeRes, ovRes] = await Promise.all([
      API.adminGetRoutingMode(),
      API.adminGetManualOverrides({ include_disabled: true, limit: 300 }),
    ])
    selectedMode.value = modeRes.routing_mode || 'auto'
    overrides.value = ovRes.rows || []
  } catch (e) {
    error.value = e?.message || 'Failed to load policies'
  }
}

async function saveMode() {
  savingMode.value = true
  error.value = ''
  try {
    await API.adminSetRoutingMode(selectedMode.value, { source: 'admin_panel' })
  } catch (e) {
    error.value = e?.message || 'Save mode failed'
  } finally {
    savingMode.value = false
  }
}

async function createOverride() {
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
.btn-secondary, .btn-secondary-sm {
  border-radius: 0.75rem;
  border: 1px solid rgba(169, 180, 185, 0.45);
  padding: 0.45rem 0.8rem;
  color: #435368;
  font-weight: 600;
}
</style>
