'use strict';

// A native stream that ends early (result 89 Part C). The Windows app (libmpv) and the Android TV
// app hand a stream end to the page. Past 88 % the page used to call that the real end: it closed
// the player, saved the film as watched, and wrote nothing. Now the real end needs the position to
// be within 60 s of the file's known runtime; an earlier end reopens the same file at the same
// second. The drop is also visible: one note per end, the guard that declines a recovery, the
// client kind, and a server line when a remux response closes while ffmpeg still runs.
// Every name here is made up.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { httpJson, bootServer, setupAdmin } = require('./helpers');

const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

function endedHarness(playing, { catalogSec = 0, kind = 'remux', started = true } = {}) {
  const start = ui.indexOf('function isGenuineEpisodeEof(p, pos, dur)');
  const endFn = ui.indexOf('function handleVodPlaybackEnded(pos, dur)', start);
  const after = ui.indexOf('\nfunction ', endFn + 10);
  assert.ok(start >= 0 && endFn > start && after > endFn, 'the end helpers are extractable');
  const events = [];
  const S = { playing };
  const fn = new Function('S', 'vodPlaybackStarted', 'appMs', 'currentPlayerKind', 'catalogRuntimeSeconds', 'notePlaybackIssue',
    'playbackSourceSwapPending', 'finishEpisodeToNext', 'closePlayer', 'recoverSamePlaybackSource', 'currentTime',
    'markPlaybackSourceSwap', 'tryNativeVideoPlayer', 'tryNextNativeKind', 'autoAdvance', 'toast', 'failover',
    `${ui.slice(start, after)}\nreturn handleVodPlaybackEnded;`)(
    S, () => started, () => 600000, () => kind, () => catalogSec,
    (k, detail) => events.push(['note', k, detail]), () => false, () => false,
    (opts) => events.push(['close', !!(opts && opts.ended)]), (why) => events.push(['recover', why]),
    () => Number(playing.nativePos) || 0, () => {}, () => true, () => false, () => events.push(['advance']),
    () => {}, () => events.push(['failover']));
  return { run: (pos, dur) => fn(pos, dur), events };
}

test('a native stream that ends at 90 % of a known runtime reopens the same second; within 60 s of the end it is the real end', () => {
  const film = { usingNative: true, started: true, startedAt: 1, openedAt: 1, item: { type: 'movie', runtime: 95 },
    tracks: { duration: 5700 }, nativePos: 5150, duration: 5700 };
  const h = endedHarness(film, { catalogSec: 5700 });
  h.run(5150, 5150);
  assert.deepStrictEqual(h.events.filter((e) => e[0] !== 'note'), [['recover', 'source ended mid-title']],
    'an early end past 88 % reopens the same file, it does not close the player');
  const note = h.events.find((e) => e[0] === 'note');
  assert.strictEqual(note[1], 'end');
  assert.match(note[2], /stream ended at 5150s of 5700s \(probe\) — player native remux — treated as finished: no \(early end past 88 %, reopening\)/);

  // The same spot ends again: the file really ends there (a shorter cut than the probe says).
  h.events.length = 0;
  h.run(5152, 5152);
  assert.deepStrictEqual(h.events.filter((e) => e[0] !== 'note'), [['close', true]], 'a second end at the same spot is the real end');

  const near = { ...film, nativePos: 5660 };
  const h2 = endedHarness(near, { catalogSec: 5700 });
  h2.run(5660, 5700);
  assert.deepStrictEqual(h2.events.filter((e) => e[0] !== 'note'), [['close', true]], 'within 60 s of the runtime: finished');
  assert.match(h2.events[0][2], /treated as finished: yes/);
});

