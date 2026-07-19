[CmdletBinding()]
param(
    [string]$CacheDirectory,
    [string]$ArtifactDirectory,
    [string]$Tag,
    [switch]$SkipTests,
    [switch]$SkipNpmInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$libMpvArchiveName = 'mpv-dev-lgpl-x86_64-20260713-git-e5486b96d7.7z'
$libMpvArchiveUrl = 'https://github.com/zhongfly/mpv-winbuild/releases/download/2026-07-13-e5486b96d7/mpv-dev-lgpl-x86_64-20260713-git-e5486b96d7.7z'
$libMpvArchiveSha256 = '1016b6029da77f96e3a2831d2c33107eee43f798374ba90f56dce45717ed7932'
$libMpvDllSha256 = '93a3095997a4ae8028a5e772ef185600dd7b2bab5f3ba3f2d6d5c4e7d9f4bd91'
$rustTarget = 'x86_64-pc-windows-msvc'

$clientRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $clientRoot '..\..'))
$tauriRoot = Join-Path $clientRoot 'src-tauri'
$cargoManifest = Join-Path $tauriRoot 'Cargo.toml'
$targetRoot = Join-Path $tauriRoot 'target'

function Resolve-RepoPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DefaultBase
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $DefaultBase $Path))
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        Write-Host "> $Command $($Arguments -join ' ')"
        $previousErrorAction = $ErrorActionPreference
        try {
            # Windows PowerShell 5.1 turns a native program's stderr into error records. Build
            # tools routinely write progress there, so rely on the process exit code instead.
            $ErrorActionPreference = 'Continue'
            & $Command @Arguments 2>&1 | ForEach-Object { Write-Host $_ }
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorAction
        }
        if ($exitCode -ne 0) {
            throw "$Command failed with exit code $exitCode"
        }
    } finally {
        Pop-Location
    }
}

function Get-CommandPath {
    param([Parameter(Mandatory = $true)][string[]]$Names)

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) {
            return $command.Source
        }
    }
    return $null
}

function Import-MsvcEnvironment {
    $dumpbin = Get-CommandPath @('dumpbin.exe', 'dumpbin')
    $libExe = Get-CommandPath @('lib.exe')
    if ($dumpbin -and $libExe -and $libExe -match '[\\/]Microsoft Visual Studio[\\/]') {
        return @{ Dumpbin = $dumpbin; Lib = $libExe }
    }

    $vswhereCandidates = @(@(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
    if (-not $vswhereCandidates) {
        throw 'Visual Studio 2022 Build Tools with the Desktop development with C++ workload are required (vswhere.exe was not found).'
    }

    $vswhere = [string]($vswhereCandidates | Select-Object -First 1)
    $installationPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or -not $installationPath) {
        throw 'Visual Studio C++ x64 build tools were not found.'
    }
    $devCmd = Join-Path ($installationPath | Select-Object -First 1) 'Common7\Tools\VsDevCmd.bat'
    if (-not (Test-Path -LiteralPath $devCmd -PathType Leaf)) {
        throw "VsDevCmd.bat was not found at $devCmd"
    }

    $cmdLine = "`"$devCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
    $environmentLines = & $env:ComSpec /d /s /c $cmdLine
    if ($LASTEXITCODE -ne 0) {
        throw "VsDevCmd.bat failed with exit code $LASTEXITCODE"
    }
    foreach ($line in $environmentLines) {
        if ($line -notmatch '^([^=][^=]*)=(.*)$') { continue }
        [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }

    $dumpbin = Get-CommandPath @('dumpbin.exe', 'dumpbin')
    $libExe = Get-CommandPath @('lib.exe')
    if (-not $dumpbin -or -not $libExe -or $libExe -notmatch '[\\/]Microsoft Visual Studio[\\/]') {
        throw 'MSVC dumpbin.exe and lib.exe were not activated by VsDevCmd.bat.'
    }
    return @{ Dumpbin = $dumpbin; Lib = $libExe }
}

function Resolve-SevenZip {
    $candidates = @(
        (Get-CommandPath @('7z.exe', '7z')),
        (Join-Path $env:ProgramFiles '7-Zip\7z.exe'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe' })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    if (-not $candidates) {
        throw '7-Zip is required to inspect and byte-verify the NSIS installer payload. Install 7-Zip and rerun this script.'
    }
    return [System.IO.Path]::GetFullPath(($candidates | Select-Object -First 1))
}

function Test-Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    return $actual -ceq $Expected.ToLowerInvariant()
}

function Assert-Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing: $Path"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($actual -cne $Expected.ToLowerInvariant()) {
        throw "$Label SHA-256 mismatch: expected $Expected, got $actual"
    }
    Write-Host "$Label SHA-256 verified: $actual"
}

