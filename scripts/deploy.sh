#!/usr/bin/env bash
# deploy.sh — подготовка и запуск AI Test Generator (Linux)
# chmod +x scripts/deploy.sh && ./scripts/deploy.sh

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  if [[ -f docs/env.example ]]; then
    cp docs/env.example .env
    echo "[deploy] Создан .env из docs/env.example — задайте GEMINI_API_KEY и POSTGRES_PASSWORD"
  else
    echo "[deploy] Ошибка: нет .env" >&2
    exit 1
  fi
fi

echo "[deploy] docker compose up -d --build"
docker compose up -d --build

echo "[deploy] Ожидание /api/health..."
for i in $(seq 1 36); do
  if curl -sf "http://127.0.0.1:${APP_HOST_PORT:-3002}/api/health" >/dev/null 2>&1; then
    echo "[deploy] API healthy"
    break
  fi
  sleep 5
done

docker compose ps
echo ""
echo "Worker:"
docker logs ai-testgen-worker --tail 15 2>/dev/null || true
echo ""
echo "См. docs/DEPLOY.md"
