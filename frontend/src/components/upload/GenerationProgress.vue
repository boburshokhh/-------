<template>
  <div class="max-w-3xl mx-auto w-full space-y-6">

    <!-- ── Фазовые шаги (светлый фон, без hover) ─────────────────── -->
    <div
      class="phase-pills-row flex items-center justify-between gap-2 flex-wrap"
      role="list"
      aria-label="Этапы обработки"
    >
      <div
        v-for="pill in phasePills"
        :key="pill.id"
        class="pill"
        :class="pill.state"
        role="listitem"
        :aria-current="pill.state === 'active' ? 'step' : undefined"
      >
        <span class="pill-dot" aria-hidden="true"></span>
        <span class="pill-label">{{ pill.label }}</span>
        <span v-if="pill.state === 'done'" class="pill-check" aria-hidden="true">✓</span>
      </div>
    </div>

    <!-- ── Простой лоадер + процент ───────────────────────────────── -->
    <div class="flex flex-col items-center gap-4 py-2">
      <div
        v-if="isActive"
        class="simple-spinner"
        role="status"
        aria-label="Идёт обработка"
      />
      <div class="text-center">
        <p class="percent-number">
          <template v-if="showNumericPercent || isDone || isError">
            {{ displayPercent }}<span class="percent-sign">%</span>
          </template>
          <template v-else>
            <span class="percent-dash">—</span>
          </template>
        </p>
        <p class="phase-label-plain">{{ phaseLabel }}</p>
      </div>
      <div v-if="showNumericPercent || isDone || isError" class="progress-track w-full max-w-md">
        <div
          class="progress-fill"
          :class="{ 'progress-fill--done': isDone && !isError, 'progress-fill--error': isError }"
          :style="{ width: `${Math.min(100, Math.max(0, displayPercent))}%` }"
        />
      </div>
    </div>

    <!-- ── Текущий статус ─────────────────────────────────────────── -->
    <div class="status-card">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span v-if="isActive" class="status-dot status-dot--live"></span>
          <span v-else-if="isDone" class="status-dot status-dot--done"></span>
          <span v-else-if="isError" class="status-dot status-dot--error"></span>
          <span class="status-title">{{ statusTitle }}</span>
        </div>
        <span class="model-badge">{{ modelLabel }}</span>
      </div>
      <p class="status-detail">{{ currentDetail }}</p>
    </div>

    <!-- ── Маршрутизация (предпросмотр / итог) ─────────────────────── -->
    <div v-if="routingPreview || routingResult" class="routing-panel">
      <p class="routing-panel__title">Маршрутизация моделей</p>
      <div v-if="isDone && routingResult" class="routing-block routing-block--result">
        <p class="routing-label">Итог генерации</p>
        <ul class="routing-list text-sm">
          <li v-if="routingResult.routing_mode_requested">
            Запрошенный режим: <strong>{{ routingResult.routing_mode_requested }}</strong>
            → эффективный: <strong>{{ routingResult.routing_mode_effective || '—' }}</strong>
          </li>
          <li v-if="routingResult.pipeline_execution_mode">
            Режим пайплайна: <strong>{{ routingResult.pipeline_execution_mode }}</strong>
            <span v-if="routingResult.pipeline_execution_mode === 'quota_offline' || routingResult.quota_offline" class="text-amber-800"> (downgrade: квота LLM)</span>
            <span v-if="routingResult.pipeline_execution_mode === 'degraded'" class="text-amber-800"> (downgrade: деградация)</span>
            <span v-if="routingResult.pipeline_execution_mode === 'emergency_fallback'" class="text-amber-800"> (downgrade: запасной путь)</span>
          </li>
          <li v-if="routingResult.degraded_reasons?.length">
            Причины деградации: {{ routingResult.degraded_reasons.join(', ') }}
          </li>
          <li v-if="routingResult.models_by_agent && Object.keys(routingResult.models_by_agent).length">
            Модели по ролям:
            <span class="font-mono text-xs">{{ formatModelsByAgent(routingResult.models_by_agent) }}</span>
          </li>
        </ul>
      </div>
      <div v-else-if="routingPreview" class="routing-block">
        <p class="routing-label">Перед запуском (оценка)</p>
        <ul class="routing-list text-sm">
          <li>Эффективный режим: <strong>{{ routingPreview.effective_mode }}</strong>
            <span v-if="routingPreview.requested_mode !== routingPreview.effective_mode" class="text-[#566166]">
              (запрошено: {{ routingPreview.requested_mode }})
            </span>
          </li>
          <li v-if="routingPreview.base_config_routing_mode && routingPreview.requested_mode === 'auto'">
            Базовый режим в настройках: <strong>{{ routingPreview.base_config_routing_mode }}</strong>
          </li>
          <li v-if="routingPreview.downgrade_active" class="text-[#9F403D] font-medium">
            Активен аварийный downgrade (экономия моделей).
          </li>
          <li v-if="routingPreview.policies?.premium_guard_enabled && routingPreview.premium_budget && !routingPreview.premium_budget.allowed" class="text-[#9F403D]">
            Premium ограничен политикой сейчас.
          </li>
          <li v-else-if="routingPreview.premium_budget?.warning" class="text-amber-800">
            Premium: приближение к мягкому лимиту (~{{ routingPreview.premium_budget.premiumPercent ?? routingPreview.premium_budget.premium_percent }}%).
          </li>
          <li v-for="(line, i) in routingPreview.explanations" :key="'e'+i">{{ line }}</li>
        </ul>
        <div v-if="routingPreview.stage_preview && !routingPreview.stage_preview._error" class="mt-2 space-y-1 text-xs text-[#566166]">
          <p class="font-semibold text-[#2A3439]">Оценка моделей по стадиям</p>
          <div v-for="(info, key) in stagePreviewFiltered" :key="key" class="font-mono">
            {{ stageLabel(key) }}: {{ info.selected }}
            <span v-if="info.premium_blocked" class="text-[#9F403D]">[premium off]</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Лог-терминал ───────────────────────────────────────────── -->
    <div class="terminal-card">
      <div class="terminal-header">
        <div class="flex items-center gap-2">
          <span class="terminal-dot red"></span>
          <span class="terminal-dot yellow"></span>
          <span class="terminal-dot green"></span>
          <span class="terminal-title">генератор · stdout</span>
        </div>
        <span class="terminal-count">{{ logHistory.length }} событий</span>
      </div>
      <div ref="logContainerRef" class="terminal-body">
        <div v-if="!logHistory.length" class="terminal-empty">
          Ожидание первого события...
        </div>
        <div
          v-for="(entry, idx) in logHistory"
          :key="entry.id"
          class="log-row"
          :class="{ 'log-row--last': idx === logHistory.length - 1 }"
        >
          <span class="log-ts">{{ entry.ts }}</span>
          <span class="log-icon" :class="entry.colorClass">{{ entry.icon }}</span>
          <span class="log-msg" :class="{ 'log-msg--active': idx === logHistory.length - 1 }">{{ entry.text }}</span>
          <span class="log-pct" :class="entry.colorClass">{{ entry.percent }}%</span>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { getStageLabelRu } from '@/lib/routingLabels'