test('the end rule uses the probe or a direct file clock, never a remux duration-so-far; with no runtime the old rule stays', () => {
  // Catalog only (no probe): 90 % of the catalog runtime still reopens.
  const catOnly = { usingNative: true, started: true, startedAt: 1, item: { type: 'movie', runtime: 100 }, nativePos: 5400, duration: 5410 };
  const h = endedHarness(catOnly, { catalogSec: 6000 });
  h.run(5400, 5410);
  assert.deepStrictEqual(h.events.filter((e) => e[0] !== 'note'), [['recover', 'source ended mid-title']]);
  assert.match(h.events[0][2], /of 6000s \(catalog\)/);
  // A direct file: the player's own duration is the file's length.
  const direct = { usingNative: true, started: true, startedAt: 1, item: { type: 'movie' }, nativePos: 5990, nativeDuration: 6000, duration: 6000 };
  const h2 = endedHarness(direct, { kind: 'direct' });
  h2.run(5990, 6000);
  assert.deepStrictEqual(h2.events.filter((e) => e[0] !== 'note'), [['close', true]]);
  assert.match(h2.events[0][2], /of 6000s \(player\)/);
  // No runtime known: the 88 % rule decides, as before.
  const unknown = { usingNative: true, started: true, startedAt: 1, item: { type: 'movie' }, nativePos: 900, duration: 1000 };
  const h3 = endedHarness(unknown, { kind: 'remux' });
  h3.run(900, 1000);
  assert.deepStrictEqual(h3.events.filter((e) => e[0] !== 'note'), [['close', true]]);
  // The browser <video> keeps its own rule (a web 'ended' is the file's real end).
  const web = { usingNative: false, started: true, startedAt: 1, item: { type: 'movie', runtime: 95 }, tracks: { duration: 5700 }, duration: 5700 };
  const h4 = endedHarness(web, { catalogSec: 5700, kind: 'direct' });
  h4.run(5150, 5700);
  assert.deepStrictEqual(h4.events.filter((e) => e[0] !== 'note'), [['close', true]]);
});

// The reopen after an early end must be able to finish the film. Here the page's own recovery runs
// (its guards, failure ledger and swap timers); only the native player and the server are stubs.
function realRecoveryHarness(playing, { hasNext = false } = {}) {
  const grab = (name) => {
    const m = new RegExp(`\\n(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]+?\\n\\}`).exec(ui);
    assert.ok(m, `${name} is extractable`);
    return m[0];
  };
  const constLine = (name) => {
    const m = new RegExp(`\\nconst ${name} = [^\\n]+`).exec(ui);
    assert.ok(m, `${name} is extractable`);
    return m[0];
  };
  const src = ['STREAM_END_SLACK_SEC', 'RESUME_IN_FLIGHT_MAX_MS', 'REPEAT_FAIL_WINDOW_MS', 'REPEAT_FAIL_RETURN_WINDOW_MS',
    'REPEAT_FAIL_SPOT_SEC', 'PLAYBACK_CONTENT_ERROR_RE'].map(constLine).join('\n') + '\n' + ['catalogRuntimeSeconds',
    'isGenuineEpisodeEof', 'streamRuntimeSeconds', 'nativeStreamEndIsRealEnd', 'handleVodPlaybackEnded',
    'playbackSourceSwapPending', 'markPlaybackSourceSwap', 'markPlaybackResuming', 'clearStaleResumeFlags',
    'noteRecoveryDeclined', 'recoverSamePlaybackSource', 'noteSourceFailure', 'playbackRepeatFailure',
    'positionBeforeRepeatFailure', 'failLedgerSource'].map(grab).join('\n');
  const clock = { now: 1e9 };
  const events = [];
  const S = { playing, view: 'player', _sourceFailLedger: [] };
  const stubs = {
    S, appMs: () => clock.now, vodPlaybackStarted: () => true, currentPlayerKind: () => 'remux',
    currentTime: () => Number(playing.nativePos) || 0, notePlaybackIssue: () => {}, notePlaybackTrace: () => {},
    finishEpisodeToNext: () => { events.push('next'); return hasNext; },
    closePlayer: (o) => events.push(o && o.ended ? 'close-ended' : 'close'),
    playbackServerGone: () => false, reMountAndResume: () => events.push('remount'), holdPlaybackAcrossRestart: () => {},
    clientCaps: () => ({}), tryNextNativeKind: () => false, autoAdvance: () => events.push('advance'),
    skipPastUnreadable: () => events.push('skip'), forwardRemuxResumeSec: (p, at) => ({ then: (f) => f(at) }),
    canUseNativeVideoPlayer: () => true, tryNativeVideoPlayer: (kind, at) => { events.push(`reopen ${Math.round(at)}`); return true; },
    $: () => null, toast: () => {}, setTimeout: () => {},
  };
  const end = new Function(...Object.keys(stubs), `${src}\nreturn handleVodPlaybackEnded;`)(...Object.values(stubs));
  return { clock, events, end: (pos) => { playing.nativePos = pos; return end(pos, pos); } };
}

