param(
  [string]$Device = $env:TRIBOON_ADB_DEVICE,
  [string]$Package = "app.triboon.tv",
  [string]$Activity = "app.triboon.tv/.MainActivity",
  [int]$DevtoolsPort = 9223,
  [int]$PageLoops = 3,
  [int]$LiveZaps = 20,
  [int]$PipLoops = 5,
  [int]$VodSeeks = 20,
  [int]$ZapDelayMs = 1400,
  [int]$SeekDelayMs = 1800,
  [int]$VodSettleSeconds = 28,
  [string]$VodKey = "tmdb:movie:1226863",
  [string]$ApkPath = "dist\triboon-tv-v1.1.16.apk",
  [switch]$InstallApk,
  [switch]$NoScreenshot
)

$ErrorActionPreference = "Stop"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
if (!(Test-Path $adb)) { throw "adb not found at $adb" }

if ([string]::IsNullOrWhiteSpace($Device)) {
  $connected = & $adb devices | Select-String -Pattern "^\S+\s+device$" | ForEach-Object { ($_ -split "\s+")[0] }
  if (@($connected).Count -eq 1) { $Device = @($connected)[0] }
  else { throw "Set -Device or TRIBOON_ADB_DEVICE to the target Android TV ADB id." }
}

$failures = New-Object System.Collections.Generic.List[string]
function Add-Failure([string]$Message) {
  $script:failures.Add($Message) | Out-Null
}
function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  $out = & $adb -s $Device @Args
  if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Args -join ' ')" }
  return $out
}
function Send-Key([string]$Key) {
  Invoke-Adb shell input keyevent $Key | Out-Null
}
function Get-WebViewSocket {
  $deadline = (Get-Date).AddSeconds(25)
  do {
    try {
      $unix = Invoke-Adb shell cat /proc/net/unix
    } catch {
      Start-Sleep -Milliseconds 750
      continue
    }
    $line = $unix | Select-String -Pattern "webview_devtools_remote_[0-9]+" | Select-Object -First 1
    if ($line) {
      $m = [regex]::Match([string]$line, "webview_devtools_remote_[0-9]+")
      if ($m.Success) { return $m.Value }
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "No WebView DevTools socket found"
}
function Connect-Devtools {
  $socket = Get-WebViewSocket
  Invoke-Adb forward "tcp:$DevtoolsPort" "localabstract:$socket" | Out-Null
  Start-Sleep -Milliseconds 250
  return $socket
}
function Invoke-CdpJson {
  param([string]$Expression, [switch]$AwaitPromise)
  for ($attempt = 0; $attempt -lt 4; $attempt++) {
    $env:TRIBOON_CDP_PORT = [string]$DevtoolsPort
    $env:TRIBOON_CDP_EXPR = $Expression
    $env:TRIBOON_CDP_AWAIT = if ($AwaitPromise) { "1" } else { "0" }
    $raw = @'
const port = process.env.TRIBOON_CDP_PORT || '9223';
const expr = process.env.TRIBOON_CDP_EXPR || '({})';
const awaitPromise = process.env.TRIBOON_CDP_AWAIT === '1';
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
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
const result = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, timeout: 45000 });
const value = result.result && Object.prototype.hasOwnProperty.call(result.result, 'value') ? result.result.value : result.result;
console.log(typeof value === 'string' ? value : JSON.stringify(value || null));
ws.close();
'@ | node -
    if ($LASTEXITCODE -eq 0) { return ($raw | ConvertFrom-Json) }
    Start-Sleep -Milliseconds (650 + ($attempt * 500))
    Connect-Devtools | Out-Null
  }
  throw "CDP eval failed"
}
function App-State {
  Invoke-CdpJson @"
({
  href: location.href,
  ready: document.readyState,
  hasS: typeof S !== 'undefined',
  view: typeof S !== 'undefined' ? S.view : null,
  zone: typeof S !== 'undefined' ? S.zone : null,
  booting: typeof S !== 'undefined' ? !!S._booting : true,
  rows: document.querySelectorAll('.card,.poster,.mediaCard,.srcRow,.chRow,.pgRow').length,
  focus: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName),
  playerOpen: !!document.querySelector('#player.open'),
  guideOpen: !!document.querySelector('#pGuide.open'),
  multiOpen: !!document.querySelector('#multiView.open'),
  chMultiVisible: !!(document.getElementById('chMultiBtn') && document.getElementById('chMultiBtn').offsetParent !== null),
  pgMultiVisible: !!(document.getElementById('pgMultiBtn') && document.getElementById('pgMultiBtn').offsetParent !== null && !document.getElementById('pgMultiBtn').disabled),
  trackMenuOpen: !!document.querySelector('#trackMenu.open'),
  loader: !!document.querySelector('#playerLoader.show,.nativeLoader.show'),
  nativeGuideMode: typeof S !== 'undefined' ? !!S.nativeGuideMode : false,
  nativeLivePending: typeof S !== 'undefined' ? !!S.nativeLivePending : false,
  screensaver: typeof S !== 'undefined' ? !!S.screensaverOn : false,
  playing: typeof S !== 'undefined' && S.playing ? {
    name: S.playing.name,
    type: S.playing.item && S.playing.item.type,
    usingNative: !!S.playing.usingNative,
    nativePos: S.playing.nativePos || 0,
    startOffset: S.playing.startOffset || 0,
    nativeStartKind: S.playing.nativeStartKind || '',
    usingTranscode: !!S.playing.usingTranscode,
    usingRemux: !!S.playing.usingRemux,
    mountId: S.playing.mountId || ''
  } : null
})
"@
}

