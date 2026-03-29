import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from './router'
import { useAuthStore } from '@/stores/authStore'

const { hydrate } = useAuthStore()
hydrate().finally(() => {
  createApp(App).use(router).mount('#app')
})
