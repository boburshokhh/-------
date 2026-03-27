# Спецификация API (Backend)

Базовый URL для всех API запросов: `/api`

## Эндпоинты

### 1. Проверка состояния сервиса
**GET** `/api/health`

Проверяет работоспособность сервера и наличие API ключа.
- **Ответ (200 OK)**:
  ```json
  {
    "status": "ok",
    "timestamp": "2026-02-24T12:00:00.000Z",
    "hasApiKey": true
  }
  ```

---

### 1a. Список доступных LLM-моделей
**GET** `/api/models`

Возвращает список моделей, доступных для генерации теста в UI.
- **Ответ (200 OK)**:
  ```json
  {
    "models": [
      { "id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash (...)" }
    ],
    "defaultModel": "gemini-2.5-flash"
  }
  ```

---

### 2. Загрузка документа и генерация теста
**POST** `/api/upload`

Загружает файл (PDF или DOCX), извлекает текст, разбивает его на чанки и использует LLM для генерации теста.
- **Headers**: `Content-Type: multipart/form-data`; опционально **`X-Job-Id`** — UUID задачи для опроса прогресса (**GET** `/api/jobs/:jobId`) во время длительной обработки.
- **Body**: поле `file` (файл документа); опционально `model` — идентификатор модели из конфигурации.
- **Ограничения**: макс. размер 10 МБ, макс. 30 страниц (для PDF).
- **Ответ (201 Created)**:
  ```json
  {
    "success": true,
    "jobId": "uuid",
    "testId": 1,
    "title": "Тест по документу: Имя_файла",
    "totalQuestions": 15,
    "generationMetrics": {
      "trace_id": "uuid",
      "final_question_count": 15,
      "final_quality_score": 0.75,
      "grounded_question_rate": 0.82,
      "retrieval_hit_rate": 0.91,
      "dedup_loss_ratio": 0.12,
      "schema_version": 1
    },
    "documentInfo": {
      "id": 1,
      "name": "Имя_файла.pdf",
      "pages": 12,
      "textLength": 45000,
      "extractionQuality": 0.95
    }
  }
  ```

Поле **`generationMetrics`** — структурированные метрики пайплайна генерации (observability): бюджет, retrieval, grounding, dedup, длительность; сохраняется в БД в колонке `tests.generation_metrics_json` и возвращается в **GET** `/api/tests/:id` как **`generationMetrics`**.

На сервере прогресс дублируется в логах строками **`[PROGRESS]`** (JSON: `phase`, `stage`, `percent`, `detail`). Дополнительно пишутся **структурированные JSON-логи** (одна строка на событие) с полями `trace_id`, `event`, `reason_code`, `metrics` — удобно для Loki/Datadog.

---

### 2a. Прогресс задачи загрузки
**GET** `/api/jobs/:jobId`

Возвращает последнее известное состояние обработки для `jobId`, переданного в **`X-Job-Id`** при **POST** `/api/upload`.
- **Ответ (200 OK)**:
  ```json
  {
    "ok": true,
    "jobId": "uuid",
    "phase": "generate",
    "stage": "llm_batch",
    "percent": 62,
    "detail": "Генерация вопросов: пакет 2/5 (накоплено 12)",
    "updatedAt": 1711536000000
  }
  ```
- **404**: задача не найдена (истёк TTL или неверный id).

---

### 3. Получение списка тестов
**GET** `/api/tests`

Возвращает список всех сгенерированных тестов (сортировка по дате создания, от новых к старым).
- **Ответ (200 OK)**:
  ```json
  {
    "tests": [
      {
        "id": 1,
        "title": "Тест по документу: История",
        "total_questions": 12,
        "created_at": "2026-02-24 10:00:00",
        "document_name": "История.pdf",
        "page_count": 5
      }
    ]
  }
  ```

---

### 4. Получение конкретного теста
**GET** `/api/tests/:id`

Возвращает данные конкретного теста вместе с массивом вопросов.
- **Ответ (200 OK)**:
  ```json
  {
    "id": 1,
    "title": "Тест по документу: История",
    "questions": [
      {
        "id": 1,
        "type": "multiple_choice",
        "question": "В каком году произошло событие X?",
        "options": ["1000", "1100", "1200", "1300"],
        "correct_answer": 2,
        "explanation": "Событие X произошло в 1200 году согласно летописям."
      }
    ],
    "totalQuestions": 1,
    "documentName": "История.pdf",
    "pageCount": 5,
    "extractionQuality": 0.94,
    "lowTextQuality": false,
    "parseDiagnostics": {
      "parseMethod": "pdf-parse"
    },
    "generationMetrics": null,
    "createdAt": "2026-02-24 10:00:00"
  }
  ```

Поле **`generationMetrics`** — объект метрик генерации (если тест создан версией backend с observability) или `null` для старых записей.

---

### 5. Удаление теста
**DELETE** `/api/tests/:id`

Удаляет тест и каскадно удаляет все связанные с ним результаты прохождений.
- **Ответ (200 OK)**:
  ```json
  { "success": true }
  ```

---

### 6. Сохранение результатов прохождения
**POST** `/api/results`

Сохраняет ответы пользователя и рассчитывает итоговый балл.
- **Headers**: `Content-Type: application/json`
- **Body**:
  ```json
  {
    "testId": 1,
    "userName": "Иван Иванов",
    "answers": [
      { "questionId": 1, "answer": 2 },
      { "questionId": 2, "answer": true }
    ]
  }
  ```
- **Ответ (201 Created)**:
  ```json
  {
    "resultId": 1,
    "score": 1,
    "maxScore": 2,
    "percentage": 50,
    "answers": [ ...детальный разбор... ]
  }
  ```

---

### 7. Получение списка результатов для конкретного теста
**GET** `/api/results/:testId`

Возвращает все попытки прохождения заданного теста.
- **Ответ (200 OK)**:
  ```json
  {
    "results": [
      {
        "id": 1,
        "user_name": "Иван Иванов",
        "score": 1,
        "max_score": 2,
        "percentage": 50,
        "completed_at": "2026-02-24 10:15:00"
      }
    ]
  }
  ```

---

### 8. Получение деталей конкретного результата
**GET** `/api/results/detail/:id`

Возвращает детальную информацию о попытке тестирования (включая правильные/неправильные ответы и объяснения).
- **Ответ (200 OK)**:
  ```json
  {
    "id": 1,
    "testTitle": "Тест по документу: История",
    "userName": "Иван Иванов",
    "score": 1,
    "maxScore": 2,
    "percentage": 50,
    "answers": [ ... ],
    "questions": [ ... ],
    "completedAt": "2026-02-24 10:15:00"
  }
  ```

---

### 9. Просмотр backend-логов (debug)
**GET** `/api/logs?limit=200`

Возвращает последние N строк логов из in-memory буфера (для debug UI).
- **Query**: `limit` (1..500, опционально, по умолчанию 200)
- **Защита**: если на сервере установлен `LOGS_API_TOKEN`, передайте `X-Logs-Token` (или `token` в query).
- **Ответ (200 OK)**:
  ```json
  {
    "logs": [
      {
        "ts": "2026-03-27T12:00:00.000Z",
        "level": "INFO",
        "message": "[UPLOAD] ..."
      }
    ]
  }
  ```