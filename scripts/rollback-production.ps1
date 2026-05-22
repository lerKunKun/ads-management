param(
  [string]$HostName = "18.222.0.113",
  [string]$User = "ubuntu",
  [string]$KeyPath = "$env:USERPROFILE\.ssh\meta_ads_deploy",
  [string]$AppDir = "/opt/ads-management",
  [string]$ApiService = "ads-api",
  [string]$WorkerService = "ads-worker",
  [string]$EnvFile = "/etc/ads-management/ads.env"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$key = (Resolve-Path $KeyPath -ErrorAction SilentlyContinue)
if (-not $key) {
  throw "SSH key not found: $KeyPath"
}

$target = "${User}@${HostName}"
$sshArgs = @(
  "-i", $key.Path,
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "StrictHostKeyChecking=accept-new"
)
$remoteCmd = "cd '$AppDir' && API_SERVICE='$ApiService' WORKER_SERVICE='$WorkerService' ENV_FILE='$EnvFile' ./rollback-last.sh"

Write-Host "[rollback] running rollback on $target"
ssh @sshArgs $target $remoteCmd
