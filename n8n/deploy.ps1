# Загрузка workflow в n8n: n8n\dist\bot.json и n8n\dist\daily.json (PowerShell 5.1).
# Ключ берётся ТОЛЬКО из пользовательской переменной окружения N8N_API_KEY; он нигде не печатается и не пишется в файлы.
# Есть workflow с таким именем -> PUT /workflows/{id} (только name, nodes, connections, settings); нет -> POST /workflows.
# Активация НЕ делается. Режим -DryRun: печатает, что было бы отправлено (имя, число нод, размер), запросов нет.
#   powershell -File n8n\deploy.ps1 -DryRun
#   powershell -File n8n\deploy.ps1            (боевой запуск — вручную, после проверки)
param(
  [switch]$DryRun,
  [ValidateSet('all', 'bot', 'daily')][string]$Only = 'all',
  [string]$BaseUrl = 'https://your-n8n.example.com/api/v1'
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$dist = Join-Path $PSScriptRoot 'dist'
$files = @()
if ($Only -in 'all', 'bot') { $files += (Join-Path $dist 'bot.json') }
if ($Only -in 'all', 'daily') { $files += (Join-Path $dist 'daily.json') }

$key = [Environment]::GetEnvironmentVariable('N8N_API_KEY', 'User')
if (-not $DryRun -and [string]::IsNullOrWhiteSpace($key)) {
  throw 'Не задана пользовательская переменная окружения N8N_API_KEY.'
}
if ($DryRun) { Write-Host ('DryRun: запросов не будет. Ключ в переменной окружения: ' + $(if ([string]::IsNullOrWhiteSpace($key)) { 'не задан' } else { 'задан' })) }

$headers = @{ 'X-N8N-API-KEY' = $key; 'Accept' = 'application/json' }
$existing = $null

foreach ($f in $files) {
  if (-not (Test-Path $f)) { throw "Нет файла $f. Сначала: node n8n/build.js" }
  $raw = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)
  $wf = $raw | ConvertFrom-Json
  # в тело идут только четыре поля (PUT другие не принимает)
  $extra = @($wf.PSObject.Properties.Name | Where-Object { $_ -notin 'name', 'nodes', 'connections', 'settings' })
  if ($extra.Count) { throw "В $f есть лишние поля: $($extra -join ', ')" }
  $bytes = [Text.Encoding]::UTF8.GetBytes($raw)

  if ($DryRun) {
    Write-Host ("[{0}] имя: '{1}'; нод: {2}; размер: {3} байт; действие: GET /workflows?limit=250, затем PUT /workflows/{{id}} (если найден по имени) или POST /workflows; активации нет" -f (Split-Path $f -Leaf), $wf.name, @($wf.nodes).Count, $bytes.Length)
    continue
  }

  if ($null -eq $existing) {
    $list = Invoke-RestMethod -Method Get -Uri "$BaseUrl/workflows?limit=250" -Headers $headers
    $existing = @($list.data)
  }
  $hit = @($existing | Where-Object { $_.name -eq $wf.name })
  if ($hit.Count -gt 1) { throw "Найдено несколько workflow с именем '$($wf.name)': обновлять не буду." }
  try {
    if ($hit.Count -eq 1) {
      $r = Invoke-RestMethod -Method Put -Uri "$BaseUrl/workflows/$($hit[0].id)" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes
      Write-Host ("[{0}] обновлён: '{1}' (id {2}), нод: {3}; не активирован" -f (Split-Path $f -Leaf), $wf.name, $r.id, @($wf.nodes).Count)
    } else {
      $r = Invoke-RestMethod -Method Post -Uri "$BaseUrl/workflows" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes
      Write-Host ("[{0}] создан: '{1}' (id {2}), нод: {3}; не активирован" -f (Split-Path $f -Leaf), $wf.name, $r.id, @($wf.nodes).Count)
    }
  } catch {
    # текст ответа сервера может помочь, заголовки и ключ не выводятся
    $msg = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $msg += ' | ' + $_.ErrorDetails.Message }
    throw "[$(Split-Path $f -Leaf)] ошибка API: $msg"
  }
}
