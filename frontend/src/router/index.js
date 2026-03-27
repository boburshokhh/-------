import { createRouter, createWebHistory } from 'vue-router'
import { useAppStore } from '@/stores/appStore'

import BibliotekaView from '@/views/BibliotekaView.vue'
import ZagruzkaView from '@/views/ZagruzkaView.vue'
import ProgressView from '@/views/ProgressView.vue'
import TestView from '@/views/TestView.vue'
import ItogView from '@/views/ItogView.vue'
import RazborView from '@/views/RazborView.vue'
import HiddenSettingsView from '@/views/HiddenSettingsView.vue'

const routes = [
  { path: '/', redirect: '/biblioteka' },
  { path: '/biblioteka', component: BibliotekaView },
  { path: '/zagruzka', component: ZagruzkaView },
  { path: '/progress', component: ProgressView },
  { path: '/test', component: TestView },
  { path: '/itog', component: ItogView },
  { path: '/razbor', component: RazborView },
  { path: '/_hidden/runtime-settings', component: HiddenSettingsView },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach((to) => {
  const store = useAppStore()
  if (to.path === '/test') {
    const hasId = Boolean(to.query?.testId || store.state.upload.testId)
    if (!hasId) return '/biblioteka'
  }
  if (to.path === '/razbor') {
    const hasResult = Boolean(to.query?.resultId || store.state.resultSummary?.resultId)
    if (!hasResult) return '/itog'
  }
  return true
})

export default router
