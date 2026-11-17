'use strict';
// A page left open across a server update reloads itself (brief 102): the functions run as written
// in web/index.html. Every version number here is made up.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const fn = (name) => {
  let start = ui.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist in web/index.html`);
  if (ui.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const end = ui.indexOf('\nfunction ', start + 1);
  const asyncEnd = ui.indexOf('\nasync function ', start + 1);
  const stop = [end, asyncEnd].filter((n) => n > start).sort((a, b) => a - b)[0];
  assert.ok(stop > start, `${name} should be extractable`);
  return ui.slice(start, stop);
};
const load = (names, deps = {}) => {
  const src = names.map(fn).join('\n');
  const keys = Object.keys(deps);
  return new Function(...keys, `${src}\nreturn { ${names.join(', ')} };`)(...keys.map((k) => deps[k]));
};
const WINDOW = 30 * 60000;
const decide = () => load(['serverVersionReloadDecision'], { VERSION_RELOAD_WINDOW_MS: WINDOW }).serverVersionReloadDecision;

test('version reload: the page reloads once the server reports another version on two polls in a row', () => {
  const d = decide();
  const st = { loaded: '9.1.0', candidate: '', sightings: 0 };
  assert.strictEqual(d(st, '9.1.0', {}), 'none', 'same version: nothing to do');
  assert.strictEqual(d(st, '9.2.0', {}), 'wait', 'first sighting waits');
  assert.strictEqual(d(st, '9.2.0', {}), 'reload');
  // A restart that answers once with another build and then the loaded one is not an update.
  const blip = { loaded: '9.1.0', candidate: '', sightings: 0 };
  assert.strictEqual(d(blip, '9.2.0', {}), 'wait');
  assert.strictEqual(d(blip, '9.1.0', {}), 'none');
  assert.strictEqual(d(blip, '9.2.0', {}), 'wait', 'the count starts again');
  // No version in the answer (an old server, an error page): nothing.
  assert.strictEqual(d({ loaded: '9.1.0' }, '', {}), 'none');
  assert.strictEqual(d({ loaded: '' }, '9.2.0', {}), 'none');
});

test('version reload: never while something plays; it reloads after the player closes', () => {
  const d = decide();
  const st = { loaded: '9.1.0', candidate: '', sightings: 0 };
  d(st, '9.2.0', {});
  assert.strictEqual(d(st, '9.2.0', { busy: true }), 'defer');
  assert.strictEqual(d(st, '9.2.0', { busy: true }), 'defer', 'still playing');
  assert.strictEqual(d(st, '9.2.0', { busy: false }), 'reload', 'the player closed');
});

test('version reload: a version that flaps cannot make a reload loop', () => {
  const d = decide();
  const now = 10 * WINDOW;
  const twice = (st, v, history) => { d(st, v, { history, now }); return d(st, v, { history, now }); };
  // Already reloaded for this version in this tab: never again.
  assert.strictEqual(twice({ loaded: '9.1.0' }, '9.2.0', { at: [now - 1000], versions: ['9.2.0'] }), 'none');
  // Two reloads in the last 30 minutes: no third, whatever the version.
  assert.strictEqual(twice({ loaded: '9.2.0' }, '9.3.0', { at: [now - 60000, now - 120000], versions: ['9.1.0', '9.2.0'] }), 'none');
  // Older reloads do not count.
  assert.strictEqual(twice({ loaded: '9.2.0' }, '9.3.0', { at: [now - WINDOW - 1, now - WINDOW - 2], versions: ['9.0.0', '9.0.1'] }), 'reload');
});

test('version reload: playing, music, an audiobook or a field being typed in all hold the reload', () => {
  const audio = { musicAudio: { paused: true }, abAudio: { paused: true } };
  const doc = { activeElement: null, getElementById: (id) => audio[id] || null };
  const S = { playing: null, view: 'home' };
  const AB = { now: null };
  const { versionReloadBusy } = load(['versionReloadBusy'], { S, document: doc, AB });
  assert.strictEqual(versionReloadBusy(), '');
  S.playing = { item: { type: 'movie' } };
  assert.strictEqual(versionReloadBusy(), 'playing');
  S.playing = null; S.view = 'player';
  assert.strictEqual(versionReloadBusy(), 'playing', 'the player view counts while it opens or closes');
  S.view = 'home';
  audio.musicAudio.paused = false;
  assert.strictEqual(versionReloadBusy(), 'music');
  audio.musicAudio.paused = true;
  AB.now = { active: true };
  assert.strictEqual(versionReloadBusy(), 'audiobook');
  AB.now = null;
  doc.activeElement = { tagName: 'INPUT' };
  assert.strictEqual(versionReloadBusy(), 'typing');
});

test('version reload: the poll reloads the page once, keeps the tab history, and the boot starts the watch', async () => {
  let reloads = 0;
  let served = '9.2.0';
  const stored = {};
  const window = { sessionStorage: { getItem: (k) => stored[k] || null, setItem: (k, v) => { stored[k] = v; } } };
  const S = { playing: null, view: 'home', _versionReload: { loaded: '9.1.0', candidate: '', sightings: 0, reloading: false } };
  const deps = {
    S, window, VERSION_RELOAD_WINDOW_MS: WINDOW,
    fetch: async () => ({ ok: true, json: async () => ({ version: served }) }),
    AbortSignal: { timeout: () => undefined },
    toast: () => {},
    location: { reload: () => { reloads++; } },
    setTimeout: (f) => f(),
    document: { activeElement: null, getElementById: () => null },
    AB: { now: null },
  };
  const { checkServerVersionForReload } = load(['versionReloadHistory', 'serverVersionReloadDecision', 'versionReloadBusy', 'checkServerVersionForReload'], deps);
  await checkServerVersionForReload();
  assert.strictEqual(reloads, 0, 'one sighting');
  S.playing = { item: { type: 'episode' } };
  await checkServerVersionForReload();
  assert.strictEqual(reloads, 0, 'not while playing');
  S.playing = null;
  await checkServerVersionForReload();
  assert.strictEqual(reloads, 1, 'reloads after the player closed');
  assert.deepStrictEqual(JSON.parse(stored.triboonVersionReloads).versions, ['9.2.0']);
  await checkServerVersionForReload();
  assert.strictEqual(reloads, 1, 'one reload only');

  // The reloaded page comes up on 9.2.0; the server flaps back to 9.1.0 and to 9.2.0 again.
  S._versionReload = { loaded: '9.2.0', candidate: '', sightings: 0, reloading: false };
  served = '9.1.0';
  await checkServerVersionForReload(); await checkServerVersionForReload();
  assert.strictEqual(reloads, 2, 'a real change back is followed once');
  S._versionReload = { loaded: '9.1.0', candidate: '', sightings: 0, reloading: false };
  served = '9.2.0';
  await checkServerVersionForReload(); await checkServerVersionForReload(); await checkServerVersionForReload();
  assert.strictEqual(reloads, 2, 'no loop');

  assert.ok(/startServerVersionWatch\(info\.version\)/.test(ui), 'the boot starts the watch with the version it loaded');
  assert.ok(/VERSION_RELOAD_POLL_MS\s*=\s*60000/.test(ui), 'the page polls once a minute');
});

test('version reload: Multiview holds the reload (its players run with no S.playing)', () => {
  // Check 103: openMultiViewFromGuide stops the single player (S.playing = null) and sets
  // S.view = 'multiview'; a reload there cut every tile, VOD tiles with unsaved progress included.
  const doc = { activeElement: null, getElementById: () => null };
  const S = { playing: null, view: 'multiview', multiView: { open: true } };
  const { versionReloadBusy } = load(['versionReloadBusy'], { S, document: doc, AB: { now: null } });
  assert.ok(versionReloadBusy(), 'Multiview is busy');
  S.view = 'livetv'; // the view changed while the tiles stay open
  assert.ok(versionReloadBusy(), 'open tiles are busy');
  S.multiView = { open: false };
  assert.strictEqual(versionReloadBusy(), '');
});

test('version reload: playback that starts in the second before the reload holds it; the reload comes after it', async () => {
  // Check 103: the reload ran 1.5 s after the decision without looking again, so a Play pressed in
  // that second was cut; the version was also marked as reloaded, so no later reload followed.
  let reloads = 0;
  const timers = [];
  const stored = {};
  const window = { sessionStorage: { getItem: (k) => stored[k] || null, setItem: (k, v) => { stored[k] = v; } } };
  const S = { playing: null, view: 'home', _versionReload: { loaded: '9.1.0', candidate: '', sightings: 0, reloading: false } };
  const deps = {
    S, window, VERSION_RELOAD_WINDOW_MS: WINDOW,
    fetch: async () => ({ ok: true, json: async () => ({ version: '9.2.0' }) }),
    AbortSignal: { timeout: () => undefined },
    toast: () => {},
    location: { reload: () => { reloads++; } },
    setTimeout: (f) => { timers.push(f); },
    document: { activeElement: null, getElementById: () => null },
    AB: { now: null },
  };
  const { checkServerVersionForReload } = load(['versionReloadHistory', 'serverVersionReloadDecision', 'versionReloadBusy', 'checkServerVersionForReload'], deps);
  await checkServerVersionForReload();
  await checkServerVersionForReload();
  assert.strictEqual(timers.length, 1, 'the reload is scheduled');
  S.playing = { item: { type: 'movie' } }; // Play pressed during the toast
  timers.shift()();
  assert.strictEqual(reloads, 0, 'not while playing');
  S.playing = null;
  await checkServerVersionForReload();
  while (timers.length) timers.shift()();
  assert.strictEqual(reloads, 1, 'it reloads once the player closed');
});
