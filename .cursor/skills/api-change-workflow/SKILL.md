---
name: api-change-workflow
description: Чеклист и процесс добавления новых API или изменения существующих. Использовать при добавлении новых фич, роутов (routes) или изменении схемы БД.
---

# API Change Workflow

При добавлении нового эндпоинта или изменения существующего, всегда следуйте этому процессу, чтобы не сломать систему:

## Чеклист:

- [ ] **1. База данных**: Требуются ли изменения в схеме? Если да, обновите `backend/db/database.js` и добавьте `ALTER TABLE ...` или пересоздайте файл базы (если это dev-режим).
- [ ] **2. Роуты (Backend)**: 
  - Используйте параметризованные запросы в SQLite (`db.prepare('... ?').run(val)`).
  - Верните JSON: `res.json({ ... })`.
  - Все ошибки пробрасывайте через `next(error)`.
- [ ] **3. API-клиент (Frontend)**:
  - Добавьте или обновите метод в объекте `API` (`frontend/js/api.js`).
  - Убедитесь, что клиент обрабатывает ответ и выбрасывает ошибку (`throw new Error(data.error)`).
- [ ] **4. UI (Frontend)**:
  - Подключите новый метод API к обработчикам событий (click, submit).
  - Добавьте `try/catch` вокруг вызова API и покажите ошибку через `App.toast(error.message, 'error')`.
- [ ] **5. Документация**:
  - Обновите `docs/api.md` (входные параметры, формат ответа, HTTP статусы).

## Пример безопасного изменения API

### Добавление роута:
```javascript
router.get('/my-new-route', (req, res, next) => {
    try {
        const data = db.prepare('SELECT * FROM my_table').all();
        res.json({ success: true, data });
    } catch (e) {
        next(e);
    }
});
```

### Добавление на фронтенде:
```javascript
// frontend/js/api.js
async getMyData() {
    const response = await fetch(`${this.BASE}/my-new-route`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ошибка загрузки данных');
    return data;
}
```