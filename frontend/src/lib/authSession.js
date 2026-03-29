const STORAGE_KEY = 'aa_auth_v1';

let cache = null;

function readStorage() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

/** @returns {string|null} */
export function getToken() {
  if (cache === null) {
    cache = readStorage();
  }
  return cache?.token || null;
}

/** @returns {object|null} */
export function getSessionUser() {
  if (cache === null) {
    cache = readStorage();
  }
  return cache?.user || null;
}

/**
 * @param {{ token: string, user: object }} session
 */
export function setSession(session) {
  const token = session?.token || null;
  const user = session?.user || null;
  cache = token ? { token, user } : null;
  try {
    if (cache) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore quota / private mode
  }
}

export function clearSession() {
  cache = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
