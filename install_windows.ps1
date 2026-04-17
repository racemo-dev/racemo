# Racemo installer for Windows
# Usage: irm https://raw.githubusercontent.com/racemo-dev/racemo/main/install_windows.ps1 | iex

$ErrorActionPreference = "Stop"
$Repo = "racemo-dev/racemo"

function Write-Info  { Write-Host "  ::" -ForegroundColor Cyan -NoNewline; Write-Host " $args" }
function Write-Ok    { Write-Host "  ok" -ForegroundColor Green -NoNewline; Write-Host " $args" }
function Write-Warn  { Write-Host "warn" -ForegroundColor Yellow -NoNewline; Write-Host " $args" }
function Write-Err   { Write-Host "  !!" -ForegroundColor Red -NoNewline; Write-Host " $args"; exit 1 }

Write-Host ""
Write-Host "  ____                                  " -ForegroundColor White
Write-Host " |  _ \ __ _  ___ ___ _ __ ___   ___   " -ForegroundColor White
Write-Host " | |_) / _`` |/ __/ _ \ '_ `` _ \ / _ \  " -ForegroundColor White
Write-Host " |  _ < (_| | (_|  __/ | | | | | (_) | " -ForegroundColor White
Write-Host " |_| \_\__,_|\___\___|_| |_| |_|\___/  " -ForegroundColor White
Write-Host "  Terminal Multiplexer for Windows" -ForegroundColor DarkGray
Write-Host ""

# ── Fetch latest version ──
Write-Info "Checking latest version..."
try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing
    $version = $release.tag_name -replace '^v', ''
} catch {
    Write-Err "Failed to fetch latest version: $_"
}

if (-not $version) { Write-Err "Failed to parse version" }

$fileName = "Racemo_${version}_Windows_x64-setup.exe"
$url = "https://github.com/$Repo/releases/download/v${version}/$fileName"
$tmpPath = Join-Path $env:TEMP $fileName

Write-Host ""
Write-Host "  version  " -ForegroundColor DarkGray -NoNewline; Write-Host "v$version" -ForegroundColor White
Write-Host "  arch     " -ForegroundColor DarkGray -NoNewline; Write-Host "x64"
Write-Host ""

# ── Download ──
Write-Info "Downloading $fileName..."
try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $tmpPath -UseBasicParsing
    $ProgressPreference = 'Continue'
} catch {
    Write-Err "Download failed: $_"
}
Write-Ok "Downloaded to $tmpPath"

# ── Run installer (silent) ──
Write-Info "Installing..."
Start-Process -FilePath $tmpPath -ArgumentList "/S" -Wait

# ── Cleanup ──
Remove-Item -Path $tmpPath -Force -ErrorAction SilentlyContinue
Write-Ok "Cleaned up"

# ── Launch ──
$exePath = Join-Path $env:LOCALAPPDATA "Racemo\Racemo.exe"
if (Test-Path $exePath) {
    Write-Ok "Installed"
    Start-Process -FilePath $exePath
} else {
    Write-Warn "Racemo.exe not found at expected path — search 'Racemo' in Start Menu"
}

Write-Host ""
Write-Host "  Racemo v$version installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  Uninstall    " -ForegroundColor DarkGray -NoNewline; Write-Host "Settings > Apps > Racemo" -ForegroundColor White
Write-Host ""
