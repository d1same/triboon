'use strict';
// A release whose last minutes are damaged (bytes match the articles, the file itself breaks near the
// end) and no other copy is healthy. skipPastUnreadable steps over unreadable bytes in growing jumps.
// Near the end those jumps used to reopen the stream PAST the file's end: the TV player sat on
// "repairing", the episode never finished and Up Next never came (owner, 3.5.3, a damaged 2160p
// episode at 43:16 of 44 min). A jump that would land at or past the end, or the last jump used up
// in the final tenth, now finishes the title the normal way. The function runs as written.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const fnSrc = (name) => {
  const start = ui.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist in web/index.html`);
  const ends = ['\nfunction ', '\nasync function ', '\nlet ', '\nconst ', '\n//'].map((s) => ui.indexOf(s, start + 1)).filter((n) => n > start);
  return ui.slice(start, Math.min(...ends));
};
const SKIPS = /const UNREADABLE_SKIP_SEC = \[[^\]]*\];/.exec(ui)[0];

function rig({ duration, nextEp = true }) {
  const calls = { native: [], finished: 0, closed: [], interrupted: 0, notes: [], nativeClosed: 0, shell: 0 };
  const deps = {
    window: { TriboonTV: { closeVideo() { calls.nativeClosed++; } } },
    streamRuntimeSeconds: () => ({ sec: duration, from: 'probe' }),
    notePlaybackIssue: (kind, msg) => calls.notes.push(msg),
    tryNativeVideoPlayer: (kind, at) => { calls.native.push(Math.round(at)); return true; },
    currentPlayerKind: () => 'direct',
    showPlaybackInterrupted: () => { calls.interrupted++; },
    revealWebPlayerShell: () => { calls.shell++; },
    finishEpisodeToNext: () => { calls.finished++; return nextEp; },
    closePlayer: (o) => { calls.closed.push(o); },
  };
  const keys = Object.keys(deps);
  const skip = new Function(...keys, `${SKIPS}\n${fnSrc('skipPastUnreadable')}\nreturn skipPastUnreadable;`)(...keys.map((k) => deps[k]));
  return { skip, calls };
}

test('unreadable tail: a jump that would land past the end finishes the episode (Up Next), never reopens past it', () => {
  const { skip, calls } = rig({ duration: 2640 });
  const p = { usingNative: true, item: { type: 'tv' } };
  // The owner's log: 2596 → 2601 → 2616 → 2646 (past the 2640 s end).
  skip(p, 2596, 'unreadable'); skip(p, 2601, 'unreadable'); skip(p, 2616, 'unreadable');
  assert.deepStrictEqual(calls.native.slice(0, 2), [2601, 2616], 'the first jumps still step over the damage');
  assert.ok(calls.native.every((t) => t < 2640), `never reopened at or past the end (${calls.native.join(', ')})`);
  assert.strictEqual(calls.finished, 1, 'the episode finished and Up Next took over');
  assert.strictEqual(calls.interrupted, 0, 'no "playback interrupted" at the very end');
  assert.ok(calls.nativeClosed >= 1 && calls.shell >= 1, 'the native player handed back to the web Up Next');
});

test('unreadable tail: a film with no next episode closes as watched', () => {
  const { skip, calls } = rig({ duration: 6000, nextEp: false });
  const p = { usingNative: true, item: { type: 'movie' } };
  skip(p, 5996, 'unreadable');
  assert.deepStrictEqual(calls.native, [], 'no reopen at 6001 s of a 6000 s film');
  assert.strictEqual(calls.closed.length, 1);
  assert.strictEqual(calls.closed[0] && calls.closed[0].ended, true, 'closed as ended (watched)');
});

test('unreadable tail: damage mid-title still steps over it, and still ends with the error after the last jump', () => {
  const { skip, calls } = rig({ duration: 6000 });
  const p = { usingNative: true, item: { type: 'movie' } };
  for (const at of [1000, 1005, 1020, 1050, 1110]) skip(p, at, 'unreadable');
  assert.deepStrictEqual(calls.native, [1005, 1020, 1050, 1110], 'the same 5/15/30/60 s jumps as before');
  assert.strictEqual(calls.finished, 0);
  assert.strictEqual(calls.interrupted, 1, 'damage wider than the last jump mid-film shows the error, as before');
});

test('unreadable tail: the jumps used up in the last tenth finish the title instead of the error', () => {
  const { skip, calls } = rig({ duration: 6000 });
  const p = { usingNative: true, item: { type: 'tv' } };
  for (const at of [5600, 5605, 5620, 5650, 5710]) skip(p, at, 'unreadable');
  assert.strictEqual(calls.interrupted, 0);
  assert.strictEqual(calls.finished, 1);
});
