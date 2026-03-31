<template>
  <AdminShell>
    <!-- Welcome Header -->
    <div class="mb-8">
      <h1 class="font-headline text-3xl font-black text-[#2A3439] tracking-tight">Центр управления ИИ</h1>
      <p class="text-[15px] text-[#566166] mt-2 max-w-2xl">
        Единая панель управления маршрутизацией ИИ. Управляйте тарифами, отслеживайте перерасход бюджета и контролируйте качество генерации в реальном времени.
      </p>
    </div>

    <!-- Active Mode Switcher (Global Policy) -->
    <div class="rounded-2xl border border-blue-200 bg-gradient-to-br from-white to-blue-50/50 p-6 shadow-sm mb-6 relative overflow-hidden">
      <!-- Decorative background icon -->
      <div class="absolute -right-6 -bottom-6 opacity-5 pointer-events-none">
        <svg fill="currentColor" viewBox="0 0 24 24" class="w-48 h-48 text-blue-900"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      </div>

      <div class="relative z-10">
        <h2 class="font-headline text-xl font-bold text-[#2A3439] flex items-center gap-2">
          <span>Глобальный режим работы ИИ</span>
          <span v-if="loadingMode" class="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></span>
        </h2>
        <p class="mt-1 text-sm text-[#566166] max-w-lg">
          Главный выключатель роутера. Выбранный режим переопределяет локальные тарифы и форсирует использование соответствующих стратегий для всех пользователей (кроме ручных Manual Overrides).
        </p>

        <div class="mt-6 flex flex-wrap gap-3">
          <button
            v-for="mode in modes"
            :key="mode.id"
            @click="setGlobalMode(mode.id)"
            class="relative px-5 py-3 rounded-xl border transition-all duration-200 flex flex-col items-start min-w-[140px]"
            :class="[
               policies.routing_mode === mode.id 
                 ? 'bg-blue-600 border-blue-700 shadow-md ring-2 ring-blue-600/20 translate-y-0 text-white' 
                 : 'bg-white border-[#A9B4B9]/30 text-[#435368] hover:border-blue-400 hover:bg-blue-50/50 hover:-translate-y-0.5',
               savingMode ? 'opacity-50 pointer-events-none' : ''
            ]"
          >
            <span class="font-bold uppercase tracking-wider text-xs mb-1" :class="policies.routing_mode === mode.id ? 'text-blue-100' : 'text-[#8A98A5]'">
              {{ mode.label }}
            </span>
            <span class="text-lg font-bold">{{ mode.title }}</span>
            <div v-if="policies.routing_mode === mode.id" class="absolute top-3 right-3">
               <span class="flex h-2 w-2 relative">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
               </span>
            </div>
          </button>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
       <!-- System Alerts -->
       <div class="lg:col-span-2 space-y-4">
          <h3 class="font-headline text-lg font-bold text-[#2A3439]">Диагностика системы</h3>
          
          <div v-if="loadingUsage" class="py-8 text-center text-[#A9B4B9]">Анализ телеметрии...</div>
          
          <div v-else-if="usageData && usageData.alerts_and_recommendations.length > 0" class="space-y-3">
             <div v-for="(alert, idx) in usageData.alerts_and_recommendations" :key="idx" 
                  class="flex items-start gap-3 p-4 rounded-xl border"
                  :class="alert.type === 'warning' ? 'bg-red-50 border-red-200 text-red-900' : 'bg-amber-50 border-amber-200 text-amber-900'">
                <div class="text-xl mt-0.5">
                   {{ alert.type === 'warning' ? '🔴' : '⚠️' }}
                </div>
                <div>
                   <h4 class="font-bold text-sm uppercase tracking-wide mb-1 opacity-80">
                     {{ alert.type === 'warning' ? 'Критическая ошибка' : 'Предупреждение системы' }}
                   </h4>
                   <p class="text-sm font-medium">{{ alert.message }}</p>
                </div>
             </div>
          </div>
          <div v-else-if="usageData" class="flex items-center gap-3 p-4 rounded-xl border bg-green-50 border-green-200 text-green-900">
              <span class="text-xl">✅</span>
              <div>
                 <h4 class="font-bold text-sm uppercase tracking-wide mb-0.5 opacity-80">Система работает в штатном режиме</h4>
                 <p class="text-sm font-medium">Квоты в норме, Premium перерасхода не обнаружено.</p>
              </div>
          </div>

          <!-- Quick Actions Grid -->
          <h3 class="font-headline text-lg font-bold text-[#2A3439] mt-8 mb-4">Разделы управления</h3>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
             <router-link to="/admin/ai/tariffs" class="flex flex-col p-4 rounded-xl border border-[#A9B4B9]/30 bg-white hover:border-blue-400 hover:shadow-sm transition-all group">
                <span class="text-2xl mb-2 group-hover:scale-110 transition-transform origin-bottom-left">💎</span>
                <span class="font-bold text-sm text-[#2A3439]">Матрица тарифов</span>
                <span class="text-[10px] text-[#566166] mt-1">Правила маршрутизации</span>
             </router-link>
             <router-link to="/admin/ai/policies" class="flex flex-col p-4 rounded-xl border border-[#A9B4B9]/30 bg-white hover:border-blue-400 hover:shadow-sm transition-all group">
                <span class="text-2xl mb-2 group-hover:scale-110 transition-transform origin-bottom-left">🛡️</span>
                <span class="font-bold text-sm text-[#2A3439]">Лимиты и защита</span>
                <span class="text-[10px] text-[#566166] mt-1">Ограничения квот</span>
             </router-link>
             <router-link to="/admin/ai/runs" class="flex flex-col p-4 rounded-xl border border-[#A9B4B9]/30 bg-white hover:border-blue-400 hover:shadow-sm transition-all group">
                <span class="text-2xl mb-2 group-hover:scale-110 transition-transform origin-bottom-left">🚀</span>
                <span class="font-bold text-sm text-[#2A3439]">Запуски Pipeline</span>
                <span class="text-[10px] text-[#566166] mt-1">Живые запуски</span>
             </router-link>
             <router-link to="/admin/ai/debug" class="flex flex-col p-4 rounded-xl border border-[#A9B4B9]/30 bg-white hover:border-blue-400 hover:shadow-sm transition-all group">
                <span class="text-2xl mb-2 group-hover:scale-110 transition-transform origin-bottom-left">🐞</span>
                <span class="font-bold text-sm text-[#2A3439]">Аудит роутера</span>
                <span class="text-[10px] text-[#566166] mt-1">Консоль отладки</span>
             </router-link>
          </div>
       </div>

       <!-- Live Mini Stats (24h) -->
       <div class="space-y-4">
          <h3 class="font-headline text-lg font-bold text-[#2A3439]">Сводка за 24 часа</h3>
          <div class="rounded-xl border border-[#A9B4B9]/25 bg-white p-5 space-y-5" v-if="usageData">
             <div class="flex flex-col">
                <span class="text-[11px] font-bold text-[#A9B4B9] uppercase tracking-wider mb-1">Трафик Pipeline</span>
                <span class="text-2xl font-black text-[#2A3439]">{{ formatNum(usageData.hero_metrics.total_requests) }} <span class="text-sm font-normal text-[#566166]">зап</span></span>
             </div>
             <div class="flex flex-col">
                <span class="text-[11px] font-bold text-[#A9B4B9] uppercase tracking-wider mb-1">Затраты на генерацию</span>
                <span class="text-2xl font-black text-blue-700">${{ usageData.hero_metrics.estimated_cost_usd.toFixed(2) }}</span>
             </div>
             <div class="flex flex-col">
                <span class="text-[11px] font-bold text-[#A9B4B9] uppercase tracking-wider mb-1">Снижения качества (Переходы)</span>
                <div class="flex items-end gap-2">
                   <span class="text-2xl font-black" :class="usageData.hero_metrics.fallback_rate_percent > 5 ? 'text-amber-600' : 'text-green-600'">
                     {{ usageData.hero_metrics.fallback_rate_percent }}%
                   </span>
                </div>
             </div>
             <div class="pt-4 border-t border-gray-100 flex justify-between items-center">
                <span class="text-xs text-[#566166]">Снято Premium запросов</span>
                <span class="text-xs font-bold text-red-600">{{ usageData.hero_metrics.premium_blocked_count }} блок.</span>
             </div>
          </div>
          <div v-else class="rounded-xl border border-[#A9B4B9]/25 bg-gray-50 p-5 h-48 animate-pulse"></div>
       </div>
    </div>

  </AdminShell>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue'
