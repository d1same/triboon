param(
  [string]$AndroidDevice = $env:TRIBOON_ADB_DEVICE,
  [switch]$SkipAndroidStress,
  [switch]$SkipServerSmoke,
  [int]$ServerPort = 7787
)

$ErrorActionPreference = "Stop"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repo

$failures = New-Object System.Collections.Generic.List[string]

function Add-Failure([string]$Name, [string]$Message) {
  $failures.Add("${Name}: $Message") | Out-Null
}

function Invoke-Gate([string]$Name, [scriptblock]$Body) {
  Write-Host ""
  Write-Host "==> $Name"
  try {
    & $Body
    Write-Host "PASS $Name"
  } catch {
    Add-Failure $Name $_.Exception.Message
    Write-Host "FAIL $Name"
    Write-Host $_.Exception.Message
  }
}

function Assert-ExitCode([string]$What) {
  if ($LASTEXITCODE -ne 0) {
    throw "$What failed with exit code $LASTEXITCODE"
  }
}

Invoke-Gate "git diff whitespace" {
  & git diff --check
  Assert-ExitCode "git diff --check"
}

Invoke-Gate "tracked JavaScript syntax" {
  $files = & git ls-files | Where-Object { $_ -match "\.js$" -and $_ -notmatch "^graphify-out/" }
  foreach ($file in $files) {
    & node --check $file
    Assert-ExitCode "node --check $file"
  }
}

Invoke-Gate "web/index.html inline script parse" {
  $parser = @'
const fs = require('fs');
const html = fs.readFileSync('web/index.html', 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1])
  .filter((s) => s.trim());
for (const src of scripts) new Function(src);
console.log(`Parsed ${scripts.length} inline script block(s)`);
'@
  $parser | node -
  Assert-ExitCode "inline web script parse"
}

Invoke-Gate "IPTV / Live TV / P9 focused tests" {
  & node --test test/iptv-cache.test.js
  Assert-ExitCode "test/iptv-cache.test.js"
  & node --test test/security.test.js --test-name-pattern "iptv|IPTV|Live TV|native proxy|native"
  Assert-ExitCode "security IPTV pattern"
  & node --test test/phase4.test.js --test-name-pattern "IPTV|Live TV|native Live|playChannel|guide|PiP"
  Assert-ExitCode "phase4 IPTV pattern"
}

Invoke-Gate "Fast VOD startup / P14 focused tests" {
  & node --test test/e2e.test.js
  Assert-ExitCode "test/e2e.test.js"
  & node --test test/phase2.test.js --test-name-pattern "warmup|prepare|startup|read-ahead|priority|buffer|4K"
  Assert-ExitCode "phase2 startup pattern"
  & node --test test/phase4.test.js --test-name-pattern "prepare|startup|VOD pause resume|native player|ExoPlayer|seek"
  Assert-ExitCode "phase4 startup/native pattern"
  & node --test test/security.test.js --test-name-pattern "streaming|prepare|play|route"
  Assert-ExitCode "security streaming pattern"
}

Invoke-Gate "Subtitles / CC / P11 focused tests" {
  & node --test test/phase2.test.js --test-name-pattern "subs|subtitle|Wyzie|caption"
  Assert-ExitCode "phase2 subtitle pattern"
  & node --test test/phase4.test.js --test-name-pattern "subtitle|Subtitles|caption|CC|Wyzie|built-in|sync"
  Assert-ExitCode "phase4 subtitle pattern"
  & node --test test/security.test.js --test-name-pattern "subtitle|subtitles|Wyzie|built-in"
  Assert-ExitCode "security subtitle pattern"
}

Invoke-Gate "full Node suite" {
  & npm.cmd test
  Assert-ExitCode "npm.cmd test"
}

if (!$SkipServerSmoke) {
  Invoke-Gate "isolated server /api/server smoke" {
    $dataDir = Join-Path ([System.IO.Path]::GetTempPath()) ("triboon-verify-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    $process = $null
    try {
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = "node"
      $psi.Arguments = "server/index.js"
      $psi.WorkingDirectory = $repo.Path
      $psi.UseShellExecute = $false
      $psi.EnvironmentVariables["PORT"] = [string]$ServerPort
      $psi.EnvironmentVariables["TRIBOON_DATA"] = $dataDir
      $psi.EnvironmentVariables["TRIBOON_SECRET"] = "verify-before-update-secret"
      $process = [System.Diagnostics.Process]::Start($psi)
      $deadline = (Get-Date).AddSeconds(25)
      $ok = $false
      do {
        if ($process.HasExited) {
          throw "server exited before health check with code $($process.ExitCode)"
        }
        try {
          $res = Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/api/server" -TimeoutSec 2
          if ($res -and $res.version) {
            Write-Host "Server version $($res.version), phase $($res.phase)"
            $ok = $true
            break
          }
        } catch {
          Start-Sleep -Milliseconds 500
        }
      } while ((Get-Date) -lt $deadline)
      if (!$ok) { throw "/api/server did not become healthy on port $ServerPort" }
    } finally {
      if ($process -and !$process.HasExited) {
        $process.Kill()
        $process.WaitForExit()
      }
      Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Invoke-Gate "Android debug build" {
  if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME)) {
    $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
  }
  if ([string]::IsNullOrWhiteSpace($env:ANDROID_HOME)) {
    $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk"
  }
  $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
  & .\android\gradlew.bat -p android assembleDebug
  Assert-ExitCode "Android assembleDebug"
}

Invoke-Gate "Android ExoPlayer stress smoke" {
  if ($SkipAndroidStress) {
    throw "Android stress was skipped; Android ExoPlayer must be reported as not fully verified."
  }
  $adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
  if (!(Test-Path $adb)) { throw "adb not found at $adb" }
  if ([string]::IsNullOrWhiteSpace($AndroidDevice)) {
    $connected = & $adb devices | Select-String -Pattern "^\S+\s+device$" | ForEach-Object { ($_ -split "\s+")[0] }
    if (@($connected).Count -eq 1) {
      $AndroidDevice = @($connected)[0]
    } else {
      throw "Set -AndroidDevice or TRIBOON_ADB_DEVICE to run Android ExoPlayer stress."
    }
  }
  powershell -NoProfile -ExecutionPolicy Bypass -File .\bench\android-tv-stress.ps1 `
    -Device $AndroidDevice `
    -PageLoops 1 `
    -LiveZaps 20 `
    -PipLoops 2 `
    -VodSeeks 10 `
    -NoScreenshot
  Assert-ExitCode "Android TV stress smoke"
}

Write-Host ""
if ($failures.Count -gt 0) {
  Write-Host "Verification failed:"
  foreach ($failure in $failures) { Write-Host " - $failure" }
  exit 1
}

Write-Host "Automated verification passed."
Write-Host "Complete the live smoke evidence in VERIFY.md before calling the update done."
