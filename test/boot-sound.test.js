'use strict';
// The start-up sound (3.5.1) plays through a Web Audio context. A context that stays open keeps the
// WebView's audio output running for the whole session (beside ExoPlayer on a TV); it must be closed
// once the sound has played, or when it is not used. The functions run as written in web/index.html.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const fn = (name) => {
  let start = ui.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist in web/index.html`);
  if (ui.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const ends = ['\nfunction ', '\nasync function ', '\nlet ', '\nconst '].map((s) => ui.indexOf(s, start + 1)).filter((n) => n > start);
  return ui.slice(start, Math.min(...ends));
};
const load = (names, deps) => {
  const src = names.map(fn).join('\n');
  const keys = Object.keys(deps);
  return new Function(...keys, `${src}\nreturn { ${names.map((n) => n).join(', ')} };`)(...keys.map((k) => deps[k]));
};
const names = ['startBootSoundThen'].concat(ui.includes('function closeBootAudioCtx(') ? ['closeBootAudioCtx'] : []);
const tick = () => new Promise((r) => setTimeout(r, 10));

function stubCtx(state) {
  const ctx = {
    state, outputLatency: 0, baseLatency: 0, closed: 0, destination: {},
    src: { connect() {}, start() { this.started = true; }, onended: null },
    createBufferSource() { return this.src; },
    createGain() { return { gain: { value: 0 }, connect() {} }; },
    close() { this.closed++; this.state = 'closed'; return Promise.resolve(); },
  };
  return ctx;
}

test('boot sound: the audio context is closed once the sound has played', async () => {
  const ctx = stubCtx('running');
  const bootAudio = { ctx, buf: { duration: 3.6 }, ready: Promise.resolve() };
  let went = 0;
  const { startBootSoundThen } = load(names, {
    bootAudio, bootSoundAllowed: () => true, primeBootSound: () => {}, $: () => null,
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 5)),
  });
  startBootSoundThen(() => { went++; });
  await tick();
  assert.strictEqual(went, 1, 'the logo starts');
  assert.ok(ctx.src.started, 'the sound starts');
  if (ctx.src.onended) ctx.src.onended();
  await tick();
  assert.strictEqual(ctx.closed, 1, 'the context is closed after the sound, so no audio output stays open');
});

test('boot sound: a context that is not running (the <audio> fallback plays) is closed at once', async () => {
  const ctx = stubCtx('suspended');
  const bootAudio = { ctx, buf: { duration: 3.6 }, ready: Promise.resolve() };
  const el = { dataset: {}, src: 'blob:x', volume: 1, currentTime: 0, addEventListener() {}, play() { return Promise.resolve(); } };
  let went = 0;
  const { startBootSoundThen } = load(names, {
    bootAudio, bootSoundAllowed: () => true, primeBootSound: () => {}, $: () => el,
    setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 5)),
  });
  startBootSoundThen(() => { went++; });
  await tick();
  assert.strictEqual(went, 1);
  assert.strictEqual(ctx.closed, 1, 'an unused context is not left open');
});
