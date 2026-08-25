param(
  [string]$Device = "emulator-5554",
  [string]$Package = "app.triboon.tv",
  [string]$Activity = "app.triboon.tv/.MainActivity",
  [int]$DevtoolsPort = 9227,
  [switch]$InstallApk,
  [string]$ApkPath = "android\app\build\outputs\apk\debug\app-debug.apk",
  [int]$HostServerPort = $(if ($env:TRIBOON_ANDROID_HOST_PORT) { [int]$env:TRIBOON_ANDROID_HOST_PORT } else { 7777 }),
  [string]$PlayKey = "tmdb:tv:124364:s1e10"
)

$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
if (!(Test-Path $adb)) { throw "adb not found at $adb" }
$failures = New-Object System.Collections.Generic.List[string]
function Add-Failure([string]$Message) { $script:failures.Add($Message) | Out-Null; Write-Host "FAIL: $Message" -ForegroundColor Red }

function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  $out = & $adb -s $Device @Args
  if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Args -join ' ')" }
  return $out
}

function Connect-Devtools {
  $deadline = (Get-Date).AddSeconds(45)
  do {
    $line = (Invoke-Adb shell cat /proc/net/unix) | Select-String -Pattern "webview_devtools_remote_[0-9]+" | Select-Object -First 1
    if ($line) {
      $m = [regex]::Match([string]$line, "webview_devtools_remote_[0-9]+")
      if ($m.Success) {
        Invoke-Adb forward "tcp:$DevtoolsPort" "localabstract:$($m.Value)" | Out-Null
        return $m.Value
      }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "No WebView DevTools socket"
}

function Invoke-CdpJson {
  param([string]$Expression)
  $env:TRIBOON_CDP_PORT = [string]$DevtoolsPort
  $env:TRIBOON_CDP_EXPR = $Expression
  $raw = @'
const port = process.env.TRIBOON_CDP_PORT || "9227";
const expr = process.env.TRIBOON_CDP_EXPR || "({})";
const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
const list = Array.isArray(targets) ? targets : targets.value;
const target = list.find((t) => t.webSocketDebuggerUrl && t.url && t.url !== "about:blank") || list.find((t) => t.webSocketDebuggerUrl);
if (!target) throw new Error("No WebView target");
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (!msg.id || !pending.has(msg.id)) return;
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
try {
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  await send("Runtime.enable");
  const result = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 180000 });
  const value = result.result && Object.prototype.hasOwnProperty.call(result.result, "value") ? result.result.value : result.result;
  console.log(typeof value === "string" ? value : JSON.stringify(value || null));
} finally { try { ws.close(); } catch {} }
'@ | node -
  if ($LASTEXITCODE -ne 0) { throw "CDP eval failed" }
  return ($raw | ConvertFrom-Json)
}

function Get-ExoMarks {
  $dump = Invoke-Adb logcat -d -t 4000
  $init = @($dump | Select-String -Pattern "ExoPlayerImpl: Init").Count
  $release = @($dump | Select-String -Pattern "ExoPlayerImpl: Release").Count
  $profile = @($dump | Select-String -Pattern "Native VOD buffer profile").Count
  return [pscustomobject]@{ init = $init; release = $release; profile = $profile }
}