$report = [ordered]@{
  startedAt = (Get-Date).ToString("o")
  device = $Device
  package = $Package
  pageLoops = $PageLoops
  liveZaps = $LiveZaps
  pipLoops = $PipLoops
  vodSeeks = $VodSeeks
  sections = [ordered]@{}
  failures = $failures
}

if ($InstallApk) {
  $apk = Resolve-Path (Join-Path $repo $ApkPath)
  Invoke-Adb install -r $apk | Out-Host
}

Invoke-Adb logcat -c | Out-Null
Invoke-Adb shell am force-stop $Package | Out-Null
Start-Sleep -Milliseconds 500
Invoke-Adb shell am start -n $Activity | Out-Host
Start-Sleep -Seconds 4
$report['socket'] = Connect-Devtools

$boot = Invoke-CdpJson @"
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    const cards = document.querySelectorAll('.card,.poster,.mediaCard').length;
    if (typeof S !== 'undefined' && !S._booting && cards > 0) {
      return { ok: true, view: S.view, cards, focus: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) };
    }
    await wait(500);
  }
  return { ok: false, view: typeof S !== 'undefined' ? S.view : null, cards: document.querySelectorAll('.card,.poster,.mediaCard').length };
})()
"@ -AwaitPromise
$report.sections['boot'] = $boot
if (!$boot.ok) { Add-Failure "Boot did not reach a focusable home state" }

$page = Invoke-CdpJson @"
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const views = ['home', 'movies', 'tv', 'watchlist', 'calendar', 'discover', 'livetv', 'music'];
  const failures = [];
  const samples = [];
  const snap = () => ({
    view: S.view,
    zone: S.zone,
    railOpen: document.body.classList.contains('railOpen') || document.getElementById('rail').classList.contains('expanded'),
    focus: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName),
    cards: document.querySelectorAll('.card,.poster,.mediaCard,.chRow').length
  });
  for (let loop = 0; loop < $PageLoops; loop++) {
    for (const v of views) {
      try {
        switchView(v, false);
        await wait(650);
        if (S.view !== v) failures.push('switch ' + v + ' landed on ' + S.view);
        if (v === 'movies' || v === 'tv') {
          window.__tvBack();
          await wait(300);
          const first = snap();
          if (first.view !== v || !first.railOpen) failures.push(v + ' first Back did not open section rail');
          window.__tvBack();
          await wait(650);
          if (S.view !== 'home') failures.push(v + ' second Back did not return Home');
        } else if (v !== 'home') {
          window.__tvBack();
          await wait(650);
          if (S.view !== 'home') failures.push(v + ' Back did not return Home');
        }
        samples.push({ loop, view: v, state: snap() });
      } catch (e) {
        failures.push(v + ': ' + (e.message || e));
      }
    }
  }
  return { ok: failures.length === 0, failures, samples: samples.slice(-16), final: snap() };
})()
"@ -AwaitPromise
$report.sections['pageChurn'] = $page
foreach ($f in @($page.failures)) { Add-Failure "Page churn: $f" }

