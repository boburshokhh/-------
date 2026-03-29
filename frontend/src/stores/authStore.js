import { reactive, computed } from 'vue';
import * as authSession from '@/lib/authSession';
import { API } from '@/lib/api';

const state = reactive({
  token: authSession.getToken(),
  user: authSession.getSessionUser(),
  hydrateDone: false,
});

async function hydrate() {
  const token = authSession.getToken();
  state.token = token;
  state.user = authSession.getSessionUser();
  if (!token) {
    state.hydrateDone = true;
    return;
  }
  try {
    const { user } = await API.getMe();
    state.user = user;
    authSession.setSession({ token, user });
  } catch {
    authSession.clearSession();
    state.token = null;
    state.user = null;
  } finally {
    state.hydrateDone = true;
  }
}

function applySession(token, user) {
  state.token = token;
  state.user = user;
  authSession.setSession({ token, user });
}

export function useAuthStore() {
  return {
    state,
    isAuthenticated: computed(() => Boolean(state.token && state.user)),
    async login(email, password) {
      const data = await API.login({ email, password });
      applySession(data.token, data.user);
    },
    async register(payload) {
      const data = await API.register(payload);
      applySession(data.token, data.user);
    },
    logout() {
      state.token = null;
      state.user = null;
      authSession.clearSession();
    },
    hydrate,
  };
}
