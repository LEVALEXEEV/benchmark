<#
  Кампания замеров на Windows «от и до»:
    1) проверки и подготовка стенда (git, браузеры пула, typecheck, сборка) —
       пока есть сеть;
    2) подготовка ОС (prepare-os.ps1, запрос UAC);
    3) чек-лист, пауза 10 мин без нагрузки, все серии по матрице пула;
       система не уснёт и экран не погаснет, пока идёт кампания (иначе
       браузер перестаёт рисовать кадры);
    4) откат настроек ОС при любом завершении (снова запрос UAC — если
       кампания шла без присмотра, подтвердите его, когда вернётесь).

  Запускать из обычного (не администраторского) окна PowerShell — замеры
  идут без повышенных прав, как в первой серии:
    powershell -ExecutionPolicy Bypass -File scripts\windows\measure.ps1 r2
    powershell -ExecutionPolicy Bypass -File scripts\windows\measure.ps1 r2 -Filter chromium/base
    powershell -ExecutionPolicy Bypass -File scripts\windows\measure.ps1 r2b -KeepNetwork

  Прерванную кампанию можно запустить той же командой: готовые серии
  пропускаются. План и прогресс: npm run campaign -- list --session r2
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('r2', 'r2b')][string]$Session,
  [string]$Filter,
  [switch]$Optional,
  [switch]$KeepNetwork
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root
$osLog = Join-Path $PSScriptRoot '..\.os-log-windows.txt'

# Кампания запускается через node напрямую, а не `npm run campaign -- …`:
# PowerShell вызывает шим npm.ps1 и может съесть `--`, и тогда npm примет
# --session за свой параметр
# (вызов не оборачивается в функцию: вывод node стал бы её результатом,
# а вопросы чек-листа не дошли бы до экрана)
$tsx = Join-Path $root 'node_modules\tsx\dist\cli.mjs'
$campaign = Join-Path $root 'packages\harness\src\campaign.ts'

function Invoke-Elevated($script, $extra = '') {
  $argList = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot $script)`" $extra"
  $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList $argList
  if (Test-Path $osLog) { Get-Content $osLog -Encoding UTF8 -Tail 25 | Write-Host }
  return $p.ExitCode
}

& node $tsx $campaign prepare --session $Session
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# не давать системе уснуть и гасить экран, пока жив этот процесс;
# настройки электропитания при этом не меняются
Add-Type -Namespace Bench -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$ES_CONTINUOUS = [uint32]2147483648; $ES_SYSTEM = [uint32]1; $ES_DISPLAY = [uint32]2
[Bench.Power]::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_SYSTEM -bor $ES_DISPLAY)) | Out-Null

$campaignCode = 1
try {
  $code = Invoke-Elevated 'prepare-os.ps1' $(if ($KeepNetwork) { '-KeepNetwork' } else { '' })
  if ($code -ne 0) { throw "prepare-os.ps1 завершился с кодом $code" }

  $runArgs = @('run', '--session', $Session)
  if ($Filter) { $runArgs += @('--filter', $Filter) }
  if ($Optional) { $runArgs += '--optional' }
  & node $tsx $campaign @runArgs
  $campaignCode = $LASTEXITCODE
}
finally {
  $code = Invoke-Elevated 'restore-os.ps1'
  if ($code -ne 0) { Write-Warning 'Откат не выполнен — запустите scripts\windows\restore-os.ps1 от администратора' }
  [Bench.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
}
exit $campaignCode
