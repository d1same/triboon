# Build the SIGNED release APK and publish it to the GitHub release for the current tag.
#
# Triboon ships one universal APK (it adapts to TV vs phone at runtime), published under the
# TV + mobile names plus the stable "latest" aliases so
#   /releases/latest/download/triboon-tv.apk  and  /triboon-mobile.apk
# always resolve to the newest build (CLAUDE.md release rule).
#
# REQUIRES (keystore values, kept OUTSIDE git):
#   $env:TRIBOON_RELEASE_STORE_FILE       full path to your .keystore/.jks
#   $env:TRIBOON_RELEASE_STORE_PASSWORD
#   $env:TRIBOON_RELEASE_KEY_ALIAS
#   $env:TRIBOON_RELEASE_KEY_PASSWORD
# Also needs: gh (GitHub CLI) logged in, and the vX.Y.Z tag already pushed (CI green).
#
# Usage from the repo root:   npm run release:apk      (or: pwsh bench/cut-apk-release.ps1)
#   -SkipTests   skip the local test gate (CI already ran it on the tag)
#   -NoPublish   build + stage the APKs only; don't touch the GitHub release

# Default signing is the Android DEBUG key (~/.android/debug.keystore) — that is what every Triboon
# release so far used, and it matches the key already installed on the devices, so the in-app
# "Update Android TV" updates in place. Pass -Release to build a proper signed release instead
# (requires the TRIBOON_RELEASE_* keystore env vars; switching keys forces a one-time reinstall).
param([switch]$SkipTests, [switch]$NoPublish, [switch]$Release)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# --- version (single source of truth: package.json, must match android versionName) ---
$ver = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$ver"
$gradle = Get-Content android/app/build.gradle -Raw
if ($gradle -notmatch "versionName\s*=\s*`"$([regex]::Escape($ver))`"") {
  throw "android/app/build.gradle versionName != package.json ($ver). Bump package.json + Android versionCode/versionName together first."
}
Write-Host "== Triboon release $tag ==" -ForegroundColor Cyan

# --- signing env (only the proper-release path needs a keystore) ---
if ($Release) {
  $need = 'TRIBOON_RELEASE_STORE_FILE','TRIBOON_RELEASE_STORE_PASSWORD','TRIBOON_RELEASE_KEY_ALIAS','TRIBOON_RELEASE_KEY_PASSWORD'
  $missing = $need | Where-Object { -not [Environment]::GetEnvironmentVariable($_) }
  if ($missing) { throw "Missing signing env: $($missing -join ', '). Set your keystore values (outside git) and re-run, or drop -Release to use debug signing." }
  if (-not (Test-Path $env:TRIBOON_RELEASE_STORE_FILE)) { throw "Keystore not found: $env:TRIBOON_RELEASE_STORE_FILE" }
} else {
  Write-Host "Signing with the Android debug key (matches prior releases + installed devices). Use -Release for a keystore-signed build." -ForegroundColor Yellow
}

# --- test gate (force-exit avoids the node:test post-run hang) ---
if (-not $SkipTests) {
  Write-Host "Running test gate..." -ForegroundColor Cyan
  & node --test --test-force-exit test/e2e.test.js test/archive.test.js test/phase2.test.js test/security.test.js test/phase4.test.js test/iptv-cache.test.js test/library-db.test.js
  if ($LASTEXITCODE -ne 0) { throw "Tests failed - aborting release." }
}

# --- build signed release ---
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr" }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
$task = if ($Release) { 'assembleRelease' } else { 'assembleDebug' }
Write-Host "Building APK ($task)..." -ForegroundColor Cyan
Push-Location android
try { & .\gradlew.bat $task --console=plain; $code = $LASTEXITCODE } finally { Pop-Location }
if ($code -ne 0) { throw "$task failed (code $code)." }

$apk = if ($Release) { "android/app/build/outputs/apk/release/app-release.apk" } else { "android/app/build/outputs/apk/debug/app-debug.apk" }
if (-not (Test-Path $apk)) { throw "APK not found at $apk" }
$sizeMb = [math]::Round((Get-Item $apk).Length / 1MB, 1)
Write-Host "Built $apk ($sizeMb MB)" -ForegroundColor Green

# --- stage the four published names (same universal APK) ---
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$names = @("triboon-$tag.apk", "triboon.apk", "triboon-tv-$tag.apk", "triboon-mobile-$tag.apk", "triboon-tv.apk", "triboon-mobile.apk")
$files = foreach ($n in $names) { $p = Join-Path $dist $n; Copy-Item $apk $p -Force; $p }
Write-Host "Staged in dist/: $($names -join ', ')" -ForegroundColor Green

if ($NoPublish) { Write-Host "Skipping publish (-NoPublish). Upload dist/* to the $tag release manually." -ForegroundColor Yellow; return }

# --- publish to the GitHub release for this tag (create if missing, else clobber-upload) ---
# Probe with ErrorActionPreference relaxed: a "release not found" on stderr must not abort the
# script under -ErrorActionPreference Stop (it's the expected "create it" signal).
$prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& gh release view $tag 2>$null 1>$null
$hasRelease = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevEAP
if ($hasRelease) {
  Write-Host "Updating existing release $tag..." -ForegroundColor Cyan
  & gh release upload $tag @files --clobber
} else {
  Write-Host "Creating release $tag (marked latest)..." -ForegroundColor Cyan
  & gh release create $tag @files --title "Triboon $tag" --notes "Triboon $tag. See the commit log / VERIFY.md for changes. Universal APK (TV + mobile)." --latest
}
if ($LASTEXITCODE -ne 0) { throw "gh release publish failed." }
Write-Host "Published ${tag}: TV + mobile APKs + stable aliases. /releases/latest/download/triboon-tv.apk now resolves to $tag." -ForegroundColor Green