const props = defineProps({
  percent:          { type: Number, default: 0 },
  phase:            { type: String, default: '' },
  stage:            { type: String, default: '' },
  detail:           { type: String, default: '' },
  updatedAt:        { type: Number, default: 0 },
  modelLabel:       { type: String, default: 'LLM' },
  /** Снимок GET /api/generation-routing до/во время генерации */
  routingPreview:   { type: Object, default: null },
  /** Фрагмент generation_metrics после завершения (routing + models_by_agent) */
  routingResult:    { type: Object, default: null },
  /** С бэкенда: известен полный объём работ (workTotal) */
  volumeReady:      { type: Boolean, default: false },
  /** История [PROGRESS] с сервера (тот же поток, что в логах) */
  progressHistory:  { type: Array, default: () => [] },
})

function stageLabel(key) {
  return getStageLabelRu(key)
}

function formatModelsByAgent(obj) {
  if (!obj || typeof obj !== 'object') return '—'
  return Object.entries(obj)
    .map(([k, v]) => `${k.replace(/_agent$/, '')}: ${v || '—'}`)
    .join(' · ')
}

const stagePreviewFiltered = computed(() => {
  const sp = props.routingPreview?.stage_preview
  if (!sp || typeof sp !== 'object') return {}
  const { _error, ...rest } = sp
  return rest
})

// ── State ──────────────────────────────────────────────────────────
const logHistory      = ref([])
const logContainerRef = ref(null)

// ── Computed helpers ───────────────────────────────────────────────
const isDone    = computed(() => props.phase === 'done' || props.percent >= 100)
const isError   = computed(() => props.phase === 'error')

