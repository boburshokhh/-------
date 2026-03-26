<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { API } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RefreshCw } from 'lucide-vue-next'

const logs = ref<any[]>([])
const autoRefresh = ref(true)
let timer: any = null

const loadLogs = async () => {
  try {
    const data = await API.getLogs(200)
    logs.value = data.logs || []
    
    // Auto scroll to bottom
    if (autoRefresh.value) {
      nextTick(() => {
        const viewport = document.querySelector('[data-radix-scroll-area-viewport]')
        if (viewport) {
          viewport.scrollTop = viewport.scrollHeight
        }
      })
    }
  } catch (e) {
    console.error('Failed to load logs', e)
  }
}

const toggleAutoRefresh = () => {
  autoRefresh.value = !autoRefresh.value
  if (autoRefresh.value) {
    timer = setInterval(loadLogs, 2000)
  } else {
    clearInterval(timer)
  }
}

onMounted(() => {
  loadLogs()
  if (autoRefresh.value) {
    timer = setInterval(loadLogs, 2000)
  }
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="py-8 h-[calc(100vh-64px)] flex flex-col">
    <div class="mb-6 flex items-center justify-between shrink-0">
      <div>
        <h1 class="text-3xl font-bold tracking-tight mb-2">Логи сервера</h1>
        <p class="text-neutral-500">Последние сообщения от backend процесса</p>
      </div>
      <div class="flex items-center gap-4">
        <label class="flex items-center gap-2 cursor-pointer text-sm font-medium">
          <input type="checkbox" :checked="autoRefresh" @change="toggleAutoRefresh" class="rounded border-neutral-300 text-blue-600 focus:ring-blue-600" />
          Автообновление
        </label>
        <Button variant="outline" size="sm" @click="loadLogs" class="gap-2">
          <RefreshCw class="w-4 h-4" /> Обновить
        </Button>
      </div>
    </div>

    <div class="flex-1 bg-neutral-950 rounded-xl border overflow-hidden flex flex-col min-h-0">
      <ScrollArea class="flex-1 p-4" ref="scrollAreaRef">
        <div v-if="logs.length === 0" class="text-neutral-500 text-center py-8 font-mono text-sm">
          Логов пока нет...
        </div>
        <div v-else class="font-mono text-[13px] leading-relaxed space-y-1">
          <div v-for="(log, i) in logs" :key="i" class="flex gap-3 hover:bg-neutral-900 px-2 py-0.5 rounded -mx-2">
            <span class="text-neutral-500 shrink-0">{{ log.ts ? `[${log.ts}]` : '' }}</span>
            <span class="shrink-0 font-semibold w-14" 
                  :class="{
                    'text-red-400': log.level === 'ERROR',
                    'text-yellow-400': log.level === 'WARN',
                    'text-blue-400': log.level === 'INFO'
                  }">{{ log.level || 'INFO' }}</span>
            <span class="text-neutral-300 break-words whitespace-pre-wrap">{{ log.message }}</span>
          </div>
        </div>
      </ScrollArea>
    </div>
  </div>
</template>