test('the reopen after an early end that ends again at once at the same spot finishes the film (no frozen last frame)', () => {
  // The probe says 7200 s, the file really ends at 6900 s. The reopen plays the last GOP and ends
  // 5 s later, inside the 8 s swap window that used to swallow that end.
  const film = { usingNative: true, item: { type: 'movie', runtime: 120 }, tracks: { duration: 7200 },
    nativePos: 0, mountId: 'm1', sessionId: 's1', openedAt: 1, startedAt: 1 };
  const h = realRecoveryHarness(film);
  h.end(6900);
  assert.deepStrictEqual(h.events, ['reopen 6900'], 'an early end past 88 % reopens the same second');
  h.clock.now += 5000;
  h.end(6902);
  assert.deepStrictEqual(h.events, ['reopen 6900', 'next', 'close-ended'], 'the second end at that spot finishes the film (no next episode: close)');

  // An episode with no probe and a padded catalog runtime (60 min listed, 42 min file): the next
  // episode starts after one reopen.
  const ep = { usingNative: true, item: { type: 'episode', runtime: 60 }, nativePos: 0, mountId: 'm2', sessionId: 's2',
    openedAt: 1, startedAt: 1 };
  const e = realRecoveryHarness(ep, { hasNext: true });
  e.end(2520);
  e.clock.now += 4000;
  e.end(2522);
  assert.deepStrictEqual(e.events, ['reopen 2520', 'next'], 'auto-next after one reopen');

  // A cut at 95 % that plays on after the reopen still finishes at the real end, and a quick end
  // somewhere else after a reopen is still held for the swap window as before.
  const cut = { usingNative: true, item: { type: 'movie', runtime: 120 }, tracks: { duration: 7200 },
    nativePos: 0, mountId: 'm3', sessionId: 's3', openedAt: 1, startedAt: 1 };
  const c = realRecoveryHarness(cut);
  c.end(6840);
  c.clock.now += 3000;
  c.end(6400);
  assert.deepStrictEqual(c.events, ['reopen 6840'], 'an end at another spot inside the swap window is held');
  c.clock.now += 360000;
  c.end(7195);
  assert.deepStrictEqual(c.events, ['reopen 6840', 'next', 'close-ended']);

  // Past 88 % with the reopen declined by a guard (a native restart is still in flight): finish as
  // 3.4.14 did, instead of leaving the last frame up with nothing left to end it.
  const held = { usingNative: true, item: { type: 'movie', runtime: 120 }, tracks: { duration: 7200 },
    nativePos: 0, mountId: 'm4', sessionId: 's4', openedAt: 1, startedAt: 1 };
  const d = realRecoveryHarness(held);
  held._nativeResuming = true;
  held._resumingSince = d.clock.now - 2000;
  d.end(6840);
  assert.deepStrictEqual(d.events, ['next', 'close-ended'], 'a declined reopen past 88 % finishes the film');
  // Mid-title, a declined reopen still finishes nothing (as before).
  const mid = { usingNative: true, item: { type: 'movie', runtime: 120 }, tracks: { duration: 7200 },
    nativePos: 0, mountId: 'm5', sessionId: 's5', openedAt: 1, startedAt: 1, _nativeResuming: true };
  const m = realRecoveryHarness(mid);
  mid._resumingSince = m.clock.now - 2000;
  m.end(3600);
  assert.deepStrictEqual(m.events, [], 'mid-title: no finish');
});

