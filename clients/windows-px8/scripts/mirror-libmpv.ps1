[CmdletBinding()]
param(
    [string]$Repository = 'd1same/triboon',
    [string]$WorkDirectory
)

# Publishes the libmpv archive pinned in build-package.ps1 as Triboon's own immutable mirror, so a
# release tag still builds after zhongfly deletes the upstream release (~5 weeks). Run it right after
# repinning and before tagging. Safe to rerun: an existing mirror is only re-verified, never replaced.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$buildScript = Join-Path $PSScriptRoot 'build-package.ps1'
$recipe = Get-Content -Raw -LiteralPath $buildScript

function Get-Pin([string]$Name) {
    $match = [regex]::Match($recipe, "(?m)^\`$$Name = '([^']+)'")
    if (-not $match.Success) { throw "build-package.ps1 does not define `$$Name" }
    return $match.Groups[1].Value
}

$archiveName = Get-Pin 'libMpvArchiveName'
$archiveSha256 = Get-Pin 'libMpvArchiveSha256'
$urls = @([regex]::Matches($recipe, "(?m)^\s+'(https://github\.com/[^']+\.7z)',?\s*$") | ForEach-Object { $_.Groups[1].Value })
if ($urls.Count -lt 2) { throw 'build-package.ps1 must list the mirror URL first and the upstream URL after it' }

$mirrorPattern = "^https://github\.com/$([regex]::Escape($Repository))/releases/download/(libmpv-[^/]+)/$([regex]::Escape($archiveName))$"
$mirrorMatch = [regex]::Match($urls[0], $mirrorPattern)
if (-not $mirrorMatch.Success) { throw "The first libmpv URL is not a $Repository mirror of ${archiveName}: $($urls[0])" }
$mirrorTag = $mirrorMatch.Groups[1].Value
$upstreamMatch = [regex]::Match($urls[1], "^https://github\.com/zhongfly/mpv-winbuild/releases/download/([^/]+)/$([regex]::Escape($archiveName))$")
if (-not $upstreamMatch.Success) { throw "The second libmpv URL is not the zhongfly upstream archive: $($urls[1])" }
if ($mirrorTag -cne "libmpv-$($upstreamMatch.Groups[1].Value)") {
    throw "Mirror tag $mirrorTag must be libmpv-$($upstreamMatch.Groups[1].Value)"
}

if (-not $WorkDirectory) {
    $WorkDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "triboon-libmpv-mirror-$($archiveSha256.Substring(0, 16))"
}
New-Item -ItemType Directory -Force -Path $WorkDirectory | Out-Null
$archivePath = Join-Path $WorkDirectory $archiveName

function Test-Archive([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() -ceq $archiveSha256
}

$gh = (Get-Command gh -ErrorAction Stop).Source
# Windows PowerShell 5.1 turns native stderr into terminating errors under 'Stop'; "release not
# found" is an expected answer here, so judge by the exit code alone.
$ErrorActionPreference = 'Continue'
& $gh release view $mirrorTag --repo $Repository --json tagName 2>&1 | Out-Null
$exists = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'

if (-not $exists) {
    Write-Host "Downloading upstream archive $($urls[1])"
    Invoke-WebRequest -UseBasicParsing -Uri $urls[1] -OutFile $archivePath
    if (-not (Test-Archive $archivePath)) { throw "Upstream archive does not match the pinned SHA-256 $archiveSha256" }
    $notes = @"
Immutable build-input mirror of the unmodified LGPL libmpv archive used by the Windows client build. Not a Triboon release; do not install.

- Archive: $archiveName
- SHA-256: $archiveSha256
- Upstream: $($urls[1])
- Source, license, and rebuild instructions: clients/windows-px8/LIBMPV-SOURCE.md

libmpv is licensed under the GNU LGPL v2.1 or later. Do not delete or replace this asset: released Windows client builds pin it by URL and SHA-256.
"@
    # Prerelease + --latest=false keeps the "latest release" link (APK and Windows updaters) on the real release,
    # and the libmpv- tag never matches the v* release workflow trigger.
    & $gh release create $mirrorTag $archivePath --repo $Repository --prerelease --latest=false `
        --title "libmpv mirror $($mirrorTag.Substring(7)) (build input, not a Triboon release)" --notes $notes
    if ($LASTEXITCODE -ne 0) { throw "gh release create $mirrorTag failed" }
} else {
    Write-Host "Mirror release $mirrorTag already exists; verifying its asset."
}

$verifyPath = Join-Path $WorkDirectory "verify-$archiveName"
Invoke-WebRequest -UseBasicParsing -Uri $urls[0] -OutFile $verifyPath
if (-not (Test-Archive $verifyPath)) { throw "Mirror asset $($urls[0]) does not match the pinned SHA-256 $archiveSha256" }
Remove-Item -LiteralPath $verifyPath -Force
Write-Host "libmpv mirror verified: $($urls[0])"
