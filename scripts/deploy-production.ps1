param(
  [string]$HostName = "18.222.0.113",
  [string]$User = "ubuntu",
  [string]$KeyPath = "$env:USERPROFILE\.ssh\meta_ads_deploy",
  [string]$AppDir = "/opt/ads-management",
  [string]$ApiService = "ads-api",
  [string]$WorkerService = "ads-worker",
  [string]$EnvFile = "/etc/ads-management/ads.env",
  [string]$StagingRoot = "",
  [switch]$SkipLocalChecks,
  [switch]$SkipMigrations,
  [switch]$SkipWebBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$defaultStagingRoot = Join-Path $root ".deploy-local"
if (-not $StagingRoot) {
  $StagingRoot = $defaultStagingRoot
}
$key = (Resolve-Path $KeyPath -ErrorAction SilentlyContinue)
if (-not $key) {
  throw "SSH key not found: $KeyPath"
}

$releaseId = Get-Date -Format "yyyyMMddHHmmss"
$stage = Join-Path $StagingRoot "ads-management-deploy-$releaseId"
$archive = Join-Path $stage "ads-management-$releaseId.tar.gz"
$target = "${User}@${HostName}"
$remoteArchive = "$AppDir/.deploy/incoming/$releaseId.tar.gz"
$remoteInstall = "$AppDir/.deploy/incoming/server-install-release.sh"
$sshArgs = @(
  "-i", $key.Path,
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "StrictHostKeyChecking=accept-new"
)

function Run-Step {
  param(
    [string]$Name,
    [scriptblock]$Block
  )
  Write-Host "[deploy] $Name"
  $global:LASTEXITCODE = 0
  & $Block
  if ($LASTEXITCODE -ne 0) {
    throw "step failed: $Name (exit $LASTEXITCODE)"
  }
}

Run-Step "ssh probe" {
  ssh @sshArgs $target "hostname && whoami" | Out-Host
}

if (-not $SkipLocalChecks) {
  Run-Step "typecheck" {
    Push-Location $root
    try {
      bun run typecheck
    } finally {
      Pop-Location
    }
  }
  Run-Step "local web build" {
    Push-Location $root
    try {
      bun --cwd apps/web build
    } finally {
      Pop-Location
    }
  }
}

Run-Step "create release archive" {
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Push-Location $root
  try {
    tar.exe `
      --exclude=.git `
      --exclude=node_modules `
      --exclude=.data `
      --exclude=logs `
      --exclude=.logs `
      --exclude=.env `
      --exclude=.codex_write_test.txt `
      --exclude=.deploy-local `
      -czf $archive .
  } finally {
    Pop-Location
  }
  if (-not (Test-Path $archive)) {
    throw "archive was not created: $archive"
  }
}

Run-Step "prepare remote directory" {
  ssh @sshArgs $target "sudo mkdir -p '$AppDir/.deploy/incoming' && sudo chown ${User}:${User} '$AppDir' '$AppDir/.deploy' '$AppDir/.deploy/incoming'"
}

Run-Step "upload archive and installer" {
  scp @sshArgs $archive "${target}:$remoteArchive"
  scp @sshArgs (Join-Path $root "scripts\server-install-release.sh") "${target}:$remoteInstall"
}

$runMigrations = if ($SkipMigrations) { "0" } else { "1" }
$buildWeb = if ($SkipWebBuild) { "0" } else { "1" }
$remoteCmd = "APP_DIR='$AppDir' RELEASE_ID='$releaseId' ARCHIVE='$remoteArchive' API_SERVICE='$ApiService' WORKER_SERVICE='$WorkerService' ENV_FILE='$EnvFile' RUN_MIGRATIONS='$runMigrations' BUILD_WEB='$buildWeb' bash '$remoteInstall'"

Run-Step "install release on server" {
  ssh @sshArgs $target $remoteCmd
}

Write-Host "[deploy] release deployed: $releaseId"
Write-Host "[deploy] rollback on server: cd $AppDir && ./rollback-last.sh"
