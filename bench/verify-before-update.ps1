param(
  [string]$AndroidDevice = $env:TRIBOON_ADB_DEVICE,
  [switch]$SkipAndroidStress,
  [switch]$SkipHouseholdLive,
  [switch]$SkipServerSmoke,
  [int]$ServerPort = 7787,
  [ValidateRange(1, 4)]
  [int]$AndroidVodQualityRank = 3,
  [ValidateRange(0, 86400)]
  [int]$AndroidVodResumeSeconds = 0,
  [ValidateRange(0, 172800)]
  [int]$AndroidVodDurationSeconds = 0,
  [ValidateRange(0, 65535)]
  [int]$AndroidHostServerPort = $(if ($env:TRIBOON_ANDROID_HOST_PORT) { [int]$env:TRIBOON_ANDROID_HOST_PORT } else { 7777 }),
  # Env fallback mirrors TRIBOON_ADB_DEVICE: QA-fixture runs (bench/android-qa-fixture-server.js)
  # must point the stress at the fixture's playable title instead of the real-server default.
  [string]$AndroidVodKey = $(if ($env:TRIBOON_STRESS_VOD_KEY) { $env:TRIBOON_STRESS_VOD_KEY } else { "tmdb:movie:1226863" })
)

$ErrorActionPreference = "Stop"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repo

function Get-AdbDeviceInventory([string]$Adb) {
  $output = @(& $Adb devices 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "Android verification preflight: adb devices failed with exit code $exitCode."
  }
  $inventory = New-Object System.Collections.Generic.List[object]
  foreach ($line in $output) {
    $parts = ([string]$line).Trim() -split "\s+"
    if ($parts.Count -ge 2 -and $parts[0] -ne "List") {
      $inventory.Add([pscustomobject]@{ serial = $parts[0]; state = $parts[1] }) | Out-Null
    }
  }
  return $inventory.ToArray()
}

function Resolve-ReadyAndroidDevice([string]$Adb, [string]$RequestedDevice) {
  $inventory = @(Get-AdbDeviceInventory $Adb)
  if ([string]::IsNullOrWhiteSpace($RequestedDevice)) {
    $ready = @($inventory | Where-Object { $_.state -eq "device" })
    if ($ready.Count -ne 1) {
      $summary = if ($inventory.Count) {
        ($inventory | ForEach-Object { "$($_.serial)=$($_.state)" }) -join ", "
      } else { "none" }
      throw "Android verification preflight: expected exactly one ready ADB device, found $($ready.Count) (connected: $summary). Set -AndroidDevice or TRIBOON_ADB_DEVICE."
    }
    $RequestedDevice = $ready[0].serial
  }
  $entry = $inventory | Where-Object { $_.serial -eq $RequestedDevice } | Select-Object -First 1
  if (!$entry) {
    throw "Android verification preflight: device '$RequestedDevice' is not listed by adb. Start or reconnect it, then rerun."
  }
  if ($entry.state -ne "device") {
    throw "Android verification preflight: device '$RequestedDevice' is '$($entry.state)', not ready. Reconnect or restart it, then rerun."
  }
  $bootOutput = @(& $Adb -s $RequestedDevice shell getprop sys.boot_completed 2>&1)
  $bootExit = $LASTEXITCODE
  $bootState = (($bootOutput | ForEach-Object { [string]$_ }) -join "").Trim()
  if ($bootExit -ne 0) {
    throw "Android verification preflight: device '$RequestedDevice' stopped responding while checking boot state."
  }
  if ($bootState -ne "1") {
    throw "Android verification preflight: device '$RequestedDevice' is connected but has not finished booting (sys.boot_completed='$bootState')."
  }
  return $RequestedDevice
}

# Android playback is a hard gate. Validate the external device before spending minutes on the
# repository gates; the stress helper repeats this check in case the device disconnects later.
if (!$SkipAndroidStress) {
  $androidAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
  if (!(Test-Path $androidAdb)) { throw "Android verification preflight: adb not found at $androidAdb" }
  $AndroidDevice = Resolve-ReadyAndroidDevice $androidAdb $AndroidDevice
  Write-Host "Android preflight ready: $AndroidDevice"
}

$LiveBase = if ($env:TRIBOON_BASE) { $env:TRIBOON_BASE.TrimEnd('/') } else { "http://127.0.0.1:$AndroidHostServerPort" }
function Test-HouseholdLiveAuth {
  return (-not [string]::IsNullOrWhiteSpace($env:TRIBOON_TOKEN)) -or (
    -not [string]::IsNullOrWhiteSpace($env:TRIBOON_USER) -and -not [string]::IsNullOrWhiteSpace($env:TRIBOON_PASS)
  )
}
if (!$SkipHouseholdLive) {
  if (!(Test-HouseholdLiveAuth)) {
    throw "Household live preflight: set TRIBOON_USER+TRIBOON_PASS or TRIBOON_TOKEN, or pass -SkipHouseholdLive and report those smokes unverified."
  }
  try {
    $liveSrv = Invoke-RestMethod -Uri "$LiveBase/api/server" -TimeoutSec 5
    if (-not $liveSrv.version) { throw "no version from $LiveBase/api/server" }
    Write-Host "Household live preflight ready: $LiveBase v$($liveSrv.version)"
  } catch {
    throw "Household live preflight: start the app at $LiveBase (node server/index.js). $($_.Exception.Message)"
  }
}