test('every guard that declines a recovery says so, the client kind rides on notes, play and stop, and the native audio note no longer claims AAC', () => {
  const rec = ui.slice(ui.indexOf('function recoverSamePlaybackSource('), ui.indexOf('function resetVlcPanel'));
  for (const guard of ['next-episode handoff window', 'the player is paused', 'the video is paused', 'a native restart is in flight', 'a web restart is in flight']) {
    assert.ok(rec.includes(`noteRecoveryDeclined(p, '${guard}', reason);`), `the "${guard}" refusal is logged`);
  }
  assert.match(ui, /function noteRecoveryDeclined\(p, guard, reason\) \{[\s\S]+now - p\._recoveryDeclinedAt\[key\] < 30000\) return;[\s\S]+notePlaybackTrace\(`recovery declined: \$\{guard\}/,
    'one trace line per guard and reason every 30 s');
  assert.match(ui, /function playbackClientKind\(\) \{[\s\S]+app && app\.platform === 'windows' \? 'windows' : 'android'/);
  const kindCall = "typeof playbackClientKind === 'function' ? playbackClientKind() : undefined";
  assert.ok(ui.includes(`sessionId: String(p.sessionId || '').slice(0, 40),\r\n      client: ${kindCall},`)
    || ui.includes(`sessionId: String(p.sessionId || '').slice(0, 40),\n      client: ${kindCall},`), 'playback notes carry the client');
  assert.ok(ui.includes(`keepPrepared: !!opts.keepPrepared, client: ${kindCall} }`), 'stop carries the client');
  assert.ok(ui.includes(`caps: clientCaps(), client: ${kindCall} };`), 'play carries the client');
  assert.doesNotMatch(ui, /server remux to AAC instead of direct play/, 'a native remux copies the audio when the device decodes it');
});

function captureConsole() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  return { lines, restore: () => { console.log = orig; } };
}

test('the server writes the client kind on playback notes and play/stop lines, and accepts an end note', async () => {
  const srv = await bootServer({ TRIBOON_DEBUG: '1' });
  const cap = captureConsole();
  try {
    const admin = await setupAdmin(srv.port);
    const r = await httpJson(srv.port, 'POST', '/api/playback-issue', { kind: 'end', detail: 'stream ended at 5150s of 5700s (probe) — treated as finished: no', title: 'Made Up Film', client: 'windows' }, admin);
    assert.strictEqual(r.status, 204);
    const bad = await httpJson(srv.port, 'POST', '/api/playback-issue', { kind: 'trace', detail: 'x', title: 'Made Up Film', client: 'evil\nline' }, admin);
    assert.strictEqual(bad.status, 204);
    await httpJson(srv.port, 'POST', '/api/play/stop', { sessionId: 'zz-missing', client: 'android' }, admin);
    await new Promise((res) => setTimeout(res, 50));
    const text = cap.lines.join('\n');
    assert.match(text, /\[debug:issue\][^\n]*playback ended[^\n]*"Made Up Film" \[windows\] — reason: stream ended at 5150s/);
    assert.doesNotMatch(text, /evil/, 'an unknown client value never reaches the log');
    assert.match(text, /stop session=zz-missing missing=true client=android/);
  } finally {
    cap.restore();
    await srv.shutdown();
  }
});

function haveFfmpeg() {
  try { execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('a remux response that closes while ffmpeg still runs writes one line with position, idle seconds and bytes sent', { skip: !haveFfmpeg() && 'ffmpeg not installed' }, async () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-earlyend-'));
  const dir = path.join(lib, 'Quill Harbor (2004)');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '6M', '-c:a', 'aac', path.join(dir, 'Quill Harbor.mkv')]);
  const srv = await bootServer({ TRIBOON_DEBUG: '1', TMDB_BASE: null });
  const cap = captureConsole();
  try {
    const admin = await setupAdmin(srv.port);
    const created = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Early', kind: 'movie', path: lib }, admin);
    const id = created.json.id;
    await httpJson(srv.port, 'POST', `/api/libraries/${id}/scan`, {}, admin);
    for (let i = 0; i < 100; i++) {
      const st = await httpJson(srv.port, 'GET', `/api/libraries/${id}/scanstatus`, null, admin);
      if (!st.json.running) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    const play = await httpJson(srv.port, 'POST', `/api/local/${id}/0/play`, { caps: {} }, admin);
    assert.strictEqual(play.status, 200, play.raw);
    assert.ok(play.json.remuxUrl, 'the server offers a remux');
    const got = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: srv.port, path: `${play.json.remuxUrl}&start=0&audio=0` }, (res) => {
        let n = 0;
        res.on('data', (c) => { n += c.length; if (n > 65536) { req.destroy(); resolve(n); } });
        res.on('error', () => resolve(n));
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve(0) : reject(e)));
    });
    assert.ok(got > 0, 'some bytes arrived before the cut');
    let line = '';
    for (let i = 0; i < 40 && !line; i++) {
      await new Promise((res) => setTimeout(res, 50));
      line = cap.lines.find((l) => /remux viewer left at/.test(l)) || '';
    }
    assert.match(line, /\[debug:remux\] .* remux viewer left at ~?\d+s\+? after \d+s idle \(\d+\.\d MB sent from 0s\) — "Quill Harbor/);
  } finally {
    cap.restore();
    await srv.shutdown();
    fs.rmSync(lib, { recursive: true, force: true });
  }
});