const showNumericPercent = computed(() => props.volumeReady || isDone.value || isError.value)

const displayPercent = computed(() => Math.max(0, Math.min(100, Math.round(props.percent))))

const isActive  = computed(() => !isDone.value && !isError.value && props.phase !== '' && props.phase !== 'error')

// ── Phase label (emoji + short text) ──────────────────────────────
const phaseLabel = computed(() => {
  if (isDone.value)  return '✓ Готово'
  if (isError.value) return '✗ Ошибка'
  if (!showNumericPercent.value && isActive.value) return '◌ Объём работ'
  const map = {
    upload:   '↑ Загрузка',
    parse:    '◉ Разбор',
    db:       '⊕ База данных',
    index:    '⊞ Индексация',
    generate: '⬡ Генерация',
    validate: '◎ Валидация',
    dedup:    '⊗ Дедупликация',
    backfill: '⊕ Дополнение',
    finalize: '◈ Финализация',
  }
  return map[props.phase] || '◌ Ожидание'
})

// ── Status card ────────────────────────────────────────────────────
const statusTitle = computed(() => {
  if (isDone.value)  return 'Тест успешно создан'
  if (isError.value) return 'Ошибка генерации'
  if (isActive.value && !showNumericPercent.value) return 'Считаем полный объём задачи…'
  if (isActive.value) return 'Движок работает · прогресс по шагам с сервера'
  return 'Ожидание запуска'
})

const currentDetail = computed(() => {
  if (props.detail) return props.detail
  return `Этап: ${props.stage || '—'} · Фаза: ${props.phase || '—'}`
})

// ── Phase pills ────────────────────────────────────────────────────
const PHASE_ORDER = ['upload', 'parse', 'db', 'index', 'generate', 'validate', 'done']
const pillDefs = [
  { id: 'upload',   phases: ['upload'],                     label: 'Загрузка'    },
  { id: 'parse',    phases: ['parse', 'db'],                label: 'Разбор'      },
  { id: 'index',    phases: ['index'],                      label: 'Индексация'  },
  { id: 'generate', phases: ['generate', 'validate', 'dedup', 'backfill', 'finalize'], label: 'ИИ Генерация' },
  { id: 'done',     phases: ['done'],                       label: 'Готово'      },
]

const phasePills = computed(() => {
  const cur = props.phase
  const curOrder = PHASE_ORDER.indexOf(cur)

  return pillDefs.map(pill => {
    const pillMaxOrder = Math.max(...pill.phases.map(p => {
      const idx = PHASE_ORDER.indexOf(p)
      return idx === -1 ? 99 : idx
    }))

    const isInPill = pill.phases.includes(cur)

    let state = 'waiting'
    if (isDone.value) {
      state = pill.id === 'done' ? 'done' : 'done'
    } else if (isInPill) {
      state = 'active'
    } else if (curOrder > pillMaxOrder) {
      state = 'done'
    }

    return { ...pill, state }
  })
})

// ── Log accumulation ───────────────────────────────────────────────
function phaseIcon(phase, stage) {
  if (phase === 'error')    return '✗'
  if (phase === 'done')     return '✓'
  if (stage === 'llm_batch' || stage === 'backfill_batch') return '⬡'
  if (stage === 'blueprint') return '⊟'
  if (stage === 'themes')    return '⊞'
  if (stage === 'language')  return '◉'
  if (stage === 'dedup')     return '⊗'
  if (stage === 'backfill')  return '⊕'
  if (stage === 'finalize' || stage === 'ready') return '◈'
  const icons = { upload: '↑', parse: '◉', db: '⊕', index: '⊞', generate: '⬡', validate: '◎' }
  return icons[phase] || '·'
}

function phaseColor(phase) {
  if (phase === 'error')    return 'cl-red'
  if (phase === 'done')     return 'cl-green'
  if (phase === 'generate' || phase === 'validate') return 'cl-purple'
  if (phase === 'index')    return 'cl-cyan'
  return 'cl-blue'
}

