'use strict';

// Optional store-review demo seeder — activates ONLY when TRIBOON_STORE_DEMO=1.
// Creates an isolated, 100% copyright-free CC-BY Blender Open Movies library
// (Tears of Steel, Sintel, Big Buck Bunny) and a non-admin read-only reviewer
// account so app-store reviewers (Roku, Apple, Google, Amazon, LG) can test
// sign-in, browsing, deep linking, and direct MP4 playback without private data.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const UA = { 'User-Agent': 'TriboonStoreDemo/1.0 (https://github.com/d1same/triboon)' };

const OPEN_MOVIES = [
  {
    folder: 'Tears of Steel (2012)',
    title: 'Tears of Steel',
    year: 2012,
    rating: 6.9,
    runtime: 12,
    genres: ['Sci-Fi', 'Action', 'Short'],
    plot: 'In a futuristic Amsterdam, a group of warriors and scientists gather at the Oude Kerk to stage a crucial event from the past in a desperate attempt to rescue the world from destructive robots. Creative Commons Attribution 3.0 (Blender Foundation).',
    posterFile: 'File:Tos-poster.png',
    backdropFile: 'File:Tears of Steel frame 09 1a.jpg',
    color: '#1b263b',
  },
  {
    folder: 'Sintel (2010)',
    title: 'Sintel',
    year: 2010,
    rating: 7.8,
    runtime: 15,
    genres: ['Animation', 'Fantasy', 'Adventure'],
    plot: 'A lonely young woman journeys across harsh lands in search of Scales, a baby dragon she befriended and lost. Creative Commons Attribution 3.0 (Blender Foundation).',
    posterFile: 'File:Sintel Poster Paintover clean.jpg',
    backdropFile: 'File:Sintel Poster Paintover clean.jpg',
    color: '#2b192e',
  },
  {
    folder: 'Big Buck Bunny (2008)',
    title: 'Big Buck Bunny',
    year: 2008,
    rating: 7.4,
    runtime: 10,
    genres: ['Animation', 'Comedy', 'Family'],
    plot: 'A gentle giant rabbit enjoys a peaceful morning in the forest until three mischievous rodents push his patience too far. Creative Commons Attribution 3.0 (Blender Foundation).',
    posterFile: 'File:Big buck bunny poster big.jpg',
    backdropFile: 'File:Big buck bunny poster big.jpg',
    color: '#162d24',
  },
];

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 60000 }, (err, _out, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

function buildMovieNfo(m) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const genres = m.genres.map((g) => `  <genre>${esc(g)}</genre>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<movie>',
    `  <title>${esc(m.title)}</title>`,
    `  <year>${m.year}</year>`,
    `  <rating>${m.rating}</rating>`,
    `  <runtime>${m.runtime}</runtime>`,
    `  <plot>${esc(m.plot)}</plot>`,
    genres,
    '</movie>',
    '',
  ].join('\n');
}

async function fetchCommonsThumbUrl(fileTitle, width) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&titles='
    + encodeURIComponent(fileTitle)
    + `&prop=imageinfo&iiprop=url|mime&iiurlwidth=${width}&format=json`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12000) });
  if (!res.ok) return null;
  const data = await res.json();
  const page = Object.values((data.query && data.query.pages) || {})[0];
  const ii = page && page.imageinfo && page.imageinfo[0];
  return ii ? (ii.thumburl || ii.url) : null;
}

async function downloadToJpg(url, dest) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${dest}.raw`;
  fs.writeFileSync(tmp, buf);
  try {
    await runFfmpeg(['-y', '-loglevel', 'error', '-i', tmp, '-q:v', '3', dest]);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function ensureFallbackJpg(dest, w, h, color) {
  await runFfmpeg([
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}:d=1`,
    '-frames:v', '1', '-q:v', '3', dest,
  ]);
}

async function ensureDemoMovie(mediaDir, m) {
  const dir = path.join(mediaDir, m.folder);
  fs.mkdirSync(dir, { recursive: true });
  const posterPath = path.join(dir, 'poster.jpg');
  const fanartPath = path.join(dir, 'fanart.jpg');
  const nfoPath = path.join(dir, `${m.folder}.nfo`);
  const mp4Path = path.join(dir, `${m.folder}.mp4`);

  if (!fs.existsSync(nfoPath)) {
    fs.writeFileSync(nfoPath, buildMovieNfo(m), 'utf8');
  }
  if (!fs.existsSync(posterPath)) {
    try {
      const pUrl = await fetchCommonsThumbUrl(m.posterFile, 600);
      if (pUrl) await downloadToJpg(pUrl, posterPath);
    } catch {}
    if (!fs.existsSync(posterPath)) await ensureFallbackJpg(posterPath, 600, 900, m.color);
  }
  if (!fs.existsSync(fanartPath)) {
    try {
      const bUrl = await fetchCommonsThumbUrl(m.backdropFile, 1280);
      if (bUrl) await downloadToJpg(bUrl, fanartPath);
    } catch {}
    if (!fs.existsSync(fanartPath)) await ensureFallbackJpg(fanartPath, 1280, 720, m.color);
  }
  if (!fs.existsSync(mp4Path)) {
    // 45s 720p H.264/AAC MP4 with gentle stereo sine tone + faststart: instant Direct Play on Roku/Apple/Android/Web.
    await runFfmpeg([
      '-y', '-loglevel', 'error',
      '-loop', '1', '-i', fanartPath,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=45',
      '-t', '45', '-r', '24',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720',
      '-c:v', 'libx264', '-profile:v', 'main', '-level', '3.1', '-preset', 'ultrafast', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-af', 'volume=0.05',
      '-shortest', '-movflags', '+faststart',
      mp4Path,
    ]);
  }
}

async function seedStoreDemo({ dataDir, auth, store, performScan, scanStates }) {
  const mediaDir = path.join(dataDir, 'demo-media');
  fs.mkdirSync(mediaDir, { recursive: true });
  console.log('[demo-seed] Preparing copyright-free Open Movies demo library...');

  for (const m of OPEN_MOVIES) {
    await ensureDemoMovie(mediaDir, m);
  }

  // Ensure an internal locked admin exists first so setup screen is bypassed and
  // store reviewers only ever sign into the non-admin read-only reviewer account.
  if (!auth.hasUsers()) {
    const adminPass = crypto.randomBytes(24).toString('base64url');
    auth.createUser({ name: 'demo-admin', password: adminPass, role: 'admin' });
  }

  const demoUser = String(process.env.TRIBOON_DEMO_USER || 'reviewer@triboon.tv').trim();
  const demoPass = String(process.env.TRIBOON_DEMO_PASS || 'TriboonDemo2026!').trim();
  try {
    auth.createUser({ name: demoUser, password: demoPass, role: 'user' });
    console.log(`[demo-seed] Created read-only reviewer account: ${demoUser}`);
  } catch (e) {
    if (!/already exists/i.test(String(e && e.message))) throw e;
  }

  let demoLib = null;
  store.update('libraries', { list: [] }, (s) => {
    const existing = (s.list || []).find((l) => l && l.id === 'openmovies');
    if (existing) {
      existing.path = mediaDir;
      existing.tmdbMatch = 'local';
      demoLib = existing;
    } else {
      demoLib = {
        id: 'openmovies',
        name: 'Open Movies',
        kind: 'movie',
        mediaType: 'movie',
        path: mediaDir,
        icon: 'movie',
        users: [],
        tmdbMatch: 'local',
        createdAt: Date.now(),
      };
      s.list = [...(s.list || []), demoLib];
    }
    return s;
  });

  if (demoLib && typeof performScan === 'function') {
    const state = { running: true, startedAt: Date.now(), progress: 0, mode: 'scan' };
    if (scanStates) scanStates.set(demoLib.id, state);
    const sum = await performScan(demoLib, state, 'scan');
    if (scanStates) scanStates.set(demoLib.id, { running: false, finishedAt: Date.now(), mode: 'scan', ...sum });
    console.log(`[demo-seed] Open Movies ready (${(sum && sum.count) || OPEN_MOVIES.length} items scanned)`);
  }
  return { demoUser, libId: 'openmovies', mediaDir };
}

module.exports = {
  OPEN_MOVIES,
  buildMovieNfo,
  seedStoreDemo,
};