$source = Invoke-CdpJson @"
(async () => {
  const title = 'The Lord of the Rings The Fellowship of the Ring 2001';
  async function search(rank) {
    const r = await api('/api/search?q=' + encodeURIComponent(title) + '&imdbid=tt0120737&maxResolutionRank=' + rank + '&preferResolutionRank=' + rank + '&originalLanguage=en&preferredAudioLanguage=en');
    const candidates = Array.isArray(r.candidates) ? r.candidates : [];
    return {
      rank,
      count: candidates.length,
      firstResolution: candidates[0] && candidates[0].attributes ? candidates[0].attributes.resolution : '',
      resolutions: [...new Set(candidates.slice(0, 25).map((c) => c.attributes && c.attributes.resolution || 'unknown'))],
      firstScore: candidates[0] ? candidates[0].score : null
    };
  }
  const hd = await search(3);
  const uhd = await search(4);
  return {
    ok: hd.count > 0 && uhd.count > 0 && hd.firstResolution === '1080p' && uhd.firstResolution === '2160p',
    hd, uhd
  };
})()
"@ -AwaitPromise
$report.sections['sources'] = $source
if (!$source.ok) { Add-Failure "Source quality search did not keep 1080p and 4K separated" }

$liveStart = Invoke-CdpJson @"
(async () => {
  const j = await api('/api/iptv/channels');
  const channels = Array.isArray(j.channels) ? j.channels : [];
  S.liveChannels = channels;
  S.liveList = channels.slice(0, Math.max(30, $LiveZaps + 4)).map(liveItemForPlayerGuide).filter(Boolean);
  const it = S.liveList[0];
  if (!it) return { ok: false, error: 'no live channel', count: channels.length };
  await playChannel(it, S.liveList);
  return { ok: true, count: channels.length, start: it.title, liveCur: S.liveCur };
})()
"@ -AwaitPromise
$report.sections['liveStart'] = $liveStart
if (!$liveStart.ok) { Add-Failure "Live TV did not start: $($liveStart.error)" }
Start-Sleep -Seconds 6

