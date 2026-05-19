# deploy.ps1 — подготовка и запуск AI Test Generator (Windows / PowerShell)
# Запуск из корня «ИИ тест»:  .\scripts\deploy.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

if (-not (Test-Path ".env")) {
    if (Test-Path "docs\env.example") {
        Copy-Item "docs\env.example" ".env"
        Write-Host "[deploy] Создан .env из docs/env.example — задайте GEMINI_API_KEY и POSTGRES_PASSWORD"
    } else {
        Write-Error ".env не найден. Создайте .env с GEMINI_API_KEY"
    }
}

Write-Host "[deploy] Сборка и запуск контейнеров..."
docker compose up -d --build

Write-Host "[deploy] Ожидание health app (до 3 мин)..."
$deadline = (Get-Date).AddMinutes(3)
do {
    Start-Sleep -Seconds 5
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:3002/api/health" -UseBasicParsing -TimeoutSec 10
        if ($r.StatusCode -eq 200) { break }
    } catch { }
} while ((Get-Date) -lt $deadline)

Write-Host "[deploy] Статус:"
docker compose ps

Write-Host ""
Write-Host "Проверки:"
Write-Host "  curl http://127.0.0.1:3002/api/health"
Write-Host "  docker logs ai-testgen-worker --tail 30"
Write-Host ""
Write-Host "Документация: docs/DEPLOY.md"
