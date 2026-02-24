# Docker-окружение для AI Test Generator

Схема деплоя: **nginx** (reverse proxy, порт 80) → **app** (Node.js, статика + API). Данные (БД, загрузки) хранятся в volume `ai-testgen-data`.

## Требования на сервере (Ubuntu)

- Docker Engine 24+
- Docker Compose v2+

```bash
# Установка (Ubuntu)
sudo apt update && sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER
# перелогиниться или newgrp docker
```

## Запуск

1. В корне проекта создайте `.env` с переменными (обязательно `GEMINI_API_KEY`):

   ```env
   GEMINI_API_KEY=ваш-ключ
   PORT=3000
   MAX_FILE_SIZE_MB=10
   ENABLE_PDF_OCR=true
   MAX_OCR_PAGES=10
   ```

2. Соберите образы и поднимите контейнеры:

   ```bash
   docker compose up -d --build
   ```

3. Приложение доступно по адресу `http://<IP-сервера>` (порт 80).

## Полезные команды

| Команда | Описание |
|--------|----------|
| `docker compose up -d --build` | Сборка и запуск в фоне |
| `docker compose down` | Остановка и удаление контейнеров (volume сохраняется) |
| `docker compose logs -f app` | Логи приложения |
| `docker compose ps` | Статус контейнеров |

## Переменные окружения

- `DATA_DIR` в контейнере задаётся в `docker-compose.yml` (`/data`). Менять не нужно.
- Остальные переменные (в т.ч. `GEMINI_API_KEY`) берутся из файла `.env` в корне проекта.

## Структура

- `docker/nginx/nginx.conf` — конфиг nginx (проксирование на app:3000).
- Volume `ai-testgen-data`: в нём создаются `data.db` и каталог `uploads/` (путь внутри контейнера: `/data`).