function Get-LockedLibMpv {
    param(
        [Parameter(Mandatory = $true)][string]$CacheRoot,
        [Parameter(Mandatory = $true)][string]$SevenZip
    )

    New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
    $archivePath = Join-Path $CacheRoot $libMpvArchiveName
    if (-not (Test-Sha256 -Path $archivePath -Expected $libMpvArchiveSha256)) {
        if (Test-Path -LiteralPath $archivePath) {
            Write-Warning 'Discarding a cached libmpv archive whose SHA-256 does not match the lock.'
            Remove-Item -LiteralPath $archivePath -Force
        }
        Write-Host "Downloading locked libmpv bundle from $libMpvArchiveUrl"
        Invoke-WebRequest -UseBasicParsing -Uri $libMpvArchiveUrl -OutFile $archivePath
    }
    Assert-Sha256 -Path $archivePath -Expected $libMpvArchiveSha256 -Label 'libmpv archive'

    $extractRoot = Join-Path $CacheRoot "extract-$($libMpvArchiveSha256.Substring(0, 16))"
    $dllPath = Join-Path $extractRoot 'libmpv-2.dll'
    $headerPath = Join-Path $extractRoot 'include\mpv\client.h'
    if (-not (Test-Sha256 -Path $dllPath -Expected $libMpvDllSha256) -or
        -not (Test-Path -LiteralPath $headerPath -PathType Leaf)) {
        if (Test-Path -LiteralPath $extractRoot) {
            $resolvedCache = [System.IO.Path]::GetFullPath($CacheRoot).TrimEnd('\') + '\'
            $resolvedExtract = [System.IO.Path]::GetFullPath($extractRoot).TrimEnd('\') + '\'
            if (-not $resolvedExtract.StartsWith($resolvedCache, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to remove extraction directory outside the libmpv cache: $resolvedExtract"
            }
            Remove-Item -LiteralPath $extractRoot -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
        Invoke-Checked -Command $SevenZip -Arguments @('x', '-y', '-bb0', '-bd', "-o$extractRoot", $archivePath) -WorkingDirectory $CacheRoot
    }

    Assert-Sha256 -Path $dllPath -Expected $libMpvDllSha256 -Label 'libmpv-2.dll'
    if (-not (Test-Path -LiteralPath $headerPath -PathType Leaf)) {
        throw "The locked libmpv archive did not contain include\mpv\client.h"
    }
    return $extractRoot
}

function New-MsvcImportLibrary {
    param(
        [Parameter(Mandatory = $true)][string]$LibMpvRoot,
        [Parameter(Mandatory = $true)][hashtable]$Msvc
    )

    $dllPath = Join-Path $LibMpvRoot 'libmpv-2.dll'
    $defPath = Join-Path $LibMpvRoot 'mpv.def'
    $libPath = Join-Path $LibMpvRoot 'mpv.lib'
    $exports = & $Msvc.Dumpbin /exports $dllPath
    if ($LASTEXITCODE -ne 0) {
        throw "dumpbin failed with exit code $LASTEXITCODE"
    }
    $names = @($exports | ForEach-Object {
        if ($_ -match '\s(mpv_[A-Za-z0-9_]+)\s*$') { $Matches[1] }
    } | Sort-Object -Unique)
    if ($names.Count -lt 20) {
        throw "Expected libmpv exports, found only $($names.Count)"
    }
    Write-Utf8NoBom -Path $defPath -Content ("EXPORTS`r`n" + ($names -join "`r`n") + "`r`n")
    Invoke-Checked -Command $Msvc.Lib -Arguments @("/def:$defPath", '/name:libmpv-2.dll', "/out:$libPath", '/machine:X64') -WorkingDirectory $LibMpvRoot
    if (-not (Test-Path -LiteralPath $libPath -PathType Leaf) -or (Get-Item -LiteralPath $libPath).Length -lt 1024) {
        throw "MSVC import library was not generated: $libPath"
    }

    $dependencies = & $Msvc.Dumpbin /dependents $dllPath
    if ($LASTEXITCODE -ne 0) {
        throw "dumpbin /dependents failed with exit code $LASTEXITCODE"
    }
    if (($dependencies -join "`n") -notmatch '(?im)^\s*vulkan-1\.dll\s*$') {
        throw 'The pinned libmpv dependency contract changed: vulkan-1.dll was not listed by dumpbin.'
    }
    Write-Host 'Pinned libmpv imports vulkan-1.dll; the installer intentionally relies on the current GPU-driver Vulkan loader.'
}

function New-RustDependencyInventory {
    param([Parameter(Mandatory = $true)][string]$OutputPath)

    $cargo = Get-CommandPath @('cargo.exe', 'cargo')
    if (-not $cargo) { throw 'cargo was not found on PATH.' }
    $metadataJson = & $cargo metadata --locked --format-version 1 --filter-platform $rustTarget --manifest-path $cargoManifest
    if ($LASTEXITCODE -ne 0) {
        throw "cargo metadata failed with exit code $LASTEXITCODE"
    }
    $metadata = $metadataJson | ConvertFrom-Json
    $resolvedIds = @($metadata.resolve.nodes | ForEach-Object { [string]$_.id })
    $packages = @($metadata.packages | Where-Object {
        $resolvedIds -contains [string]$_.id -and $_.name -ne 'triboon-px8'
    } | Sort-Object name, version)
    $missingLicense = @($packages | Where-Object { -not $_.license })
    if ($missingLicense.Count -gt 0) {
        throw "Cargo dependencies without declared license metadata: $(($missingLicense.name | Sort-Object -Unique) -join ', ')"
    }

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# Rust dependency license inventory')
    $lines.Add('')
    $lines.Add('Generated from the locked Cargo dependency graph for `x86_64-pc-windows-msvc`.')
    $lines.Add('License expressions are the SPDX metadata declared by each crate; upstream license texts remain authoritative.')
    $lines.Add('')
    $lines.Add('| Crate | Version | Declared license | Source |')
    $lines.Add('| --- | --- | --- | --- |')
    foreach ($package in $packages) {
        $license = ([string]$package.license).Replace('|', '\|')
        $source = if ($package.repository) {
            [string]$package.repository
        } else {
            "https://crates.io/crates/$($package.name)/$($package.version)"
        }
        $lines.Add("| $($package.name) | $($package.version) | $license | $source |")
    }
    $lines.Add('')
    Write-Utf8NoBom -Path $OutputPath -Content ($lines -join "`r`n")
    Write-Host "Generated Rust dependency inventory for $($packages.Count) locked packages."
}

function Find-HashMatch {
    param(
        [Parameter(Mandatory = $true)][System.IO.FileInfo[]]$Files,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$ExpectedPath
    )

    $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ExpectedPath).Hash
    $matches = @($Files | Where-Object { $_.Name -ceq $Name })
    foreach ($match in $matches) {
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $match.FullName).Hash -ceq $expectedHash) {
            return $match
        }
    }
    $seen = if ($matches.Count -eq 0) { 'no files with that name' } else { "$($matches.Count) non-matching file(s)" }
    throw "Installer payload is missing the byte-identical $Name ($seen)."
}

function Test-InstallerPayload {
    param(
        [Parameter(Mandatory = $true)][string]$Installer,
        [Parameter(Mandatory = $true)][string]$SevenZip,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ExpectedFiles,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion
    )

    $validationRoot = Join-Path $targetRoot "installer-payload-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $validationRoot | Out-Null
    try {
        Invoke-Checked -Command $SevenZip -Arguments @('x', '-y', '-bb0', '-bd', "-o$validationRoot", $Installer) -WorkingDirectory $targetRoot
        $files = @(Get-ChildItem -LiteralPath $validationRoot -Recurse -File)
        if ($files.Count -lt 2) {
            throw "7-Zip did not expose an NSIS payload from $Installer"
        }

        # Tauri patches bundle-type metadata into the copy embedded by NSIS and restores the target
        # executable afterwards, so those two PE hashes intentionally differ. Verify the embedded
        # executable's unique name, size, x64 machine type, and version resources instead.
        $appCandidates = @($files | Where-Object { $_.Name -ceq (Split-Path -Leaf $ExpectedExecutable) })
        if ($appCandidates.Count -ne 1) {
            throw "Installer payload must contain exactly one $(Split-Path -Leaf $ExpectedExecutable); found $($appCandidates.Count)."
        }
        $appMatch = $appCandidates[0]
        if ($appMatch.Length -ne (Get-Item -LiteralPath $ExpectedExecutable).Length) {
            throw 'The embedded application size differs from the release executable.'
        }
        $versionInfo = $appMatch.VersionInfo
        if ($versionInfo.FileVersion -cne $ExpectedVersion -or
            $versionInfo.ProductVersion -cne $ExpectedVersion -or
            $versionInfo.ProductName -cne 'Triboon') {
            throw "Embedded application metadata is not Triboon v$ExpectedVersion."
        }
        $stream = [System.IO.File]::OpenRead($appMatch.FullName)
        $reader = New-Object System.IO.BinaryReader($stream)
        try {
            if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Embedded application has no DOS/PE header.' }
            $stream.Position = 0x3c
            $peOffset = $reader.ReadInt32()
            $stream.Position = $peOffset
            if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Embedded application has no PE signature.' }
            if ($reader.ReadUInt16() -ne 0x8664) { throw 'Embedded application is not x86-64.' }
        } finally {
            $reader.Dispose()
            $stream.Dispose()
        }
        $resourceMatches = @{}
        foreach ($name in ($ExpectedFiles.Keys | Sort-Object)) {
            $resourceMatches[$name] = Find-HashMatch -Files $files -Name $name -ExpectedPath $ExpectedFiles[$name]
        }

        $appDirectory = $appMatch.Directory.FullName
        foreach ($name in $resourceMatches.Keys) {
            if ($resourceMatches[$name].Directory.FullName -cne $appDirectory) {
                throw "$name is embedded outside the application directory; libmpv and legal resources must install beside the executable."
            }
        }
        if ($files | Where-Object { $_.Name -ieq 'vulkan-1.dll' }) {
            throw 'The installer unexpectedly bundles vulkan-1.dll; the pinned contract relies on the graphics-driver loader.'
        }

        Write-Host 'NSIS payload byte verification passed:'
        Write-Host "  $($appMatch.FullName.Substring($validationRoot.Length).TrimStart('\'))"
        foreach ($name in ($resourceMatches.Keys | Sort-Object)) {
            Write-Host "  $($resourceMatches[$name].FullName.Substring($validationRoot.Length).TrimStart('\'))"
        }
    } finally {
        $resolvedTarget = [System.IO.Path]::GetFullPath($targetRoot).TrimEnd('\') + '\'
        $resolvedValidation = [System.IO.Path]::GetFullPath($validationRoot).TrimEnd('\') + '\'
        if ($resolvedValidation.StartsWith($resolvedTarget, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Test-Path -LiteralPath $validationRoot)) {
            Remove-Item -LiteralPath $validationRoot -Recurse -Force
        }
    }
}

if (-not $CacheDirectory) {
    $baseCache = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } elseif ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $targetRoot }
    $CacheDirectory = Join-Path $baseCache 'Triboon\build-cache\libmpv'
}
if (-not $ArtifactDirectory) {
    $ArtifactDirectory = Join-Path $repoRoot 'dist\windows-client'
}
$CacheDirectory = Resolve-RepoPath -Path $CacheDirectory -DefaultBase $repoRoot
$ArtifactDirectory = Resolve-RepoPath -Path $ArtifactDirectory -DefaultBase $repoRoot

$tauriConfig = Get-Content -Raw -LiteralPath (Join-Path $tauriRoot 'tauri.conf.json') | ConvertFrom-Json
$packageConfig = Get-Content -Raw -LiteralPath (Join-Path $clientRoot 'package.json') | ConvertFrom-Json
$version = [string]$tauriConfig.version
if ($version -cne [string]$packageConfig.version) {
    throw "Windows package versions differ: Tauri $version vs npm $($packageConfig.version)"
}
if ($Tag) {
    if ($Tag -notmatch '^v\d+\.\d+\.\d+$') { throw "Tag must be strict semver (vX.Y.Z), got $Tag" }
    if ($Tag -cne "v$version") { throw "Tag $Tag does not match Windows client v$version" }
}

$sevenZip = Resolve-SevenZip
$msvc = Import-MsvcEnvironment
$libMpvRoot = Get-LockedLibMpv -CacheRoot $CacheDirectory -SevenZip $sevenZip
New-MsvcImportLibrary -LibMpvRoot $libMpvRoot -Msvc $msvc

$packageInputRoot = Join-Path $targetRoot 'triboon-package-inputs'
New-Item -ItemType Directory -Force -Path $packageInputRoot | Out-Null
$resourceSources = [ordered]@{
    'libmpv-2.dll' = (Join-Path $libMpvRoot 'libmpv-2.dll')
    'LICENSE' = (Join-Path $repoRoot 'LICENSE')
    'THIRD-PARTY-NOTICES.md' = (Join-Path $repoRoot 'THIRD-PARTY-NOTICES.md')
    'LIBMPV-SOURCE.md' = (Join-Path $clientRoot 'LIBMPV-SOURCE.md')
    'LIBMPV-LICENSE.LGPL' = (Join-Path $clientRoot 'LIBMPV-LICENSE.LGPL')
}
foreach ($name in $resourceSources.Keys) {
    if (-not (Test-Path -LiteralPath $resourceSources[$name] -PathType Leaf)) {
        throw "Required package resource is missing: $($resourceSources[$name])"
    }
    Copy-Item -LiteralPath $resourceSources[$name] -Destination (Join-Path $packageInputRoot $name) -Force
}
$rustInventory = Join-Path $packageInputRoot 'RUST-DEPENDENCIES.md'
New-RustDependencyInventory -OutputPath $rustInventory

$stagedResources = [ordered]@{}
foreach ($name in @('libmpv-2.dll', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'LIBMPV-SOURCE.md', 'LIBMPV-LICENSE.LGPL', 'RUST-DEPENDENCIES.md')) {
    $path = Join-Path $packageInputRoot $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
        throw "Staged resource is empty or missing: $name"
    }
    $stagedResources[$name] = $path
}
Assert-Sha256 -Path $stagedResources['libmpv-2.dll'] -Expected $libMpvDllSha256 -Label 'staged libmpv-2.dll'

