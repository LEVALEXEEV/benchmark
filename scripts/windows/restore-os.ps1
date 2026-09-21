#Requires -RunAsAdministrator
<#
  Возвращает настройки, изменённые prepare-os.ps1, к сохранённому состоянию.
  Безопасно запускать повторно и вручную (например, после сбоя или
  перезагрузки посреди кампании):
    powershell -ExecutionPolicy Bypass -File scripts\windows\restore-os.ps1
#>
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# окно администратора закрывается сразу — вывод дублируется в лог, measure.ps1 его показывает
Start-Transcript -Path (Join-Path $PSScriptRoot '..\.os-log-windows.txt') -Append | Out-Null

$state = Join-Path $PSScriptRoot '..\.os-state-windows.json'
if (-not (Test-Path $state)) { Write-Host "Нечего возвращать: $state нет"; Stop-Transcript | Out-Null; exit 0 }
$s = Get-Content $state -Raw -Encoding UTF8 | ConvertFrom-Json

foreach ($a in @($s.adapters)) { if ($a) { Enable-NetAdapter -Name $a -Confirm:$false; Write-Host "Сеть: адаптер «$a» включён" } }
foreach ($p in @($s.exclusions)) {
  if ($p) { try { Remove-MpPreference -ExclusionPath $p; Write-Host "Защитник: исключение $p снято" } catch { Write-Warning "Защитник: $p — $($_.Exception.Message)" } }
}
if ($s.node) { powercfg /powerthrottling reset /path "$($s.node)"; Write-Host "Power throttling: сброшен для $($s.node)" }
if ($s.scheme) { powercfg /setactive $s.scheme; Write-Host "Питание: схема $($s.scheme) восстановлена" }

# Start в реестре: 2 — автоматически (с DelayedAutostart — отложенно), 3 — вручную, 4 — отключена
foreach ($svc in @($s.services)) {
  $mode = switch ([int]$svc.start) { 2 { if ($svc.delayed -eq 1) { 'delayed-auto' } else { 'auto' } } 3 { 'demand' } 4 { 'disabled' } default { $null } }
  if (-not $mode) { continue }
  sc.exe config $svc.name start= $mode | Out-Null
  if ($svc.running) { Start-Service -Name $svc.name -ErrorAction SilentlyContinue }
  Write-Host "Служба $($svc.name): тип запуска $mode$(if ($svc.running) { ', запущена' })"
}
Remove-Item $state
Write-Host 'Настройки Windows восстановлены'
Stop-Transcript | Out-Null
