#!/bin/bash
# Проверка занятых портов на Ubuntu-сервере перед деплоем
# Запуск на сервере: bash check-ports-ubuntu.sh

echo "=== Занятые порты (LISTEN) ==="
echo ""
echo "--- Все слушающие порты (ss) ---"
ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null

echo ""
echo "--- Сводка по портам (порт : процесс) ---"
ss -tlnp 2>/dev/null | awk 'NR>1 {print $4}' | sed 's/.*://' | sort -n -u | while read p; do
  [ -n "$p" ] && echo -n "Порт $p: " && (ss -tlnp 2>/dev/null | grep -E ":$p\s" | head -1 || true)
done

echo ""
echo "--- Проверка нужных для деплоя портов ---"
for port in 80 443 3000 9000 9001; do
  if ss -tlnp 2>/dev/null | grep -qE ":$port\s"; then
    echo "Порт $port: ЗАНЯТ"
    ss -tlnp 2>/dev/null | grep -E ":$port\s"
  else
    echo "Порт $port: свободен"
  fi
done

echo ""
echo "--- Docker-контейнеры и их порты ---"
docker ps --format "table {{.Names}}\t{{.Ports}}" 2>/dev/null || true
