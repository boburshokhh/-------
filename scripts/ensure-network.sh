#!/usr/bin/env bash
# Создаёт общую Docker-сеть для AI + edu_atg (один раз).
# Использование: ./scripts/ensure-network.sh
set -euo pipefail
NET="${AI_TESTGEN_DOCKER_NETWORK:-edu_atg_ai_testgen_default}"

if docker network inspect "$NET" >/dev/null 2>&1; then
  echo "[network] $NET already exists"
  exit 0
fi

echo "[network] Creating $NET ..."
docker network create "$NET"
echo "[network] Done. Start AI: docker compose up -d --build"
