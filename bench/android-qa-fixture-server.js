'use strict';

// Deterministic, credential-free Android playback fixture. It provides two local Newznab
// quality classes, a mock NNTP provider, and a 32-channel M3U backed by seekable MP4 media.
// Real user settings/data are never read. Configure an isolated Triboon data directory to use:
//   provider 127.0.0.1:53159 (no TLS/auth)
//   indexer  http://127.0.0.1:60993
//   M3U      http://127.0.0.1:60993/playlist.m3u

const fs = require('fs');
const http = require('http');
const path = require('path');
const { encodePart } = require('../server/yenc');
const { createMockNntp } = require('../test/mock-nntp');

const root = path.resolve(__dirname, '..');
const httpPort = Number(process.env.TRIBOON_QA_HTTP_PORT || 60993);
const nntpPort = Number(process.env.TRIBOON_QA_NNTP_PORT || 53159);
const hdPath = path.resolve(process.env.TRIBOON_QA_HD_MEDIA || path.join(root, 'tmp', 'windows-smoke-1080-dual-long.mp4'));
const uhdPath = path.resolve(process.env.TRIBOON_QA_UHD_MEDIA || path.join(root, 'tmp', 'windows-smoke-4k-long.mp4'));
const partSize = Math.max(256 * 1024, Number(process.env.TRIBOON_QA_PART_BYTES || 4 * 1024 * 1024));

for (const file of [hdPath, uhdPath]) {
  if (!fs.existsSync(file)) throw new Error(`Missing QA media fixture: ${file}`);
}

function xml(value) {
  return String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function releaseFromFile(file, name, prefix) {
  const data = fs.readFileSync(file);
  const articles = new Map();
  const segments = [];
  const totalParts = Math.ceil(data.length / partSize);
  for (let index = 0; index < totalParts; index++) {
    const begin = index * partSize;
    const end = Math.min(data.length, begin + partSize);
    const messageId = `${prefix}-${index + 1}@qa.triboon.local`;
    const body = encodePart(data, {
      name,
      partNum: index + 1,
      totalParts,
      begin,
      end,
      totalSize: data.length,
    });
    articles.set(messageId, body);
    segments.push(`<segment bytes="${body.length}" number="${index + 1}">${messageId}</segment>`);
  }
  const nzb = `<?xml version="1.0" encoding="utf-8"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file poster="triboon-qa" date="1700000000" subject="[qa] &quot;${xml(name)}&quot; yEnc (1/${totalParts})"><groups><group>alt.binaries.triboon.qa</group></groups><segments>${segments.join('')}</segments></file></nzb>`;
  return { nzb, articles, size: data.length };
}

const hd = releaseFromFile(hdPath, 'Triboon.QA.Movie.2025.1080p.WEB-DL.DDP5.1.H.264-NTb.mp4', 'qa-hd');
const uhd = releaseFromFile(uhdPath, 'Triboon.QA.Movie.2025.2160p.WEB-DL.DDP5.1.HEVC-FLUX.mp4', 'qa-uhd');
const articles = new Map([...hd.articles, ...uhd.articles]);
const nntp = createMockNntp({ articles });

const releases = [
  { name: 'The.Lord.of.the.Rings.The.Fellowship.of.the.Ring.2001.1080p.WEB-DL.H.264-NTb', size: 6_000_000_000, nzb: hd.nzb },
  { name: 'The.Lord.of.the.Rings.The.Fellowship.of.the.Ring.2001.2160p.WEB-DL.HEVC-FLUX', size: 16_000_000_000, nzb: uhd.nzb },
  { name: 'Triboon.QA.Movie.2025.1080p.WEB-DL.DDP5.1.H.264-NTb', size: 6_000_000_000, nzb: hd.nzb },
  { name: 'Triboon.QA.Movie.2025.2160p.WEB-DL.DDP5.1.HEVC-FLUX', size: 16_000_000_000, nzb: uhd.nzb },
];

function rss() {
  const items = releases.map((release, index) => `<item><title>${xml(release.name)}</title><guid>triboon-qa-${index}</guid><enclosure url="http://127.0.0.1:${httpPort}/nzb/${index}" length="${release.size}" type="application/x-nzb"/></item>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><title>Triboon QA</title>${items}</channel></rss>`;
}

function playlist() {
  const lines = ['#EXTM3U'];
  for (let i = 1; i <= 32; i++) {
    lines.push(`#EXTINF:-1 tvg-id="qa-${i}" tvg-name="Triboon QA ${i}" group-title="QA",Triboon QA ${i}`);
    lines.push(`http://127.0.0.1:${httpPort}/live/1080.mp4?channel=${i}`);
  }
  return `${lines.join('\n')}\n`;
}

function sendFile(req, res, file) {
  const stat = fs.statSync(file);
  const range = /^bytes=(\d*)-(\d*)$/i.exec(req.headers.range || '');
  let start = 0;
  let end = stat.size - 1;
  if (range) {
    if (range[1]) start = Number(range[1]);
    if (range[2]) end = Math.min(end, Number(range[2]));
    if (!range[1] && range[2]) start = Math.max(0, stat.size - Number(range[2]));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
  }
  const headers = {
    'accept-ranges': 'bytes',
    'content-type': 'video/mp4',
    'content-length': end - start + 1,
    'cache-control': 'no-store',
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

const api = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${httpPort}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, releases: releases.length, channels: 32 }));
  }
  if (url.pathname === '/api') {
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
    return res.end(rss());
  }
  const nzbMatch = /^\/nzb\/(\d+)$/.exec(url.pathname);
  if (nzbMatch && releases[Number(nzbMatch[1])]) {
    res.writeHead(200, { 'content-type': 'application/x-nzb; charset=utf-8' });
    return res.end(releases[Number(nzbMatch[1])].nzb);
  }
  if (url.pathname === '/playlist.m3u') {
    res.writeHead(200, { 'content-type': 'audio/x-mpegurl; charset=utf-8' });
    return res.end(playlist());
  }
  if (url.pathname === '/live/1080.mp4') return sendFile(req, res, hdPath);
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function close() {
  await Promise.allSettled([
    new Promise((resolve) => api.close(resolve)),
    nntp.close(),
  ]);
}

process.on('SIGINT', () => close().finally(() => process.exit(0)));
process.on('SIGTERM', () => close().finally(() => process.exit(0)));

(async () => {
  await listen(nntp.server, nntpPort);
  await listen(api, httpPort);
  process.stdout.write(`Triboon Android QA fixture ready: HTTP ${httpPort}, NNTP ${nntpPort}, ${articles.size} articles\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
