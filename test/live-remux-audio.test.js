'use strict';

// Web Live TV remux (result 89 Part B). A channel with AC-3 5.1(side) audio was re-encoded to AAC
// with channel configuration 0 (a PCE), and Chrome refused the init segment ("stream parsing
// failed" at 0:00). Both live remux paths now ask for a standard layout. And a stdin remux that
// dies on a mid-GOP start now logs the line that says why, not only the last two echo lines.
// Fixtures are made by ffmpeg itself (test patterns, silence); no provider is contacted.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FF = process.env.FFMPEG_PATH || 'ffmpeg';
function haveFfmpeg() {
  try { execFileSync(FF, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const transcode = require('../server/transcode');

test('both live remux argument lists ask for a standard AAC channel layout', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'transcode.js'), 'utf8');
  assert.strictEqual(transcode.LIVE_AUDIO_LAYOUTS, 'aformat=channel_layouts=5.1|stereo|mono');
  for (const fn of ['function spawnLiveRemux(', 'function spawnLiveRemuxStdin(']) {
    const at = src.indexOf(fn);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    assert.match(body, /'-c:a', 'aac', '-b:a', '384k',[\s\S]{0,400}'-af', LIVE_AUDIO_LAYOUTS,/, `${fn} sets the layout`);
  }
  const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(idx, /const cause = all\.filter\(\(l\) => \/dimensions not set\|could not write header\|could not find codec parameters\|invalid data found\/i\.test\(l\)\)\.slice\(0, 2\);/,
    'the ts-pipe log keeps the line that says what failed');
  assert.match(idx, /const tail = \[\.\.\.new Set\(\[\.\.\.cause, \.\.\.all\.slice\(-2\)\]\)\]\.join\(' \| '\)/);
});

// AudioSpecificConfig channel configuration from the first esds box of an fMP4 init segment.
function aacChannelConfig(buf) {
  const at = buf.indexOf(Buffer.from('esds'));
  if (at < 0) return null;
  for (let i = at + 8; i < Math.min(buf.length - 4, at + 200); i++) {
    if (buf[i] !== 0x05) continue; // DecoderSpecificInfo tag
    let j = i + 1;
    let len = 0;
    for (let k = 0; k < 4; k++) { const b = buf[j++]; len = (len << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
    if (len < 2 || len > 64) continue;
    return (buf[j + 1] >> 3) & 0x0f;
  }
  return null;
}

function remuxOnce(tsBuf, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const ff = transcode.spawnLiveRemuxStdin();
    const out = [];
    let err = '';
    const t = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, timeoutMs);
    ff.stdout.on('data', (c) => out.push(c));
    ff.stderr.on('data', (c) => { err += c; });
    ff.stdin.on('error', () => {});
    ff.on('close', (code) => { clearTimeout(t); resolve({ code, out: Buffer.concat(out), err }); });
    ff.stdin.end(tsBuf);
  });
}

test('an AC-3 5.1(side) channel becomes AAC that a browser accepts (channel configuration 6, not 0)', { skip: !haveFfmpeg() && 'ffmpeg not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-liveaudio-'));
  try {
    const ts = path.join(dir, 'side.ts');
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'aevalsrc=0.1*sin(2*PI*440*t)|0|0|0|0|0:channel_layout=5.1(side):sample_rate=48000',
      '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'ac3', '-b:a', '384k', '-f', 'mpegts', ts]);
    const r = await remuxOnce(fs.readFileSync(ts));
    assert.ok(r.out.length > 1000, `the remux wrote output (exit ${r.code}: ${r.err.slice(-200)})`);
    const cc = aacChannelConfig(r.out);
    assert.notStrictEqual(cc, 0, 'channel configuration 0 (PCE) is what Chrome refuses');
    assert.strictEqual(cc, 6, '5.1(side) is written as standard 5.1');

    // A video-only channel and a stereo AAC channel still remux.
    const vonly = path.join(dir, 'vonly.ts');
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
      '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-f', 'mpegts', vonly]);
    const v = await remuxOnce(fs.readFileSync(vonly));
    assert.ok(v.out.length > 1000 && v.code === 0, `video only still remuxes (exit ${v.code}: ${v.err.slice(-200)})`);
    const stereo = path.join(dir, 'stereo.ts');
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25',
      '-c:a', 'aac', '-ac', '2', '-f', 'mpegts', stereo]);
    const s = await remuxOnce(fs.readFileSync(stereo));
    assert.strictEqual(aacChannelConfig(s.out), 2, 'stereo stays stereo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stdin remux that starts mid-GOP prints a cause line the ts-pipe log now keeps', { skip: !haveFfmpeg() && 'ffmpeg not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-livegop-'));
  try {
    const ts = path.join(dir, 'longgop.ts');
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-g', '250', '-keyint_min', '250', '-sc_threshold', '0', '-c:a', 'aac', '-f', 'mpegts', ts]);
    const all = fs.readFileSync(ts);
    const cut = all.subarray(Math.floor(all.length * 0.4) + 77); // an arbitrary byte, far from the only keyframe
    const r = await remuxOnce(cut);
    assert.notStrictEqual(r.code, 0, `a mid-GOP start with a 0.5 s probe fails (exit ${r.code})`);
    const lines = r.err.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
    const cause = lines.filter((l) => /dimensions not set|could not write header|could not find codec parameters|invalid data found/i.test(l));
    assert.ok(cause.length >= 1, `ffmpeg says why at -loglevel error: ${lines.join(' | ')}`);
    assert.ok(!lines.slice(-2).some((l) => cause.includes(l)) || lines.length <= 2,
      'the cause is not among the last two lines (that is why the old log hid it)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