$resourceMap = [ordered]@{}
foreach ($name in $stagedResources.Keys) {
    $resourceMap[[System.IO.Path]::GetFullPath($stagedResources[$name])] = $name
}
$overlayConfig = [ordered]@{ bundle = [ordered]@{ resources = $resourceMap } }
$overlayConfigPath = Join-Path $packageInputRoot 'tauri.package.conf.json'
Write-Utf8NoBom -Path $overlayConfigPath -Content ($overlayConfig | ConvertTo-Json -Depth 8)

$env:MPV_SOURCE = $libMpvRoot
$env:LIB = "$libMpvRoot;$env:LIB"
$env:PATH = "$libMpvRoot;$env:PATH"
# Tauri launches cargo itself. Pin its rustup selection so a developer whose global default is the
# Windows GNU toolchain cannot silently fall back to dlltool.exe or produce a different ABI.
$env:RUSTUP_TOOLCHAIN = "stable-$rustTarget"
$cargo = Get-CommandPath @('cargo.exe', 'cargo')
$npm = Get-CommandPath @('npm.cmd', 'npm.exe', 'npm')
if (-not $cargo) { throw 'cargo was not found on PATH.' }
if (-not $npm) { throw 'npm was not found on PATH.' }

if (-not $SkipNpmInstall) {
    Invoke-Checked -Command $npm -Arguments @('ci') -WorkingDirectory $clientRoot
}
if (-not $SkipTests) {
    Invoke-Checked -Command $cargo -Arguments @("+stable-$rustTarget", 'test', '--locked', '--manifest-path', $cargoManifest, '--features', 'player') -WorkingDirectory $repoRoot
}

