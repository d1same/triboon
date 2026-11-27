[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [string]$PackageIdentityName = 'Disame.Triboon',
    [string]$PackagePublisher = 'CN=CC350014-1964-4C3C-BCF7-6D4262F0EC93',
    [string]$PublisherDisplayName = 'Disame'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$clientRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $clientRoot '..\..'))
$tauriRoot = Join-Path $clientRoot 'src-tauri'
$targetRoot = Join-Path $tauriRoot 'target'
$packageInputRoot = Join-Path $targetRoot 'triboon-package-inputs'
$releaseExe = Join-Path $targetRoot 'release\triboon-px8.exe'
$iconsRoot = Join-Path $tauriRoot 'icons'
$msStoreAssets = Join-Path $clientRoot 'ms-store'

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot 'dist\ms-store'
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

$tauriConfig = Get-Content -Raw -LiteralPath (Join-Path $tauriRoot 'tauri.conf.json') | ConvertFrom-Json
$version = [string]$tauriConfig.version
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Expected X.Y.Z version in tauri.conf.json, got $version"
}
$msixVersion = "$version.0"

if (-not (Test-Path -LiteralPath $releaseExe -PathType Leaf)) {
    throw "Release executable missing ($releaseExe). Run build-package.ps1 first."
}

function Resolve-MakeAppx {
    $cmd = Get-Command 'makeappx.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    if (Test-Path -LiteralPath $kitsRoot) {
        $found = Get-ChildItem -LiteralPath $kitsRoot -Recurse -Filter 'makeappx.exe' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\makeappx\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    throw 'makeappx.exe (Windows 10/11 SDK) was not found. Install the Windows SDK or run on GitHub Actions windows-latest.'
}

$makeAppx = Resolve-MakeAppx
Write-Host "Using MakeAppx: $makeAppx"

$stageRoot = Join-Path $targetRoot 'triboon-msix-stage'
if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
$assetsStage = Join-Path $stageRoot 'Assets'
New-Item -ItemType Directory -Force -Path $assetsStage | Out-Null

# Stage executable + LGPL libmpv + license/notices
Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $stageRoot 'triboon-px8.exe') -Force
foreach ($name in @('libmpv-2.dll', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'LIBMPV-SOURCE.md', 'LIBMPV-LICENSE.LGPL', 'RUST-DEPENDENCIES.md')) {
    $src = Join-Path $packageInputRoot $name
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        throw "Required staged payload file missing: $src"
    }
    Copy-Item -LiteralPath $src -Destination (Join-Path $stageRoot $name) -Force
}

# Stage Microsoft Store visual assets
$assetMap = [ordered]@{
    'StoreLogo.png'       = (Join-Path $iconsRoot 'StoreLogo.png')
    'Square44x44Logo.png' = (Join-Path $iconsRoot 'Square44x44Logo.png')
    'Square150x150Logo.png' = (Join-Path $iconsRoot 'Square150x150Logo.png')
    'Square310x310Logo.png' = (Join-Path $iconsRoot 'Square310x310Logo.png')
    'Wide310x150Logo.png' = (Join-Path $msStoreAssets 'Wide310x150Logo.png')
}
foreach ($destName in $assetMap.Keys) {
    $src = $assetMap[$destName]
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
        throw "Required MSIX visual asset missing: $src"
    }
    Copy-Item -LiteralPath $src -Destination (Join-Path $assetsStage $destName) -Force
}

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">

  <Identity
    Name="$PackageIdentityName"
    Publisher="$PackagePublisher"
    Version="$msixVersion"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>Triboon</DisplayName>
    <PublisherDisplayName>$PublisherDisplayName</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>

  <Resources>
    <Resource Language="en-us" />
  </Resources>

  <Applications>
    <Application Id="Triboon" Executable="triboon-px8.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="Triboon"
        Description="Connect to your self-hosted Triboon media server on Windows."
        BackgroundColor="#0B0812"
        Square150x150Logo="Assets\Square150x150Logo.png"
        Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png" Square310x310Logo="Assets\Square310x310Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>

  <Capabilities>
    <Capability Name="internetClient" />
    <Capability Name="privateNetworkClientServer" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"@

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $stageRoot 'AppxManifest.xml'), $manifest, $utf8NoBom)

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$msixPath = Join-Path $OutputDirectory "Triboon-Windows-Store-v$version.msix"
& $makeAppx pack /d $stageRoot /p $msixPath /o
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $msixPath -PathType Leaf)) {
    throw "MakeAppx pack failed (exit code $LASTEXITCODE)"
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $msixPath).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$msixPath.sha256", "$hash  Triboon-Windows-Store-v$version.msix`n", $utf8NoBom)
Write-Host "Microsoft Store MSIX ready: $msixPath"
Write-Host "MSIX SHA-256: $hash"
