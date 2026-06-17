param(
  [string]$Device = $env:TRIBOON_ADB_DEVICE,
  [string]$Package = "app.triboon.tv",
  [string]$Activity = "app.triboon.tv/.MainActivity",
  [int]$DevtoolsPort = 9222,
  [switch]$LiveZap,
  [switch]$VodSmoke,
  [string]$VodKey = "tmdb:movie:1226863",
  [int]$ResumeSeconds = 120,
  [int]$VodSettleSeconds = 22,
  [switch]$VodNoSeek,
  [switch]$StartupDpad,
  [switch]$ColdStart,
  [switch]$NoScreenshot,
  [switch]$InstallApk
)

$ErrorActionPreference = "Stop"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
if (!(Test-Path $adb)) { throw "adb not found at $adb" }

if ([string]::IsNullOrWhiteSpace($Device)) {
  $connected = & $adb devices | Select-String -Pattern "^\S+\s+device$" | ForEach-Object { ($_ -split "\s+")[0] }
  if (@($connected).Count -eq 1) {
    $Device = @($connected)[0]
  } else {
    throw "Set -Device or TRIBOON_ADB_DEVICE to the target Android TV ADB id."
  }
}

function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & $adb -s $Device @Args
  if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Args -join ' ')" }
}

function Get-WebViewSocket {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    $line = Invoke-Adb shell cat /proc/net/unix | Select-String -Pattern "webview_devtools_remote" | Select-Object -First 1
    if ($line) {
      $m = [regex]::Match([string]$line, "@(webview_devtools_remote_[0-9]+)")
      if ($m.Success) { return $m.Groups[1].Value }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "No WebView DevTools socket found"
}

function Invoke-CdpEval {
  param([string]$Expression, [switch]$AwaitPromise)
  $env:TRIBOON_CDP_PORT = [string]$DevtoolsPort
  $env:TRIBOON_CDP_EXPR = $Expression
  $env:TRIBOON_CDP_AWAIT = if ($AwaitPromise) { "1" } else { "0" }
  @'
const port = process.env.TRIBOON_CDP_PORT || '9222';
const expr = process.env.TRIBOON_CDP_EXPR || '({})';
const awaitPromise = process.env.TRIBOON_CDP_AWAIT === '1';
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
const list = Array.isArray(targets) ? targets : targets.value;
const target = list.find((t) => t.webSocketDebuggerUrl && t.url && t.url !== 'about:blank')
  || list.find((t) => t.webSocketDebuggerUrl);
if (!target) throw new Error('No WebView target');
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
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await send('Runtime.enable');
const result = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, timeout: 30000 });
console.log(JSON.stringify(result.result.value ?? result.result, null, 2));
ws.close();
'@ | node -
}

$apk = Join-Path $repo "android\app\build\outputs\apk\debug\app-debug.apk"
if ($InstallApk) {
  if (!(Test-Path $apk)) { throw "APK not found at $apk" }
  Invoke-Adb install -r $apk | Out-Host
}

if ($ColdStart) {
  Invoke-Adb shell am force-stop $Package | Out-Null
  Start-Sleep -Milliseconds 400
}

$launchAt = Get-Date
Invoke-Adb shell am start -n $Activity | Out-Host
if ($StartupDpad) {
  Start-Sleep -Milliseconds 500
  Invoke-Adb shell input keyevent DPAD_RIGHT
  Invoke-Adb shell input keyevent DPAD_DOWN
}
Start-Sleep -Seconds 3

$socket = Get-WebViewSocket
Invoke-Adb forward "tcp:$DevtoolsPort" "localabstract:$socket" | Out-Null

$stateExpr = @"
({
  url: location.href,
  ready: document.readyState,
  bodyClass: document.body.className,
  title: document.title,
  nativeBridge: !!window.TriboonTV,
  nativeChromeVersion: window.TriboonTV && window.TriboonTV.nativeChromeVersion ? window.TriboonTV.nativeChromeVersion() : 0,
  playerOpen: document.getElementById('player') && document.getElementById('player').className,
  bootLoaderHidden: document.getElementById('appLoader') && document.getElementById('appLoader').classList.contains('hide'),
  activeId: document.activeElement && document.activeElement.id,
  focusText: (document.querySelector('.focus') && document.querySelector('.focus').textContent || '').trim().slice(0, 80),
  focusedClass: document.querySelector('.focus') && document.querySelector('.focus').className,
  zone: typeof S !== 'undefined' && S.zone,
  view: typeof S !== 'undefined' && S.view,
  rows: typeof S !== 'undefined' && S.rows && S.rows.length,
  tvReadyAt: typeof S !== 'undefined' && S.tvReadyAt,
  tvReadyReason: typeof S !== 'undefined' && S.tvReadyReason,
  perfMarks: typeof S !== 'undefined' && S.perfMarks,
  playingType: typeof S !== 'undefined' && S.playing && S.playing.item && S.playing.item.type,
  playing: typeof S !== 'undefined' && S.playing && S.playing.name,
  liveCur: typeof S !== 'undefined' && S.liveCur,
  videoSrc: document.getElementById('video') ? document.getElementById('video').currentSrc : ''
})
"@

$result = [ordered]@{
  device = $Device
  package = $Package
  socket = $socket
  launchedAt = $launchAt.ToString("o")
  inspectedAfterMs = [int]((Get-Date) - $launchAt).TotalMilliseconds
  state = (Invoke-CdpEval $stateExpr | ConvertFrom-Json)
}