$buildStarted = Get-Date
Invoke-Checked -Command $npm -Arguments @('run', 'tauri', '--', 'build', '--features', 'player', '--config', $overlayConfigPath) -WorkingDirectory $clientRoot

$nsisDirectory = Join-Path $targetRoot 'release\bundle\nsis'
$setups = @(Get-ChildItem -LiteralPath $nsisDirectory -Filter '*-setup.exe' -File | Where-Object {
    $_.Name -match [regex]::Escape($version) -and $_.LastWriteTime -ge $buildStarted.AddMinutes(-2)
})
if ($setups.Count -ne 1) {
    throw "Expected exactly one freshly built v$version NSIS installer, found $($setups.Count) in $nsisDirectory"
}
$installer = $setups[0].FullName
$releaseExecutable = Join-Path $targetRoot 'release\triboon-px8.exe'
if (-not (Test-Path -LiteralPath $releaseExecutable -PathType Leaf)) {
    throw "Release executable was not produced: $releaseExecutable"
}
Test-InstallerPayload -Installer $installer -SevenZip $sevenZip -ExpectedFiles $stagedResources -ExpectedExecutable $releaseExecutable -ExpectedVersion $version

$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -eq 'NotSigned') {
    Write-Warning 'Windows client installer is unsigned; SmartScreen may warn until protected code signing is configured.'
} elseif ($signature.Status -ne 'Valid') {
    throw "Windows client Authenticode status is $($signature.Status)"
} else {
    Write-Host "Valid Windows client signature: $($signature.SignerCertificate.Subject)"
}

New-Item -ItemType Directory -Force -Path $ArtifactDirectory | Out-Null
$stableInstaller = Join-Path $ArtifactDirectory 'Triboon-Windows-Client.exe'
Copy-Item -LiteralPath $installer -Destination $stableInstaller -Force
if ($Tag) {
    $versionedInstaller = Join-Path $ArtifactDirectory "Triboon-Windows-Client-$Tag.exe"
    Copy-Item -LiteralPath $installer -Destination $versionedInstaller -Force
    $stableHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stableInstaller).Hash
    $versionedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $versionedInstaller).Hash
    if ($stableHash -cne $versionedHash) {
        throw 'Windows client stable/versioned aliases differ.'
    }
}

$installerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stableInstaller).Hash.ToLowerInvariant()
Write-Host "Windows client package ready: $stableInstaller"
Write-Host "Installer SHA-256: $installerHash"