function stageToMessage(phase, stage, detail) {
  const d = detail ? ` — ${detail}` : ''
  const map = {
    'upload:':           'Отправка файла на сервер...',
    'parse:reading':     'Чтение и декодирование документа',
    'parse:parsed':      `Текст извлечён${d}`,
    'db:saving':         'Сохранение в базу данных',
    'db:saved':          `Документ зарегистрирован${d}`,
    'index:indexing':    `Индексация и векторизация чанков${d}`,
    'index:indexed':     `Индекс построен${d}`,
    'index:chunks_saved':'Новые фрагменты сохранены в БД',
    'index:embeddings':  `Векторные эмбеддинги${d}`,
    'index:summaries':   `Краткие выжимки по чанкам${d}`,
    'index:cache_hit':   `Индекс из кэша${d}`,
    'generate:language': 'Определение языка документа',
    'generate:themes':   'Извлечение тематических блоков из документа',
    'generate:blueprint':'Построение плана вопросов (blueprint)',
    'generate:llm_batch':'ИИ генерирует вопросы батчами...',
    'generate:backfill_batch': 'Добор вопросов: пакет LLM',
    'validate:':         'Валидация качества вопросов',
    'generate:dedup':    'Семантическая дедупликация вопросов',
    'generate:backfill': 'Дозаполнение пробелов в тесте',
    'generate:finalize': 'Финализация и ранжирование вопросов',
    'generate:ready':    'Подготовка к сохранению',
    'done:saved_test':   `Тест сохранён${d}`,
    'error:':            `Ошибка${d}`,
  }
  const key = `${phase}:${stage}`
  if (map[key]) return map[key]
  // Partial match on phase
  for (const k of Object.keys(map)) {
    if (k.startsWith(`${phase}:`) && k.endsWith(':')) return map[k]
  }
  if (detail) return detail
  return `${phase} · ${stage}`
}

function scrollLogToEnd() {
  nextTick(() => {
    if (logContainerRef.value) {
      logContainerRef.value.scrollTop = logContainerRef.value.scrollHeight
    }
  })
}

function rowFromProgressEntry(entry, idx) {
  const phase = entry.phase || ''
  const stage = entry.stage || ''
  return {
    id:         `${entry.updatedAt}-${idx}-${stage}`,
    ts:         entry.updatedAt ? new Date(entry.updatedAt).toLocaleTimeString('ru-RU') : '—',
    icon:       phaseIcon(phase, stage),
    colorClass: phaseColor(phase),
    text:       stageToMessage(phase, stage, entry.detail),
    percent:    Math.max(0, Math.min(100, Math.round(Number(entry.percent) || 0))),
  }
}

function syncLogFromProps() {
  const h = props.progressHistory || []
  if (h.length) {
    logHistory.value = h.map((entry, idx) => rowFromProgressEntry(entry, idx))
    scrollLogToEnd()
    return
  }
  if (props.phase) {
    logHistory.value = [rowFromProgressEntry({
      updatedAt: props.updatedAt || Date.now(),
      phase: props.phase,
      stage: props.stage,
      detail: props.detail,
      percent: props.percent,
    }, 0)]
    scrollLogToEnd()
  }
}

watch(
  () => [props.progressHistory, props.updatedAt, props.phase, props.stage, props.detail, props.percent],
  () => syncLogFromProps(),
  { deep: true },
)

onMounted(() => syncLogFromProps())
</script>

<style scoped>
/* ── Phase pills (белый фон: контур + лёгкая заливка, без hover) ─ */
.phase-pills-row {
  padding-bottom: 2px;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  min-height: 2rem;
  border-radius: 9999px;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  flex: 1 1 0;
  min-width: 5.5rem;
  justify-content: center;
  box-sizing: border-box;
  transition: none;
}
.pill-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
/* Ожидание: нейтральный контур */
.pill.waiting {
  background: #FFFFFF;
  color: #94A3B8;
  border: 1px solid #E1E9EE;
}
.pill.waiting .pill-dot {
  background: #CBD5E1;
}
/* Текущий этап: акцент бренда, заметно но без «неона» */
.pill.active {
  background: rgba(55, 85, 195, 0.08);
  color: #3755C3;
  border: 1.5px solid #3755C3;
}
.pill.active .pill-dot {
  background: #3755C3;
}
/* Завершённые шаги */
.pill.done {
  background: #F0FDF4;
  color: #047857;
  border: 1px solid #A7F3D0;
}
.pill.done .pill-dot {
  background: #10B981;
}
.pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.pill-check {
  font-size: 0.6rem;
  font-weight: 800;
  color: #059669;
  line-height: 1;
}

/* ── Simple loader + percent ───────────────────────────────────── */
.simple-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #E1E9EE;
  border-top-color: #3755C3;
  border-radius: 50%;
  animation: spin 0.85s linear infinite;
}