$helpers = @'
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = () => {
  const p = S.playing;
  return {
    view: S.view,
    key: p && p.item && p.item.key || "",
    title: p && p.item && p.item.title || "",
    name: p && p.name || "",
    usingNative: !!(p && p.usingNative),
    paused: !!(p && p.nativePaused),
    started: !!(p && p.started),
    recoveryCount: p && p._sameSourceRecoveryCount || 0,
    pos: p ? (p.nativePos || p.startOffset || 0) : 0
  };
};
const resolveKey = async (key) => {
  const catalog = (S.rows || []).flatMap((r) => r.items || []);
  let item = catalog.find((x) => x && x.key === key);
  if (!item) {
    const parsed = /^tmdb:(movie|tv):(\d+)/i.exec(key);
    if (parsed) {
      const d = await api("/api/tmdb/" + parsed[1] + "/" + parsed[2]);
      if (d && d.id) item = mapTmdb({ ...d, media_type: parsed[1] });
    }
  }
  return item;
};
const playKey = async (key, rank) => {
  const item = await resolveKey(key);
  if (!item) return { ok: false, error: "missing " + key };
  await play({ ...item, qualityRank: rank });
  for (let n = 0; n < 80; n++) {
    const p = S.playing;
    if (p && p.mountId && (p.started || p.usingNative)) return { ok: true, ...snap() };
    await wait(400);
  }
  return { ok: false, error: "did not start", ...snap() };
};
const closeNow = async () => { try { await closePlayer(); } catch (e) {} await wait(600); };
const waitPlaying = async (ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = snap();
    if (s.usingNative && s.started && !s.paused) return s;
    await wait(400);
  }
  return snap();
};
'@

if ($InstallApk) {
  Invoke-Adb install -r (Resolve-Path (Join-Path $repo $ApkPath)) | Out-Host
}
try { Invoke-RestMethod -Uri "http://127.0.0.1:$HostServerPort/api/server" -TimeoutSec 5 | Out-Null } catch { throw "Start Triboon on port $HostServerPort" }
Invoke-Adb reverse "tcp:7777" "tcp:$HostServerPort" | Out-Null
try { Invoke-Adb shell svc power stayon true | Out-Null } catch {}
Invoke-Adb shell am force-stop $Package | Out-Null
Start-Sleep -Milliseconds 400
Invoke-Adb shell am start -n $Activity | Out-Host
Start-Sleep -Seconds 8
Connect-Devtools | Out-Null

$boot = Invoke-CdpJson @"
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 120; i++) {
    if (location.href.startsWith("chrome-error://")) return { ok: false, reason: "server" };
    const gate = document.querySelector("#gateSetup.open,#gateLogin.open,#gateProfiles.open,#gatePin.open");
    if (gate) return { ok: false, reason: gate.id };
    const cards = document.querySelectorAll(".pcard,.card,.poster,.mediaCard").length;
    if (typeof S !== "undefined" && !S._booting && cards > 0) {
      try { _updatePromptDone = true; } catch (e) {}
      try { closeUpdateModal(); } catch (e) {}
      return { ok: true };
    }
    await wait(500);
  }
  return { ok: false, reason: "home-not-ready" };
})()
"@
if (!$boot.ok) { throw "Remount boot failed: $($boot.reason)" }

Invoke-Adb logcat -c | Out-Null
$start = Invoke-CdpJson "(async () => { $helpers await closeNow(); const start = await playKey('$PlayKey', 3); if (!start.ok) return start; const ready = await waitPlaying(35000); return { ok: !!(ready.started && !ready.paused), error: (ready.started && !ready.paused) ? '' : 'never started playing', ...ready }; })()"
if (!$start.ok) { throw "Play failed: $($start.error)" }
Write-Host ("Playing {0} :: {1}" -f $start.title, $start.name) -ForegroundColor Cyan
$baseline = Get-ExoMarks
Write-Host ("Baseline Init={0} Release={1} Profile={2}" -f $baseline.init, $baseline.release, $baseline.profile)

function Assert-NoRebuild([string]$Name, $before, $after, $snap) {
  $newInit = $after.init - $before.init
  $newRelease = $after.release - $before.release
  $newProfile = $after.profile - $before.profile
  $same = $snap.name -and $snap.name -eq $start.name
  Write-Host ("{0}: Init+{1} Release+{2} Profile+{3} paused={4} name={5}" -f $Name, $newInit, $newRelease, $newProfile, $snap.paused, $snap.name)
  if ($newInit -gt 0 -or $newRelease -gt 0 -or $newProfile -gt 0) {
    Add-Failure ("{0} rebuilt ExoPlayer (Init+{1} Release+{2} Profile+{3})" -f $Name, $newInit, $newRelease, $newProfile)
  }
  if (-not $same) { Add-Failure ("{0} lost source {1} -> {2}" -f $Name, $start.name, $snap.name) }
}

