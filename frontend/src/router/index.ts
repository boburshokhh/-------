import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'upload',
      component: () => import('../views/UploadView.vue')
    },
    {
      path: '/tests',
      name: 'tests',
      component: () => import('../views/TestsView.vue')
    },
    {
      path: '/quiz/:id',
      name: 'quiz',
      component: () => import('../views/QuizView.vue')
    },
    {
      path: '/results/:id',
      name: 'results',
      component: () => import('../views/ResultsView.vue')
    },
    {
      path: '/results/detail/:id',
      name: 'result-detail',
      component: () => import('../views/ResultDetailView.vue')
    }
  ]
})

export default router