$multiLivePrep = Invoke-CdpJson @"
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (typeof S === 'undefined') return { ok: false, error: 'missing app state' };
  if (document.getElementById('player').classList.contains('open') || (S.playing && S.playing.usingNative)) {
    await closePlayer();
    for (let n = 0; n < 20; n++) {
      if (!document.getElementById('player').classList.contains('open') && !(S.playing && S.playing.usingNative)) break;
      await wait(120);
    }
  }
  await wait(1000);
  switchView('livetv', false);
  for (let n = 0; n < 35; n++) {
    if (document.getElementById('chMultiBtn')) break;
    await wait(180);
  }
  const btn = document.getElementById('chMultiBtn');
  const visible = !!(btn && btn.offsetParent !== null);
  if (visible) focusLiveToolbar('chMultiBtn');
  return {
    ok: visible,
    view: S.view,
    focus: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName),
    mse: !!liveMseType(),
    playerOpen: document.getElementById('player').classList.contains('open'),
    playing: S.playing && S.playing.item && S.playing.item.type,
    channels: (S.liveList && S.liveList.length) || (S.liveChannels && S.liveChannels.length) || 0
  };
})()
"@ -AwaitPromise
if (!$multiLivePrep.ok) { Add-Failure "Live TV Multiview button was missing or not visible on Android" }
if (!$multiLivePrep.mse) { Add-Failure "Android WebView did not report MediaSource support for Multiview" }
Send-Key "DPAD_CENTER"
Start-Sleep -Seconds 3
$multiLiveOpen = Invoke-CdpJson @"
(() => {
  const slot = S.multiView && S.multiView.slots ? S.multiView.slots[0] : null;
  return {
    ok: S.view === 'multiview' && !!(S.multiView && S.multiView.open) && !!document.querySelector('#multiView.open'),
    view: S.view,
    multiOpen: !!(S.multiView && S.multiView.open),
    pickerOpen: !!document.querySelector('#mvPicker.open'),
    count: S.multiView ? S.multiView.count : 0,
    active: S.multiView ? S.multiView.active : null,
    slot0: slot ? { title: slot.item && slot.item.title, status: slot.status || '', error: slot.error || '' } : null
  };
})()
"@
if (!$multiLiveOpen.ok) { Add-Failure "Live TV Multiview did not open from Android D-pad OK" }
$multiLiveCleanup = Invoke-CdpJson @"
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (S.multiView && S.multiView.open) closeMultiView();
  await wait(500);
  switchView('livetv', false);
  await wait(500);
  const it = (S.liveList || [])[0] || ((S.liveChannels || []).map(liveItemForPlayerGuide).filter(Boolean))[0];
  if (it) await playChannel(it, S.liveList || [it]);
  return { ok: !!it, view: S.view, playing: S.playing && S.playing.item && S.playing.item.type };
})()
"@ -AwaitPromise
if (!$multiLiveCleanup.ok) { Add-Failure "Live TV did not restart after Multiview launcher smoke" }
Start-Sleep -Seconds 6

$multiPipPrep = Invoke-CdpJson @"
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!(S.playing && S.playing.item && S.playing.item.type === 'live')) {
    const it = (S.liveList || [])[0] || ((S.liveChannels || []).map(liveItemForPlayerGuide).filter(Boolean))[0];
    if (it) await playChannel(it, S.liveList || [it]);
    await wait(1800);
  }
  if (!document.getElementById('pGuide').classList.contains('open')) await togglePlayerGuide();
  for (let n = 0; n < 40; n++) {
    if (document.getElementById('pGuide').classList.contains('open') && document.querySelector('.pgGuideMain .pgRow[data-pg]')) break;
    await wait(160);
  }
  const pg = document.getElementById('pGuide');
  const btn = document.getElementById('pgMultiBtn');
  const first = document.querySelector('.pgGuideMain .pgRow[data-pg]');
  if (first) {
    try { first.focus({ preventScroll: true }); } catch { first.focus(); }
    setPlayerGuideVisualFocus(first._ch || first.dataset.guideChannel);
  }
  return {
    ok: !!(pg.classList.contains('open') && btn && btn.offsetParent !== null && !btn.disabled && first),
    guideOpen: pg.classList.contains('open'),
    pgMultiVisible: !!(btn && btn.offsetParent !== null && !btn.disabled),
    focus: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName)
  };
})()
"@ -AwaitPromise
if (!$multiPipPrep.ok) { Add-Failure "PiP guide Multiview button was not reachable before D-pad test" }
Send-Key "DPAD_UP"
Start-Sleep -Seconds 1
$multiPipFocus = Invoke-CdpJson @"
(() => ({
  ok: document.activeElement && document.activeElement.id === 'pgMultiBtn',
  focus: document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName),
  guideOpen: document.getElementById('pGuide').classList.contains('open')
}))()
"@
if (!$multiPipFocus.ok) { Add-Failure "PiP guide D-pad Up did not focus Multiview button" }
Send-Key "DPAD_CENTER"
Start-Sleep -Seconds 3
$multiPipOpen = Invoke-CdpJson @"
(() => ({
  ok: S.view === 'multiview' && !!(S.multiView && S.multiView.open) && !!document.querySelector('#multiView.open'),
  view: S.view,
  multiOpen: !!(S.multiView && S.multiView.open),
  guideOpen: document.getElementById('pGuide').classList.contains('open')
}))()
"@
if (!$multiPipOpen.ok) { Add-Failure "PiP guide Multiview did not open from D-pad OK" }
$multiPipCleanup = Invoke-CdpJson @"
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (S.multiView && S.multiView.open) closeMultiView();
  await wait(500);
  const it = (S.liveList || [])[0] || ((S.liveChannels || []).map(liveItemForPlayerGuide).filter(Boolean))[0];
  if (it) await playChannel(it, S.liveList || [it]);
  return { ok: !!it, view: S.view, playing: S.playing && S.playing.item && S.playing.item.type };
})()
"@ -AwaitPromise
if (!$multiPipCleanup.ok) { Add-Failure "Live TV did not restart after PiP Multiview D-pad smoke" }
Start-Sleep -Seconds 6
$report.sections['multiview'] = [ordered]@{
  livePrep = $multiLivePrep
  liveOpen = $multiLiveOpen
  liveCleanup = $multiLiveCleanup
  pipPrep = $multiPipPrep
  pipFocus = $multiPipFocus
  pipOpen = $multiPipOpen
  pipCleanup = $multiPipCleanup
}

