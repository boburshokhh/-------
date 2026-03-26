import { onMounted, onUnmounted } from 'vue'
import { API } from '@/lib/api'
import { toast } from '@/components/ui/toast'
import {
  alertDedupeKey,
  classifyLogLine,
  logFingerprint,
} from '@/lib/logAlerts'

const POLL_MS = 4000
const DEDUPE_MS = 90_000

/**
 * Опрос /api/logs и toast только для новых строк (по сравнению с предыдущим снимком).
 */
export function useServerLogAlerts() {
  let timer: ReturnType<typeof setInterval> | null = null
  const lastShown = new Map<string, number>()
  let prevFingerprints = new Set<string>()
  let initialized = false

  function shouldShowToast(key: string) {
    const now = Date.now()
    const prev = lastShown.get(key) ?? 0
    if (now - prev < DEDUPE_MS) return false
    lastShown.set(key, now)
    return true
  }

  async function poll() {
    try {
      const { logs } = await API.getLogs(200)
      const list = logs || []
      const next = new Set<string>()

      for (const log of list) {
        const fp = logFingerprint(log)
        next.add(fp)

        if (initialized && !prevFingerprints.has(fp)) {
          const info = classifyLogLine(String(log.message ?? ''), log.level)
          if (info) {
            const key = alertDedupeKey(info, String(log.message ?? ''))
            if (shouldShowToast(key)) {
              toast({
                title: info.title,
                description: info.description,
                variant:
                  info.kind === 'quota'
                  || info.kind === 'api_key'
                  || info.kind === 'server_error'
                    ? 'destructive'
                    : 'default',
              })
            }
          }
        }
      }

      prevFingerprints = next
      initialized = true
    }
    catch {
      /* ignore */
    }
  }

  onMounted(() => {
    void poll()
    timer = setInterval(poll, POLL_MS)
  })

  onUnmounted(() => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  })
}
