'use strict';
// Playback scenarios the owner actually hits: pause, freeze, +30, CC, long pause, resume.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const android = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'app', 'triboon', 'tv', 'MainActivity.java'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const trakt = fs.readFileSync(path.join(__dirname, '..', 'server', 'trakt.js'), 'utf8');
const subText = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'app', 'triboon', 'tv', 'SubtitleText.java'), 'utf8');

function shiftCues(cues, off) {
  const out = [];
  for (const raw of cues) {
    const c = { ...raw };
    if (c._shifted) { out.push(c); continue; }
    if (c.endTime - off <= 0.2) continue;
    c.startTime = Math.max(0, c.startTime - off);
    c.endTime = Math.max(0.05, c.endTime - off);
    c._shifted = true;
    out.push(c);
  }
  return out;
}

function traktSeekSeconds({ catalogDur, videoDur, remux, pct }) {
  const dur = remux ? catalogDur : (catalogDur || videoDur || 0);
  if (!dur || (remux && dur < 30)) return null;
  return (pct / 100) * dur;
}

test('playback scenarios: long pause stays open for 1 hour then exits', () => {
  assert.match(ui, /const PAUSE_IDLE_EXIT_MS = 60 \* 60 \* 1000;/);
  assert.match(ui, /function armPauseIdleExit\([\s\S]+closePlayer\(\)/);
  assert.match(ui, /function togglePlay\(\) \{[\s\S]+startSource\(currentPlayerKind\(p\), currentTime\(\), \{ quietSeek: true \}\)/,
    'web remux Play after pause remounts the same file');
  assert.match(android, /resumeNativeVideoInPlace\(\) \{[\s\S]+requestNativeVideoSeek\(nativeResumePositionMs\(\), true\)/,
    'native remux Play remounts the same file instead of reading a dead pipe');
  assert.match(android, /updateNativeVideoWatchdog\(\) \{[\s\S]+!nativePlayer\.getPlayWhenReady\(\)[\s\S]+return;/,
    'paused playback must not trip the freeze watchdog');
});

test('playback scenarios: remux +30 / pause / resume do not freeze or save the wrong clock', () => {
  assert.match(android, /reuseQuietVideo && "video"\.equals\(mode\)[\s\S]+NATIVE_VIDEO_REMUX_RESUME_GRACE_MS/);
  assert.match(android, /nativeQuietSeekHoldPlay[\s\S]+setPlayWhenReady\(false\)/);
  assert.match(android, /nativeSeekHoldDisplayMs = Math\.max\(nativeStartOffsetMs \+ nativeRawPositionMs\(\), startOffsetMs\)/);
  assert.match(ui, /if \(opts\.quietSeek\) p\._nativeResuming = true/);
  assert.match(ui, /p\._nativeSeekGen = \(p\._nativeSeekGen \|\| 0\) \+ 1/);
});

test('playback scenarios: captions shift only after a successful write', () => {
  const cues = shiftCues([
    { startTime: 600, endTime: 604, _shifted: false },
    { startTime: 10, endTime: 12, _shifted: false },
  ], 600);
  assert.strictEqual(cues.length, 1, 'cues that ended before the seek are dropped');
  assert.strictEqual(cues[0].startTime, 0);
  assert.strictEqual(cues[0].endTime, 4);
  assert.ok(cues[0]._shifted);
  const again = shiftCues(cues, 600);
  assert.strictEqual(again[0].startTime, 0, 'a second remount must not double-shift');
  assert.match(ui, /c\.startTime = Math\.max\(0, c\.startTime - off\);[\s\S]+c\.endTime = Math\.max\(0\.05, c\.endTime - off\);[\s\S]+c\._shifted = true;/);
});

test('playback scenarios: 4K captions keep five visual lines and cancel the old fetch', () => {
  assert.match(subText, /static final int MAX_OVERLAY_LINES = 5;/);
  assert.match(subText, /static String lastLines\(Iterable<String> texts/);
  assert.match(android, /nativeSubtitleOverlay\.setMaxLines\(SubtitleText\.MAX_OVERLAY_LINES\)/);
  assert.match(android, /SubtitleText\.lastLines\(active\)/);
  assert.match(android, /bumpNativeSubtitleLoadToken\(\) \{[\s\S]+disconnectNativeSubtitleFetch\(\)/);
  assert.match(android, /token != nativeSubtitleLoadToken[\s\S]+throw new java\.io\.IOException\("subtitle fetch cancelled"\)/);
  assert.match(ui, /function abortSubtitleFetches\(p\) \{[\s\S]+p\._subFetchAbort\.abort\(\)/);
  assert.match(ui, /function beginSubtitleFetch\(p\) \{[\s\S]+Do not abort the variant-list fetch/);
  assert.match(ui, /if \(subtitleFetchAborted\(e\)\) \{[\s\S]+subtitleAbortIsCurrent\(p, subGen\)[\s\S]+scheduleStartupSubtitleRetry\(p\)/);
  assert.match(ui, /active\.slice\(-5\)/);
  assert.match(android, /if \(rel\.isEmpty\(\) \|\| subtitleUrl\.isEmpty\(\)\) \{[\s\S]+clearNativeSubtitleOverlay\(\)/);
  assert.match(ui, /let r = await fetch\(url, subSignal \? \{ signal: subSignal \} : \{\}\)/);
  assert.match(server, /async function resolveEpisodeImdb\([\s\S]+if \(hit && Date\.now\(\) - hit\.at < EPISODE_IMDB_TTL_MS\) return hit\.imdb/);
  assert.match(server, /ctx\.req\.once\('close', \(\) => \{ if \(!ctx\.req\.complete\) clientGone = true; \}\)/);
});

test('playback scenarios: Trakt scrobble heartbeats do not spam the same percent', () => {
  assert.match(trakt, /if \(!finished && prev && prev\.key === key && prev\.progress === rounded && now - prev\.at < 45000\) return;/);
  assert.match(trakt, /e && \(e\.message \|\| e\.code\) \? e : Object\.assign\(new Error\(\(e && e\.code\) \|\| 'trakt socket error'\)/);
});

test('playback scenarios: dead prepares and hivecast 503 do not keep hammering', () => {
  const pipeline = fs.readFileSync(path.join(__dirname, '..', 'server', 'pipeline.js'), 'utf8');
  assert.match(pipeline, /e\.cachedFail = true;/);
  assert.match(pipeline, /this\.prepareFailUntil\.set\(key, Date\.now\(\) \+ 15 \* 60 \* 1000\)/);
  assert.match(server, /if \(!e\.cachedFail\) debug\.log\('prepare'/);
  assert.match(server, /\/\\b\(401\|403\|429\|503\)\\b\//);
  assert.match(server, /reason !== 'idle \(no viewers\)' && reason !== 'playlist sent'/);
});

test('playback scenarios: Trakt percent resume ignores remux duration-so-far', () => {
  assert.strictEqual(traktSeekSeconds({ catalogDur: 0, videoDur: 8, remux: true, pct: 45 }), null);
  assert.strictEqual(traktSeekSeconds({ catalogDur: 7200, videoDur: 8, remux: true, pct: 45 }), 3240);
  assert.strictEqual(traktSeekSeconds({ catalogDur: 0, videoDur: 7200, remux: false, pct: 45 }), 3240);
  assert.match(ui, /Remux duration-so-far is often ~8s[\s\S]+const dur = remux \? catalogDur :/);
});