$zapSamples = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $LiveZaps; $i++) {
  $key = if ($i % 2 -eq 0) { "DPAD_UP" } else { "DPAD_DOWN" }
  Send-Key $key
  Start-Sleep -Milliseconds $ZapDelayMs
  if ($i % 5 -eq 4 -or $i -eq $LiveZaps - 1) {
    $zapSamples.Add((App-State)) | Out-Null
  }
}
$report.sections['liveZaps'] = [ordered]@{ samples = $zapSamples }
$afterZap = App-State
if (!$afterZap.playing -or $afterZap.playing.type -ne 'live') { Add-Failure "Live TV was not still playing after zap loop" }
if ($afterZap.loader) { Add-Failure "Live TV loader was still visible after zap loop" }

$pipSamples = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $PipLoops; $i++) {
  $open = Invoke-CdpJson @"
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await togglePlayerGuide();
  for (let n = 0; n < 30; n++) {
    if (document.getElementById('pGuide').classList.contains('open')) break;
    await wait(160);
  }
  return {
    guideOpen: document.getElementById('pGuide').classList.contains('open'),
    nativeGuideMode: S.nativeGuideMode,
    view: S.view,
    screensaver: S.screensaverOn
  };
})()
"@ -AwaitPromise
  $pipSamples.Add([ordered]@{ loop = $i; open = $open }) | Out-Null
  if (!$open.guideOpen) { Add-Failure "PiP guide did not open on loop $i" }
  Start-Sleep -Seconds 2
  Send-Key "BACK"
  Start-Sleep -Seconds 2
  $closed = App-State
  $pipSamples.Add([ordered]@{ loop = $i; afterBack = $closed }) | Out-Null
  if ($closed.guideOpen) { Add-Failure "PiP guide stayed open after Back on loop $i" }
  if ($closed.screensaver) { Add-Failure "Screensaver was visible after PiP Back on loop $i" }
}
$report.sections['pip'] = [ordered]@{ samples = $pipSamples }

Send-Key "BACK"
Start-Sleep -Seconds 2
$vodStart = Invoke-CdpJson @"
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (typeof S === 'undefined') return { ok: false, error: 'missing app state' };
  if (!S.rows || !S.rows.length) await loadRows();
  await wait(500);
  let item = (S.rows || []).flatMap((r) => r.items || []).find((x) => x && x.key === '$VodKey');
  if (!item) item = (S.rows || []).flatMap((r) => r.items || []).find((x) => x && x.type !== 'live' && x.tmdbId);
  if (!item) return { ok: false, error: 'no VOD item found', rows: S.rows ? S.rows.length : 0 };
  item = { ...item, qualityRank: 3 };
  await play(item);
  return { ok: true, key: item.key, title: item.title, type: item.type, originalLanguage: item.originalLanguage || '' };
})()
"@ -AwaitPromise
$report.sections['vodStart'] = $vodStart
if (!$vodStart.ok) { Add-Failure "VOD did not start: $($vodStart.error)" }
Start-Sleep -Seconds $VodSettleSeconds

