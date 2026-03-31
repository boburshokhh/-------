<template>
  <AdminShell>
    <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 class="font-headline text-2xl font-bold text-[#2A3439]">Usage, Cost &amp; Burn</h2>
        <p class="text-sm text-[#566166] mt-1">Обозреватель финансовых расходов и аналитика Fallback-инцидентов.</p>
      </div>

      <div class="flex items-center gap-3 bg-white p-1 rounded-lg border border-[#A9B4B9]/25 shadow-sm">
         <button class="px-3 py-1 text-sm font-semibold rounded-md transition-colors" 
                 :class="period === '24h' ? 'bg-[#2A3439] text-white' : 'text-[#566166] hover:bg-gray-100'" 
                 @click="setPeriod('24h')">24 Hours</button>
         <button class="px-3 py-1 text-sm font-semibold rounded-md transition-colors" 
                 :class="period === '7d' ? 'bg-[#2A3439] text-white' : 'text-[#566166] hover:bg-gray-100'" 
                 @click="setPeriod('7d')">7 Days</button>
         <button class="px-3 py-1 text-sm font-semibold rounded-md transition-colors" 
                 :class="period === '30d' ? 'bg-[#2A3439] text-white' : 'text-[#566166] hover:bg-gray-100'" 
                 @click="setPeriod('30d')">30 Days</button>
      </div>
    </div>

    <!-- Loading and Error -->
    <div v-if="loading" class="flex justify-center py-20">
      <div class="animate-spin h-8 w-8 border-4 border-[#3755c3] border-t-transparent rounded-full"></div>
    </div>
    <div v-else-if="error" class="p-6 bg-red-50 text-red-700 rounded-xl border border-red-200">
      {{ error }}
    </div>

    <!-- Dashboard Content -->
    <div v-else-if="data" class="space-y-6">

      <!-- Hero Metrics Row -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
         <div class="bg-white p-5 rounded-2xl border border-[#A9B4B9]/25 shadow-sm">
            <h3 class="text-xs uppercase tracking-wider font-bold text-[#566166] mb-2">Total Requests</h3>
            <div class="text-3xl font-bold text-[#2A3439]">{{ formatNum(data.hero_metrics.total_requests) }}</div>
            <div class="text-xs text-[#A9B4B9] mt-2">+ {{ calculateScale(data.hero_metrics.total_requests) }} per minute</div>
         </div>
         <div class="bg-white p-5 rounded-2xl border border-blue-200 shadow-sm bg-gradient-to-b from-white to-blue-50/30">
            <h3 class="text-xs uppercase tracking-wider font-bold text-blue-800 mb-2">Estimated Cost</h3>
            <div class="text-3xl font-bold text-blue-900">${{ data.hero_metrics.estimated_cost_usd.toFixed(2) }}</div>
            <div class="text-xs text-blue-600/70 mt-2">Based on {{ formatNum(data.hero_metrics.total_tokens) }} tokens</div>
         </div>
         <div class="bg-white p-5 rounded-2xl border border-[#A9B4B9]/25 shadow-sm">
            <h3 class="text-xs uppercase tracking-wider font-bold text-[#566166] mb-2">Downgrade Rate</h3>
            <div class="text-3xl font-bold" :class="data.hero_metrics.fallback_rate_percent > 10 ? 'text-amber-600' : 'text-[#2A3439]'">
               {{ data.hero_metrics.fallback_rate_percent }}%
            </div>
            <div class="text-xs text-[#A9B4B9] mt-2">Запросов получили Fallback</div>
         </div>
         <div class="bg-white p-5 rounded-2xl border border-red-200 shadow-sm bg-gradient-to-b from-white to-red-50/20">
            <h3 class="text-xs uppercase tracking-wider font-bold text-red-800 mb-2">Premium Blocks</h3>
            <div class="text-3xl font-bold text-red-600">{{ formatNum(data.hero_metrics.premium_blocked_count) }}</div>
            <div class="text-xs text-red-500/80 mt-2">Отказов по квоте или лимитам</div>
         </div>
      </div>

      <!-- Smart Alerts (Recommendations) -->
      <div v-if="data.alerts_and_recommendations.length" class="space-y-3">
         <div v-for="(alert, idx) in data.alerts_and_recommendations" :key="idx" 
              class="flex items-start gap-4 p-4 rounded-xl border shadow-sm"
              :class="alert.type === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-green-50 border-green-200 text-green-900'">
            <div class="text-2xl mt-0.5">
               {{ alert.type === 'warning' ? '⚠️' : '💡' }}
            </div>
            <div>
               <h4 class="font-bold text-sm uppercase tracking-wide mb-1 opacity-80">
                 {{ alert.type === 'warning' ? 'Warning' : 'Optimization Recommendation' }}
               </h4>
               <p class="text-sm font-medium">{{ alert.message }}</p>
            </div>
         </div>
      </div>

      <!-- Main Visuals (Breakdowns) -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
         <!-- Cost Split by Model -->
         <div class="bg-white p-5 rounded-2xl border border-[#A9B4B9]/25 shadow-sm">
            <h3 class="font-headline font-bold text-lg text-[#2A3439] mb-4">Cost Split By Model</h3>
            <div class="space-y-3">
               <div v-for="m in data.breakdown_by_model" :key="m.model_id" class="flex flex-col gap-1 text-sm">
                  <div class="flex justify-between items-end">
                     <span class="font-semibold text-[#566166]">{{ m.model_id }}</span>
                     <span class="font-bold text-[#2A3439]">${{ m.cost.toFixed(2) }}</span>
                  </div>
                  <div class="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden">
                     <div class="h-full bg-blue-500 rounded-full" :style="{ width: percentOfCost(m.cost) + '%' }"></div>
                  </div>
                  <div class="text-[10px] text-[#A9B4B9] text-right">{{ formatNum(m.requests) }} calls &middot; {{ formatNum(m.tokens) }} tokens</div>
               </div>
               <div v-if="!data.breakdown_by_model.length" class="text-sm text-gray-400 text-center py-4">No data</div>
            </div>
         </div>

         <!-- Top Downgrades by Stage -->
         <div class="bg-white p-5 rounded-2xl border border-[#A9B4B9]/25 shadow-sm">
            <h3 class="font-headline font-bold text-lg text-[#2A3439] mb-4">Fallback Stress by Stage</h3>
            <div class="space-y-3">
               <div v-for="s in data.breakdown_by_stage" :key="s.stage" class="flex flex-col gap-1 text-sm">
                  <div class="flex justify-between items-end">
                     <span class="font-semibold text-[#566166]">{{ s.stage }}</span>
                     <span class="font-bold text-amber-600">{{ s.was_fallback_percent }}%</span>
                  </div>
                  <div class="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden flex">
                     <div class="h-full bg-amber-500" :style="{ width: s.was_fallback_percent + '%' }"></div>
                     <div class="h-full bg-green-500" :style="{ width: (100 - s.was_fallback_percent) + '%' }"></div>
                  </div>
                  <div class="text-[10px] text-[#A9B4B9] text-right">{{ formatNum(s.requests) }} total evaluations</div>
               </div>
               <div v-if="!data.breakdown_by_stage.length" class="text-sm text-gray-400 text-center py-4">No data</div>
            </div>
         </div>
      </div>

      <!-- Bottom Tables -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
         <!-- Daily Timeseries Table -->
         <div class="bg-white p-5 rounded-2xl border border-[#A9B4B9]/25 shadow-sm overflow-hidden flex flex-col">
            <h3 class="font-headline font-bold text-lg text-[#2A3439] mb-4">Traffic Matrix</h3>
            <div class="overflow-y-auto max-h-64 flex-1 pr-2 custom-scrollbar">
               <table class="w-full text-left text-sm">
                  <thead class="bg-gray-50/80 sticky top-0 backdrop-blur-sm z-10 border-b border-gray-200">
                     <tr>
                        <th class="py-2.5 px-3 font-semibold text-[#566166]">Date</th>
                        <th class="py-2.5 px-3 font-semibold text-[#566166] text-right">Economy</th>
                        <th class="py-2.5 px-3 font-semibold text-[#566166] text-right">Standard</th>
                        <th class="py-2.5 px-3 font-semibold text-[#566166] text-right">Premium</th>
                        <th class="py-2.5 px-3 font-semibold text-right text-amber-600">Downgrades</th>
                     </tr>
                  </thead>
                  <tbody>
                     <tr v-for="t in data.timeseries" :key="t.date" class="border-b last:border-b-0 border-[#A9B4B9]/15">
                        <td class="py-2 px-3 font-mono text-[#566166]">{{ t.date.substring(0, 10) }}</td>
                        <td class="py-2 px-3 text-right font-medium">{{ formatNum(t.economy_requests) }}</td>
                        <td class="py-2 px-3 text-right font-medium text-blue-600">{{ formatNum(t.standard_requests) }}</td>
                        <td class="py-2 px-3 text-right font-medium text-purple-700">{{ formatNum(t.premium_requests) }}</td>
                        <td class="py-2 px-3 text-right font-bold text-amber-600">{{ formatNum(t.downgrades) }}</td>
                     </tr>
                     <tr v-if="!data.timeseries.length">
                        <td colspan="5" class="text-center py-8 text-[#A9B4B9]">No timeseries data</td>
                     </tr>
                  </tbody>
               </table>
            </div>
         </div>

         <!-- Top Blocker Reasons -->
         <div class="bg-white p-5 rounded-2xl border border-[#A9B4B9]/25 shadow-sm overflow-hidden flex flex-col">
            <h3 class="font-headline font-bold text-lg text-[#2A3439] mb-4">Top Blockers &amp; Faults</h3>
            <div class="overflow-y-auto max-h-64 flex-1 pr-2 custom-scrollbar">
               <table class="w-full text-left text-sm">
                  <thead class="bg-gray-50/80 sticky top-0 backdrop-blur-sm z-10 border-b border-gray-200">
                     <tr>
                        <th class="py-2.5 px-3 font-semibold text-[#566166]">Reason Code</th>
                        <th class="py-2.5 px-3 font-semibold text-[#566166] text-right">Count</th>
                     </tr>
                  </thead>
                  <tbody>
                     <tr v-for="b in data.top_blocker_reasons" :key="b.reason" class="border-b last:border-b-0 border-[#A9B4B9]/15 hover:bg-red-50/30 transition-colors">
                        <td class="py-2 px-3 font-mono font-bold text-red-700 break-all">{{ b.reason }}</td>
                        <td class="py-2 px-3 text-right font-semibold text-[#2A3439]">{{ formatNum(b.count) }}</td>
                     </tr>
                     <tr v-if="!data.top_blocker_reasons.length">
                        <td colspan="2" class="text-center py-8 text-[#A9B4B9]">Clean! No major blockers</td>
                     </tr>
                  </tbody>
               </table>
            </div>
         </div>
      </div>

    </div>
  </AdminShell>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'

const period = ref('7d')
const loading = ref(false)
const error = ref('')
const data = ref(null)

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const res = await API.adminGetUsageOverview(period.value)
    data.value = res
  } catch (e) {
    error.value = e.message || 'Ошибка загрузки дашборда'
  } finally {
    loading.value = false
  }
}

function setPeriod(p) {
  period.value = p
  loadData()
}

// Helpers
function formatNum(n) {
  return new Intl.NumberFormat('en-US').format(n || 0)
}

function percentOfCost(cost) {
  if (!data.value || !data.value.hero_metrics.estimated_cost_usd) return 0
  return (cost / data.value.hero_metrics.estimated_cost_usd) * 100
}

function calculateScale(total) {
  if (period.value === '24h') return (total / 1440).toFixed(1)
  if (period.value === '7d') return (total / 10080).toFixed(1)
  return (total / 43200).toFixed(1)
}

onMounted(() => {
  loadData()
})
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background-color: rgba(169, 180, 185, 0.4);
  border-radius: 20px;
}
</style>
