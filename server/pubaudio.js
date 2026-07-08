'use strict';
// Public-domain audiobook sources — LibriVox + Internet Archive. Free, legal, and directly
// streamable (the app's CSP allows https media, so the client plays the chapter MP3s straight from
// archive.org). Complements the usenet path for classics. search() returns lightweight items;
// tracks() returns the per-chapter MP3 playlist that the existing multi-file player consumes.
const { fetchUrl } = require('./newznab');

const ALLOWED_HOSTS = /(^|\.)archive\.org$|(^|\.)librivox\.org$/i;
function isAllowedPubUrl(u) {
  try { const url = new URL(u); return /^https?:$/.test(url.protocol) && ALLOWED_HOSTS.test(url.hostname); }
  catch { return false; }
}
function naturalKey(name) { return String(name || '').toLowerCase().replace(/\d+/g, (n) => n.padStart(8, '0')); }

async function getJson(url, timeoutMs = 8000) {
  const r = await fetchUrl(url, { timeoutMs, deadlineMs: timeoutMs + 5000 });
  if (r.status !== 200) { const e = new Error(`pubaudio upstream ${r.status}`); e.status = 502; throw e; }
  try { return JSON.parse(r.body.toString('utf8')); }
  catch { const e = new Error('pubaudio upstream returned non-JSON'); e.status = 502; throw e; }
}

function lvAuthor(a) { return a ? [a.first_name, a.last_name].filter(Boolean).join(' ').trim() : ''; }

// ---- LibriVox ----
async function searchLibrivox(q, limit = 8) {
  const url = `https://librivox.org/api/feed/audiobooks/?title=^${encodeURIComponent(q)}&format=json&limit=${limit}`;
  let data; try { data = await getJson(url); } catch { return []; }
  const books = Array.isArray(data && data.books) ? data.books : [];
  return books.map((b) => ({
    source: 'librivox', id: String(b.id),
    title: String(b.title || '').trim(),
    authors: (b.authors || []).map(lvAuthor).filter(Boolean),
    cover: null,
    runtimeSec: Number(b.totaltimesecs) || null,
  })).filter((x) => x.title && x.id);
}
async function librivoxTracks(id) {
  const url = `https://librivox.org/api/feed/audiobooks/?id=${encodeURIComponent(String(id).replace(/[^0-9]/g, ''))}&format=json&extended=1`;
  const data = await getJson(url, 12000);
  const b = data && data.books && data.books[0];
  const sections = (b && b.sections) || [];
  return sections
    .filter((s) => s && s.listen_url && isAllowedPubUrl(s.listen_url))
    .map((s, i) => ({ index: i, name: String(s.title || `Chapter ${i + 1}`), url: String(s.listen_url), durationSec: Number(s.playtime) || null }));
}

// Browse LibriVox by genre — for discovery rows of guaranteed-available, free public-domain classics
// (no per-title availability check needed; everything here streams).
async function browseLibrivox(genre, limit = 20) {
  const url = `https://librivox.org/api/feed/audiobooks/?genre=^${encodeURIComponent(genre)}&format=json&limit=${limit}&coverart=1`;
  let data; try { data = await getJson(url, 12000); } catch { return []; }
  const books = Array.isArray(data && data.books) ? data.books : [];
  return books.map((b) => ({
    source: 'librivox', id: String(b.id),
    title: String(b.title || '').trim(),
    authors: (b.authors || []).map(lvAuthor).filter(Boolean),
    cover: (b.coverart_jpg && isAllowedPubUrl(b.coverart_jpg)) ? b.coverart_jpg
      : (b.coverart_thumbnail && isAllowedPubUrl(b.coverart_thumbnail)) ? b.coverart_thumbnail : null,
  })).filter((x) => x.title && x.id);
}

// ---- Internet Archive (librivoxaudio collection) ----
async function searchArchive(q, limit = 8) {
  const query = `collection:librivoxaudio AND title:(${q})`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=creator&rows=${limit}&output=json`;
  let data; try { data = await getJson(url); } catch { return []; }
  const docs = (data && data.response && data.response.docs) || [];
  return docs.map((d) => ({
    source: 'archive', id: String(d.identifier),
    title: String(d.title || '').trim(),
    authors: [].concat(d.creator || []).filter(Boolean).map(String),
    cover: `https://archive.org/services/img/${encodeURIComponent(String(d.identifier))}`,
    runtimeSec: null,
  })).filter((x) => x.title && x.id);
}
async function archiveTracks(id) {
  const data = await getJson(`https://archive.org/metadata/${encodeURIComponent(id)}`, 12000);
  const files = (data && data.files) || [];
  const mp3 = files.filter((f) => /mp3/i.test(f.format || '') || /\.mp3$/i.test(f.name || ''));
  // Pick ONE clean bitrate set so we don't list the same chapter 3× (64Kbps → VBR → any).
  const pick = (fmt) => mp3.filter((f) => (f.format || '').toLowerCase().includes(fmt));
  let set = pick('64kbps'); if (!set.length) set = pick('vbr'); if (!set.length) set = mp3;
  set.sort((a, b) => naturalKey(a.name).localeCompare(naturalKey(b.name)));
  return set.map((f, i) => ({
    index: i, name: String(f.title || f.name),
    url: `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(f.name)}`,
    durationSec: Number(f.length) || null,
  }));
}

// ---- combined ----
async function search(q, limit = 6) {
  const query = String(q || '').trim();
  if (!query) return [];
  const [lv, ar] = await Promise.all([
    searchLibrivox(query, limit).catch(() => []),
    searchArchive(query, limit).catch(() => []),
  ]);
  // LibriVox is the cleaner source; drop Archive items whose title we already have from LibriVox.
  const seen = new Set(lv.map((x) => x.title.toLowerCase()));
  return [...lv, ...ar.filter((x) => !seen.has(x.title.toLowerCase()))].slice(0, limit * 2);
}
async function tracks(source, id) {
  if (source === 'librivox') return librivoxTracks(id);
  if (source === 'archive') return archiveTracks(id);
  const e = new Error('unknown source'); e.status = 400; throw e;
}

module.exports = { search, tracks, browseLibrivox, isAllowedPubUrl, searchLibrivox, searchArchive, librivoxTracks, archiveTracks, naturalKey };
