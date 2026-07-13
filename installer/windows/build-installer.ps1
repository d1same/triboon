#requires -version 5.1
<#
  build-installer.ps1 - package the Triboon Node server into a one-click Windows installer.

  Produces installer\windows\dist\Triboon-Setup-v<version>.exe. The installer bundles the Node 24
  runtime + ffmpeg/ffprobe + yt-dlp (+ alass), registers Triboon as an auto-start Windows service,
  opens the LAN firewall (private+domain only), locks the data dir ACL, and keeps user data under
  C:\ProgramData\Triboon.

  Every bundled binary's exact version, immutable URL, and reviewed SHA-256 live in
  dependencies.lock.json. Builds never resolve a moving "latest" endpoint or fetch a new checksum.

  Prerequisites on THIS build machine:
    - The exact Inno Setup version in dependencies.lock.json (ISCC.exe). CI installs the locked
      compiler with install-inno.ps1; local builders can do the same from an elevated PowerShell.
    - Internet access (bundled binaries are downloaded once, then cached + re-verified in staging\downloads)

  Usage (from anywhere):
    powershell -ExecutionPolicy Bypass -File installer\windows\build-installer.ps1
    ... build-installer.ps1 -NoAlass     # don't bundle alass (disables subtitle auto-sync on Windows)
    ... build-installer.ps1 -Clean       # wipe cached downloads + staging first (fresh build)
    ... build-installer.ps1 -IsccPath "D:\Inno\ISCC.exe"
