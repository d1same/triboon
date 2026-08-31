'use strict';
// Library folder/file names must actually describe the TMDB title we bind them to.
// Taking search results[0] made "Do Sag (2025)" play as Return of the King (id 122).

const path = require('path');
const { parseWantedTitle, releaseMatches } = require('./pipeline');

const SKIP_ARTICLES = new Set(['the', 'a', 'an', 'and']);

function parseLibraryName(label) {
  const clean = String(label || '').replace(/\.[a-z0-9]+$/i, '');
  // The LAST year-shaped token is the release year — "Blade Runner 2049 (2017)" and
  // "Wonder.Woman.1984.2020.1080p" carry a year INSIDE the title, and grabbing the FIRST one
  // yielded title "Blade Runner" year 2049 → wrong/no TMDB match (and local-first playback
  // silently broke for those titles). Same trailing-year rule as the usenet matcher.
  const re = /[. (_-]+\(?((?:19|20)\d{2})\)?(?=[. )_-]|$)/g;
  let m = null;
  for (let h; (h = re.exec(clean));) m = h;
  const title = (m ? clean.slice(0, m.index) : clean).replace(/[._]/g, ' ').trim();
  return title ? { title, year: m ? m[1] : null } : { title: clean.replace(/[._]/g, ' ').trim(), year: null };
}

function coreWords(words) {
  return (words || []).filter((w) => !SKIP_ARTICLES.has(w));
}

function isTvKind(kind) {
  return kind === 'tv' || kind === 'show' || kind === 'episode';
}

function tmdbHitTitles(hit) {
  if (!hit || typeof hit !== 'object') return [];
  return [hit.title, hit.name, hit.original_title, hit.original_name]
    .map((s) => String(s || '').trim()).filter(Boolean);
}

function uniqueHalfEqualsFile(tmdbTitle, fileWanted, kind) {
  const raw = String(tmdbTitle || '');
  const colon = raw.indexOf(':');
  if (colon < 1) return false;
  const uniqueWanted = parseWantedTitle(raw.slice(colon + 1).trim());
  const u = coreWords(uniqueWanted.words);
  const f = coreWords(fileWanted.words);
  if (!u.length || u.join(' ') !== f.join(' ')) return false;
  if (u.length >= 2) return true;
  // One leftover word is only safe for TV folders ("Lioness" vs "Special Ops: Lioness").
  // Movies keep the Mission: Impossible guard.
  return isTvKind(kind) && u[0].length >= 6;
}

function libraryTitleMatches(fileTitle, fileYear, tmdbTitle, tmdbYear, kind) {
  const fileWanted = parseWantedTitle([fileTitle, fileYear].filter(Boolean).join(' '));
  if (!fileWanted.words.length) return false;
  const tmdbStr = String(tmdbTitle || '');
  if (releaseMatches(tmdbStr, fileWanted)) return true;
  const tmdbWanted = parseWantedTitle([tmdbTitle, tmdbYear].filter(Boolean).join(' '));
  const fileCore = coreWords(fileWanted.words);
  const tmdbCore = coreWords(tmdbWanted.words);
  // Same title minus articles: matrix.mkv is The Matrix. Not a substring (Crystal ≠ Crystal Skull).
  if (fileCore.length && fileCore.join(' ') === tmdbCore.join(' ')) return true;
  if (tmdbWanted.aliasWords && tmdbWanted.aliasWords.length && releaseMatches(String(fileTitle || ''), tmdbWanted)) {
    return true;
  }
  return uniqueHalfEqualsFile(tmdbStr, fileWanted, kind);
}

function libraryTitleMatchesAny(fileTitle, fileYear, titles, tmdbYear, kind) {
  return (titles || []).some((t) => libraryTitleMatches(fileTitle, fileYear, t, tmdbYear, kind));
}

function pickLibraryTmdbHit(results, title, year, kind) {
  const list = Array.isArray(results) ? results : [];
  for (const hit of list) {
    const hitYear = String(hit.release_date || hit.first_air_date || '').slice(0, 4) || year;
    if (libraryTitleMatchesAny(title, year, tmdbHitTitles(hit), hitYear || year, kind)) return hit;
  }
  return null;
}

function libraryFileLabel(item) {
  if (!item) return '';
  if (item.kind === 'show' && item.dir) return path.basename(item.dir);
  const file = item.file || '';
  const fileBase = file ? path.basename(file, path.extname(file)) : '';
  let dir = item.dir || (file ? path.dirname(file) : '');
  if (item.kind === 'episode' && dir && /season|specials/i.test(path.basename(dir))) {
    dir = path.dirname(dir);
  }
  const dirBase = dir ? path.basename(dir) : '';
  if (!fileBase) return dirBase;
  if (!dirBase) return fileBase;
  const fileParsed = parseLibraryName(fileBase);
  const dirParsed = parseLibraryName(dirBase);
  if (dirParsed.title && fileParsed.title) {
    const d = dirParsed.title.toLowerCase();
    const f = fileParsed.title.toLowerCase();
    if (d === f || d.startsWith(f) || f.startsWith(d)) return dirBase;
  }
  if (dirParsed.year && fileParsed.title) return dirBase;
  return fileBase;
}

function libraryItemKind(item) {
  if (!item) return 'movie';
  if (item.kind === 'episode' || item.kind === 'show') return 'tv';
  return 'movie';
}

// An NFO without a TMDB uniqueid is the owner's title. Searching TMDB by that
// name glued Persian films to Hollywood (Do Sag → Return of the King). Example:
// movie.nfo says "دختر برقی" — keep it; do not pick a close English hit.
function libraryNfoPrefersLocal(nfo, matchOverride) {
  if (matchOverride === 'none') return true;
  if (typeof matchOverride === 'number') return false;
  return !!(nfo && !nfo.tmdbId);
}

function libraryItemMatchesTmdb(item) {
  if (!item || !item.tmdbId) return false;
  if (typeof item.matchOverride === 'number') return true;
  const parsed = parseLibraryName(libraryFileLabel(item));
  if (!parsed.title) return false;
  const kind = libraryItemKind(item);
  const titles = [];
  if (item.kind === 'episode') {
    titles.push(String(item.title || '').split(' · ')[0]);
  } else if (item.title) {
    titles.push(item.title);
  }
  if (item.originalTitle) titles.push(item.originalTitle);
  return libraryTitleMatchesAny(parsed.title, parsed.year || item.year, titles, item.year, kind);
}

function unboundLibraryItem(item) {
  if (!item) return item;
  // Admin "use folder/NFO info" must drop TMDB art even when a leftover poster path is
  // still on the row — otherwise the library cover stays the wrong movie after revert.
  if (item.matchOverride === 'none') {
    return {
      ...item,
      tmdbId: null,
      poster: null,
      backdrop: null,
      originalTitle: null,
    };
  }
  if (!item.tmdbId || libraryItemMatchesTmdb(item)) return item;
  const parsed = parseLibraryName(libraryFileLabel(item));
  return {
    ...item,
    tmdbId: null,
    poster: null,
    backdrop: null,
    genres: [],
    rating: null,
    overview: '',
    originalTitle: null,
    title: parsed.title || item.title,
    year: parsed.year || item.year,
  };
}

module.exports = {
  parseLibraryName,
  libraryFileLabel,
  libraryTitleMatches,
  pickLibraryTmdbHit,
  libraryNfoPrefersLocal,
  libraryItemMatchesTmdb,
  unboundLibraryItem,
};
