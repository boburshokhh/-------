<template>
  <AcademicLayout>
    <section class="max-w-7xl mx-auto px-6 py-10">
      <div class="mb-6">
        <h1 class="text-3xl font-headline font-extrabold text-[#2A3439] tracking-tight">
          Панель управления ИИ
        </h1>
        <p class="text-sm text-[#566166] mt-1">
          Единый центр конфигурации моделей, тарифов, профилей маршрутизации и политик безопасности.
        </p>
      </div>

      <nav class="mb-6 flex flex-wrap gap-2 rounded-xl border border-[#A9B4B9]/25 bg-white p-2">
        <RouterLink
          v-for="tab in tabs"
          :key="tab.to"
          :to="tab.to"
          class="rounded-lg px-3 py-2 text-sm font-semibold transition-colors"
          :class="route.path === tab.to ? 'bg-[#3755C3] text-white' : 'text-[#435368] hover:bg-[#F0F4F7]'"
        >
          {{ tab.label }}
        </RouterLink>
      </nav>

      <slot />
    </section>
  </AcademicLayout>
</template>

<script setup>
import { useRoute } from 'vue-router'
import AcademicLayout from '@/layouts/AcademicLayout.vue'

const route = useRoute()

const tabs = [
  { to: '/admin/ai/home', label: 'Главная ИИ' },
  { to: '/admin/ai/models', label: 'Модели' },
  { to: '/admin/ai/roles-stages', label: 'Роли и этапы' },
  { to: '/admin/ai/routing', label: 'Маршрутизация' },
  { to: '/admin/ai/modes', label: 'Режимы ИИ' },
  { to: '/admin/ai/tariffs', label: 'Тарифы и Пакеты' },
  { to: '/admin/ai/runs', label: 'Запуски' },
  { to: '/admin/ai/usage', label: 'Статистика' },
  { to: '/admin/ai/policies', label: 'Политики' },
  { to: '/admin/ai/debug', label: 'Журнал отладки' },
]
</script>
