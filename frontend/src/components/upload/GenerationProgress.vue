<template>
  <div class="max-w-3xl mx-auto w-full space-y-6">

    <!-- ── Фазовые пилюли ─────────────────────────────────────────── -->
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <div
        v-for="pill in phasePills"
        :key="pill.id"
        class="pill"
        :class="pill.state"
      >
        <span class="pill-dot" :class="{ 'pulse-dot': pill.state === 'active' }"></span>
        <span>{{ pill.label }}</span>
        <span v-if="pill.state === 'done'" class="pill-check">✓</span>
      </div>
    </div>

    <!-- ── Центральный SVG + процент ──────────────────────────────── -->
    <div class="flex justify-center">
      <div class="neural-wrapper">
        <svg
          viewBox="0 0 260 260"
          width="260"
          height="260"
          class="neural-svg"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <!-- Glow filter -->
            <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="glow-strong" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="7" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <!-- Gradient for ring -->
            <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" :stop-color="ringColor1" />
              <stop offset="100%" :stop-color="ringColor2" />
            </linearGradient>
            <!-- Radial glow bg -->
            <radialGradient id="bgGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" :stop-color="glowBgColor" stop-opacity="0.18" />
              <stop offset="100%" stop-color="#0F172A" stop-opacity="0" />
            </radialGradient>
          </defs>

          <!-- Background circle glow -->
          <circle cx="130" cy="130" r="120" fill="url(#bgGlow)" />

          <!-- Track ring -->
          <circle
            cx="130" cy="130" r="114"
            fill="none"
            stroke="#1E293B"
            stroke-width="8"
          />

          <!-- Progress ring -->
          <circle
            cx="130" cy="130" r="114"
            fill="none"
            stroke="url(#ringGrad)"
            stroke-width="8"
            stroke-linecap="round"
            :stroke-dasharray="ringCircumference"
            :stroke-dashoffset="ringOffset"
            transform="rotate(-90 130 130)"
            class="progress-ring"
            filter="url(#glow)"
          />

          <!-- ── Neural network lines ─────────────────────────── -->
          <g opacity="0.55">
            <!-- Hex nodes to center -->
            <line v-for="n in hexNodes" :key="'lc'+n.id"
              :x1="n.x" :y1="n.y" x2="130" y2="130"
              stroke="#3755C3" stroke-width="1"
              class="neural-line" :style="{ animationDelay: n.delay }"
            />
            <!-- Hex node to adjacent hex nodes -->
            <line v-for="e in hexEdges" :key="'le'+e.id"
              :x1="e.x1" :y1="e.y1" :x2="e.x2" :y2="e.y2"
              stroke="#2747B6" stroke-width="0.8"
              class="neural-line" :style="{ animationDelay: e.delay }"
            />
          </g>

          <!-- ── Orbital particles ───────────────────────────── -->
          <g v-if="isActive">
            <circle r="4" fill="#7C9FFF" filter="url(#glow)" class="orbit orbit-1">
              <animateMotion dur="3s" repeatCount="indefinite">
                <mpath href="#orbitPath1" />
              </animateMotion>
            </circle>
            <circle r="3" fill="#A78BFA" filter="url(#glow)" class="orbit orbit-2">
              <animateMotion dur="5s" repeatCount="indefinite" begin="-1.5s">
                <mpath href="#orbitPath2" />
              </animateMotion>
            </circle>
            <circle r="2.5" fill="#38BDF8" filter="url(#glow)" class="orbit orbit-3">
              <animateMotion dur="7s" repeatCount="indefinite" begin="-3s">
                <mpath href="#orbitPath3" />
              </animateMotion>
            </circle>
          </g>

          <!-- Orbit paths (hidden) -->
          <defs>
            <path id="orbitPath1" d="M130,40 A90,90 0 1,1 129.99,40" fill="none" />
            <path id="orbitPath2" d="M130,58 A72,72 0 1,0 129.99,58" fill="none" />
            <path id="orbitPath3" d="M130,72 A58,58 0 1,1 129.99,72" fill="none" />
          </defs>

          <!-- ── Hex neural nodes ────────────────────────────── -->
          <g v-for="n in hexNodes" :key="'node'+n.id">
            <circle
              :cx="n.x" :cy="n.y" r="7"
              :fill="n.id === activeHexNode ? '#3755C3' : '#1E3A5F'"
              :filter="n.id === activeHexNode ? 'url(#glow-strong)' : 'none'"
              :class="{ 'node-pulse': n.id === activeHexNode }"
              stroke="#3755C3" stroke-width="1"
            />
          </g>

          <!-- Center node -->
          <circle
            cx="130" cy="130" r="10"
            :fill="isDone ? '#10B981' : (isError ? '#EF4444' : '#3755C3')"
            filter="url(#glow-strong)"
            :class="{ 'node-pulse': isActive, 'done-flash': isDone }"
          />

          <!-- ── Percent text ─────────────────────────────────── -->
          <text
            x="130" y="185"
            text-anchor="middle"
            class="percent-text"
            :fill="isDone ? '#10B981' : (isError ? '#EF4444' : '#E2E8F0')"
          >{{ displayPercent }}%</text>

          <!-- Phase emoji label -->
          <text
            x="130" y="203"
            text-anchor="middle"
            class="phase-label-text"
            fill="#94A3B8"
          >{{ phaseLabel }}</text>
        </svg>
      </div>
    </div>

    <!-- ── Текущий статус ─────────────────────────────────────────── -->
    <div class="status-card">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span v-if="isActive" class="live-dot"></span>
          <span v-else-if="isDone" class="done-dot"></span>
          <span v-else-if="isError" class="error-dot"></span>
          <span class="status-title">{{ statusTitle }}</span>
        </div>
        <span class="model-badge">{{ modelLabel }}</span>
      </div>
      <p class="status-detail">{{ currentDetail }}</p>
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

