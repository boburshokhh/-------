import { createRouter, createWebHistory } from 'vue-router'
import { useAppStore } from '@/stores/appStore'

import BibliotekaView from '@/views/BibliotekaView.vue'
import ZagruzkaView from '@/views/ZagruzkaView.vue'
import ProgressView from '@/views/ProgressView.vue'
import TestView from '@/views/TestView.vue'
import ItogView from '@/views/ItogView.vue'
import RazborView from '@/views/RazborView.vue'
import HiddenSettingsView from '@/views/HiddenSettingsView.vue'
import LoginView from '@/views/LoginView.vue'
import RegisterView from '@/views/RegisterView.vue'
import { useAuthStore } from '@/stores/authStore'
import AdminModelsView from '@/views/AdminModelsView.vue'
import AdminRoutingView from '@/views/AdminRoutingView.vue'
import AdminUsageView from '@/views/AdminUsageView.vue'
import AdminPoliciesView from '@/views/AdminPoliciesView.vue'
import AdminDebugDecisionsView from '@/views/AdminDebugDecisionsView.vue'
import RolesStagesView from '@/views/RolesStagesView.vue'
import AdminTariffsView from '@/views/AdminTariffsView.vue'
import AdminRunsListView from '@/views/AdminRunsListView.vue'
import AdminRunDetailsView from '@/views/AdminRunDetailsView.vue'
import AiHomeView from '@/views/AiHomeView.vue'
import AdminModesListView from '@/views/AdminModesListView.vue'
import AdminModeBuilderView from '@/views/AdminModeBuilderView.vue'
import AdminModeTestView from '@/views/AdminModeTestView.vue'
import AdminModeRunsView from '@/views/AdminModeRunsView.vue'

const routes = [
  { path: '/', redirect: '/biblioteka' },
  { path: '/login', component: LoginView },
  { path: '/register', component: RegisterView },
  { path: '/biblioteka', component: BibliotekaView },
  { path: '/zagruzka', component: ZagruzkaView },
  { path: '/progress', component: ProgressView },
  { path: '/test', component: TestView },
  { path: '/itog', component: ItogView },
  { path: '/razbor', component: RazborView },
  { path: '/_hidden/runtime-settings', component: HiddenSettingsView },
  { path: '/admin/ai', redirect: '/admin/ai/home', meta: { adminOnly: true } },
  { path: '/admin/ai/home', component: AiHomeView, meta: { adminOnly: true } },
  { path: '/admin/ai/models', component: AdminModelsView, meta: { adminOnly: true } },
  { path: '/admin/ai/routing', component: AdminRoutingView, meta: { adminOnly: true } },
  { path: '/admin/ai/tariffs', component: AdminTariffsView, meta: { adminOnly: true } },
  { path: '/admin/ai/modes', component: AdminModesListView, meta: { adminOnly: true } },
  { path: '/admin/ai/modes/new', component: AdminModeBuilderView, meta: { adminOnly: true } },
  { path: '/admin/ai/modes/:id', component: AdminModeBuilderView, meta: { adminOnly: true } },
  { path: '/admin/ai/modes/:id/test', component: AdminModeTestView, meta: { adminOnly: true } },
  { path: '/admin/ai/modes/:id/runs', component: AdminModeRunsView, meta: { adminOnly: true } },
  { path: '/admin/ai/runs', component: AdminRunsListView, meta: { adminOnly: true } },
  { path: '/admin/ai/runs/:id', component: AdminRunDetailsView, meta: { adminOnly: true } },
  { path: '/admin/ai/usage', component: AdminUsageView, meta: { adminOnly: true } },
  { path: '/admin/ai/policies', component: AdminPoliciesView, meta: { adminOnly: true } },
  { path: '/admin/ai/debug', component: AdminDebugDecisionsView, meta: { adminOnly: true } },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach((to) => {
  const store = useAppStore()
  const auth = useAuthStore()
  if (to.meta?.adminOnly) {
    const role = auth.state.user?.role
    if (!auth.state.token || role !== 'admin') return '/login'
  }
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
