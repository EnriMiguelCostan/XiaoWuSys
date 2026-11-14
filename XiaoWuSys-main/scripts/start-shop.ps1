<#
.SYNOPSIS
  Starts XiaoMei ERP on the shop computer: the Express API (port 5000) and the Next.js screens
  (port 3000), waits until both answer, then opens http://localhost:3000 in the default browser.

.DESCRIPTION
  Both servers listen on 0.0.0.0, so tablets on the shop Wi-Fi can open
  http://<shop-computer-ip>:3000 (add that address to CORS_ORIGINS in Backend\.env).
  Close this window, or press Ctrl+C, to stop both servers.

  First time on a computer:  cd Backend; npm ci   and   cd Web; npm ci
  The Next.js app is built automatically the first time (or with -Rebuild after an update).

.PARAMETER Demo
  Demo mode: no cloud database needed (Backend "npm run demo", sample data on this computer).

.PARAMETER Rebuild
  Rebuild the Next.js app before starting (run this after updating the code).

.PARAMETER NoBrowser
  Do not open the browser (e.g. when the computer only serves tablets).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-shop.ps1
  powershell -ExecutionPolicy Bypass -File scripts\start-shop.ps1 -Demo
#>
[CmdletBinding()]
param(
  [switch]$Demo,
  [switch]$Rebuild,
  [switch]$NoBrowser,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$Root = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $Root 'Backend'
$WebDir = Join-Path $Root 'Web'
$ApiStatusUrl = 'http://127.0.0.1:5000/api/status'
$WebUrl = 'http://127.0.0.1:3000'
$OpenUrl = 'http://localhost:3000'
# The Next.js process must never see these (Web/next.config.ts refuses to start if it does)
$BackendOnlyEnv = @('DATABASE_URL', 'PG_LISTEN_URL', 'JWT_SECRET', 'TEST_DATABASE_URL')

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

function Stop-Shop([string]$Why) {
  Say "`n$Why" 'Red'
  exit 1
}

# Any HTTP answer (even an error page) proves the server is listening; no answer = not yet
function Test-Answers([string]$Url) {
  try {
    $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
    return $true
  } catch [System.Net.WebException] {
    return $null -ne $_.Exception.Response
  } catch {
    return $false
  }
}

# Stops a process and everything it started (npm.cmd -> cmd -> node)
function Stop-Tree($Proc) {
  if ($Proc -and -not $Proc.HasExited) {
    & taskkill.exe /PID $Proc.Id /T /F 2>&1 | Out-Null
  }
}

# --- Checks -------------------------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-Shop 'Node.js is not installed. Install Node.js 22 or newer from nodejs.org, then try again.' }
# Parsed here: PowerShell 5.1 strips inner quotes from arguments passed to native programs
$nodeMajor = [int](((& node -p 'process.versions.node') -split '\.')[0])
if ($nodeMajor -lt 22) { Stop-Shop "Node.js $nodeMajor is too old. Install Node.js 22 or newer." }
foreach ($dir in @($BackendDir, $WebDir)) {
  if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
    Stop-Shop "Packages are missing in $dir. Open a terminal there and run: npm ci"
  }
}
if (-not $Demo -and -not (Test-Path (Join-Path $BackendDir '.env'))) {
  Stop-Shop 'Backend\.env is missing. Copy Backend\.env.example to Backend\.env and fill it in, or start with -Demo.'
}

$apiUp = Test-Answers $ApiStatusUrl
$webUp = Test-Answers $WebUrl
if ($apiUp -and $webUp) {
  Say 'XiaoMei ERP is already running.' 'Green'
  if (-not $NoBrowser) { Start-Process $OpenUrl }
  exit 0
}
if ($apiUp) { Stop-Shop 'Something is already using port 5000. Close the other XiaoMei window (or the program using that port) and try again.' }
if ($webUp) { Stop-Shop 'Something is already using port 3000. Close the other XiaoMei window (or the program using that port) and try again.' }

# --- Build the screens once (production build) --------------------------------------------
# Next.js is run through its own entry point (same as "npm run build" / "npm run start"), so it
# also works when the install folder's name contains a semicolon, which breaks npm's PATH lookup.
$NextBin = Join-Path $WebDir 'node_modules\next\dist\bin\next'
$saved = @{}
foreach ($name in $BackendOnlyEnv) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}

$backend = $null
$web = $null
try {
  if ($Rebuild -or -not (Test-Path (Join-Path $WebDir '.next\BUILD_ID'))) {
    Say 'Building the screens (first start or -Rebuild); this takes a minute...' 'Cyan'
    Push-Location $WebDir
    try {
      & node $NextBin build
      if ($LASTEXITCODE -ne 0) { Stop-Shop 'The screens could not be built. See the messages above.' }
    } finally { Pop-Location }
  }

  # --- Start both servers -----------------------------------------------------------------
  # Restore the backend's variables for the backend only (it also reads Backend\.env itself)
  foreach ($name in $BackendOnlyEnv) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  $backendScript = if ($Demo) { 'demo' } else { 'start' }
  Say "Starting the API on port 5000 ($(if ($Demo) { 'demo mode' } else { 'npm start' }))..." 'Cyan'
  $backend = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', $backendScript -WorkingDirectory $BackendDir -NoNewWindow -PassThru

  foreach ($name in $BackendOnlyEnv) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  Say 'Starting the screens on port 3000...' 'Cyan'
  $web = Start-Process -FilePath 'node' -ArgumentList "`"$NextBin`"", 'start', '-H', '0.0.0.0', '-p', '3000' -WorkingDirectory $WebDir -NoNewWindow -PassThru

  # --- Wait until both answer ---------------------------------------------------------------
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $apiUp = $false
  $webUp = $false
  while (-not ($apiUp -and $webUp)) {
    if ($backend.HasExited) { Stop-Shop 'The API stopped while starting. See the messages above (Backend\.env, database address).' }
    if ($web.HasExited) { Stop-Shop 'The screens stopped while starting. See the messages above.' }
    if ((Get-Date) -gt $deadline) { Stop-Shop "The system did not answer within $TimeoutSeconds seconds. See the messages above." }
    if (-not $apiUp) { $apiUp = Test-Answers $ApiStatusUrl }
    if (-not $webUp) { $webUp = Test-Answers $WebUrl }
    if (-not ($apiUp -and $webUp)) { Start-Sleep -Seconds 1 }
  }

  Say "`nXiaoMei ERP is ready: $OpenUrl" 'Green'
  Say 'Tablets on the shop Wi-Fi: http://<this-computer-ip>:3000 (see the API messages above for the exact address).'
  Say 'Keep this window open. Close it or press Ctrl+C to stop the system.' 'Yellow'
  if (-not $NoBrowser) { Start-Process $OpenUrl }

  while (-not $backend.HasExited -and -not $web.HasExited) { Start-Sleep -Seconds 2 }
  if ($backend.HasExited) { Say 'The API stopped. Stopping the screens too.' 'Red' } else { Say 'The screens stopped. Stopping the API too.' 'Red' }
} finally {
  Stop-Tree $web
  Stop-Tree $backend
  foreach ($name in $BackendOnlyEnv) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
