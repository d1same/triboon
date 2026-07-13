# Build the SIGNED release APK and stage it for the current tag; optional -Publish creates a draft.
#
# Triboon ships ONE universal APK (it adapts to TV vs phone at runtime), published as triboon.apk
# (+ versioned triboon-vX.Y.Z.apk) so /releases/latest/download/triboon.apk always resolves to the
# newest build (CLAUDE.md release rule). The legacy triboon-tv/mobile names were retired post-v1.7.67.
#
# REQUIRES (keystore values, kept OUTSIDE git):
#   $env:TRIBOON_RELEASE_STORE_FILE       full path to your .keystore/.jks
#   $env:TRIBOON_RELEASE_STORE_PASSWORD
#   $env:TRIBOON_RELEASE_KEY_ALIAS
#   $env:TRIBOON_RELEASE_KEY_PASSWORD
# Also needs: gh (GitHub CLI) logged in, and the vX.Y.Z tag already pushed (CI green).
#
# Usage from the repo root:   npm run release:apk
#   -SkipTests  skip the full local gate only after the exact commit passed CI
#   -Publish    create a NEW draft GitHub release after staging (never overwrites an existing one)
param([switch]$SkipTests, [switch]$Publish)
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

if ($Publish) {
  $dirty = @(& git status --porcelain --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $dirty.Count) { throw "Publishing requires a completely clean worktree." }
  $head = (& git rev-parse HEAD).Trim()
  & git show-ref --verify --quiet "refs/tags/$tag"
  if ($LASTEXITCODE -ne 0) { throw "Local tag $tag does not exist. Create it only after main CI is green." }
  if ((& git rev-parse "$tag^{commit}").Trim() -ne $head) { throw "Tag $tag does not point at HEAD." }
  $remoteTag = @(& git ls-remote --refs origin "refs/tags/$tag")
  if ($LASTEXITCODE -ne 0 -or -not $remoteTag) { throw "Remote tag $tag is missing." }
  if (($remoteTag[0] -split "`t")[0] -ne $head) { throw "Remote tag $tag does not point at HEAD." }
  $remoteMain = @(& git ls-remote --refs origin refs/heads/main)
  if ($LASTEXITCODE -ne 0 -or -not $remoteMain -or ($remoteMain[0] -split "`t")[0] -ne $head) {
    throw "HEAD must be the current origin/main commit before publishing."
  }
  $runs = @(& gh run list --branch main --commit $head --workflow docker.yml --event push --limit 20 --json status,conclusion | ConvertFrom-Json)
  if (-not ($runs | Where-Object { $_.status -eq 'completed' -and $_.conclusion -eq 'success' })) {
    throw "No successful main push workflow exists for $head. Wait for CI before publishing."
  }
}

# Release assets are NEVER debug-signed. These values remain outside git.
$need = 'TRIBOON_RELEASE_STORE_FILE','TRIBOON_RELEASE_STORE_PASSWORD','TRIBOON_RELEASE_KEY_ALIAS','TRIBOON_RELEASE_KEY_PASSWORD'
$missing = $need | Where-Object { -not [Environment]::GetEnvironmentVariable($_) }
if ($missing) { throw "Missing release-signing env: $($missing -join ', '). Debug APKs cannot be published." }
if (-not (Test-Path $env:TRIBOON_RELEASE_STORE_FILE)) { throw "Keystore not found: $env:TRIBOON_RELEASE_STORE_FILE" }

# --- test gate (force-exit avoids the node:test post-run hang) ---
if (-not $SkipTests) {
  Write-Host "Running test gate..." -ForegroundColor Cyan
  & npm.cmd run verify:full
  if ($LASTEXITCODE -ne 0) { throw "Full verification failed - aborting release." }
}

# --- build signed release ---
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr" }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
Write-Host "Building signed release APK..." -ForegroundColor Cyan
Push-Location android
try { & .\gradlew.bat assembleRelease --console=plain; $code = $LASTEXITCODE } finally { Pop-Location }
if ($code -ne 0) { throw "assembleRelease failed (code $code)." }

$apk = "android/app/build/outputs/apk/release/app-release.apk"
if (-not (Test-Path $apk)) { throw "APK not found at $apk" }

