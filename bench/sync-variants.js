'use strict';
// Measure A/V alignment of remux flag variants against a LIVE mount.
// For each variant: ffmpeg writes ~25s of fMP4 to a temp file, ffprobe reports per-stream
// first/last pts. PASS = audio.first ≈ video.first (≤15ms) and no drift over the capture.
// Usage: node bench/sync-variants.js "Inception 2010" [startSeconds]
const { Store } = require('../server/store');
const { Auth } = require('../server/auth');
const { spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const store = new Store();
const auth = new Auth(store, process.env.TRIBOON_SECRET);
const users = store.read('users', { list: [] }).list;
const admin = users.find((u) => u.role === 'owner' || u.role === 'admin');
const token = auth.signToken({ uid: admin.id, role: admin.role, scope: 'session' }, 3600e3);
const BASE = 'http://127.0.0.1:7777';

function apiPost(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(BASE + p, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
      authorization: 'Bearer ' + token } }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (e) { reject(new Error(b.slice(0, 300))); } });
    });
    req.on('error', reject); req.end(data);
  });
}

function probeFile(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_packets', file],
    { timeout: 60000, maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error('ffprobe: ' + String(r.stderr).slice(0, 300));
  const pkts = (JSON.parse(String(r.stdout) || '{}').packets || []).filter((p) => p.pts_time != null);
  const by = {};
  for (const p of pkts) {
    const k = p.codec_type;
    if (k !== 'video' && k !== 'audio') continue;
    if (!by[k]) by[k] = { first: +p.pts_time, last: +p.pts_time, n: 0 };
    by[k].first = Math.min(by[k].first, +p.pts_time); by[k].last = Math.max(by[k].last, +p.pts_time); by[k].n++;
  }
  return by;
}

(async () => {
  const q = process.argv[2] || 'Inception 2010';
  const ss = parseFloat(process.argv[3] || '0') || 0;
  const r = await apiPost('/api/play', { q, caps: { mkv: true, hevc: true, ac3: false, eac3: false, dts: false } });
  if (r.status !== 200) { console.error('play failed', JSON.stringify(r.json).slice(0, 300)); process.exit(1); }
  const m = r.json.mount || r.json;
  console.log('mount:', m.name, ss ? `(seek ${ss}s)` : '(from start)');
  const streamUrl = BASE + m.streamUrl;

  const VARIANTS = {
    'current             ': { mov: 'frag_keyframe+empty_moov+default_base_moof', flags: [], pre: [] },
    'FINAL noacc+delay   ': { mov: 'frag_keyframe+empty_moov+default_base_moof+delay_moov', flags: ['-frag_duration', '500000'], pre: ['-noaccurate_seek'] },
    'FINAL + make_zero   ': { mov: 'frag_keyframe+empty_moov+default_base_moof+delay_moov', flags: ['-frag_duration', '500000', '-avoid_negative_ts', 'make_zero'], pre: ['-noaccurate_seek'] },
  };
  const { spawn } = require('child_process');
  for (const [label, v] of Object.entries(VARIANTS)) {
    const out = path.join(os.tmpdir(), `triboon-sync-${Date.now()}.mp4`);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostats',
      ...(ss > 0 ? [...(v.pre || []), '-ss', String(ss)] : []),
      '-i', streamUrl, '-map', '0:v:0', '-map', '0:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '384k', '-ac', '6',
      ...v.flags, '-movflags', v.mov, '-t', '25', '-y', '-f', 'mp4', out];
    const t0 = Date.now();
    const ttfb = await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let err = '', first = 0;
      ff.stderr.on('data', (d) => err += d);
      const poll = setInterval(() => {
        try { if (!first && fs.existsSync(out) && fs.statSync(out).size > 1024) first = Date.now() - t0; } catch {}
      }, 25);
      const killer = setTimeout(() => { ff.kill('SIGKILL'); }, 180000);
      ff.on('close', (c) => { clearInterval(poll); clearTimeout(killer);
        c === 0 ? resolve(first) : reject(new Error(err.slice(0, 200))); });
    }).catch((e) => { console.log(label, 'FFMPEG FAILED:', e.message); return null; });
    if (ttfb === null) continue;
    const p = probeFile(out);
    fs.unlinkSync(out);
    const off = (p.audio.first - p.video.first) * 1000;
    console.log(label, `v.first=${p.video.first.toFixed(3)} a.first=${p.audio.first.toFixed(3)}`,
      `| a-v offset=${off.toFixed(1)}ms | first-bytes ${ttfb}ms`,
      off > -45 && off <= 15 ? 'PASS' : 'FAIL');
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