$seekSamples = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $VodSeeks; $i++) {
  $key = if ($i % 2 -eq 0) { "MEDIA_FAST_FORWARD" } else { "MEDIA_REWIND" }
  Send-Key $key
  Start-Sleep -Milliseconds $SeekDelayMs
  if ($i % 4 -eq 3 -or $i -eq $VodSeeks - 1) {
    $seekSamples.Add((App-State)) | Out-Null
  }
}
$report.sections['vodSeeks'] = [ordered]@{ samples = $seekSamples; final = (App-State) }
if (!$report.sections['vodSeeks'].final.playing -or $report.sections['vodSeeks'].final.playing.type -eq 'live') {
  Add-Failure "VOD was not still playing after seek loop"
}
if ($report.sections['vodSeeks'].final.loader) { Add-Failure "VOD loader was visible after seek loop" }

$subs = Invoke-CdpJson @"
(async () => {
  const p = S.playing;
  if (!p || !p.mountId || !p.streamToken || !p.item || !p.item.tmdbId) return { ok: false, skipped: true, reason: 'no mounted catalog VOD' };
  const q = subtitleRequestParams(p.item, 'en', p.streamToken);
  q.set('list', '1');
  const r = await fetch('/api/ossubs/' + encodeURIComponent(p.mountId) + '?' + q.toString());
  let body = {};
  try { body = await r.json(); } catch {}
  return { ok: r.status === 200 || r.status === 404, status: r.status, variants: Array.isArray(body.variants) ? body.variants.length : 0, code: body.code || '', has401: r.status === 401 };
})()
"@ -AwaitPromise
$report.sections['subtitles'] = $subs
if ($subs.has401) { Add-Failure "Subtitle request returned HTTP 401" }
if (!$subs.ok -and !$subs.skipped) { Add-Failure "Subtitle request returned HTTP $($subs.status)" }

$log = Invoke-Adb logcat -d -t 1600 | Select-String -Pattern "AndroidRuntime|FATAL|app\.triboon|ExoPlayer|Playback error|provider bot-protection|HTTP 403|HTTP 404|Renderer|crash|SIG"
$logText = ($log | ForEach-Object { [string]$_ }) -join "`n"
$fatalLog = [regex]::IsMatch($logText, "FATAL EXCEPTION|AndroidRuntime:\s+FATAL|AndroidRuntime.*(Exception|Error)|SIGSEGV|SIGABRT|Renderer.*crash", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
$report.sections['logScan'] = [ordered]@{
  fatal = $fatalLog
  providerProtection = [bool]($logText -match "provider bot-protection|HTTP 403|HTTP 404")
  lines = @($log | Select-Object -First 120 | ForEach-Object { [string]$_ })
}
if ($report.sections['logScan'].fatal) { Add-Failure "Android log contains fatal/crash markers" }
if ($report.sections['logScan'].providerProtection) { Add-Failure "Android log contains provider-protection/channel HTTP rejection markers" }

if (!$NoScreenshot) {
  $shotDir = Join-Path $PSScriptRoot "shots"
  New-Item -ItemType Directory -Force -Path $shotDir | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $remoteShot = "/sdcard/triboon-stress-$stamp.png"
  $localShot = Join-Path $shotDir "android-tv-stress-$stamp.png"
  try {
    Invoke-Adb shell screencap -p $remoteShot | Out-Null
    Invoke-Adb pull $remoteShot $localShot | Out-Null
    Invoke-Adb shell rm $remoteShot | Out-Null
    $report['screenshot'] = $localShot
  } catch {
    $report['screenshotError'] = $_.Exception.Message
  }
}

$report['completedAt'] = (Get-Date).ToString("o")
$report['ok'] = $failures.Count -eq 0
$outDir = Join-Path $PSScriptRoot "stress-results"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outFile = Join-Path $outDir ("android-tv-stress-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
$report | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $outFile
$report['output'] = $outFile
$report | ConvertTo-Json -Depth 8
if ($failures.Count -gt 0) { exit 1 }