#>
param(
  [switch]$NoAlass,
  [switch]$Clean,
  [string]$IsccPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # keep Invoke-WebRequest fast (no progress-bar redraw)
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path      # installer\windows
$repo    = (Resolve-Path (Join-Path $here '..\..')).Path        # repo root
$staging = Join-Path $here 'staging'
$dl      = Join-Path $staging 'downloads'
$app     = Join-Path $staging 'app'
$bin     = Join-Path $app 'bin'
$dist    = Join-Path $here 'dist'

$lockPath = Join-Path $here 'dependencies.lock.json'
if (-not (Test-Path -LiteralPath $lockPath)) { throw "Dependency lock not found: $lockPath" }
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
if ($lock.schemaVersion -ne 1) { throw "Unsupported dependency lock schema: $($lock.schemaVersion)" }

function Get-LockedArtifact([string]$name) {
  $artifact = $lock.artifacts.$name
  if (-not $artifact) { throw "Missing '$name' in dependencies.lock.json" }
  if (-not $artifact.version -or -not $artifact.fileName -or
      [IO.Path]::GetFileName([string]$artifact.fileName) -ne [string]$artifact.fileName -or
      $artifact.url -notmatch '^https://' -or $artifact.url -match '/latest(?:/|$)' -or
      $artifact.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw "Invalid locked artifact metadata for '$name'"
  }
  return $artifact
}

$nodeLock   = Get-LockedArtifact 'node'
$winswLock  = Get-LockedArtifact 'winsw'
$ffmpegLock = Get-LockedArtifact 'ffmpeg'
$ytDlpLock  = Get-LockedArtifact 'ytDlp'
$alassLock  = Get-LockedArtifact 'alass'
$innoLock   = Get-LockedArtifact 'innoSetup'
if ($innoLock.compilerSha256 -notmatch '^[0-9a-fA-F]{64}$') {
  throw 'Invalid locked Inno Setup compiler hash'
}
$WINSW_VERSION = [string]$winswLock.version
$ALASS_VERSION = [string]$alassLock.version

$pkg     = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version

Write-Host "Triboon Windows installer build - v$version" -ForegroundColor Cyan

if ($Clean) {
  Write-Host "  -Clean: removing staging + dist"
  Remove-Item $staging, $dist -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $dl, $app, $bin, (Join-Path $app 'licenses'), $dist | Out-Null

function Assert-Sha256([string]$file, [string]$expected, [string]$label) {
  $got = (Get-FileHash -Algorithm SHA256 $file).Hash
  if ($got.ToLower() -ne $expected.ToLower()) {
    throw "SHA-256 mismatch for ${label}:`n  expected $expected`n  got      $got"
  }
  Write-Host "  sha256 : ok ($label)"
}

# Download to a temporary file and verify before it enters the cache. Cached bytes are re-verified,
# so a poisoned or partial cache entry is never trusted.
function Get-Verified([string]$url, [string]$outFile, [string]$expectedHash, [string]$label) {
  if ($url -notmatch '^https://' -or $url -match '/latest(?:/|$)' -or
      $expectedHash -notmatch '^[0-9a-fA-F]{64}$') {
    throw "Invalid locked download metadata for $label"
  }
  if (Test-Path $outFile) {
    if ((Get-FileHash -Algorithm SHA256 $outFile).Hash.ToLower() -eq $expectedHash.ToLower()) {
      Write-Host "  cached : $label (verified)"; return
    }
    Write-Host "  cached $label failed hash check - re-downloading"
    Remove-Item $outFile -Force
  }
  Write-Host "  get    : $url"
  $partial = "$outFile.partial"
  Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
  try {
    Invoke-WebRequest -Uri $url -OutFile $partial -UseBasicParsing
    Assert-Sha256 $partial $expectedHash $label
    Move-Item -LiteralPath $partial -Destination $outFile -Force
  } finally {
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------- [1/6] Node runtime
Write-Host "[1/6] Node 24 runtime"
$nodeVer = [string]$nodeLock.version
$nodeZipName = [string]$nodeLock.fileName
$nodeZip = Join-Path $dl $nodeZipName
Get-Verified ([string]$nodeLock.url) $nodeZip ([string]$nodeLock.sha256) "node $nodeVer"
$nodeExtract = Join-Path $dl "node-$nodeVer"
if (-not (Test-Path $nodeExtract)) { Expand-Archive -Path $nodeZip -DestinationPath $nodeExtract -Force }
Copy-Item (Join-Path $nodeExtract "node-$nodeVer-win-x64\node.exe") (Join-Path $app 'node.exe') -Force

# ---------------------------------------------------------------- [2/6] WinSW service wrapper (pinned)
Write-Host "[2/6] WinSW service wrapper ($WINSW_VERSION)"
$winsw = Join-Path $dl ([string]$winswLock.fileName)
Get-Verified ([string]$winswLock.url) $winsw ([string]$winswLock.sha256) 'WinSW'
Copy-Item $winsw (Join-Path $app 'triboon-service.exe') -Force
Copy-Item (Join-Path $here 'triboon-service.xml') (Join-Path $app 'triboon-service.xml') -Force

# ---------------------------------------------------------------- [3/6] ffmpeg + ffprobe (locked)
Write-Host "[3/6] ffmpeg + ffprobe ($($ffmpegLock.version), gyan.dev essentials)"
$ffZip = Join-Path $dl ([string]$ffmpegLock.fileName)
Get-Verified ([string]$ffmpegLock.url) $ffZip ([string]$ffmpegLock.sha256) 'ffmpeg'
$ffExtract = Join-Path $dl "ffmpeg-$($ffmpegLock.version)"
Remove-Item $ffExtract -Recurse -Force -ErrorAction SilentlyContinue   # version-stamped inner folder; extract fresh
Expand-Archive -Path $ffZip -DestinationPath $ffExtract -Force
$ffmpegExe  = Get-ChildItem $ffExtract -Recurse -Filter 'ffmpeg.exe'  | Select-Object -First 1
$ffprobeExe = Get-ChildItem $ffExtract -Recurse -Filter 'ffprobe.exe' | Select-Object -First 1
if (-not $ffmpegExe -or -not $ffprobeExe) { throw "ffmpeg.exe / ffprobe.exe not found in the ffmpeg archive" }
Copy-Item $ffmpegExe.FullName  (Join-Path $bin 'ffmpeg.exe')  -Force
Copy-Item $ffprobeExe.FullName (Join-Path $bin 'ffprobe.exe') -Force
# GPLv3: ship ffmpeg's own license/attribution alongside the redistributed binary.
$ffRoot = Split-Path (Split-Path $ffmpegExe.FullName -Parent) -Parent
$ffLicDir = Join-Path $app 'licenses\ffmpeg'
New-Item -ItemType Directory -Force -Path $ffLicDir | Out-Null
Get-ChildItem $ffRoot -Include 'LICENSE*','COPYING*','README*' -Recurse -ErrorAction SilentlyContinue |
  Select-Object -First 8 | ForEach-Object { Copy-Item $_.FullName $ffLicDir -Force }

# ---------------------------------------------------------------- [4/6] yt-dlp (locked)
Write-Host "[4/6] yt-dlp $($ytDlpLock.version) (Music)"
$ytdlp = Join-Path $dl ([string]$ytDlpLock.fileName)
Get-Verified ([string]$ytDlpLock.url) $ytdlp ([string]$ytDlpLock.sha256) 'yt-dlp'
Copy-Item $ytdlp (Join-Path $bin 'yt-dlp.exe') -Force

# ---------------------------------------------------------------- [5/6] alass (pinned, optional)
if ($NoAlass) {
  Write-Host "[5/6] alass skipped (-NoAlass) - subtitle auto-sync will be feature-gated off"
} else {
  Write-Host "[5/6] alass (subtitle auto-sync, $ALASS_VERSION)"
  $alassZip = Join-Path $dl ([string]$alassLock.fileName)
  Get-Verified ([string]$alassLock.url) $alassZip ([string]$alassLock.sha256) 'alass'
  $alassExtract = Join-Path $dl "alass-$ALASS_VERSION"
  if (-not (Test-Path $alassExtract)) { Expand-Archive -Path $alassZip -DestinationPath $alassExtract -Force }
  # The archive ships the CLI as bin\alass-cli.exe (there is NO alass.exe). Copy it to the name the
  # service expects; alass-cli.exe spawns ffmpeg as a subprocess (ALASS_FFMPEG_PATH), so the zip's
  # bundled ffmpeg DLLs are not needed.
  $alassExe = Get-ChildItem $alassExtract -Recurse -Include 'alass-cli.exe','alass.exe' -File | Select-Object -First 1
  if (-not $alassExe) { throw 'alass-cli.exe not found in the locked archive' }
  Copy-Item $alassExe.FullName (Join-Path $bin 'alass.exe') -Force
}

# ---------------------------------------------------------------- [6/6] app payload + notices
Write-Host "[6/6] app payload (server + web) + license notices"
Remove-Item (Join-Path $app 'server'), (Join-Path $app 'web') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $repo 'server') (Join-Path $app 'server') -Recurse -Force
Copy-Item (Join-Path $repo 'web')    (Join-Path $app 'web')    -Recurse -Force
Copy-Item (Join-Path $repo 'package.json') (Join-Path $app 'package.json') -Force
if (Test-Path (Join-Path $repo 'LICENSE')) { Copy-Item (Join-Path $repo 'LICENSE') (Join-Path $app 'LICENSE') -Force }
if (Test-Path (Join-Path $repo 'THIRD-PARTY-NOTICES.md')) {
  Copy-Item (Join-Path $repo 'THIRD-PARTY-NOTICES.md') (Join-Path $app 'licenses\THIRD-PARTY-NOTICES.md') -Force
}
Copy-Item $lockPath (Join-Path $app 'licenses\windows-dependencies.lock.json') -Force

$notice = @"
Triboon Windows build - third-party components
==============================================
Triboon itself is MIT-licensed. The following programs are bundled and invoked only as separate
subprocesses (mere aggregation); their licenses apply to those binaries, not to Triboon's source.
Every binary is SHA-256 verified at build time against dependencies.lock.json.

- Node.js runtime ($nodeVer)  - node.exe            - https://nodejs.org  (MIT + deps)
- WinSW $WINSW_VERSION         - triboon-service.exe - https://github.com/winsw/winsw  (MIT)
- ffmpeg + ffprobe $($ffmpegLock.version) - bin\ffmpeg.exe       - https://www.gyan.dev/ffmpeg/builds  (GPLv3)
      Source for this build: https://github.com/GyanD/codexffmpeg  (see licenses\ffmpeg\).
- yt-dlp $($ytDlpLock.version)             - bin\yt-dlp.exe       - https://github.com/yt-dlp/yt-dlp  (Unlicense)
- alass $ALASS_VERSION (optional) - bin\alass.exe    - https://github.com/kaegi/alass  (GPLv3)
"@
$notice | Set-Content (Join-Path $app 'licenses\THIRD-PARTY-NOTICES.txt') -Encoding UTF8

# ---------------------------------------------------------------- compile with Inno Setup
Write-Host "Compiling with Inno Setup..."
if (-not $IsccPath) {
  $cands = @(
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 7\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe",
    # winget's default per-user (non-elevated) install location
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 7\ISCC.exe"
  )
  $IsccPath = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $IsccPath) {
  throw "ISCC.exe (locked Inno Setup $($innoLock.version)) not found. Run install-inno.ps1 as administrator or pass -IsccPath."
}
$isccHash = (Get-FileHash -LiteralPath $IsccPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($isccHash -ne ([string]$innoLock.compilerSha256).ToLowerInvariant()) {
  throw "ISCC version mismatch: dependencies.lock.json requires compiler $($innoLock.version) ($($innoLock.compilerSha256)), found $isccHash at $IsccPath"
}
& $IsccPath "/DAppVersion=$version" "/DStageDir=$app" (Join-Path $here 'Triboon.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }

$out = Join-Path $dist "Triboon-Setup-v$version.exe"
Write-Host ""
Write-Host "Done -> $out" -ForegroundColor Green
Write-Host "Payload staged in: $app"
