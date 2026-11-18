'use strict';

// Owner report 2026-11-18: pressing a favorite channel on Home opened the native player PAUSED.
// Home activates a channel card on OK key-DOWN; the native Android player clicks its focused
// Play/Pause on OK key-UP, so the release of the same press paused the new channel. The Live TV
// page acts on key-up and was fine. The native hand-off must now wait for OK to come up.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

function extractFunction(name) {
  let start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in web/index.html`);
  if (html.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let i = html.indexOf(') {', start) + 2; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${name} has no end`);
}

function okBlock() {
  const a = html.indexOf('const OK_KEY_RELEASE_MAX_MS');
  assert.ok(a >= 0, 'OK key-release tracking exists in web/index.html');
  return html.slice(a, html.indexOf('async function playChannel(', a));
}

function load({ native = true } = {}) {
  const listeners = { keydown: [], keyup: [] };
  const S = { view: 'home', liveCat: 'All' };
  const calls = [];
  const el = { classList: { contains: () => false, add() {}, remove() {} } };
  const stubs = {
    S,
    document: { addEventListener: (type, fn) => listeners[type] && listeners[type].push(fn), body: { classList: { remove() {} } } },
    $: () => el,
    promotePlayerGuideChannelToFullscreen: () => false,
    liveSplitEnabled: () => false,
    beginLiveTune: () => ({ id: 1 }),
    liveTuneIsCurrent: () => true,
    rememberVodReturn() {},
    setPlayerGuideVisualFocus() {},
    hydrateLivePlaybackUrls: async (it) => ({ ...it, _streamUrl: '/s', _nativeUrl: '/n' }),
    prefetchAdjacentChannelUrls() {},
    windowsDesktopLiveWatchFromGuide: () => false,
    closePlayerGuide() {},
    canUseNativeLivePlayer: () => native,
    tryNativeLivePlayer: () => { if (!native) return false; calls.push({ kind: 'native', okDown: !!S._okKeyDown }); return true; },
    nativeLiveRequired: () => false,
    playChannelWeb: () => { calls.push({ kind: 'web', okDown: !!S._okKeyDown }); },
    toast() {}, markGuideCur() {}, schedulePlayerGuideFocusRestore() {}, playLiveSplitChannel() {}, liveSplitActivePane: () => 0,
  };
  const src = `${okBlock()}\n${extractFunction('playChannel')}`;
  const fns = new Function(...Object.keys(stubs), `${src}\nreturn { playChannel, okKeyReleased };`)(...Object.values(stubs));
  const key = (type) => listeners[type].forEach((fn) => fn({ key: 'Enter', repeat: false }));
  return { S, fns, calls, key };
}
const tick = () => new Promise((r) => setImmediate(r));

test('Home favorite on Android TV: the native player starts only after OK is released', async () => {
  const t = load();
  t.key('keydown');                       // OK goes down on the Home card → card click → playChannel
  const run = t.fns.playChannel({ _channel: 3, _chid: 'src:3', title: 'Test One' });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(t.calls.length, 0, 'no native hand-off while OK is still held');
  t.key('keyup');
  await run;
  assert.deepEqual(t.calls, [{ kind: 'native', okDown: false }], 'hand-off happens after the release');
});

test('zaps and taps with no OK held start at once; a lost key-up never blocks longer than the cap', async () => {
  const t = load();
  await t.fns.playChannel({ _channel: 4, _chid: 'src:4' });
  assert.deepEqual(t.calls, [{ kind: 'native', okDown: false }]);
  t.key('keydown');
  const at = Date.now();
  await t.fns.okKeyReleased(80);
  assert.ok(Date.now() - at >= 70, 'waited for the cap');
  assert.equal(t.S._okKeyDown, false, 'a swallowed key-up is forgotten after the cap');
});

test('browser (no native player) is not delayed by a held OK', async () => {
  const t = load({ native: false });
  t.key('keydown');
  await t.fns.playChannel({ _channel: 5, _chid: 'src:5' });
  assert.deepEqual(t.calls, [{ kind: 'web', okDown: true }]);
});
