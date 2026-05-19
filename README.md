# AI Test Generator

AI Test Generator — это веб-приложение для автоматического создания структурированных тестов из учебных материалов (в форматах PDF и DOCX). Приложение анализирует текст документа с помощью большой языковой модели (Google Gemini 2.5 Flash) и генерирует набор вопросов разных типов (выбор варианта, верно/неверно, открытый вопрос).

## Особенности
- **Автоматическая генерация тестов**: достаточно загрузить PDF или Word документ.
- **Поддержка больших документов**: автоматическое разбиение длинных текстов на смысловые блоки (чанки) с учетом лимитов токенов LLM.
- **Интерактивное прохождение**: встроенный UI для решения сгенерированных тестов.
- **Аналитика**: сохранение детальных результатов тестирования в базе данных (SQLite).

## Предварительные требования
- **Node.js** (v18 или выше)
- **Ключ API Google Gemini** (получить можно в Google AI Studio)
- **Для отсканированных PDF (OCR)**: на сервере должны быть установлены **GraphicsMagick** и **Ghostscript**.
  - **Windows**: [Установщик GraphicsMagick](http://www.graphicsmagick.org/download.html), [Ghostscript](https://ghostscript.com/releases/gsdnld.html). Или через Chocolatey: `choco install graphicsmagick ghostscript`.
  - **Linux (Debian/Ubuntu)**: `sudo apt install graphicsmagick ghostscript`.
  - **macOS**: `brew install graphicsmagick ghostscript`.
  Без них загрузка обычных PDF и DOCX работает; при отсутствии текста в PDF будет показана ошибка с рекомендацией установить эти программы.

## Установка и запуск

1. Перейдите в корневую директорию проекта и установите зависимости бэкенда:
   ```bash
   cd backend
   npm install
   ```
2. Создайте файл `.env` в корне проекта (или скопируйте `.env.example`, если есть) и укажите свой API ключ:
   ```env
   GEMINI_API_KEY=your-gemini-api-key-here
   PORT=3002
   # Лимиты загрузки: 100 стр. / 100 МБ (фиксированы в backend/utils/uploadLimits.js)
   CHUNK_TOKEN_LIMIT=2500
   CHUNK_OVERLAP_TOKENS=200
   ENABLE_PDF_OCR=true
   # MAX_OCR_PAGES — как MAX_PAGES (100), задаётся в коде
   ```
   Для отключения OCR по отсканированным PDF задайте `ENABLE_PDF_OCR=false`. OCR обрабатывает до 100 страниц (как и загрузка).
2. Запустите frontend и backend параллельно (в разных терминалах):
   
   **Frontend:**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

   **Backend:**
   ```bash
   cd backend
   npm install
   npm run dev
   ```

4. Откройте браузер по адресу `http://localhost:5173`.

## Деплой на Ubuntu (Docker)

**Полное руководство (рекомендуется):** [docs/DEPLOY.md](docs/DEPLOY.md) — Redis, worker, общая сеть с edu_atg, поэтапное включение оптимизаций.

**Быстрый старт:**

```bash
cp docs/env.example .env   # GEMINI_API_KEY, POSTGRES_PASSWORD
docker compose up -d --build
# или: ./scripts/deploy.sh
```

Стек: `postgres` + `redis` + `app` + `worker` + `nginx` (порт 80).

Шаблон переменных: [docs/env.example](docs/env.example).

Подробнее (legacy): [docker/README.md](docker/README.md).

## Быстрый старт (Пользовательский сценарий)
1. Откройте приложение в браузере.
2. На главной странице загрузите документ формата `.pdf` или `.docx` (до 100 страниц, до 100 МБ).
3. Дождитесь, пока ИИ проанализирует текст и сформирует вопросы (от 1 до 3 минут в зависимости от размера документа).
4. Пройдите тест, ответив на предложенные вопросы.
5. Завершите тест и просмотрите свой результат, включая правильные ответы и объяснения.

## Документация
- [Архитектура проекта](docs/architecture.md) — обзор компонентов, потока данных и модели БД.
- [Руководство пользователя](docs/user-guide.md) — подробные инструкции для конечных пользователей.
- [Спецификация API](docs/api.md) — описание доступных REST API эндпоинтов для разработчиков.
- [Устранение неполадок](docs/troubleshooting.md) — решение частых проблем и ошибок.