const props = defineProps({
  percent:    { type: Number, default: 0 },
  phase:      { type: String, default: '' },
  stage:      { type: String, default: '' },
  detail:     { type: String, default: '' },
  updatedAt:  { type: Number, default: 0 },
  modelLabel: { type: String, default: 'LLM' },
})

// ── State ──────────────────────────────────────────────────────────
const logHistory      = ref([])
const logContainerRef = ref(null)

// ── Computed helpers ───────────────────────────────────────────────
const isActive  = computed(() => props.percent > 0 && props.percent < 100 && props.phase !== 'error')
const isDone    = computed(() => props.phase === 'done' || props.percent >= 100)
const isError   = computed(() => props.phase === 'error')

const displayPercent = computed(() => Math.max(0, Math.min(100, Math.round(props.percent))))

// ── Ring geometry ──────────────────────────────────────────────────
const ringCircumference = computed(() => 2 * Math.PI * 114)
const ringOffset = computed(() => {
  const pct = displayPercent.value / 100
  return ringCircumference.value * (1 - pct)
})

const ringColor1 = computed(() => {
  if (isDone.value)  return '#10B981'
  if (isError.value) return '#EF4444'
  return '#3755C3'
})
const ringColor2 = computed(() => {
  if (isDone.value)  return '#34D399'
  if (isError.value) return '#F87171'
  return '#7C9FFF'
})
const glowBgColor = computed(() => {
  if (isDone.value)  return '#10B981'
  if (isError.value) return '#EF4444'
  return '#3755C3'
})

// ── Hexagonal neural nodes ─────────────────────────────────────────
// 6 nodes at radius 68 from centre (130,130)
const HEX_R = 68
const hexNodes = computed(() => Array.from({ length: 6 }, (_, i) => {
  const angle = (Math.PI / 3) * i - Math.PI / 6
  return {
    id: i,
    x: 130 + HEX_R * Math.cos(angle),
    y: 130 + HEX_R * Math.sin(angle),
    delay: `${(i * 0.4).toFixed(1)}s`,
  }
}))

// Adjacent pairs for hex ring edges
const hexEdges = computed(() => [
  { id: 0, x1: hexNodes.value[0].x, y1: hexNodes.value[0].y, x2: hexNodes.value[1].x, y2: hexNodes.value[1].y, delay: '0s' },
  { id: 1, x1: hexNodes.value[1].x, y1: hexNodes.value[1].y, x2: hexNodes.value[2].x, y2: hexNodes.value[2].y, delay: '0.3s' },
  { id: 2, x1: hexNodes.value[2].x, y1: hexNodes.value[2].y, x2: hexNodes.value[3].x, y2: hexNodes.value[3].y, delay: '0.6s' },
  { id: 3, x1: hexNodes.value[3].x, y1: hexNodes.value[3].y, x2: hexNodes.value[4].x, y2: hexNodes.value[4].y, delay: '0.9s' },
  { id: 4, x1: hexNodes.value[4].x, y1: hexNodes.value[4].y, x2: hexNodes.value[5].x, y2: hexNodes.value[5].y, delay: '1.2s' },
  { id: 5, x1: hexNodes.value[5].x, y1: hexNodes.value[5].y, x2: hexNodes.value[0].x, y2: hexNodes.value[0].y, delay: '1.5s' },
])

// Active hex node cycles through 0-5 based on percent
const activeHexNode = computed(() => {
  if (!isActive.value) return -1
  return Math.floor((props.percent / 100) * 6) % 6
})

