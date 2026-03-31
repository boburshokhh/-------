<template>
  <div>
    <!-- Backdrop overlay -->
    <div 
      v-if="isOpen" 
      class="fixed inset-0 bg-black/30 z-40 transition-opacity"
      @click="closePanel"
    ></div>

    <!-- Sliding Panel -->
    <div 
      class="fixed top-0 right-0 h-full w-[450px] bg-[#fdfdfd] shadow-2xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col"
      :class="isOpen ? 'translate-x-0' : 'translate-x-full'"
    >
      <!-- Header -->
      <div class="px-6 py-5 border-b border-[#A9B4B9]/30 bg-white flex justify-between items-center shrink-0">
        <div>
          <h2 class="text-xl font-headline font-bold text-[#2A3439]">Decision Trace</h2>
          <p class="text-xs text-[#566166] mt-1" v-if="loadedData">ID: {{ loadedData.decision_id }} &bull; {{ formatTs(loadedData.timestamp) }}</p>
        </div>
        <button @click="closePanel" class="text-[#A9B4B9] hover:text-[#2A3439] transition-colors p-2">
          ✕
        </button>
      </div>

      <!-- Loading State -->
      <div v-if="loading" class="p-6 text-center text-[#566166]">
        Загрузка трейса...
      </div>
      <div v-else-if="error" class="p-6 text-center text-[#9F403D]">
        {{ error }}
      </div>

      <!-- Content -->
      <div v-else-if="loadedData" class="flex-1 overflow-y-auto bg-[#F7F8FA]">
        
        <!-- Hero Section: Outcome -->
        <div class="p-6 bg-white border-b border-[#A9B4B9]/20">
          <div class="flex items-center gap-3 mb-4">
            <span class="text-3xl" v-if="loadedData.summary.status === 'matched'">✅</span>
            <span class="text-3xl" v-else-if="loadedData.summary.status === 'downgraded'">⚠️</span>
            <span class="text-3xl" v-else>🛑</span>
            
            <div>
              <h3 class="text-lg font-bold text-[#2A3439] capitalize">
                {{ loadedData.summary.status === 'matched' ? 'As Configured' : (loadedData.summary.status === 'downgraded' ? 'Downgraded' : 'Skipped / Failed') }}
              </h3>
              <p class="text-sm text-[#566166]">Финальный результат маршрутизатора</p>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="p-3 bg-[#F0F4F7] rounded-xl border border-[#A9B4B9]/20">
              <div class="text-[10px] font-bold text-[#566166] uppercase tracking-wider mb-1">Target Model</div>
              <div class="font-mono text-sm break-all font-semibold text-[#2A3439]">{{ loadedData.summary.target_model }}</div>
            </div>
            <div class="p-3 rounded-xl border" :class="loadedData.summary.status === 'matched' ? 'bg-[#F0F4F7] border-[#A9B4B9]/20' : 'bg-amber-50 border-amber-200'">
              <div class="text-[10px] font-bold text-[#566166] uppercase tracking-wider mb-1">Effective Model</div>
              <div class="font-mono text-sm break-all font-semibold" :class="loadedData.summary.effective_model ? 'text-[#2A3439]' : 'text-red-600'">
                {{ loadedData.summary.effective_model || '— None —' }}
              </div>
            </div>
          </div>
          
          <!-- Human readable badges -->
          <div class="mt-4 flex flex-wrap gap-2">
            <span v-if="loadedData.flags.was_fallback" class="px-2 py-1 bg-orange-100 text-orange-800 rounded-md text-[11px] font-semibold">
              🟠 Сработал Fallback
            </span>
            <span v-if="loadedData.flags.premium_blocked" class="px-2 py-1 bg-red-100 text-red-800 rounded-md text-[11px] font-semibold">
              🔴 Блокировка Premium
            </span>
            <span v-if="loadedData.flags.manual_override_active" class="px-2 py-1 bg-purple-100 text-purple-800 rounded-md text-[11px] font-semibold">
              🟣 Ручное переопределение (Override)
            </span>
            <span v-if="loadedData.flags.preview_blocked" class="px-2 py-1 bg-stone-200 text-stone-700 rounded-md text-[11px] font-semibold">
              🔒 Preview отключено 
            </span>
          </div>
        </div>

        <!-- The Chain -->
        <div class="p-6">
          <h4 class="text-[11px] font-bold text-[#566166] uppercase tracking-wider mb-5">Decision Timeline</h4>
          
          <div class="relative pl-4 border-l-2 border-[#E1E5E8] space-y-6">
            <div v-for="(step, idx) in loadedData.chain" :key="idx" class="relative">
              <div class="absolute -left-[21px] top-1 w-[10px] h-[10px] rounded-full" 
                   :class="getStepDotColor(step)"></div>
              
              <h5 class="text-sm font-bold text-[#2A3439] mb-1">{{ step.title }}</h5>
              <div class="p-3 bg-white rounded-lg border border-[#A9B4B9]/20 shadow-sm">
                <ul class="text-xs text-[#566166] space-y-1">
                  <li v-for="(val, key) in step.details" :key="key" class="flex justify-between items-start gap-4">
                    <span class="capitalize opacity-80 shrink-0">{{ key.replace(/_/g, ' ') }}:</span>
                    <strong class="text-[#2A3439] text-right font-medium break-all">{{ formatVal(val) }}</strong>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <!-- Diagnostics -->
        <div class="p-6 pt-0">
           <h4 class="text-[11px] font-bold text-[#566166] uppercase tracking-wider mb-3">Сырые параметры (Diagnostics)</h4>
           
           <!-- Accordion style sections -->
           <div class="space-y-2">
             <details class="group bg-white rounded-lg border border-[#A9B4B9]/30 overflow-hidden">
                <summary class="cursor-pointer px-4 py-3 text-sm font-semibold text-[#2A3439] bg-[#F7F8FA] group-open:border-b border-[#A9B4B9]/30">
                  Fallback Chain
                </summary>
                <div class="p-3 text-xs bg-white font-mono break-all text-[#566166]">
                  {{ loadedData.diagnostics.fallback_chain_attempted.join(' ➔ ') || 'Нет кандидатов' }}
                </div>
             </details>
             
             <details class="group bg-white rounded-lg border border-[#A9B4B9]/30 overflow-hidden">
                <summary class="cursor-pointer px-4 py-3 text-sm font-semibold text-[#2A3439] bg-[#F7F8FA] group-open:border-b border-[#A9B4B9]/30">
                  Quota Snapshot
                </summary>
                <div class="p-3 text-xs bg-white font-mono overflow-auto text-[#566166]">
                  <pre>{{ JSON.stringify(loadedData.diagnostics.quota_pressure, null, 2) }}</pre>
                </div>
             </details>

             <details class="group bg-white rounded-lg border border-[#A9B4B9]/30 overflow-hidden">
                <summary class="cursor-pointer px-4 py-3 text-sm font-semibold text-[#2A3439] bg-[#F7F8FA] group-open:border-b border-[#A9B4B9]/30">
                  Global Policy
                </summary>
                <div class="p-3 text-xs bg-white font-mono overflow-auto text-[#566166]">
                  <pre>{{ JSON.stringify(loadedData.diagnostics.policy_snapshot, null, 2) }}</pre>
                </div>
             </details>
           </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { API } from '@/lib/api'