import { API } from '@/lib/api'
import AdminShell from '@/components/admin/AdminShell.vue'

const modes = [
  { id: 'auto', title: 'Авто', label: 'По умолчанию' },
  { id: 'economy', title: 'Экономия', label: 'Меньше затрат' },
  { id: 'balanced', title: 'Баланс', label: 'Оптимальный' },
  { id: 'quality', title: 'Качество', label: 'Макс. результат' },
  { id: 'manual', title: 'Ручной', label: 'Без логики ИИ' }
]

const policies = reactive({
  routing_mode: 'auto'
})

const loadingMode = ref(true)
const savingMode = ref(false)

const loadingUsage = ref(true)
const usageData = ref(null)

async function loadData() {
  loadingMode.value = true
  loadingUsage.value = true
  try {
    const [polRes, usgRes] = await Promise.all([
      API.adminGetGlobalPolicies(),
      API.adminGetUsageOverview('24h') // Home page always shows 24h immediate pulse
    ])
    if (polRes.policies) {
      policies.routing_mode = polRes.policies.routing_mode
    }
    usageData.value = usgRes
  } catch (e) {
    console.error('Home Dashboard error:', e)
  } finally {
    loadingMode.value = false
    loadingUsage.value = false
  }
}

async function setGlobalMode(modeId) {
  if (policies.routing_mode === modeId) return
  
  savingMode.value = true
  try {
    // Only update routing_mode to avoid overwriting other policy flags inadvertently
    // But since API requires passing all or relies on partial update, let's fetch first to be safe
    const polRes = await API.adminGetGlobalPolicies()
    const current = polRes.policies || {}
    const updated = { ...current, routing_mode: modeId }
    
    await API.adminUpdateGlobalPolicies(updated)
    policies.routing_mode = modeId
  } catch (e) {
    console.error('Failed to update mode', e)
    alert('Ошибка при смене режима')
  } finally {
    savingMode.value = false
  }
}

function formatNum(n) {
  return new Intl.NumberFormat('en-US').format(n || 0)
}

onMounted(() => {
  loadData()
})
</script>
