# Docker-окружение для AI Test Generator

Схема деплоя: **nginx** (порт 80) → **app** (Node.js) → **postgres** (PostgreSQL 16). Загрузки и локальные файлы — volume `ai-testgen-data`; данные БД — volume `ai-testgen-postgres-data`. MinIO при `STORAGE_BACKEND=minio` по умолчанию ожидается на хосте (`host.docker.internal`), либо задайте `MINIO_ENDPOINT` в `.env`.

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

1. В корне проекта создайте `.env` (обязательно `GEMINI_API_KEY`; для Postgres в Compose — `PGUSER`, `PGPASSWORD`, `PGDATABASE` в согласовании с тем, что вы хотите в контейнере; по умолчанию в compose есть dev-пароль `ai_testgen_dev`, его нужно сменить в проде):

   ```env
   GEMINI_API_KEY=ваш-ключ
   PORT=3000
   MAX_FILE_SIZE_MB=10
   ENABLE_PDF_OCR=true
   MAX_OCR_PAGES=10
   PGPASSWORD=надёжный-пароль
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
| `docker compose down` | Остановка контейнеров (volumes с данными сохраняются) |
| `docker compose down -v` | То же + удалить volumes (очистить БД и загрузки) |
| `docker compose logs -f app` | Логи приложения |
| `docker compose ps` | Статус контейнеров |

## Переменные окружения

- `DATA_DIR` в контейнере задаётся в `docker-compose.yml` (`/data`). Менять не нужно.
- Остальные переменные (в т.ч. `GEMINI_API_KEY`) берутся из файла `.env` в корне проекта.

## Структура

- `docker/nginx/nginx.conf` — конфиг nginx (проксирование на app:3000).
- Volume `ai-testgen-data`: каталог `uploads/` и прочие файлы приложения (в контейнере: `/data`).
- Volume `ai-testgen-postgres-data`: файлы кластера PostgreSQL.
