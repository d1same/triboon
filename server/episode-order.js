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
  for (const g of group.groups) {
    const rows = (g && Array.isArray(g.episodes) ? g.episodes : []).filter((x) => Number(x.season_number) === s);
    if (rows.length && (!best || rows.length > best.length)) best = rows;
  }
  if (!best || best.length < 2) return null;
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
  while (i < eps.length) {
    const x = eps[i];
    if (known.has(x.e)) { map.set(x.e, [known.get(x.e)]); prevSlot = known.get(x.e); i++; continue; }
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
    if (!counts) { prevSlot = nextSlot; continue; }
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

module.exports = { titleWords, pickAirOrderGroup, releaseNumbering };