// ── Phase label (emoji + short text) ──────────────────────────────
const phaseLabel = computed(() => {
  if (isDone.value)  return '✓ Готово'
  if (isError.value) return '✗ Ошибка'
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
  if (isActive.value) return 'Движок работает · живой анализ'
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
    const pillMinOrder = Math.min(...pill.phases.map(p => {
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
  if (stage === 'llm_batch') return '⬡'
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
    'generate:language': 'Определение языка документа',
    'generate:themes':   'Извлечение тематических блоков из документа',
    'generate:blueprint':'Построение плана вопросов (blueprint)',
    'generate:llm_batch':'ИИ генерирует вопросы батчами...',
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

function pushLog() {
  logHistory.value.push({
    id:         Date.now() + Math.random(),
    ts:         new Date().toLocaleTimeString('ru-RU'),
    icon:       phaseIcon(props.phase, props.stage),
    colorClass: phaseColor(props.phase),
    text:       stageToMessage(props.phase, props.stage, props.detail),
    percent:    displayPercent.value,
  })
  nextTick(() => {
    if (logContainerRef.value) {
      logContainerRef.value.scrollTop = logContainerRef.value.scrollHeight
    }
  })
}

// Watch for phase:stage change (each unique combination = new log entry)
watch(
  () => `${props.phase}:${props.stage}`,
  (val, old) => {
    if (val !== old && props.phase) pushLog()
  },
)

// Seed initial entry when component mounts if we already have state
onMounted(() => {
  if (props.phase) pushLog()
})
</script>

<style scoped>
/* ── Phase pills ────────────────────────────────────────────────── */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 14px;
  border-radius: 9999px;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  transition: all 0.4s ease;
  flex: 1;
  justify-content: center;
}
.pill.waiting {
  background: #1E293B;
  color: #475569;
  border: 1px solid #334155;
}
.pill.active {
  background: #1E3A8A;
  color: #93C5FD;
  border: 1px solid #3755C3;
  box-shadow: 0 0 12px rgba(55, 85, 195, 0.4);
}
.pill.done {
  background: #064E3B;
  color: #6EE7B7;
  border: 1px solid #10B981;
}
.pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.pulse-dot {
  animation: dotPulse 1.2s ease-in-out infinite;
}
.pill-check {
  font-size: 0.65rem;
}

/* ── Neural SVG wrapper ─────────────────────────────────────────── */
.neural-wrapper {
  position: relative;
  display: inline-block;
}
.neural-svg {
  display: block;
}

/* Progress ring smooth transition */
.progress-ring {
  transition: stroke-dashoffset 1.2s cubic-bezier(0.4, 0, 0.2, 1),
              stroke 0.6s ease;
}

/* Neural lines animation */
.neural-line {
  stroke-dasharray: 6 4;
  animation: signalFlow 2.4s linear infinite;
}

/* Node pulse */
.node-pulse {
  animation: nodePulse 1.5s ease-in-out infinite;
}
.done-flash {
  animation: doneFlash 0.8s ease-out forwards;
}

/* Percent & label text */
.percent-text {
  font-family: 'JetBrains Mono', 'Courier New', monospace;
  font-size: 36px;
  font-weight: 800;
  letter-spacing: -1px;
}
.phase-label-text {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* ── Status card ────────────────────────────────────────────────── */
.status-card {
  background: #FFFFFF;
  border: 1px solid rgba(169, 180, 185, 0.2);
  border-radius: 1rem;
  padding: 1.25rem 1.5rem;
  space-y: 0.5rem;
}
.live-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3755C3;
  animation: livePing 1.2s ease-in-out infinite;
  flex-shrink: 0;
}
.done-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #10B981;
  flex-shrink: 0;
}
.error-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #EF4444;
  flex-shrink: 0;
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

/* ── Terminal ───────────────────────────────────────────────────── */
.terminal-card {
  border-radius: 1rem;
  overflow: hidden;
  border: 1px solid #1E293B;
  box-shadow: 0 0 0 1px rgba(55, 85, 195, 0.1), 0 8px 32px rgba(0,0,0,0.3);
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
  animation: logFadeIn 0.3s ease-out;
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

/* ── Keyframes ──────────────────────────────────────────────────── */
@keyframes dotPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.4; transform: scale(0.7); }
}

@keyframes signalFlow {
  0%   { stroke-dashoffset: 0; }
  100% { stroke-dashoffset: -40; }
}

@keyframes nodePulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.6; transform: scale(1.35); }
}

@keyframes doneFlash {
  0%   { opacity: 0.5; transform: scale(0.8); }
  60%  { opacity: 1;   transform: scale(1.3); }
  100% { opacity: 1;   transform: scale(1); }
}

@keyframes livePing {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.3; transform: scale(1.6); }
}

@keyframes logFadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
</style>
