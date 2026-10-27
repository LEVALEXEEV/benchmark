<#
  Смоук-тест стенда на Windows: работает ли стенд на этой машине так, как в
  кампании. Не готовит ОС и не требует закоммиченного кода; данные пишет во
  временную папку и для анализа их не использует. ≈ 15–20 мин.

    1) Node.js ≥ 22.12, зависимости, браузеры пула (нужна сеть);
    2) typecheck и production-сборка;
    3) packages\harness\src\smoke.ts: Chromium и Firefox — S1–S5; по одному
       прогону на ячейку, короткие окна; проверка результата (паритет,
       условия страницы, формат CSV).

  Обычное окно PowerShell, из папки benchmark:
    powershell -ExecutionPolicy Bypass -File scripts\windows\smoke.ps1
    powershell -ExecutionPolicy Bypass -File scripts\windows\smoke.ps1 -Browser firefox -Scenario s2,s4
    powershell -ExecutionPolicy Bypass -File scripts\windows\smoke.ps1 -Keep       # не удалять данные
    powershell -ExecutionPolicy Bypass -File scripts\windows\smoke.ps1 -Offline    # без npm и загрузки браузеров

  Код выхода 0 — все проверки пройдены.
#>
param(
  [string]$Browser,
  [string]$Scenario,
  [switch]$Keep,
  [switch]$Offline
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root

function Step($text) { Write-Host "`n[smoke] $text" }
function Check($what) { if ($LASTEXITCODE -ne 0) { Write-Host "[smoke] ошибка: $what"; exit 1 } }

Step 'Node.js'
$nodeVersion = & node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0) { Write-Host 'Node.js не найден — нужен ≥ 22.12'; exit 1 }
& node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)'
if ($LASTEXITCODE -ne 0) { Write-Host "Node.js $nodeVersion — нужен ≥ 22.12"; exit 1 }
Write-Host "Node.js $nodeVersion"

if (-not $Offline) {
  Step 'зависимости и браузеры пула'
  if (-not (Test-Path 'node_modules')) { & npm ci; Check 'npm ci' }
  & npm run --silent browsers; Check 'npm run browsers'
}

Step 'typecheck'
& npm run --silent typecheck; Check 'typecheck'

Step 'production-сборка'
& npm run --silent build | Out-Null; Check 'сборка'
Write-Host 'собрано'

Step 'прогоны'
# smoke.ts запускается через node напрямую, а не `npm run smoke -- …`:
# PowerShell вызывает шим npm.ps1 и может съесть `--`
$smokeArgs = @()
if ($Browser) { $smokeArgs += @('--browser', $Browser) }
if ($Scenario) { $smokeArgs += @('--scenario', $Scenario) }
if ($Keep) { $smokeArgs += '--keep' }
& node (Join-Path $root 'node_modules\tsx\dist\cli.mjs') (Join-Path $root 'packages\harness\src\smoke.ts') @smokeArgs
exit $LASTEXITCODE
