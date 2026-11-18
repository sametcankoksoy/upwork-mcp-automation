$ErrorActionPreference = "SilentlyContinue"

$ProjectRoot = "C:\Users\root\Desktop\upwork_mcp_automation"
Set-Location $ProjectRoot

$LogsDir = Join-Path $ProjectRoot "logs"
if (-not (Test-Path $LogsDir)) {
  New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}

function Write-WatchdogLog {
  param([string]$Message)
  $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  Add-Content -Path (Join-Path $LogsDir "watchdog.log") -Value "[$ts] $Message"
}

$createdNew = $false
$mutex = $null
try {
  $mutex = New-Object System.Threading.Mutex($true, "Global\UpworkLoomWatchdogMutex", [ref]$createdNew)
} catch {
  $mutex = New-Object System.Threading.Mutex($true, "Local\UpworkLoomWatchdogMutex", [ref]$createdNew)
}

if (-not $createdNew) {
  exit 0
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NodeExe = if ($NodeCmd) { $NodeCmd.Source } else { "node.exe" }
$TunnelExe = Join-Path $ProjectRoot "cloudflared.exe"
$script:NodeProc = $null

Write-WatchdogLog "Watchdog started (PID=$PID)"

try {
  while ($true) {
    $listening = Get-NetTCPConnection -LocalPort 3050 -State Listen -ErrorAction SilentlyContinue
    $nodeAlive = ($null -ne $script:NodeProc) -and (-not $script:NodeProc.HasExited)

    if (-not $listening -and -not $nodeAlive) {
      Write-WatchdogLog "Starting node src/server.js..."
      $script:NodeProc = Start-Process -FilePath $NodeExe `
        -ArgumentList "src/server.js" `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogsDir "server.out.log") `
        -RedirectStandardError (Join-Path $LogsDir "server.err.log") `
        -PassThru
    }

    $tunnelRunning = Get-Process -Name cloudflared -ErrorAction SilentlyContinue
    if (-not $tunnelRunning -and (Test-Path $TunnelExe)) {
      Write-WatchdogLog "Starting Cloudflare tunnel loom..."
      Start-Process -FilePath $TunnelExe `
        -ArgumentList "tunnel", "run", "--url", "http://localhost:3050", "loom" `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LogsDir "tunnel.out.log") `
        -RedirectStandardError (Join-Path $LogsDir "tunnel.err.log") | Out-Null
    }

    Start-Sleep -Seconds 5
  }
} finally {
  if ($mutex) {
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
  }
  [GC]::KeepAlive($mutex)
}