const props = defineProps({
  isOpen: {
    type: Boolean,
    default: false
  },
  decisionId: {
    type: Number,
    default: null
  }
})

const emit = defineEmits(['close'])

function closePanel() {
  emit('close')
}

const loading = ref(false)
const error = ref('')
const loadedData = ref(null)

watch(() => props.isOpen, (newVal) => {
  if (newVal && props.decisionId) {
    fetchData()
  } else {
    loadedData.value = null
  }
})

watch(() => props.decisionId, (newVal) => {
  if (props.isOpen && newVal) {
    fetchData()
  }
})

async function fetchData() {
  loading.value = true
  error.value = ''
  loadedData.value = null
  try {
    const res = await API.adminGetRoutingDecisionExplain(props.decisionId)
    loadedData.value = res.explain
  } catch (e) {
    error.value = e.message || 'Ошибка загрузки трейса'
  } finally {
    loading.value = false
  }
}

function formatTs(ts) {
  if (!ts) return ''
  try { return new Date(ts).toLocaleString() } catch { return String(ts) }
}

function formatVal(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

function getStepDotColor(step) {
  if (step.step === 'intention') return 'bg-blue-400'
  if (step.step === 'resolution') return 'bg-indigo-400'
  if (step.step === 'guards') {
    return step.details.passed === false ? 'bg-amber-500' : 'bg-green-400'
  }
  if (step.step === 'health_check') {
    return step.details.status === 'healthy' || step.details.status === 'resolved' ? 'bg-green-500' : 'bg-red-500'
  }
  return 'bg-gray-400'
}
</script>
