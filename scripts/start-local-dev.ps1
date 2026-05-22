Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = 'D:\development\ads-management'

function Stop-PortOwner {
  param([int]$Port)
  $lines = netstat -ano | Select-String -Pattern ":$Port\s"
  foreach ($line in $lines) {
    $parts = ($line.ToString() -split '\s+') | Where-Object { $_ }
    if ($parts.Count -lt 5) { continue }
    if ($parts[3] -ne 'LISTENING') { continue }
    $pid = [int]$parts[4]
    if ($pid -gt 0) {
      taskkill /PID $pid /T /F | Out-Null
    }
  }
}

Stop-PortOwner -Port 3001
Stop-PortOwner -Port 5173

Start-Process powershell -WorkingDirectory $root -ArgumentList @(
  '-NoExit',
  '-NoProfile',
  '-Command',
  "cd '$root'; `$env:META_FAKE='1'; `$env:API_PORT='3001'; bun run dev:api"
)

Start-Process powershell -WorkingDirectory $root -ArgumentList @(
  '-NoExit',
  '-NoProfile',
  '-Command',
  "cd '$root'; `$env:META_FAKE='1'; `$env:API_PORT='3001'; `$env:WEB_PORT='5173'; bun run dev:web"
)

Start-Sleep -Seconds 6
netstat -ano | Select-String -Pattern ':3001|:5173'
Write-Host ''
Write-Host 'Open http://localhost:5173'
