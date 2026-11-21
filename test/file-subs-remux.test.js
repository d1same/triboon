'use strict';
// Brief 143: the file's own text subtitles ride along the remux/transcode as a side file, so the
// phone on the remux and the browser can show them. The picture output must stay byte-for-byte
// the same, the cues must be on the movie's own clock after a seek, and a play with no side file
// must say so (the client then asks the remux again).

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { bootServer, setupAdmin, httpJson } = require('./helpers');
const tc = require('../server/transcode');

const ff = tc.detectFfmpeg();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-filesub-test-'));
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

function srt(lines) {
  const t = (x) => new Date(x * 1000).toISOString().slice(11, 23).replace('.', ',');
  return lines.map(([a, b, text], i) => `${i + 1}\n${t(a)} --> ${t(b)}\n${text}\n`).join('\n');
}
// 2 minutes: H.264 (keyframe every 2 s), AC3 audio, English SRT, a PGS-free French ASS-less SRT.
function makeFixture() {
  const en = []; const fr = [];
  for (let i = 0; i < 24; i++) { en.push([i * 5 + 1, i * 5 + 3, `English line ${i}`]); fr.push([i * 5 + 2, i * 5 + 4, `Ligne ${i}`]); }
  fs.writeFileSync(path.join(dir, 'en.srt'), srt(en));
  fs.writeFileSync(path.join(dir, 'fr.srt'), srt(fr));
  const out = path.join(dir, 'movie.mkv');
  const r = spawnSync(ff.path, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=f=440',
    '-i', path.join(dir, 'en.srt'), '-i', path.join(dir, 'fr.srt'), '-t', '120',
    '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48',
    '-c:a', 'ac3', '-c:s', 'srt', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=fre', out]);
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}`);
  return out;
}
function runToEnd(child) {
  return new Promise((resolve) => {
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.resume();
    child.on('close', (code) => resolve({ code, out: Buffer.concat(chunks) }));
  });
}
function packetTimes(buf) {
  const f = path.join(dir, `p${Date.now()}${Math.random()}.mp4`);
  fs.writeFileSync(f, buf);
  const probe = tc.detectFfprobe();
  const r = spawnSync(probe.path, ['-v', 'error', '-show_entries', 'packet=pts_time,stream_index', '-of', 'csv', f], { encoding: 'utf8' });
  return r.stdout;
}

test('side subtitle args map only the known text tracks and put cues back on the movie clock', () => {
  assert.deepStrictEqual(tc.sideSubtitleArgs(null, 10), []);
  assert.deepStrictEqual(tc.sideSubtitleArgs({ file: 'x.mkv', rels: [] }, 10), [], 'no track: no output (an empty output stops the picture)');
  const a = tc.sideSubtitleArgs({ file: 'x.mkv', rels: [0, 3] }, 95.5);
  assert.deepStrictEqual(a, ['-map', '0:s:0', '-map', '0:s:3', '-c', 'copy', '-output_ts_offset', '95.5', '-flush_packets', '1', '-f', 'matroska', 'x.mkv']);
  assert.ok(!tc.sideSubtitleArgs({ file: 'x.mkv', rels: [1] }, 0).includes('-output_ts_offset'));
});

test('remux with the side file: same picture bytes, cues on the movie clock after a seek', { skip: !ff && 'no ffmpeg' }, async () => {
  const movie = makeFixture();
  const side = path.join(dir, 'side.mkv');
  const plain = await runToEnd(tc.spawnRemux(movie, { startSeconds: 60 }));
  const withSide = await runToEnd(tc.spawnRemux(movie, { startSeconds: 60, sideSubs: { file: side, rels: [0, 1] } }));
  assert.strictEqual(plain.code, 0);
  assert.strictEqual(withSide.code, 0);
  assert.strictEqual(packetTimes(withSide.out), packetTimes(plain.out), 'the picture and sound packets are unchanged');
  const en = await tc.readSideSubtitleVtt(side, 0);
  const fr = await tc.readSideSubtitleVtt(side, 1);
  assert.match(en, /^WEBVTT/);
  assert.match(en, /01:01\.000 --> 01:03\.000\nEnglish line 12/, 'a line at 61 s stays at 61 s after a 60 s seek');
  assert.match(fr, /01:02\.000 --> 01:04\.000\nLigne 12/, 'the second track is read from the same side file');
  assert.doesNotMatch(en, /English line 3\b/, 'nothing from before the seek');
});

test('/api/filesub serves the side track; a play without a side file answers NO_SIDE', { skip: !ff && 'no ffmpeg' }, async () => {
  const movie = fs.existsSync(path.join(dir, 'movie.mkv')) ? path.join(dir, 'movie.mkv') : makeFixture();
  const srv = await bootServer();
  try {
    const admin = await setupAdmin(srv.port);
    const uid = srv.auth._users().list[0].id;
    const id = 'fsubmount1';
    const size = fs.statSync(movie).size;
    srv.mounts.set(id, {
      id, name: 'Movie.2024.1080p.mkv', size, streamable: true, _local: { file: movie }, mountedAt: Date.now(),
      _tracks: { available: true, duration: 120, audio: [{ rel: 0, codec: 'ac3', channels: 1 }],
        subs: [{ rel: 0, codec: 'subrip', lang: 'eng', text: true }, { rel: 1, codec: 'subrip', lang: 'fre', text: true }] },
    });
    const t = srv.auth.streamToken(uid, id);
    // The remux with fs=<id> writes the side file while the picture streams.
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: srv.port, path: `/api/remux/${id}?t=${t}&start=30&fs=abc123def` }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    assert.ok(body.length > 1000, 'the picture still streams');
    const r = await httpJson(srv.port, 'GET', `/api/filesub/${id}/0?t=${t}&fs=abc123def`);
    assert.strictEqual(r.status, 200);
    assert.match(r.raw, /00:31\.000 --> 00:33\.000\nEnglish line 6/);
    // A seek respawns the remux with the same play id: the same address now reads the new side file.
    await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: srv.port, path: `/api/remux/${id}?t=${t}&start=90&fs=abc123def` }, (res) => {
        res.resume(); res.on('end', resolve);
      }).on('error', reject);
    });
    const afterSeek = await httpJson(srv.port, 'GET', `/api/filesub/${id}/0?t=${t}&fs=abc123def`);
    assert.strictEqual(afterSeek.status, 200);
    assert.match(afterSeek.raw, /01:31\.000 --> 01:33\.000\nEnglish line 18/, 'the newest remux of this play');
    assert.doesNotMatch(afterSeek.raw, /English line 6\b/, 'not the side file of the remux before the seek');
    const missing = await httpJson(srv.port, 'GET', `/api/filesub/${id}/0?t=${t}&fs=zzz999zzz`);
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.json.code, 'NO_SIDE');
    const noTrack = await httpJson(srv.port, 'GET', `/api/filesub/${id}/7?t=${t}&fs=abc123def`);
    assert.strictEqual(noTrack.status, 404);
    assert.strictEqual(noTrack.json.code, 'NO_TRACK');
    const wrongToken = await httpJson(srv.port, 'GET', `/api/filesub/${id}/0?t=${srv.auth.streamToken(uid, 'other')}&fs=abc123def`);
    assert.strictEqual(wrongToken.status, 401, 'a token for another mount cannot read it');
    assert.ok(admin);
  } finally {
    await srv.shutdown();
  }
});

test('a side output that fails before the picture is respawned without it (the picture never stops)', { skip: !ff && 'no ffmpeg' }, async () => {
  const movie = fs.existsSync(path.join(dir, 'movie.mkv')) ? path.join(dir, 'movie.mkv') : makeFixture();
  const srv = await bootServer();
  try {
    await setupAdmin(srv.port);
    const uid = srv.auth._users().list[0].id;
    const id = 'fsubmount2';
    // The probe claims a text track 5 the file does not have: the side output fails at once.
    srv.mounts.set(id, {
      id, name: 'Movie.2024.1080p.mkv', size: fs.statSync(movie).size, streamable: true, _local: { file: movie }, mountedAt: Date.now(),
      _tracks: { available: true, duration: 120, audio: [{ rel: 0, codec: 'ac3', channels: 1 }], subs: [{ rel: 5, codec: 'subrip', lang: 'eng', text: true }] },
    });
    const t = srv.auth.streamToken(uid, id);
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: srv.port, path: `/api/remux/${id}?t=${t}&start=90&fs=abc123def` }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    assert.ok(body.length > 1000, 'the plain remux took over');
    const r = await httpJson(srv.port, 'GET', `/api/filesub/${id}/5?t=${t}&fs=abc123def`);
    assert.strictEqual(r.status, 404, 'the play is marked as having no side file');
  } finally {
    await srv.shutdown();
  }
});
