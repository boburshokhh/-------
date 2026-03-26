<script setup lang="ts">
import { RouterView, RouterLink } from 'vue-router'
</script>

<template>
  <div class="min-h-screen bg-neutral-50 text-neutral-950 font-sans">
    <header class="bg-white border-b border-neutral-200 sticky top-0 z-10">
      <div class="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
        <RouterLink to="/" class="flex items-center gap-2 font-bold text-xl tracking-tight">
          <span class="text-2xl">🧠</span>
          <span>AI Test<span class="text-blue-600">Gen</span></span>
        </RouterLink>
        <nav class="flex gap-6 text-sm font-medium">
          <RouterLink to="/" class="hover:text-blue-600 transition-colors" active-class="text-blue-600">Загрузка</RouterLink>
          <RouterLink to="/tests" class="hover:text-blue-600 transition-colors" active-class="text-blue-600">Тесты</RouterLink>
          <RouterLink to="/logs" class="hover:text-blue-600 transition-colors" active-class="text-blue-600">Логи</RouterLink>
        </nav>
      </div>
    </header>

    <main class="max-w-5xl mx-auto px-4 py-8">
      <RouterView />
    </main>
  </div>
</template>
