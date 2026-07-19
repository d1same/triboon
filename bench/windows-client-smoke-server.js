'use strict';

// Local-only native Windows client harness. It exercises the real remote-origin bridge, HTTP
// ranges, non-zero Continue Watching, subtitles, an EOF-to-next handoff, and a 4K second item
// without requiring an owner's Triboon account or credentials.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const host = '127.0.0.1';
const port = Number(process.env.TRIBOON_WINDOWS_SMOKE_PORT || 17888);
const media1080 = path.resolve(process.env.TRIBOON_WINDOWS_SMOKE_1080 || 'tmp/windows-smoke-1080.mp4');
const media4k = path.resolve(process.env.TRIBOON_WINDOWS_SMOKE_4K || 'tmp/windows-smoke-4k.mp4');
const duration = Math.max(4, Math.min(600, Number(process.env.TRIBOON_WINDOWS_SMOKE_DURATION || 8)));
const automate = process.env.TRIBOON_WINDOWS_SMOKE_AUTOMATE === '1';
const events = [];

function record(type, data) {
  events.push({ type, at: Date.now(), ...(data && typeof data === 'object' ? data : {}) });
  if (events.length > 500) events.splice(0, events.length - 500);
}

for (const file of [media1080, media4k]) {
  if (!fs.existsSync(file)) throw new Error(`Missing smoke fixture: ${file}`);
}

function sendFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(req.headers.range || '');
  if (!match) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(file).pipe(res);
  }
  const start = match[1] ? Math.min(size - 1, Number(match[1])) : 0;
  const end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
  });
  return fs.createReadStream(file, { start, end }).pipe(res);
}

const page = `<!doctype html><meta charset="utf-8"><title>Triboon Windows smoke</title>
<style>body{font:16px system-ui;background:#08060d;color:#fff;padding:32px}code{color:#fb8b3c}</style>
<h1>Triboon Windows native smoke</h1><p id="status">Waiting for the guarded Windows bridge...</p>
<script>
(() => {
  const status = document.getElementById('status');
  let token = 4100;
  let started = false;
  let advanced = false;
  let automationStarted = false;
  const automate = ${automate ? 'true' : 'false'};
  const report = (type, data) => fetch('/smoke-event', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...(data || {}) })
  }).catch(() => {});
  const payload = (fourK) => ({
    title: fourK ? 'Smoke Episode 2 - 4K' : 'Smoke Episode 1 - 1080p',
    episodeLabel: fourK ? 'S01 E02 - Direct handoff' : 'S01 E01 - Continue Watching',
    source: 'Local range fixture',
    url: location.origin + (fourK ? '/api/stream/smoke-4k?t=smoke' : '/api/stream/smoke-1080?t=smoke'),
    start: fourK ? 0 : 2,
    startOffset: 0,
    kind: 'direct',
    mime: 'video/mp4',
    qualityLabel: fourK ? '4K HEVC' : '1080p H.264',
    duration: ${JSON.stringify(duration)},
    bufferGoalSec: 12,
    playbackToken: ++token,
    qualityChoices: true,
    hasNext: !fourK,
    subtitleRel: 'smoke:en',
    subtitleUrl: location.origin + '/api/subtitle/smoke?t=smoke',
    subtitleLang: 'en',
    subtitleLabel: 'English smoke captions',
    subtitleShift: 0,
    subtitleSize: 'M',
    subtitleChoices: [{
      rel: 'smoke:en', label: 'English smoke captions', lang: 'en', shift: 0, size: 'M',
      url: location.origin + '/api/subtitle/smoke?t=smoke'
    }],
    episodeChoices: [
      { index: 0, tag: 'S01 E01', name: 'Continue Watching', current: !fourK },
      { index: 1, tag: 'S01 E02', name: '4K handoff', current: fourK }
    ]
  });
  const play = (fourK) => {
    const request = payload(fourK);
    status.textContent = 'Starting ' + request.title;
    window.TriboonTV.playVideo(JSON.stringify(request));
  };
  window.__tvNativeVideoReady = (pos, duration, playbackToken) => {
    status.textContent = 'READY token=' + playbackToken + ' position=' + Number(pos).toFixed(1);
    report('ready', { pos, duration, playbackToken });
    if (automate && !automationStarted) {
      automationStarted = true;
      setTimeout(() => window.TriboonTV.pause(), 250);
      setTimeout(() => window.TriboonTV.play(), 750);
      setTimeout(() => window.TriboonTV.seekBy(10), 1200);
      setTimeout(() => {
        report('select-audio', { id: '2' });
        window.TriboonTV.selectAudio('2');
      }, 1700);
      // Leave enough time for the next native stats sample to confirm the selected track before
      // replacing the session with the 4K episode.
      setTimeout(() => window.TriboonTV.nextEpisode(), 4500);
    }
  };
  window.__tvNativeVideoProgress = (pos, duration, playbackToken) => {
    status.textContent = 'PLAYING token=' + playbackToken + ' position=' + Number(pos).toFixed(1);
    report('progress', { pos, duration, playbackToken });
  };
  window.__tvNativeVideoPlaying = (pos, duration, playbackToken) => report('playing', { pos, duration, playbackToken });
  window.__tvNativeVideoPaused = (pos, duration, playbackToken) => report('paused', { pos, duration, playbackToken });
  window.__tvNativeVideoStats = (raw, playbackToken) => {
    let stats = {}; try { stats = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
    report('stats', { playbackToken, stats });
  };
  window.__tvNativeVideoNext = () => {
    report('next');
    if (!advanced) { advanced = true; play(true); }
  };
  window.__tvNativeVideoEnded = (pos, duration, playbackToken) => {
    report('ended', { pos, duration, playbackToken });
    if (!advanced) { advanced = true; play(true); }
  };
  window.__tvNativeVideoClosed = () => { status.textContent = 'CLOSED'; report('closed'); };
  window.__tvNativeVideoError = (message) => { status.textContent = 'ERROR ' + message; report('error', { message }); };
  const timer = setInterval(() => {
    if (started || !window.TriboonTV || typeof window.TriboonTV.playVideo !== 'function') return;
    started = true;
    clearInterval(timer);
    play(false);
  }, 50);
})();
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  if (url.pathname === '/smoke-event' && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { if (body.length < 16384) body += chunk; });
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        record(String(event.type || 'page'), event);
      } catch { record('invalid-page-event'); }
      res.writeHead(204).end();
    });
    return;
  }
  if (url.pathname === '/smoke-events') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(events));
  }
  if (url.pathname === '/api/server') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ version: '2.8.0', needsSetup: false }));
  }
  if (url.pathname === '/api/stream/smoke-1080') {
    record('request-1080', { range: req.headers.range || '' });
    return sendFile(req, res, media1080, 'video/mp4');
  }
  if (url.pathname === '/api/stream/smoke-4k') {
    record('request-4k', { range: req.headers.range || '' });
    return sendFile(req, res, media4k, 'video/mp4');
  }
  if (url.pathname === '/api/subtitle/smoke') {
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
    const end = new Date((duration - 0.5) * 1000).toISOString().slice(11, 23);
    return res.end('WEBVTT\n\n00:00:00.000 --> ' + end + '\nTriboon Windows subtitle smoke test\n');
  }
  if (url.pathname === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'",
      'Cache-Control': 'no-store',
    });
    return res.end(page);
  }
  res.writeHead(404).end('not found');
});

server.listen(port, host, () => {
  console.log(`Triboon Windows smoke server: http://${host}:${port}`);
  console.log(`1080p: ${media1080}`);
  console.log(`4K: ${media4k}`);
});
