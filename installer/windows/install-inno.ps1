#requires -version 5.1
<#
  Installs the exact Inno Setup compiler recorded in dependencies.lock.json.
  The immutable upstream release asset is SHA-256 and Authenticode checked before it is started;
  Chocolatey and other moving package-resolution services are not part of the release build path.
#>
param(
  [string]$DownloadDirectory = (Join-Path $env:TEMP 'triboon-inno-setup')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$lockPath = Join-Path $here 'dependencies.lock.json'
if (-not (Test-Path -LiteralPath $lockPath)) { throw "Dependency lock not found: $lockPath" }
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
if ($lock.schemaVersion -ne 1) { throw "Unsupported dependency lock schema: $($lock.schemaVersion)" }
$inno = $lock.artifacts.innoSetup
if (-not $inno -or $inno.url -notmatch '^https://' -or $inno.url -match '/latest(?:/|$)' -or
    $inno.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or $inno.compilerSha256 -notmatch '^[0-9a-fA-F]{64}$' -or
    -not $inno.publisherSubject) {
  throw 'Invalid locked Inno Setup artifact metadata'
}

function Assert-Sha256([string]$File, [string]$Expected, [string]$Label) {
  $got = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($got -ne $Expected.ToLowerInvariant()) {
    throw "SHA-256 mismatch for ${Label}:`n  expected $Expected`n  got      $got"
  }
}

New-Item -ItemType Directory -Force -Path $DownloadDirectory | Out-Null
$installer = Join-Path $DownloadDirectory ([string]$inno.fileName)
$partial = "$installer.partial"
Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $installer) {
  try { Assert-Sha256 $installer $inno.sha256 'Inno Setup installer' }
  catch { Remove-Item -LiteralPath $installer -Force }
}
if (-not (Test-Path -LiteralPath $installer)) {
  try {
    Invoke-WebRequest -Uri ([string]$inno.url) -OutFile $partial -UseBasicParsing
    Assert-Sha256 $partial $inno.sha256 'Inno Setup installer'
    Move-Item -LiteralPath $partial -Destination $installer -Force
  } finally {
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
  }
}

$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
    $signature.SignerCertificate.Subject -notlike "$($inno.publisherSubject)*") {
  throw "Invalid Authenticode signature for Inno Setup $($inno.version): $($signature.Status) / $($signature.SignerCertificate.Subject)"
}

$args = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/ALLUSERS')
$process = Start-Process -FilePath $installer -ArgumentList $args -Wait -PassThru
if ($process.ExitCode -notin @(0, 1641, 3010)) {
  throw "Inno Setup installer failed with exit code $($process.ExitCode)"
}

$compilerCandidates = @(
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $compiler) { throw "ISCC.exe was not found after installing Inno Setup $($inno.version)" }
Assert-Sha256 $compiler $inno.compilerSha256 "Inno Setup $($inno.version) compiler"
Write-Host "Installed locked Inno Setup $($inno.version)."
