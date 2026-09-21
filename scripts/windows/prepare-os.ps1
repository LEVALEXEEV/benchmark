#Requires -RunAsAdministrator
<#
  Подготовка Windows к кампании замеров: выключает то, что создаёт фоновую
  нагрузку, — индексацию (WSearch), SysMain, службы обновления, OneDrive,
  проверку файлов стенда Защитником и сетевые адаптеры (стенду сеть не нужна,
  всё через localhost). Схема питания — «Высокая производительность».
  Исходное состояние сохраняется в файл, restore-os.ps1 возвращает ровно его.
  Показания машины не снимаются — меняются только настройки.

  Запускает measure.ps1 (с запросом UAC); вручную:
    powershell -ExecutionPolicy Bypass -File scripts\windows\prepare-os.ps1 [-KeepNetwork]
#>
param([switch]$KeepNetwork)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# окно администратора закрывается сразу — вывод дублируется в лог, measure.ps1 его показывает
Start-Transcript -Path (Join-Path $PSScriptRoot '..\.os-log-windows.txt') -Append | Out-Null

$state = Join-Path $PSScriptRoot '..\.os-state-windows.json'
if (Test-Path $state) { throw "Уже подготовлено ($state). Сначала restore-os.ps1" }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$playwright = Join-Path $env:LOCALAPPDATA 'ms-playwright'

# Тип запуска берётся из реестра, а не из Get-Service: Windows PowerShell 5.1
# не отличает отложенный автозапуск (так настроен WSearch) от обычного
function Get-ServiceStart($name) {
  $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$name"
  if (-not (Test-Path $key)) { return $null }
  $p = Get-ItemProperty $key
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  [ordered]@{
    name    = $name
    start   = [int]$p.Start
    delayed = [int]($p.DelayedAutostart -eq 1)
    running = [bool]($svc -and $svc.Status -eq 'Running')
  }
}

$services = @('WSearch', 'SysMain', 'wuauserv', 'UsoSvc') | ForEach-Object { Get-ServiceStart $_ } | Where-Object { $_ }
$scheme = [regex]::Match((powercfg /getactivescheme), '[0-9a-fA-F-]{36}').Value
$exclusions = @()
try {
  $existing = @((Get-MpPreference).ExclusionPath)
  $exclusions = @($root, $playwright | Where-Object { $existing -notcontains $_ })
} catch { Write-Warning "Защитник Windows недоступен: $($_.Exception.Message)" }
$adapters = @()
if (-not $KeepNetwork) { $adapters = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object Name) }

# сначала состояние, потом изменения: откат возможен, даже если скрипт упадёт на середине
[ordered]@{ services = @($services); scheme = $scheme; exclusions = $exclusions; adapters = $adapters } |
  ConvertTo-Json -Depth 4 | Set-Content -Path $state -Encoding UTF8

foreach ($s in $services) {
  sc.exe config $s.name start= disabled | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning "$($s.name): тип запуска не изменён (служба защищена системой)"; continue }
  Stop-Service -Name $s.name -Force -ErrorAction SilentlyContinue
  Write-Host "Служба $($s.name): остановлена и отключена"
}
Get-Process OneDrive -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host 'OneDrive: закрыт (запустится при следующем входе)'

# через cmd: в Windows PowerShell 5.1 перенаправление stderr внешней программы при Stop — исключение
cmd /c 'powercfg /setactive SCHEME_MIN >nul 2>&1'
if ($LASTEXITCODE -eq 0) { Write-Host 'Питание: схема «Высокая производительность»' }
else { Write-Warning 'Схемы «Высокая производительность» нет (Modern Standby) — выставьте режим «Максимальная производительность» вручную' }

foreach ($p in $exclusions) {
  try { Add-MpPreference -ExclusionPath $p; Write-Host "Защитник: исключение $p" }
  catch { Write-Warning "Защитник: исключение $p не добавлено ($($_.Exception.Message))" }
}
foreach ($a in $adapters) { Disable-NetAdapter -Name $a -Confirm:$false; Write-Host "Сеть: адаптер «$a» выключен" }
Write-Host 'Готово. Откат: scripts\windows\restore-os.ps1'
Stop-Transcript | Out-Null
