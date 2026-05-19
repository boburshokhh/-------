# Создаёт общую Docker-сеть для AI + edu_atg (один раз)
$Net = if ($env:AI_TESTGEN_DOCKER_NETWORK) { $env:AI_TESTGEN_DOCKER_NETWORK } else { "edu_atg_ai_testgen_default" }

$exists = docker network inspect $Net 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "[network] $Net already exists"
    exit 0
}

Write-Host "[network] Creating $Net ..."
docker network create $Net
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "[network] Done"