if ($LiveZap) {
  $playLiveExpr = @"
(async () => {
  const token = localStorage.getItem('triboon.token') || '';
  if (!token) return { ok: false, error: 'missing token' };
  const j = await fetch('/api/iptv/channels', { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json());
  const list = (j.channels || []).slice(0, 12).map(liveItemForPlayerGuide).filter(Boolean);
  S.liveChannels = j.channels || [];
  S.liveList = list;
  const it = list[0];
  if (!it) return { ok: false, error: 'no channel', count: j.channels ? j.channels.length : 0 };
  await playChannel(it, list);
  return { ok: true, count: j.channels.length, liveCur: S.liveCur, playingType: S.playing && S.playing.item && S.playing.item.type, playing: S.playing && S.playing.name };
})()
"@
  $before = Invoke-CdpEval $playLiveExpr -AwaitPromise | ConvertFrom-Json
  Start-Sleep -Seconds 8
  Invoke-Adb shell input keyevent DPAD_UP
  Start-Sleep -Seconds 8
  $afterUp = Invoke-CdpEval "({ liveCur: S.liveCur, playingType: S.playing && S.playing.item && S.playing.item.type, playing: S.playing && S.playing.name })" | ConvertFrom-Json
  Invoke-Adb shell input keyevent DPAD_DOWN
  Start-Sleep -Seconds 8
  $afterDown = Invoke-CdpEval "({ liveCur: S.liveCur, playingType: S.playing && S.playing.item && S.playing.item.type, playing: S.playing && S.playing.name })" | ConvertFrom-Json
  $result.liveZap = [ordered]@{ before = $before; afterUp = $afterUp; afterDown = $afterDown }
}

if ($VodSmoke) {
  $vodExpr = @"
(async () => {
  if (!S.rows || !S.rows.length) await loadRows();
  const key = '$VodKey';
  const item = (S.rows || []).flatMap((r) => r.items || []).find((x) => x && x.key === key);
  if (!item) return { ok: false, error: 'vod item not found', key, rows: S.rows ? S.rows.length : 0 };
  S.watchMap = S.watchMap || {};
  S.watchMap[key] = { ...(S.watchMap[key] || {}), key, position: $ResumeSeconds, duration: item.duration || 0, watched: false, meta: item };
  item.resume = $ResumeSeconds;
  await play(item);
  return { ok: true, key, requestedResume: $ResumeSeconds, title: item.title, view: S.view };
})()
"@
  $started = Invoke-CdpEval $vodExpr -AwaitPromise | ConvertFrom-Json
  Start-Sleep -Seconds $VodSettleSeconds
  $afterStart = Invoke-CdpEval "({ playing: S.playing && { name: S.playing.name, type: S.playing.item && S.playing.item.type, nativePos: S.playing.nativePos, duration: S.playing.duration, nativeDuration: S.playing.nativeDuration, usingNative: S.playing.usingNative, nativeStartKind: S.playing.nativeStartKind, usingRemux: S.playing.usingRemux, usingTranscode: S.playing.usingTranscode, startOffset: S.playing.startOffset } })" | ConvertFrom-Json
  $afterForward = $null
  $afterRewind = $null
  if (!$VodNoSeek) {
    Invoke-Adb shell input keyevent 19
    Start-Sleep -Milliseconds 700
    Invoke-Adb shell input keyevent 22
    Start-Sleep -Seconds ([Math]::Max(8, [Math]::Floor($VodSettleSeconds / 2)))
    $afterForward = Invoke-CdpEval "({ playing: S.playing && { nativePos: S.playing.nativePos, startOffset: S.playing.startOffset, nativeStartKind: S.playing.nativeStartKind } })" | ConvertFrom-Json
    Invoke-Adb shell input keyevent 19
    Start-Sleep -Milliseconds 700
    Invoke-Adb shell input keyevent 21
    Start-Sleep -Seconds ([Math]::Max(8, [Math]::Floor($VodSettleSeconds / 2)))
    $afterRewind = Invoke-CdpEval "({ playing: S.playing && { nativePos: S.playing.nativePos, startOffset: S.playing.startOffset, nativeStartKind: S.playing.nativeStartKind } })" | ConvertFrom-Json
  }
  $result.vodSmoke = [ordered]@{ started = $started; afterStart = $afterStart; afterForward = $afterForward; afterRewind = $afterRewind }
}

if (!$NoScreenshot) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $shotDir = Join-Path $PSScriptRoot "shots"
  New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
  $remoteShot = "/sdcard/triboon-smoke-$stamp.png"
  $localShot = Join-Path $shotDir "android-tv-smoke-$stamp.png"
  & $adb -s $Device shell "screencap -p $remoteShot" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "adb failed: shell screencap -p $remoteShot" }
  $remoteExists = & $adb -s $Device shell "ls $remoteShot 2>/dev/null"
  if ($LASTEXITCODE -ne 0 -or -not $remoteExists) {
    & $adb -s $Device shell "screencap $remoteShot" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "adb failed: shell screencap $remoteShot" }
  }
  Invoke-Adb pull $remoteShot $localShot | Out-Null
  $result.screenshot = $localShot
}

$result | ConvertTo-Json -Depth 8