.percent-number {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 2.25rem;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: #2A3439;
  line-height: 1.2;
}
.percent-sign {
  font-size: 1.25rem;
  font-weight: 700;
  color: #566166;
  margin-left: 2px;
}
.percent-dash {
  color: #94A3B8;
}
.phase-label-plain {
  margin-top: 0.35rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #64748B;
}

.progress-track {
  height: 8px;
  border-radius: 9999px;
  background: #E1E9EE;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  border-radius: 9999px;
  background: linear-gradient(90deg, #3755C3, #5B7AE8);
  transition: width 0.35s ease;
}
.progress-fill--done {
  background: linear-gradient(90deg, #059669, #34D399);
}
.progress-fill--error {
  background: linear-gradient(90deg, #DC2626, #F87171);
}

/* ── Status card ────────────────────────────────────────────────── */
.status-card {
  background: #FFFFFF;
  border: 1px solid rgba(169, 180, 185, 0.2);
  border-radius: 1rem;
  padding: 1.25rem 1.5rem;
}
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot--live {
  background: #3755C3;
}
.status-dot--done {
  background: #10B981;
}
.status-dot--error {
  background: #EF4444;
}
.status-title {
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #2A3439;
}
.model-badge {
  font-size: 0.65rem;
  font-family: monospace;
  background: #E1E9EE;
  color: #435368;
  padding: 2px 8px;
  border-radius: 4px;
}
.status-detail {
  margin-top: 0.5rem;
  font-size: 0.8rem;
  color: #566166;
  line-height: 1.5;
  font-style: italic;
}

.routing-panel {
  border-radius: 1rem;
  border: 1px solid rgba(169, 180, 185, 0.35);
  background: #f8fafb;
  padding: 1rem 1.1rem;
}
.routing-panel__title {
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #435368;
  margin-bottom: 0.6rem;
}
.routing-block--result {
  border-left: 3px solid #3755c3;
  padding-left: 0.65rem;
}
.routing-label {
  font-size: 0.7rem;
  font-weight: 700;
  color: #2a3439;
  margin-bottom: 0.35rem;
}
.routing-list {
  margin: 0;
  padding-left: 1.1rem;
  color: #566166;
  line-height: 1.45;
}
.routing-list li {
  margin-bottom: 0.25rem;
}

/* ── Terminal ───────────────────────────────────────────────────── */
.terminal-card {
  border-radius: 1rem;
  overflow: hidden;
  border: 1px solid #1E293B;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}
.terminal-header {
  background: #1E293B;
  padding: 8px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.terminal-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.terminal-dot.red    { background: #FF5F57; }
.terminal-dot.yellow { background: #FEBC2E; }
.terminal-dot.green  { background: #28C840; }
.terminal-title {
  font-size: 0.68rem;
  font-family: monospace;
  color: #64748B;
  letter-spacing: 0.06em;
}
.terminal-count {
  font-size: 0.62rem;
  font-family: monospace;
  color: #475569;
}
.terminal-body {
  background: #0F172A;
  padding: 12px 14px;
  max-height: 13rem;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #334155 #0F172A;
}
.terminal-body::-webkit-scrollbar       { width: 4px; }
.terminal-body::-webkit-scrollbar-track { background: #0F172A; }
.terminal-body::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }

.terminal-empty {
  font-family: monospace;
  font-size: 0.72rem;
  color: #334155;
  text-align: center;
  padding: 1rem 0;
}

.log-row {
  display: grid;
  grid-template-columns: 5.5rem 1.4rem 1fr auto;
  align-items: baseline;
  gap: 6px;
  padding: 2px 0;
  border-bottom: 1px solid #0D1B2A;
}
.log-row--last {
  background: rgba(55, 85, 195, 0.06);
}
.log-ts {
  font-family: monospace;
  font-size: 0.63rem;
  color: #475569;
  flex-shrink: 0;
}
.log-icon {
  font-size: 0.7rem;
  text-align: center;
}
.log-msg {
  font-family: monospace;
  font-size: 0.72rem;
  color: #94A3B8;
  word-break: break-all;
}
.log-msg--active {
  color: #E2E8F0;
  font-weight: 700;
}
.log-pct {
  font-family: monospace;
  font-size: 0.63rem;
  flex-shrink: 0;
}

/* Color classes for icons & percent */
.cl-blue   { color: #60A5FA; }
.cl-purple { color: #A78BFA; }
.cl-cyan   { color: #38BDF8; }
.cl-green  { color: #34D399; }
.cl-red    { color: #F87171; }

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
