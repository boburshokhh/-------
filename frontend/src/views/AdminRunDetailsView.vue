<template>
  <AdminShell>
    <!-- Header Card -->
    <div v-if="run" class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-5 mb-6 shadow-sm">
      <div class="flex justify-between items-start">
        <div class="flex flex-col gap-1">
          <!-- Back Link -->
          <router-link to="/admin/ai/runs" class="text-xs text-blue-600 font-bold hover:underline mb-2 flex items-center gap-1">
             &larr; Back to Runs
          </router-link>

          <h2 class="font-headline text-2xl font-bold text-[#2A3439]">Run #{{ run.id }}</h2>
          <div class="text-[13px] text-[#566166] flex items-center gap-3">
             <span class="flex items-center gap-1 font-mono bg-gray-100 px-2 py-0.5 rounded text-gray-700">doc: {{ run.document_id }}</span>
             <span>{{ formatTs(run.created_at) }}</span>
             <span v-if="run.duration_ms" class="text-green-700 bg-green-50 px-1.5 rounded">{{ formatDuration(run.duration_ms) }}</span>
          </div>
        </div>

        <!-- Status Badge -->
        <span class="px-3 py-1.5 rounded-md text-sm font-bold uppercase tracking-wider border" :class="getStatusClass(run.status)">
          {{ run.status }}
        </span>
      </div>
      
      <!-- Metrics Grid -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8 pt-6 border-t border-[#A9B4B9]/20" v-if="stats">
         <div class="flex flex-col">
            <span class="text-[10px] font-bold text-[#566166] uppercase mb-1">Target</span>
            <span class="text-xl font-bold text-[#2A3439]">{{ run.target_count || 'Auto' }} <span class="text-sm font-normal text-[#A9B4B9]">qs</span></span>
         </div>
         <div class="flex flex-col">
            <span class="text-[10px] font-bold text-[#566166] uppercase mb-1">Generated</span>
            <span class="text-xl font-bold text-[#2A3439]">{{ stats.questions_accepted }} / {{ stats.intents_planned }} <span class="text-sm font-normal text-[#A9B4B9]">intents</span></span>
         </div>
         <div class="flex flex-col">
            <span class="text-[10px] font-bold text-[#566166] uppercase mb-1">Fallback Rate</span>
            <span class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r" :class="stats.fallback_rate_percent > 0 ? 'from-amber-500 to-orange-500' : 'from-green-500 to-teal-500'">
               {{ stats.fallback_rate_percent > 0 ? 'Triggered' : 'Clean' }}
            </span>
         </div>
         <div class="flex flex-col">
            <span class="text-[10px] font-bold text-[#566166] uppercase mb-1">Language</span>
            <span class="text-xl font-bold text-[#2A3439] uppercase">{{ run.language || '?' }}</span>
         </div>
      </div>
      
      <!-- Error Banner -->
      <div v-if="run.error_message" class="mt-4 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 font-mono">
         <strong class="block mb-1 text-red-900 border-b border-red-200 pb-1">Fatal Error</strong>
         {{ run.error_message }}
      </div>
    </div>

    <!-- The Timeline -->
    <div class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-5 pb-8 mb-6" v-if="timeline && timeline.length">
       <h3 class="font-headline text-lg font-bold text-[#2A3439] mb-6">Pipeline Timeline</h3>
       
       <div class="relative pl-6 border-l-2 border-[#E1E5E8] space-y-8 ml-2">
         <div v-for="(stage, idx) in timeline" :key="idx" class="relative group">
            
            <!-- Node Dot -->
            <div class="absolute -left-[31px] top-1.5 w-[14px] h-[14px] rounded-full border-2 border-white shadow-sm"
                 :class="getStageDot(stage.status)"></div>

            <!-- Stage Header -->
            <div class="flex items-center justify-between mb-3 border-b-2 pb-2" :class="getStageBorder(stage.status)">
               <div class="flex items-center gap-3">
                  <h4 class="text-[15px] font-bold capitalize" :class="getStageHeaderColor(stage.status)">
                     {{ stage.stage_name.replace(/_/g, ' ') }}
                  </h4>
                  <!-- Routing Output Box -->
                  <div v-if="stage.routing" class="flex items-center bg-[#F7F8FA] border border-[#A9B4B9]/30 rounded-md px-2 py-0.5">
                     <span class="text-[10px] text-[#A9B4B9] uppercase font-bold mr-2">Model</span>
                     <span class="text-xs font-mono font-bold text-[#2A3439]">
                       {{ stage.routing.selected_model || '—' }}
                     </span>
                     <span v-if="stage.routing.was_fallback" class="ml-2 text-[10px] bg-amber-100 text-amber-800 rounded px-1.5 py-0.5">Fallback</span>
                  </div>
               </div>
               
               <!-- Explain Button -->
               <button v-if="stage.routing && stage.routing.decision_id" 
                       class="text-xs font-bold text-blue-600 bg-blue-50 border border-blue-100 hover:bg-blue-100 rounded-lg px-3 py-1 transition-colors capitalize"
                       @click="openExplainPanel(stage.routing.decision_id)">
                 Trace Decision &rarr;
               </button>
            </div>

            <!-- Logs / Events -->
            <div class="bg-[#Fdfdfd] border border-[#A9B4B9]/20 rounded-xl overflow-hidden mt-1 shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
               <ul class="text-xs font-mono">
                  <li v-for="(ev, eIdx) in stage.events" :key="eIdx" 
                      class="px-4 py-2 flex items-start gap-4 hover:bg-[#F7F8FA] border-b border-[#A9B4B9]/10 last:border-b-0">
                     <span class="text-[#A9B4B9] shrink-0">{{ formatShortTime(ev.time) }}</span>
                     <span class="text-[#2A3439] break-words" :class="ev.level === 'warn' ? 'text-orange-700' : (ev.level === 'error' ? 'text-red-700 font-semibold' : '')">
                        {{ ev.event }}
                     </span>
                  </li>
               </ul>
            </div>
            
         </div>
       </div>
    </div>
    
    <div v-else-if="run && (!timeline || !timeline.length)" class="rounded-2xl border border-[#A9B4B9]/25 bg-white p-8 text-center text-[#566166]">
       No pipeline events registered.
    </div>
    
    <p v-if="loading" class="text-center py-4 text-[#566166]">Loading...</p>
    <p v-if="error" class="text-center py-4 text-[#9F403D]">{{ error }}</p>

    <!-- Side Panel component -->
    <ExplainDecisionPanel 
      :is-open="explainOpen" 
      :decision-id="explainId"
      @close="explainOpen = false"
    />
  </AdminShell>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'
import ExplainDecisionPanel from '@/components/admin/ExplainDecisionPanel.vue'

const route = useRoute()
const runId = route.params.id

const loading = ref(false)
const error = ref('')

const run = ref(null)
const stats = ref(null)
const timeline = ref([])

const explainOpen = ref(false)
const explainId = ref(null)

async function fetchRun() {
  loading.value = true
  try {
    const res = await API.adminGetRun(runId)
    run.value = res.run
    stats.value = res.stats
    timeline.value = res.timeline
  } catch (e) {
    error.value = e.message || 'Error loading run'
  } finally {
    loading.value = false
  }
}

function openExplainPanel(id) {
  explainId.value = id
  explainOpen.value = true
}

// Helpers
function getStatusClass(st) {
  if (st === 'completed') return 'bg-green-50 text-green-700 border-green-200'
  if (st === 'degraded') return 'bg-yellow-50 text-yellow-700 border-yellow-200'
  if (st === 'running') return 'bg-blue-50 text-blue-700 border-blue-200'
  if (st === 'failed') return 'bg-red-50 text-red-700 border-red-200'
  return 'bg-gray-100 text-gray-800 border-gray-200'
}

function getStageDot(status) {
  if (status === 'success') return 'bg-blue-500' // blue dot while successful
  if (status === 'warning') return 'bg-amber-500' // amber for warnings
  if (status === 'error') return 'bg-red-600'     // red for fatal
  return 'bg-gray-400'
}

function getStageHeaderColor(status) {
   if (status === 'error') return 'text-red-700'
   if (status === 'warning') return 'text-amber-700'
   return 'text-[#2A3439]'
}

function getStageBorder(status) {
   if (status === 'error') return 'border-red-100'
   if (status === 'warning') return 'border-amber-100'
   return 'border-[#A9B4B9]/15'
}

function formatTs(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute:'2-digit' })
  } catch {
    return String(ts)
  }
}

function formatShortTime(ts) {
   if (!ts) return ''
   try { return new Date(ts).toISOString().substring(11, 23) } catch { return '' }
}

function formatDuration(ms) {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

onMounted(() => {
  if (runId) {
    fetchRun()
  }
})
</script>