$before = Get-ExoMarks
$pause5 = Invoke-CdpJson "(async () => { $helpers if (typeof togglePlay === 'function') togglePlay(); await wait(5000); const mid = snap(); if (typeof togglePlay === 'function') togglePlay(); const after = await waitPlaying(12000); return { ...after, heldPaused: mid.paused, heldPos: mid.pos }; })()"
if (-not $pause5.heldPaused) { Add-Failure "pause-5s never paused" }
if ($pause5.paused) { Add-Failure "pause-5s did not resume" }
Assert-NoRebuild "pause-5s" $before (Get-ExoMarks) $pause5

$before = Get-ExoMarks
$pause60 = Invoke-CdpJson "(async () => { $helpers const beforePos = snap().pos; if (typeof togglePlay === 'function') togglePlay(); await wait(60000); const mid = snap(); if (typeof togglePlay === 'function') togglePlay(); const after = await waitPlaying(12000); return { ...after, heldPaused: mid.paused, heldPos: mid.pos, beforePos }; })()"
if (-not $pause60.heldPaused) { Add-Failure "pause-60s never paused" }
if (($pause60.heldPos - $pause60.beforePos) -gt 8) { Add-Failure ("pause-60s kept playing ({0} -> {1})" -f $pause60.beforePos, $pause60.heldPos) }
if ($pause60.paused) { Add-Failure "pause-60s did not resume" }
Assert-NoRebuild "pause-60s" $before (Get-ExoMarks) $pause60

$before = Get-ExoMarks
$seek = Invoke-CdpJson @"
(async () => {
  $helpers
  const pos = snap().pos || 0;
  if (typeof seekTo === "function") seekTo(pos + 30);
  await wait(6000);
  if (typeof seekTo === "function") seekTo(Math.max(5, (snap().pos || pos) - 30));
  await wait(6000);
  return snap();
})()
"@
Assert-NoRebuild "seek-30" $before (Get-ExoMarks) $seek

$before = Get-ExoMarks
Invoke-Adb shell input keyevent 23 | Out-Null
Start-Sleep -Seconds 2
$ok1 = Invoke-CdpJson "(async () => { $helpers return snap(); })()"
if ($ok1.paused) { Add-Failure "first OK paused playback instead of opening chrome only" }
Assert-NoRebuild "first-ok" $before (Get-ExoMarks) $ok1

Invoke-Adb shell input keyevent 23 | Out-Null
Start-Sleep -Seconds 2
$ok2 = Invoke-CdpJson "(async () => { $helpers return snap(); })()"
if (-not $ok2.paused) { Add-Failure "second OK did not pause" }

$hop = Invoke-CdpJson "(async () => { $helpers await closeNow(); const next = await playKey('tmdb:movie:1288445', 3); await wait(5000); return next; })()"
if (-not $hop.ok) { Add-Failure ("hop title failed: {0}" -f $hop.error) }
elseif ($hop.name -and $hop.name -eq $start.name) { Add-Failure "hop stayed on the first file" }

$report = [ordered]@{
  start = $start
  pause5 = $pause5
  pause60 = $pause60
  seek = $seek
  firstOkPaused = [bool]$ok1.paused
  secondOkPaused = [bool]$ok2.paused
  hop = $hop
  failures = @($failures)
  passed = $failures.Count -eq 0
}
$outDir = Join-Path $PSScriptRoot "stress-results"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir ("android-tv-remount-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $outFile
Write-Host "`nRemount matrix -> $outFile" -ForegroundColor Cyan
if ($failures.Count) { $failures | ForEach-Object { Write-Host $_ -ForegroundColor Red }; exit 1 }
Write-Host "Remount matrix passed." -ForegroundColor Green
