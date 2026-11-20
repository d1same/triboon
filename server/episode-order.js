'use strict';
// TMDB episode numbers vs release (scene/TVDB) numbers (brief 127).
//
// Releases are numbered the way TVDB airs a show. TMDB sometimes merges an hour-long two-parter into
// one episode (The Office S06E04 "Niagara" is release S06E04 + S06E05), or splits differently. From
// that point every number is off: TMDB S06E15 "The Manager and the Salesman" is release S06E16, and
// release S06E15 is "Sabre" (TMDB S06E14). Play by number alone fetched the wrong episode.
//
// Two sources, both only used when they show a difference (every other show takes today's path):
//  1. A TMDB episode group of type 1 ("Original air date"): each listed episode's `order` + 1 is its
//     release number, and the merged TMDB episodes are left out, so they fill the gaps (two each).
//  2. The release names themselves: "S06E15.Sabre" names TMDB S06E14, so release E15 is not TMDB E15.
// Everything here is pure; index.js fetches the TMDB data and pipeline.js applies the evidence.

const ARTICLES = new Set(['the', 'a', 'an']);
const PART_WORDS = new Set(['part', 'pt', 'pts', 'parts', 'and']);

function fold(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}
// "The Manager and the Salesman" → ['manager', 'and', 'salesman']; "Niagara (1)" → ['niagara'].
// Articles go, and so do the part markers, so "Dunder Mifflin Infinity Part 1" is the same words as
// TMDB's merged "Dunder Mifflin Infinity".
function titleWords(title) {
  const words = fold(title).toLowerCase().replace(/['’`]/g, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (ARTICLES.has(w)) continue;
    // A trailing "part 1", "pt 2", "1", "2" (or "1 and 2") is a part marker, not the title.
    if ((PART_WORDS.has(w) || /^\d{1,2}$/.test(w) || /^(i|ii|iii)$/.test(w))
      && words.slice(i).every((x) => PART_WORDS.has(x) || /^\d{1,2}$/.test(x) || /^(i|ii|iii)$/.test(x))) break;
    out.push(w);
  }
  return out;
}

// Pick the episode group that gives the release numbering: type 1 ("Original air date"). With several,
// the one listing the most episodes.
function pickAirOrderGroup(groups) {
  const list = (Array.isArray(groups) ? groups : (groups && groups.results) || [])
    .filter((g) => g && g.id && Number(g.type) === 1 && Number(g.episode_count) > 0);
  if (!list.length) return null;
  list.sort((a, b) => Number(b.episode_count) - Number(a.episode_count));
  return String(list[0].id);
}

function medianOf(nums) {
  const s = nums.filter((n) => n > 0).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// For one season: Map TMDB episode → release episode numbers ([16], or [4, 5] for a merged two-parter),
// or null when the group gives no usable difference.
//   tmdbEpisodes: TMDB /tv/{id}/season/{s} `episodes` ({ episode_number, runtime, name }).
//   group: the TMDB episode group document (`groups[].episodes[]` with season_number, episode_number, order).
function releaseNumbering(tmdbEpisodes, group, season) {
  const s = Number(season);
  const eps = (Array.isArray(tmdbEpisodes) ? tmdbEpisodes : [])
    .map((x) => ({ e: Number(x && x.episode_number), runtime: Number(x && x.runtime) || 0 }))
    .filter((x) => Number.isInteger(x.e) && x.e > 0)
    .sort((a, b) => a.e - b.e);
  if (eps.length < 2 || !group || !Array.isArray(group.groups)) return null;
  // The group's part for this season: the one whose episodes are (mostly) this TMDB season.
  let best = null;
  let bestMixed = false;
  for (const g of group.groups) {
    const all = g && Array.isArray(g.episodes) ? g.episodes : [];
    const rows = all.filter((x) => Number(x.season_number) === s);
    if (rows.length && (!best || rows.length > best.length)) { best = rows; bestMixed = rows.length !== all.length; }
  }
  // A part that mixes in other seasons' episodes (specials between episodes, a moved episode) does
  // not give this season's release numbers: its slots count the others too.
  if (!best || best.length < 2 || bestMixed) return null;
  const known = new Map();
  for (const row of best) {
    const e = Number(row.episode_number), slot = Number(row.order) + 1;
    if (!Number.isInteger(e) || !Number.isInteger(slot) || slot < 1) return null;
    if (known.has(e)) return null;
    known.set(e, slot);
  }
  // Release numbers must rise with TMDB numbers; anything else is a different order (DVD, story arc).
  const knownSorted = [...known.entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < knownSorted.length; i++) if (knownSorted[i][1] <= knownSorted[i - 1][1]) return null;
  const single = medianOf(eps.filter((x) => known.has(x.e)).map((x) => x.runtime));
  const slotsFor = (x) => (single > 0 && x.runtime >= single * 1.6 ? 2 : 1);
  const map = new Map();
  let prevSlot = 0;
  let i = 0;
  // Every jump in the slots must be explained by TMDB episodes the group left out (a merged
  // two-parter fills two). An unexplained jump — a flat whole-show numbering (S06E01 at slot 101),
  // a special or an extra in between — means the group is not this season's release order: no
  // translation at all for the season, never a guess.
  while (i < eps.length) {
    const x = eps[i];
    if (known.has(x.e)) {
      if (known.get(x.e) !== prevSlot + 1) return null;
      map.set(x.e, [known.get(x.e)]); prevSlot = known.get(x.e); i++; continue;
    }
    // A run of TMDB episodes the group left out: they fill the slots up to the next listed one.
    const run = [];
    while (i < eps.length && !known.has(eps[i].e)) run.push(eps[i++]);
    const nextSlot = i < eps.length ? known.get(eps[i].e) : null;
    let counts;
    if (nextSlot == null) counts = run.map(slotsFor);
    else {
      const gap = nextSlot - prevSlot - 1;
      if (gap === run.length) counts = run.map(() => 1);
      else if (gap === run.length * 2) counts = run.map(() => 2);
      else {
        counts = run.map(slotsFor);
        if (counts.reduce((a, b) => a + b, 0) !== gap) counts = null; // cannot place them: no guess
      }
    }
    if (!counts) return null; // the left-out episodes cannot be placed: no guess
    let slot = prevSlot;
    run.forEach((r, k) => {
      const n = counts[k];
      map.set(r.e, Array.from({ length: n }, (_, j) => slot + 1 + j));
      slot += n;
    });
    prevSlot = slot;
  }
  let differs = false;
  for (const [e, slots] of map) if (slots.length !== 1 || slots[0] !== e) { differs = true; break; }
  return differs ? map : null;
}

// The episode title a release name carries right after its episode token:
// "The.Office.US.S06E15.Sabre.720p.WEB-DL" → ['sabre'];
// "The.Office.US.S04E03.Dunder.Mifflin.Infinity.Part.1.720p" → ['dunder', 'mifflin', 'infinity'].
// Empty when the name has no title there (a quality tag follows the number).
const STOP = /^(?:\d{3,4}p|4k|uhd|hdr\d*|dv|dovi|sdr|web|webrip|webdl|dl|hdtv|bluray|bdrip|brrip|blu|ray|dvdrip|dvd|remux|x26[45]|h26[45]|hevc|avc|xvid|aac\d*|ac3|eac3|ddp?\d*|dts|truehd|atmos|flac|mp3|opus|proper|repack|rerip|internal|extended|uncut|unrated|directors|superfan|readnfo|nfo|subbed|dubbed|multi|amzn|nf|dsnp|hulu|hmax|pcok|atvp|itunes|(?:19|20)\d{2}|\d{1,2})$/;
function positionalTitle(name) {
  const norm = fold(name).toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const toks = norm.split(' ');
  let at = -1;
  for (let i = 0; i < toks.length; i++) {
    if (/^s\d{1,2}e\d{1,3}(?:e\d{1,3})*$/.test(toks[i]) || /^\d{1,2}x\d{1,3}$/.test(toks[i])) { at = i; break; }
  }
  if (at < 0) return [];
  let j = at + 1;
  if (j < toks.length && /^e\d{1,3}$/.test(toks[j])) j++; // S04E03-E04
  const out = [];
  for (; j < toks.length; j++) {
    const w = toks[j];
    if (STOP.test(w)) break;
    out.push(w);
  }
  return titleWords(out.join(' '));
}

// Does a release title (positional words) name this TMDB title? The same words exactly, after articles
// and part markers are dropped ("Sabre Superfan Cut" was already cut at "superfan"). A longer title that
// only starts with it is a different title: "Money In The Bank" is not "Money".
function titleNames(posWords, tmdbTitle) {
  const t = titleWords(tmdbTitle);
  if (!posWords.length || !t.length || posWords.length !== t.length) return false;
  for (let i = 0; i < t.length; i++) if (posWords[i] !== t[i]) return false;
  return true;
}

// Which TMDB episode (number) a release names, or null. `seasonEpisodes`: [{ n, name }].
function namedEpisode(name, seasonEpisodes) {
  const pos = positionalTitle(name);
  if (!pos.length) return null;
  const hits = (seasonEpisodes || []).filter((row) => row && row.name && titleNames(pos, row.name));
  if (!hits.length) return null;
  // Two TMDB titles with the same words (a split "Part 1"/"Part 2"): the first.
  hits.sort((a, b) => Number(a.n) - Number(b.n));
  return Number(hits[0].n);
}

module.exports = { titleWords, pickAirOrderGroup, releaseNumbering, positionalTitle, titleNames, namedEpisode };

// One file holds several episodes ("S05E14E15", "S05E14-E15") and the viewer chose a later one:
// { index, of } of that episode inside the file (index 2 of 2 for E15), or null when it is the first
// part or the name holds one episode. The player then starts at that part (brief 127).
function episodePartOf(name, season, episode) {
  const s = Number(season), e = Number(episode);
  if (!Number.isInteger(s) || !Number.isInteger(e)) return null;
  const norm = ' ' + fold(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  const m = new RegExp(`\\bs0?${s}((?:\\s?e0?\\d{1,3}){2,})\\b`).exec(norm);
  if (!m) return null;
  const eps = [...m[1].matchAll(/e0?(\d{1,3})/g)].map((x) => Number(x[1]));
  const glued = !/\s/.test(m[1]);
  let index = -1, of = 0;
  if (glued || eps.length > 2) { index = eps.indexOf(e) + 1; of = eps.length; }
  else if (eps[0] <= e && e <= eps[1]) { index = e - eps[0] + 1; of = eps[1] - eps[0] + 1; }
  return index > 1 && of >= index && of <= 6 ? { index, of } : null;
}
module.exports.episodePartOf = episodePartOf;
