<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { API } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RefreshCw } from 'lucide-vue-next'

const logs = ref<{ ts?: string; level?: string; message?: string }[]>([])
const autoRefresh = ref(true)
const panelRoot = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

function scrollPanelToBottom() {
  nextTick(() => {
    const root = panelRoot.value
    if (!root) return
    const viewport = root.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  })
}

async function loadLogs() {
  try {
    const data = await API.getLogs(200)
    logs.value = data.logs || []
    if (autoRefresh.value) scrollPanelToBottom()
  }
  catch (e) {
    console.error('Failed to load logs', e)
  }
}

function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value
  if (autoRefresh.value) {
    if (timer) clearInterval(timer)
    timer = setInterval(loadLogs, 2000)
  }
  else {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

onMounted(() => {
  loadLogs()
  if (autoRefresh.value)
    timer = setInterval(loadLogs, 2000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="flex flex-col h-full min-h-[50vh] max-h-[calc(100vh-8rem)]">
    <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-neutral-200 shrink-0">
      <label class="flex items-center gap-2 cursor-pointer text-sm font-medium text-neutral-700">
        <input
          type="checkbox"
          :checked="autoRefresh"
          class="rounded border-neutral-300 text-blue-600 focus:ring-blue-600"
          @change="toggleAutoRefresh"
        >
        Автообновление
      </label>
      <Button variant="outline" size="sm" class="gap-2" @click="loadLogs">
        <RefreshCw class="w-4 h-4" /> Обновить
      </Button>
    </div>

    <div ref="panelRoot" class="flex-1 min-h-0 bg-neutral-950 rounded-b-lg border border-t-0 border-neutral-200 overflow-hidden">
      <ScrollArea class="h-full max-h-[calc(100vh-12rem)] p-3">
        <div v-if="logs.length === 0" class="text-neutral-500 text-center py-8 font-mono text-sm">
          Логов пока нет…
        </div>
        <div v-else class="font-mono text-[12px] leading-relaxed space-y-1">
          <div
            v-for="(log, i) in logs"
            :key="i"
            class="flex gap-2 hover:bg-neutral-900/80 px-1.5 py-0.5 rounded"
          >
            <span class="text-neutral-500 shrink-0">{{ log.ts ? `[${log.ts}]` : '' }}</span>
            <span
              class="shrink-0 font-semibold w-12"
              :class="{
                'text-red-400': log.level === 'ERROR',
                'text-yellow-400': log.level === 'WARN',
                'text-blue-400': log.level === 'INFO',
              }"
            >{{ log.level || 'INFO' }}</span>
            <span
              class="break-words whitespace-pre-wrap"
              :class="log.message?.includes('[PROGRESS]') ? 'text-emerald-300' : 'text-neutral-300'"
            >{{ log.message }}</span>
          </div>
        </div>
      </ScrollArea>
    </div>
  </div>
</template>