$failures = New-Object System.Collections.Generic.List[string]
$script:coverage = [ordered]@{
  "Household VOD play/seek/resume/CC" = "not run"
  "Household IPTV web+native retune" = "not run"
  "Household overlapping Play" = "not run"
  "Android ExoPlayer Live+VOD+CC" = "not run"
  "Windows native GPU/HDR" = "not run (needs a real Windows PC session)"
  "Web UI click-through" = "not automated (stream path covered by household VOD/IPTV)"
  "Episode handoff / nested Back / CW recovery" = "not automated (still a VERIFY.md live smoke)"
}

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
  & git diff --check HEAD
  Assert-ExitCode "git diff --check HEAD"
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
  & node --test --test-force-exit test/iptv-cache.test.js
  Assert-ExitCode "test/iptv-cache.test.js"
  & node --test --test-force-exit --test-name-pattern "IPTV|Live TV|native Live|playChannel|guide|PiP" test/phase4.test.js
  Assert-ExitCode "phase4 IPTV pattern"
}

Invoke-Gate "Fast VOD startup / P14 focused tests" {
  & node --test --test-force-exit test/e2e.test.js
  Assert-ExitCode "test/e2e.test.js"
  & node --test --test-force-exit --test-name-pattern "warmup|prepare|startup|read-ahead|priority|buffer|4K|multi-user|concurrent VOD|season pack|season-zero|live-mount reuse|understudy|rank grace" test/phase2.test.js
  Assert-ExitCode "phase2 startup pattern"
  & node --test --test-force-exit --test-name-pattern "prepare|startup|VOD pause resume|native player|ExoPlayer|seek|rebuffer" test/phase4.test.js
  Assert-ExitCode "phase4 startup/native pattern"
  # security.test.js intentionally boots one shared server in its first test. Include that bootstrap
  # in filtered runs or every later route test sees an undefined server and reports false failures.
  & node --test --test-force-exit --test-name-pattern "boot: fresh server|streaming|prepare|play|route|teardown" test/security.test.js
  Assert-ExitCode "security play/prepare/streaming pattern"
}

Invoke-Gate "Subtitles / CC / P11 focused tests" {
  & node --test --test-force-exit --test-name-pattern "subs|subtitle|Wyzie|caption" test/phase2.test.js
  Assert-ExitCode "phase2 subtitle pattern"
  & node --test --test-force-exit --test-name-pattern "subtitle|Subtitles|caption|CC|Wyzie|built-in|sync" test/phase4.test.js
  Assert-ExitCode "phase4 subtitle pattern"
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

Invoke-Gate "household VOD play/seek/resume/CC" {
  if ($SkipHouseholdLive) {
    throw "Household live was skipped; report VOD/CC unverified."
  }
  $movie = if ($env:TRIBOON_VERIFY_MOVIE) { $env:TRIBOON_VERIFY_MOVIE } else { "The Super Mario Galaxy Movie||||4k" }
  $episode = if ($env:TRIBOON_VERIFY_EPISODE) { $env:TRIBOON_VERIFY_EPISODE } else { "FROM S01E01||||1080p" }
  & node bench/verify-live.js --base $LiveBase --cc --resume-frac 0.45 --title $movie --title $episode
  Assert-ExitCode "household VOD verify-live"
  $script:coverage["Household VOD play/seek/resume/CC"] = "PASS"
}

Invoke-Gate "household IPTV first-byte + retune" {
  if ($SkipHouseholdLive) {
    throw "Household live was skipped; report IPTV unverified."
  }
  & node bench/verify-live.js --base $LiveBase --iptv
  Assert-ExitCode "household IPTV verify-live"
  $script:coverage["Household IPTV web+native retune"] = "PASS"
}

Invoke-Gate "household overlapping Play" {
  if ($SkipHouseholdLive) {
    throw "Household live was skipped; report concurrent Play unverified."
  }
  $movie = if ($env:TRIBOON_VERIFY_MOVIE) { $env:TRIBOON_VERIFY_MOVIE } else { "The Super Mario Galaxy Movie||||4k" }
  $episode = if ($env:TRIBOON_VERIFY_EPISODE) { $env:TRIBOON_VERIFY_EPISODE } else { "FROM S01E01||||1080p" }
  & node bench/verify-live.js --base $LiveBase --concurrent --title $episode --title $movie
  Assert-ExitCode "household concurrent verify-live"
  $script:coverage["Household overlapping Play"] = "PASS"
}

Invoke-Gate "Android lint, native unit tests, and debug build" {
  if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME)) {
    $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
  }
  if ([string]::IsNullOrWhiteSpace($env:ANDROID_HOME)) {
    $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk"
  }
  $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
  & .\android\gradlew.bat -p android lintDebug testDebugUnitTest assembleDebug
  Assert-ExitCode "Android lintDebug testDebugUnitTest assembleDebug"
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
    -InstallApk `
    -PageLoops 1 `
    -LiveZaps 20 `
    -PipLoops 2 `
    -VodSeeks 10 `
    -VodKey $AndroidVodKey `
    -VodQualityRank $AndroidVodQualityRank `
    -VodResumeSeconds $AndroidVodResumeSeconds `
    -VodDurationSeconds $AndroidVodDurationSeconds `
    -HostServerPort $AndroidHostServerPort `
    -NoScreenshot
  Assert-ExitCode "Android TV stress smoke"
  $script:coverage["Android ExoPlayer Live+VOD+CC"] = "PASS"
}

Write-Host ""
Write-Host "Live coverage:"
foreach ($key in $script:coverage.Keys) {
  Write-Host "  ${key}: $($script:coverage[$key])"
}

if ($failures.Count -gt 0) {
  Write-Host "Verification failed:"
  foreach ($failure in $failures) { Write-Host " - $failure" }
  exit 1
}

Write-Host "Automated verification passed."
Write-Host "Complete any leftover 'not run' / 'not automated' rows in VERIFY.md before calling the update done."
