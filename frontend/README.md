# Academic Architect Frontend

Vue 3 + Vite фронтенд, адаптированный под backend API проекта (`/api`).

## Запуск

```bash
npm install
npm run dev
```

По умолчанию запросы идут на `/api`, а Vite проксирует их на `http://localhost:3002`.

## Переменные окружения

Скопируйте `.env.example` в `.env` при необходимости:

```env
VITE_API_BASE=/api
VITE_BACKEND_ORIGIN=http://localhost:3002
```

## Реализованный flow

1. **Загрузка документа** (`/zagruzka`) -> `POST /api/upload` с `X-Job-Id`
2. **Прогресс генерации** (`/progress`) -> polling `GET /api/jobs/:jobId`
3. **Прохождение теста** (`/test?testId=...`) -> `GET /api/tests/:id`
4. **Сохранение результата** -> `POST /api/results`
5. **Итоги/разбор** (`/itog`, `/razbor?resultId=...`) -> `GET /api/results*`

## Структура

- `src/lib/api.js` - HTTP-клиент и обработка API-ошибок
- `src/lib/mappers.js` - мапперы `backend -> UI`
- `src/stores/appStore.js` - централизованное состояние флоу
- `src/views/*` - экраны, подключенные к backend
