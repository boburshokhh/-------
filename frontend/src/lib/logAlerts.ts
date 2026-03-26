/** Классификация строк логов для пользовательских уведомлений */

export type LogAlertKind =
  | 'quota'
  | 'rate'
  | 'upload_size'
  | 'api_key'
  | 'server_error'

export interface LogAlertInfo {
  kind: LogAlertKind
  title: string
  description: string
}

const TRUNC = 180

function trunc(s: string) {
  const t = s.trim()
  return t.length > TRUNC ? `${t.slice(0, TRUNC)}…` : t
}

/**
 * Возвращает уведомление для новой строки лога или null, если не нужно беспокоить пользователя.
 */
export function classifyLogLine(
  message: string,
  level: string | undefined,
): LogAlertInfo | null {
  const m = message
  const low = m.toLowerCase()

  if (
    low.includes('quota exceeded')
    || low.includes('resource_exhausted')
    || low.includes('exceeded your current quota')
    || (low.includes('generativelanguage.googleapis.com') && low.includes('429'))
    || (/\b429\b/.test(m) && (low.includes('quota') || low.includes('generate_content')))
  ) {
    return {
      kind: 'quota',
      title: 'Квота или лимит Gemini',
      description:
        'Запросы к модели временно недоступны (лимит бесплатного тарифа или квота). Подождите или проверьте биллинг в Google AI Studio.',
    }
  }

  if (
    low.includes('rate limit')
    || low.includes('too many requests')
    || (low.includes('retry') && low.includes('resource exhausted'))
  ) {
    return {
      kind: 'rate',
      title: 'Слишком много запросов',
      description: 'Сервис просит подождать. Повторите попытку через минуту.',
    }
  }

  if (
    low.includes(' 413 ')
    || low.includes('" 413"')
    || low.includes('request entity too large')
    || low.includes('client intended to send too large')
  ) {
    return {
      kind: 'upload_size',
      title: 'Файл не принят (слишком большой)',
      description:
        'Прокси или сервер отклонили загрузку. Уменьшите файл или увеличьте client_max_body_size в nginx.',
    }
  }

  if (
    low.includes('api key')
    || low.includes('invalid api key')
    || low.includes('unauthorized')
    || (low.includes('401') && low.includes('gemini'))
  ) {
    return {
      kind: 'api_key',
      title: 'Проблема с API-ключом',
      description: 'Проверьте переменную GEMINI_API_KEY и доступ к API.',
    }
  }

  if (level === 'ERROR') {
    if (
      low.includes('econnrefused')
      || low.includes('enotfound')
      || low.includes('fetch failed')
      || low.includes('socket hang up')
    ) {
      return {
        kind: 'server_error',
        title: 'Сетевая ошибка',
        description: trunc(m),
      }
    }
    if (
      low.includes('[generator]')
      || low.includes('[upload]')
      || low.includes('unhandled')
    ) {
      return {
        kind: 'server_error',
        title: 'Ошибка при обработке',
        description: trunc(m),
      }
    }
  }

  return null
}

export function alertDedupeKey(info: LogAlertInfo, message: string): string {
  if (info.kind === 'quota' || info.kind === 'rate' || info.kind === 'upload_size' || info.kind === 'api_key') {
    return info.kind
  }
  return `${info.kind}:${message.slice(0, 64)}`
}

export function logFingerprint(log: { ts?: string; level?: string; message?: string }) {
  return `${log.ts ?? ''}|${log.level ?? ''}|${String(log.message ?? '').slice(0, 400)}`
}
