#requires -version 5.1
<#
  build-installer.ps1 - package the Triboon Node server into a one-click Windows installer.

  Produces installer\windows\dist\Triboon-Setup-v<version>.exe. The installer bundles the Node 24
  runtime + ffmpeg/ffprobe + yt-dlp (+ alass), registers Triboon as an auto-start Windows service,
  opens the LAN firewall (private+domain only), locks the data dir ACL, and keeps user data under
  C:\ProgramData\Triboon.

  Every bundled binary is integrity-checked before it goes into the payload:
    - Node + ffmpeg + yt-dlp : verified against the provider's own published checksum, fetched fresh
      (SHASUMS256.txt / .sha256 / SHA2-256SUMS) - same trust model the Node download already used.
    - WinSW + alass          : pinned to a known-good SHA-256 constant below (immutable releases),
      the strongest check. Update the constant if you ever bump those versions.

  Prerequisites on THIS build machine:
    - Inno Setup 6.3+ (ISCC.exe) - https://jrsoftware.org/isdl.php  (winget install JRSoftware.InnoSetup)
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

# --- pinned integrity constants for the immutable (versioned) releases -------------------------
$WINSW_VERSION = 'v2.12.0'
$WINSW_SHA256  = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'  # WinSW-x64.exe
$ALASS_VERSION = 'v2.0.0'
$ALASS_SHA256  = 'e81a72f97f592910e909a2352d6b8c0de0801c51ac1383bad4ebf3f2ecdd2fd8'  # alass-windows64.zip

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path      # installer\windows
$repo    = (Resolve-Path (Join-Path $here '..\..')).Path        # repo root
$staging = Join-Path $here 'staging'
$dl      = Join-Path $staging 'downloads'
$app     = Join-Path $staging 'app'
$bin     = Join-Path $app 'bin'
$dist    = Join-Path $here 'dist'

$pkg     = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version

Write-Host "Triboon Windows installer build - v$version" -ForegroundColor Cyan