# Match CI's immutable APK identity checks before anything is copied into dist/. Selecting from the
# installed build-tools directories avoids trusting a PATH shadow for either verifier.
$expectedReleaseCertSha256 = 'c0b1e2d90b443b07fe4ec4001496539aeb810d2bb9bba9a5f1d8781aa7e28d42'

function Get-LatestAndroidBuildTool([string[]]$Names) {
  $buildTools = Join-Path $env:ANDROID_HOME 'build-tools'
  if (-not (Test-Path -LiteralPath $buildTools -PathType Container)) {
    throw "Android build-tools directory not found under ANDROID_HOME: $buildTools"
  }
  $candidates = foreach ($directory in Get-ChildItem -LiteralPath $buildTools -Directory) {
    foreach ($name in $Names) {
      $candidate = Join-Path $directory.FullName $name
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        [pscustomobject]@{ Path = $candidate; Version = $directory.Name }
      }
    }
  }
  $selected = $candidates | Sort-Object @{ Expression = {
    try { [version](($_.Version -replace '-.*$', '')) } catch { [version]'0.0' }
  } } | Select-Object -Last 1
  if (-not $selected) { throw "Required Android build tool not found: $($Names -join ' or ')" }
  return $selected.Path
}

function Invoke-CheckedAndroidTool([string]$Tool, [string[]]$Arguments, [string]$Label) {
  $output = @(& $Tool @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw "$Label failed (code $exitCode)." }
  return ($output -join "`n")
}

$apksigner = Get-LatestAndroidBuildTool -Names @('apksigner.bat', 'apksigner')
$aapt = Get-LatestAndroidBuildTool -Names @('aapt.exe', 'aapt')
$certOutput = Invoke-CheckedAndroidTool -Tool $apksigner -Arguments @('verify', '--verbose', '--print-certs', $apk) -Label 'APK signature verification'
$cert = [regex]::Match($certOutput, '(?im)certificate SHA-256 digest:\s*([0-9a-f]{64})\s*$')
if (-not $cert.Success -or $cert.Groups[1].Value.ToLowerInvariant() -ne $expectedReleaseCertSha256) {
  throw 'Release APK certificate does not match the pinned Triboon production signer.'
}

$badging = Invoke-CheckedAndroidTool -Tool $aapt -Arguments @('dump', 'badging', $apk) -Label 'APK badging inspection'
$embeddedVersion = [regex]::Match($badging, "(?m)^package:.*\bversionName='([^']+)'")
if (-not $embeddedVersion.Success -or $embeddedVersion.Groups[1].Value -cne $ver) {
  throw "Release APK embedded versionName does not match package.json ($ver)."
}
Write-Host "Verified APK embedded version and production signing certificate." -ForegroundColor Green

$sizeMb = [math]::Round((Get-Item $apk).Length / 1MB, 1)
Write-Host "Built $apk ($sizeMb MB)" -ForegroundColor Green

# --- stage the two published APK names (same universal APK) ---
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$names = @("triboon-$tag.apk", "triboon.apk")
$files = foreach ($n in $names) { $p = Join-Path $dist $n; Copy-Item $apk $p -Force; $p }
Write-Host "Staged in dist/: $($names -join ', ')" -ForegroundColor Green

if (-not $Publish) { Write-Host "Staged only. CI is the normal publisher; pass -Publish only to create a new draft release." -ForegroundColor Yellow; return }

# --- optional fallback publisher: a new draft for an existing verified tag only ---
# Probe with ErrorActionPreference relaxed: a "release not found" on stderr must not abort the
# script under -ErrorActionPreference Stop (it's the expected "create it" signal).
$prevEAP = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& gh release view $tag 2>$null 1>$null
$hasRelease = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevEAP
if ($hasRelease) { throw "Release $tag already exists; refusing to overwrite immutable assets." }
Write-Host "Creating draft release $tag..." -ForegroundColor Cyan
& gh release create $tag @files --verify-tag --title "Triboon $tag" --notes "Triboon $tag. See VERIFY.md for verified changes. Universal APK (TV + mobile)." --draft
if ($LASTEXITCODE -ne 0) { throw "gh release publish failed." }
Write-Host "Created draft ${tag}; review all required assets before publishing it as latest." -ForegroundColor Green
