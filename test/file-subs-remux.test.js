'use strict';
// Brief 143: the file's own text subtitles for remux/transcode viewers (browser, phone, TV). The
// server reads the subtitle blocks out of the Matroska bytes the remux already pulls through
// /api/stream (or, for a local file, reads ahead of the picture), and /api/filesub hands one track
// out as WebVTT on the movie's own clock. The remux itself is untouched.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { bootServer, setupAdmin, httpJson } = require('./helpers');
const tc = require('../server/transcode');
const { MkvSubtitleTap, parseHeader, cueText } = require('../server/mkvsubs');

const ff = tc.detectFfmpeg();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-filesub-test-'));
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

function srt(lines) {
  const t = (x) => new Date(x * 1000).toISOString().slice(11, 23).replace('.', ',');
  return lines.map(([a, b, text], i) => `${i + 1}\n${t(a)} --> ${t(b)}\n${text}\n`).join('\n');
}
let fixture = null;
// 2 minutes: H.264, AC3, an English SRT track and a French ASS track (ffmpeg writes CRC-32 elements).
function makeFixture() {
  if (fixture) return fixture;
  const en = []; const fr = [];
  for (let i = 0; i < 24; i++) { en.push([i * 5 + 1, i * 5 + 3, `English line ${i}`]); fr.push([i * 5 + 2, i * 5 + 4, `Ligne ${i}`]); }
  fs.writeFileSync(path.join(dir, 'en.srt'), srt(en));
  fs.writeFileSync(path.join(dir, 'fr.srt'), srt(fr));
  const out = path.join(dir, 'movie.mkv');
  const r = spawnSync(ff.path, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=f=440',
    '-i', path.join(dir, 'en.srt'), '-i', path.join(dir, 'fr.srt'), '-t', '120',
    '-map', '0', '-map', '1', '-map', '2', '-map', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48',
    '-c:a', 'ac3', '-c:s:0', 'srt', '-c:s:1', 'ass', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=fre', out]);
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}`);
  fixture = out;
  return out;
}
const starts = (vtt) => vtt.split('\n').filter((l) => l.includes('-->')).map((l) => l.split(' --> ')[0]);

test('ASS lines lose their fields and tags; SRT text stays; no line can end a WebVTT cue early', () => {
  assert.strictEqual(cueText('S_TEXT/ASS', Buffer.from('3,0,Default,,0,0,0,,{\\i1}Hello{\\i0}\\Nthere, friend')), 'Hello\nthere, friend');
  assert.strictEqual(cueText('S_TEXT/UTF8', Buffer.from('<i>Hi</i>\r\n\r\nyou')), '<i>Hi</i>\nyou');
  assert.strictEqual(cueText('S_TEXT/UTF8', Buffer.from('a --> b')), 'a → b');
  assert.deepStrictEqual(parseHeader(Buffer.from('not matroska')), { notMkv: true });
});

test('the tap reads every text line of the file, in any chunk sizes, with the times ffmpeg reads', { skip: !ff && 'no ffmpeg' }, () => {
  const movie = makeFixture();
  const buf = fs.readFileSync(movie);
  const tap = new MkvSubtitleTap();
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let o = 0; o < buf.length;) { const n = 1 + Math.floor(rnd() * 90000); tap.feed(o, buf.subarray(o, o + n)); o += n; }
  assert.deepStrictEqual(tap.header.subs.map((s) => [s.index, s.codec, s.lang, s.text]), [[0, 'S_TEXT/UTF8', 'eng', true], [1, 'S_TEXT/ASS', 'fre', true]]);
  // The times written into the file (ffmpeg's own read shifts them by the file's start offset on some
  // versions: 6 ms with ffmpeg 6.1 on Ubuntu 24.04).
  const want = Array.from({ length: 24 }, (_, i) => `00:${String(Math.floor((i * 5 + 1) / 60)).padStart(2, '0')}:${String((i * 5 + 1) % 60).padStart(2, '0')}.000`);
  assert.deepStrictEqual(starts(tap.vtt(0)), want, 'the same 24 English lines at the times written into the file');
  assert.match(tap.vtt(0), /00:01:01\.000 --> 00:01:03\.000\nEnglish line 12\n/);
  assert.match(tap.vtt(1), /00:01:02\.000 --> 00:01:04\.000\nLigne 12\n/, 'the ASS track as plain text');
});

test('after a seek the tap starts in the middle of the file and finds the next cluster', { skip: !ff && 'no ffmpeg' }, () => {
  const buf = fs.readFileSync(makeFixture());
  const tap = new MkvSubtitleTap();
  tap.feed(0, buf.subarray(0, 4096)); // the header, as every reader reads it first
  const mid = Math.floor(buf.length * 0.5) + 12345; // not on a cluster boundary
  for (let p = mid; p < buf.length; p += 65536) tap.feed(p, buf.subarray(p, Math.min(buf.length, p + 65536)));
  const got = starts(tap.vtt(0));
  assert.ok(got.length >= 10 && got.length < 24, `lines from the middle on (${got.length})`);
  assert.strictEqual(got[got.length - 1], '00:01:56.000', 'up to the last line');
  // Picture bytes that happen to hold the cluster id do not make lines (a cluster must start with its time).
  const junk = Buffer.alloc(200000, 0x55); junk.writeUInt32BE(0x1F43B675, 5000); junk[5004] = 0x88; junk.writeUInt32BE(0xA3880081, 5012);
  const t2 = new MkvSubtitleTap(); t2.feed(0, buf.subarray(0, 4096)); t2.feed(10000000, junk);
  assert.strictEqual(starts(t2.vtt(0)).length, 0);
});

test('/api/filesub: lines from the bytes /api/stream hands the remux; a local file is read ahead of the picture', { skip: !ff && 'no ffmpeg' }, async () => {
  const movie = makeFixture();
  const buf = fs.readFileSync(movie);
  const srv = await bootServer();
  try {
    await setupAdmin(srv.port);
    const uid = srv.auth._users().list[0].id;
    const tracks = { available: true, duration: 120, audio: [{ rel: 0, codec: 'ac3', channels: 1 }],
      subs: [{ rel: 0, codec: 'subrip', lang: 'eng', text: true }, { rel: 1, codec: 'ass', lang: 'fre', text: true }] };
    // A usenet-like mount: its bytes come from vf.read, like any mount.
    const id = 'fsubmount1';
    srv.mounts.set(id, { id, name: 'Movie.2024.1080p', size: buf.length, streamable: true, mountedAt: Date.now(), _tracks: tracks,
      async *read(start, end) { for (let p = start; p < end; p += 65536) yield buf.subarray(p, Math.min(end, p + 65536)); } });
    const t = srv.auth.streamToken(uid, id);
    // Only the first bytes read (the header ask): the opening lines at most, not an error.
    const early = await httpJson(srv.port, 'GET', `/api/filesub/${id}/0?t=${t}`);
    assert.strictEqual(early.status, 200);
    assert.doesNotMatch(early.raw, /English line 23/);
    // The remux reads the middle of the file through /api/stream: those lines are now known.
    const from = Math.floor(buf.length * 0.5);
    await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.port, path: `/api/stream/${id}?t=${t}`, headers: { range: `bytes=${from}-` } },
      (res) => { res.resume(); res.on('end', resolve); }).on('error', reject));
    const mid = await httpJson(srv.port, 'GET', `/api/filesub/${id}/0?t=${t}`);
    assert.match(mid.raw, /00:01:56\.000 --> 00:01:58\.000\nEnglish line 23/);
    assert.doesNotMatch(mid.raw, /English line 2\n/, 'only what was read');
    assert.strictEqual((await httpJson(srv.port, 'GET', `/api/filesub/${id}/5?t=${t}`)).json.code, 'NO_TRACK');
    assert.strictEqual((await httpJson(srv.port, 'GET', `/api/filesub/${id}/0?t=${srv.auth.streamToken(uid, 'other')}`)).status, 401, 'a token for another mount cannot read it');

    // A local file: ffmpeg reads it from disk, so the server reads ahead of the picture (at=).
    const lid = 'fsubmount2';
    srv.mounts.set(lid, { id: lid, name: 'Local.Movie.mkv', size: buf.length, streamable: true, mountedAt: Date.now(), _local: { file: movie }, _tracks: tracks });
    const lt = srv.auth.streamToken(uid, lid);
    const loc = await httpJson(srv.port, 'GET', `/api/filesub/${lid}/1?t=${lt}&at=60`);
    assert.strictEqual(loc.status, 200);
    assert.match(loc.raw, /00:01:02\.000 --> 00:01:04\.000\nLigne 12/, 'the line at the picture is there on the first ask');

    // Not Matroska: no file lines, the client goes online.
    const mp4 = path.join(dir, 'movie.mp4');
    spawnSync(ff.path, ['-hide_banner', '-loglevel', 'error', '-y', '-i', movie, '-map', '0:v', '-c', 'copy', '-t', '5', mp4]);
    const mid4 = 'fsubmount3';
    srv.mounts.set(mid4, { id: mid4, name: 'Movie.mp4', size: fs.statSync(mp4).size, streamable: true, mountedAt: Date.now(), _local: { file: mp4 }, _tracks: tracks });
    const no = await httpJson(srv.port, 'GET', `/api/filesub/${mid4}/0?t=${srv.auth.streamToken(uid, mid4)}`);
    assert.strictEqual(no.status, 404);
    assert.strictEqual(no.json.code, 'NO_SIDE');
  } finally {
    await srv.shutdown();
  }
});

test('the remux and transcode stay exactly as in 3.5.6 (nothing added to the picture path)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'transcode.js'), 'utf8');
  assert.match(src, /function spawnRemux\(streamUrl, \{ startSeconds = 0, audioTrack = 0, transcodeAudio = false, safeStereo = false \} = \{\}\)/);
  assert.doesNotMatch(src, /sideSubs|sideSubtitleArgs/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /const subTap = mountSubtitleTap\(vf\);\s*\n\s*for await \(const chunk of vf\.read\(start, end, \{ priority: readPriority, signal: readSignal \}\)\) \{\s*\n\s*if \(subTap\) subTap\.feed\(start \+ sentBytes, chunk\);/,
    'the stream handler shows each chunk to the tap before sending it');
});

test('a hostile or broken size field never freezes the server (second check 3.5.7)', () => {
  // Each case runs in a child process: the old reader looped forever on these bytes, which would
  // stop the whole server's event loop (VOD, Live TV, API) on the first read of such a file.
  const probe = `
    const { MkvSubtitleTap, parseHeader } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'mkvsubs.js'))});
    const ebml = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x84, 0x42, 0x86, 0x81, 0x01]);
    const seg = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    const el = (id, body) => Buffer.concat([Buffer.from(id), Buffer.from([0x80 | body.length]), body]);
    const cases = {
      // TimecodeScale with an "unknown" (all ones) size.
      scaleUnknown: Buffer.concat([ebml, seg, el([0x15, 0x49, 0xA9, 0x66], Buffer.from([0x2A, 0xD7, 0xB1, 0xFF]))]),
      // TimecodeScale with an 8-byte size of 2^40.
      scaleHuge: Buffer.concat([ebml, seg, el([0x15, 0x49, 0xA9, 0x66], Buffer.from([0x2A, 0xD7, 0xB1, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]))]),
      // A TrackEntry whose TrackNumber claims 2^40 bytes.
      trackHuge: Buffer.concat([ebml, seg, el([0x16, 0x54, 0xAE, 0x6B], el([0xAE], Buffer.from([0xD7, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00])))]),
    };
    for (const [k, b] of Object.entries(cases)) {
      parseHeader(b);
      const tap = new MkvSubtitleTap(); tap.feed(0, b);
    }
    console.log('done');
  `;
  const r = spawnSync(process.execPath, ['-e', probe], { timeout: 10000, encoding: 'utf8' });
  assert.strictEqual(r.signal, null, 'the reader returned instead of looping forever');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /done/);
});

test('/api/filesub: a local file seek back reads the lines at the new picture (second check 3.5.7)', { skip: !ff && 'no ffmpeg' }, async () => {
  // 6 minutes at about 2 Mbit/s, so the 90 s read-ahead spans many 4 MB reads. An English line every 5 s.
  const lines = [];
  for (let i = 0; i < 72; i++) lines.push([i * 5 + 1, i * 5 + 3, `Long line ${i}`]);
  fs.writeFileSync(path.join(dir, 'long.srt'), srt(lines));
  const movie = path.join(dir, 'long.mkv');
  const r = spawnSync(ff.path, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24', '-i', path.join(dir, 'long.srt'), '-t', '360',
    '-map', '0', '-map', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2M', '-g', '48',
    '-c:s', 'srt', '-metadata:s:s:0', 'language=eng', movie]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const size = fs.statSync(movie).size;
  assert.ok(size > 40 * 1048576, `fixture is big enough (${size})`);
  const srv = await bootServer();
  try {
    await setupAdmin(srv.port);
    const uid = srv.auth._users().list[0].id;
    const tracks = { available: true, duration: 360, audio: [], subs: [{ rel: 0, codec: 'subrip', lang: 'eng', text: true }] };
    const id = 'fsubseekback';
    srv.mounts.set(id, { id, name: 'Long.mkv', size, streamable: true, mountedAt: Date.now(), _local: { file: movie }, _tracks: tracks });
    const t = srv.auth.streamToken(uid, id);
    const ask = (at) => httpJson(srv.port, 'GET', `/api/filesub/${id}/0?t=${t}&at=${at}`);
    const until = async (at, re) => {
      for (let n = 0; n < 40; n++) { const a = await ask(at); if (re.test(a.raw)) return true; await new Promise((ok) => setTimeout(ok, 250)); }
      return false;
    };
    // Resume at 5:00: the lines there arrive.
    assert.ok(await until(300, /00:05:01\.000 --> 00:05:03\.000\nLong line 60/), 'the lines at 5:00');
    // Seek back to 1:00: the lines at the new picture arrive too.
    assert.ok(await until(60, /00:01:01\.000 --> 00:01:03\.000\nLong line 12/), 'the lines at 1:00 after a seek back');
    assert.ok(await until(60, /00:01:46\.000 --> 00:01:48\.000\nLong line 21/), 'and the next minute and a half');
  } finally {
    await srv.shutdown();
  }
});

test('a compressed subtitle track is not read as text, and a track keeps at most 8 MB of lines (second check 3.5.7)', () => {
  const el = (id, body) => {
    const len = body.length;
    const size = len < 0x7F ? Buffer.from([0x80 | len]) : Buffer.from([0x40 | (len >> 8), len & 0xFF]);
    return Buffer.concat([Buffer.from(id), size, body]);
  };
  const ebml = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x84, 0x42, 0x86, 0x81, 0x01]);
  const seg = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  const entry = (num, compressed) => el([0xAE], Buffer.concat([
    el([0xD7], Buffer.from([num])), el([0x83], Buffer.from([0x11])), el([0x86], Buffer.from('S_TEXT/UTF8')),
    ...(compressed ? [el([0x6D, 0x80], el([0x62, 0x40], el([0x50, 0x34], el([0x42, 0x54], Buffer.from([0x00])))))] : []),
  ]));
  const head = Buffer.concat([ebml, seg, el([0x15, 0x49, 0xA9, 0x66], el([0x2A, 0xD7, 0xB1], Buffer.from([0x0F, 0x42, 0x40]))),
    el([0x16, 0x54, 0xAE, 0x6B], Buffer.concat([entry(1, false), entry(2, true)])), Buffer.from([0x1F, 0x43, 0xB6, 0x75, 0x80])]);
  const h = parseHeader(head);
  assert.ok(h && h.subs.length === 2);
  assert.strictEqual(h.subs[0].text, true, 'a plain SRT track is text');
  assert.strictEqual(h.subs[1].text, false, 'a zlib-compressed track goes online instead of showing junk');

  // A track's lines are capped by size, not only by count: 200 lines of 100 KB stop near 8 MB.
  const tap = new MkvSubtitleTap();
  tap.header = { scale: 1000000, duration: 0, subs: [{ index: 0, number: 1, codec: 'S_TEXT/UTF8', lang: 'eng', text: true }] };
  for (let i = 0; i < 200; i++) {
    const block = Buffer.concat([Buffer.from([0x81, 0x00, 0x00, 0x00]), Buffer.from(`line ${i} `.padEnd(100 * 1024, 'x'))]);
    tap._textBlock(0xA3, block, i * 1000, 0);
  }
  const kept = [...tap.cues.get(0).values()].reduce((n, c) => n + c.text.length, 0);
  assert.ok(kept <= 8 * 1048576 + 100 * 1024, `kept ${kept} bytes`);
  assert.ok(kept >= 7 * 1048576, 'and up to the cap');
});