if ($Clean) {
  Write-Host "  -Clean: removing staging + dist"
  Remove-Item $staging, $dist -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $dl, $app, $bin, (Join-Path $app 'licenses'), $dist | Out-Null

# Fetch a small text resource as a decoded string. Invoke-WebRequest returns .Content as a byte[]
# when the server sends application/octet-stream (e.g. GitHub release assets like SHA2-256SUMS),
# and as a string for text/plain (e.g. nodejs.org SHASUMS256.txt) - normalize both to text.
function Get-Text([string]$url) {
  $c = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
  if ($c -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($c) }
  return [string]$c
}

function Assert-Sha256([string]$file, [string]$expected, [string]$label) {
  $got = (Get-FileHash -Algorithm SHA256 $file).Hash
  if ($got.ToLower() -ne $expected.ToLower()) {
    throw "SHA-256 mismatch for ${label}:`n  expected $expected`n  got      $got"
  }
  Write-Host "  sha256 : ok ($label)"
}

# Download to $outFile and verify against $expectedHash. A cached file is re-verified (a poisoned
# cache entry is caught, not trusted); a rolling-URL artifact whose hash moved is re-downloaded.
function Get-Verified([string]$url, [string]$outFile, [string]$expectedHash, [string]$label) {
  if (Test-Path $outFile) {
    if ($expectedHash) {
      if ((Get-FileHash -Algorithm SHA256 $outFile).Hash.ToLower() -eq $expectedHash.ToLower()) {
        Write-Host "  cached : $label (verified)"; return
      }
      Write-Host "  cached $label failed hash check - re-downloading"
      Remove-Item $outFile -Force
    } else { Write-Host "  cached : $label"; return }
  }
  Write-Host "  get    : $url"
  Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
  if ($expectedHash) { Assert-Sha256 $outFile $expectedHash $label }
}

# ---------------------------------------------------------------- [1/6] Node runtime
Write-Host "[1/6] Node 24 runtime"
$idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
$v24 = $idx | Where-Object { $_.version -like 'v24.*' } |
       Sort-Object { [version]($_.version.TrimStart('v')) } -Descending | Select-Object -First 1
if (-not $v24) { throw "Could not resolve a Node v24 release from dist/index.json" }
$nodeVer = $v24.version
$nodeZipName = "node-$nodeVer-win-x64.zip"
$nodeZip = Join-Path $dl $nodeZipName
# Expected zip hash comes from the official SHASUMS256.txt for this exact version.
$shas = Get-Text "https://nodejs.org/dist/$nodeVer/SHASUMS256.txt"
$nodeExpected = $null
foreach ($line in ($shas -split "`n")) {
  if ($line.Trim() -match ('\s' + [regex]::Escape($nodeZipName) + '$')) { $nodeExpected = ($line.Trim() -split '\s+')[0]; break }
}
if (-not $nodeExpected) { throw "Could not find $nodeZipName in Node SHASUMS256.txt" }
Get-Verified "https://nodejs.org/dist/$nodeVer/$nodeZipName" $nodeZip $nodeExpected "node $nodeVer"
$nodeExtract = Join-Path $dl "node-$nodeVer"
if (-not (Test-Path $nodeExtract)) { Expand-Archive -Path $nodeZip -DestinationPath $nodeExtract -Force }
Copy-Item (Join-Path $nodeExtract "node-$nodeVer-win-x64\node.exe") (Join-Path $app 'node.exe') -Force

# ---------------------------------------------------------------- [2/6] WinSW service wrapper (pinned)
Write-Host "[2/6] WinSW service wrapper ($WINSW_VERSION)"
$winsw = Join-Path $dl 'WinSW-x64.exe'
Get-Verified "https://github.com/winsw/winsw/releases/download/$WINSW_VERSION/WinSW-x64.exe" $winsw $WINSW_SHA256 'WinSW'
Copy-Item $winsw (Join-Path $app 'triboon-service.exe') -Force
Copy-Item (Join-Path $here 'triboon-service.xml') (Join-Path $app 'triboon-service.xml') -Force

# ---------------------------------------------------------------- [3/6] ffmpeg + ffprobe (provider checksum)
Write-Host "[3/6] ffmpeg + ffprobe (gyan.dev release-essentials)"
$ffUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
$ffZip = Join-Path $dl 'ffmpeg-release-essentials.zip'
$ffShaTxt = Get-Text "$ffUrl.sha256"
$ffExpected = ([regex]::Match($ffShaTxt, '[0-9a-fA-F]{64}')).Value
if (-not $ffExpected) { throw "Could not read ffmpeg .sha256 checksum" }
Get-Verified $ffUrl $ffZip $ffExpected 'ffmpeg'
$ffExtract = Join-Path $dl 'ffmpeg'
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

# ---------------------------------------------------------------- [4/6] yt-dlp (provider checksum)
Write-Host "[4/6] yt-dlp (Music)"
$ytdlp = Join-Path $dl 'yt-dlp.exe'
$ytSums = Get-Text 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS'
$ytExpected = $null
foreach ($line in ($ytSums -split "`n")) {
  $t = $line.Trim(); if ($t -match '\syt-dlp\.exe$') { $ytExpected = ($t -split '\s+')[0]; break }
}
if (-not $ytExpected) { throw "Could not find yt-dlp.exe in yt-dlp SHA2-256SUMS" }
Get-Verified 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' $ytdlp $ytExpected 'yt-dlp'
Copy-Item $ytdlp (Join-Path $bin 'yt-dlp.exe') -Force

# ---------------------------------------------------------------- [5/6] alass (pinned, optional)
if ($NoAlass) {
  Write-Host "[5/6] alass skipped (-NoAlass) - subtitle auto-sync will be feature-gated off"
} else {
  Write-Host "[5/6] alass (subtitle auto-sync, $ALASS_VERSION)"
  try {
    $alassZip = Join-Path $dl 'alass-windows64.zip'
    Get-Verified "https://github.com/kaegi/alass/releases/download/$ALASS_VERSION/alass-windows64.zip" $alassZip $ALASS_SHA256 'alass'
    $alassExtract = Join-Path $dl 'alass'
    if (-not (Test-Path $alassExtract)) { Expand-Archive -Path $alassZip -DestinationPath $alassExtract -Force }
    # The archive ships the CLI as bin\alass-cli.exe (there is NO alass.exe). Copy it to the name the
    # service expects; alass-cli.exe spawns ffmpeg as a subprocess (ALASS_FFMPEG_PATH), so the zip's
    # bundled ffmpeg DLLs are not needed.
    $alassExe = Get-ChildItem $alassExtract -Recurse -Include 'alass-cli.exe','alass.exe' -File | Select-Object -First 1
    if ($alassExe) { Copy-Item $alassExe.FullName (Join-Path $bin 'alass.exe') -Force }
    else { Write-Warning "  alass-cli.exe not found in archive; auto-sync will be disabled." }
  } catch {
    Write-Warning "  alass step failed ($($_.Exception.Message)); continuing without it."
  }
}

# ---------------------------------------------------------------- [6/6] app payload + notices
Write-Host "[6/6] app payload (server + web) + license notices"
Remove-Item (Join-Path $app 'server'), (Join-Path $app 'web') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $repo 'server') (Join-Path $app 'server') -Recurse -Force
Copy-Item (Join-Path $repo 'web')    (Join-Path $app 'web')    -Recurse -Force
Copy-Item (Join-Path $repo 'package.json') (Join-Path $app 'package.json') -Force
if (Test-Path (Join-Path $repo 'LICENSE')) { Copy-Item (Join-Path $repo 'LICENSE') (Join-Path $app 'LICENSE') -Force }

$notice = @"
Triboon Windows build - third-party components
==============================================
Triboon itself is MIT-licensed. The following programs are bundled and invoked only as separate
subprocesses (mere aggregation); their licenses apply to those binaries, not to Triboon's source.
Every binary is SHA-256 verified at build time (provider checksum or pinned constant).

- Node.js runtime ($nodeVer)  - node.exe            - https://nodejs.org  (MIT + deps)
- WinSW $WINSW_VERSION         - triboon-service.exe - https://github.com/winsw/winsw  (MIT)
- ffmpeg + ffprobe            - bin\ffmpeg.exe       - https://www.gyan.dev/ffmpeg/builds  (GPLv3)
      Source for this build: https://github.com/GyanD/codexffmpeg  (see licenses\ffmpeg\).
- yt-dlp                      - bin\yt-dlp.exe       - https://github.com/yt-dlp/yt-dlp  (Unlicense)
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
  throw "ISCC.exe (Inno Setup 6.3+) not found. Install it (winget install JRSoftware.InnoSetup) or pass -IsccPath."
}
& $IsccPath "/DAppVersion=$version" "/DStageDir=$app" (Join-Path $here 'Triboon.iss')
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }

$out = Join-Path $dist "Triboon-Setup-v$version.exe"
Write-Host ""
Write-Host "Done -> $out" -ForegroundColor Green
Write-Host "Payload staged in: $app"
