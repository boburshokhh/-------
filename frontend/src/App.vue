<script setup lang="ts">
import { ref } from 'vue'
import { RouterView, RouterLink } from 'vue-router'
import { Toaster } from '@/components/ui/toast'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import ServerLogsPanel from '@/components/ServerLogsPanel.vue'
import { useServerLogAlerts } from '@/composables/useServerLogAlerts'
import { ScrollText } from 'lucide-vue-next'

const logsOpen = ref(false)

useServerLogAlerts()
</script>

<template>
  <div class="min-h-screen bg-neutral-50 text-neutral-950 font-sans">
    <header class="bg-white border-b border-neutral-200 sticky top-0 z-40">
      <div class="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
        <RouterLink to="/" class="flex items-center gap-2 font-bold text-xl tracking-tight shrink-0">
          <span class="text-2xl">🧠</span>
          <span>AI Test<span class="text-blue-600">Gen</span></span>
        </RouterLink>
        <nav class="flex items-center gap-4 sm:gap-6 text-sm font-medium">
          <RouterLink to="/" class="hover:text-blue-600 transition-colors duration-150" active-class="text-blue-600">
            Загрузка
          </RouterLink>
          <RouterLink to="/tests" class="hover:text-blue-600 transition-colors duration-150" active-class="text-blue-600">
            Тесты
          </RouterLink>
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="gap-1.5 text-neutral-800 border-neutral-300 hover:bg-neutral-50 hover:text-blue-600 transition-colors duration-150"
            @click="logsOpen = true"
          >
            <ScrollText class="w-4 h-4" />
            Логи
          </Button>
        </nav>
      </div>
    </header>

    <Sheet v-model:open="logsOpen">
      <SheetContent
        side="right"
        class="w-full sm:max-w-lg flex flex-col gap-0 p-0 overflow-hidden border-l border-neutral-200"
      >
        <SheetHeader class="px-6 pt-6 pb-2 text-left space-y-1">
          <SheetTitle>Логи сервера</SheetTitle>
          <SheetDescription>
            Сообщения backend в реальном времени. Уведомления о квоте и ошибках показываются отдельно.
          </SheetDescription>
        </SheetHeader>
        <div class="flex-1 min-h-0 px-4 pb-6">
          <ServerLogsPanel />
        </div>
      </SheetContent>
    </Sheet>

    <Toaster />

    <main class="max-w-5xl mx-auto px-4 py-8">
      <RouterView />
    </main>
  </div>
</template>
