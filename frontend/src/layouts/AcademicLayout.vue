<template>
  <div class="min-h-screen flex flex-col bg-surface text-on-surface font-body">
    <TopNavigation :active-route="activeRoute" />
    <main class="flex-grow">
      <slot />
    </main>
    <SiteFooter />
  </div>
</template>

<script setup>
import TopNavigation from '@/components/navigation/TopNavigation.vue'
import SiteFooter from '@/components/navigation/SiteFooter.vue'
import { useRoute } from 'vue-router'
import { computed } from 'vue'

const route = useRoute()
const activeRoute = computed(() => route.path)
</script>
