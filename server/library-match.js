'use strict';
// Library folder/file names must actually describe the TMDB title we bind them to.
// Taking search results[0] made "Do Sag (2025)" play as Return of the King (id 122).

const fs = require('fs');
const path = require('path');
const { parseWantedTitle, releaseMatches, foldDiacritics } = require('./pipeline');

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

// ---- Persian / Arabic-script names (local libraries only; the Usenet tokenizer is untouched) ----
// The Usenet tokenizer keeps only [a-z0-9], so a Persian name had no words at all and its lone
// year became the only "word": any same-year Persian TMDB hit then matched (wrong film shown).
const ARABIC_SCRIPT = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|ts|webm|mov)$/i;

// Persian/Arabic-Indic digits -> ASCII, one char for one char (indexes stay aligned).
function asciiDigits(s) {
  return String(s || '')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

// Spelling-neutral form for COMPARING names (never for display): Arabic Yeh/Kaf/Alef forms fold to
// the Persian ones, short vowels, tatweel, ZWNJ and direction marks go, digits become ASCII.
function foldPersian(s) {
  return asciiDigits(String(s || '').normalize('NFKC'))
    .replace(/[يىے]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ة/g, 'ه')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .toLowerCase();
}

function hasArabicScript(s) {
  return ARABIC_SCRIPT.test(String(s || ''));
}

// Release/quality and country tags that are not part of a title: [1080p], [4K], (IR), (TR).
const NAME_TAG = /\[\s*(?:\d{3,4}[pi]|4k|uhd|fhd|hd|sd)\s*\]|\((?:[A-Z]{2})\)/g;
// A provider's country prefix at the very start of a name: "IR - Show", "|IR| Show".
const NFO_PREFIX = /^\s*(?:\|\s*IR\s*\||IR\s*[-–—]\s)\s*/;
// A hand-written NFO <title> is shown as written (owner rule 2026-11-14), but a downloader writes
// the provider's raw name there ("IR - Show شو [1080p]"). Clean it like a folder name: drop the
// release and country tags and a leading IR prefix, keep every word. The year is left in place for
// the caller. An empty result means the NFO gave no title.
function cleanNfoTitle(title) {
  const raw = String(title || '');
  const digits = asciiDigits(raw); // same UTF-16 length as raw (one digit for one digit)
  let out = '';
  let from = 0;
  for (const m of digits.matchAll(NAME_TAG)) {
    out += raw.slice(from, m.index) + ' ';
    from = m.index + m[0].length;
  }
  out += raw.slice(from);
  return out.replace(NFO_PREFIX, '').replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s+/g, ' ')
    .replace(/^[\s\-–—|,;:]+|[\s\-–—|,;:]+$/g, '').trim();
}
// A year token: Gregorian 19xx/20xx or a Solar Hijri 13xx/14xx (Iranian calendar), bare or in ().
const YEAR_TOKEN = /(^|[\s._(\[-])\(?((?:19|20)\d{2}|1[34]\d{2})\)?(?=$|[\s._)\]-])/g;

function solarToGregorian(y) {
  const n = parseInt(y, 10);
  if (!n) return null;
  return n >= 1300 && n < 1500 ? n + 621 : n; // Farvardin 1 ~ 21 March; checks allow +-1
}

// Shown title + comparable words for a folder or file name.
//   display: the folder name without its year and release tags ("Do Sag (2025) دو سگ" -> "Do Sag دو سگ").
//            A scene-style tail after the year with no Persian letters is dropped
//            ("Wonder.Woman.1984.2020.1080p" -> "Wonder Woman 1984").
//   year:    Gregorian year as a string (a Solar Hijri 1382 becomes 2003), or null.
//   latin / persian: comparable words of each script (Persian ones folded).
function libraryNameParts(label, opts = {}) {
  let raw = String(label || '');
  if (opts.file) raw = raw.replace(VIDEO_EXT, '');
  const digits = asciiDigits(raw); // same length as raw
  const keep = [...raw];
  const blank = (from, to) => { for (let i = from; i < to; i++) keep[i] = ' '; };
  for (const m of digits.matchAll(NAME_TAG)) blank(m.index, m.index + m[0].length);
  const scrubbed = keep.join('');
  const scrubbedDigits = asciiDigits(scrubbed);
  let last = null;
  for (const m of scrubbedDigits.matchAll(YEAR_TOKEN)) last = m;
  let display = scrubbed;
  let matchText = scrubbed;
  let year = null;
  if (last) {
    const start = last.index + last[1].length;
    const end = last.index + last[0].length;
    const before = scrubbed.slice(0, start);
    const after = scrubbed.slice(end);
    // A name that is only a number (1917, 2012) keeps the number as its title. A number title with
    // its year after it ("1917 (2019)", "300 (2006)") is a title plus a year, as in 3.4.13.
    if (/[\p{L}]/u.test(before + after) || /\d/.test(before)) {
      year = String(solarToGregorian(last[2]));
      const persianTail = hasArabicScript(after);
      // Words for matching never include the release year (same cut as parseLibraryName).
      matchText = persianTail ? `${before} ${after}` : before;
      // The shown name drops "(2025)" and a scene tail after the year, but a bare number with
      // nothing after it may be part of the title ("Blade Runner 2049"), and a bare year in front
      // of the Persian half tells parts apart ("Gol 1390 گل"): those stay.
      const bare = !scrubbed.slice(start, end).includes('(');
      const yearText = scrubbed.slice(start, end);
      if (bare && !after.trim()) display = `${before} ${yearText}`;
      else if (bare && persianTail) display = `${before} ${yearText} ${after}`;
      else display = matchText;
    }
  }
  const tidy = (s) => s.replace(/[._]+/g, ' ').replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s\-,;|:]+|[\s\-,;|:]+$/g, '').trim();
  display = tidy(display) || raw.replace(/[._]+/g, ' ').trim();
  const text = tidy(matchText) || display;
  // Latin words fold accents the way the Usenet matcher does (Şeref -> seref, Amélie -> amelie).
  const words = foldDiacritics(foldPersian(text)).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const latin = words.filter((w) => /^[a-z0-9]+$/.test(w));
  const persian = words.filter((w) => hasArabicScript(w));
  // The Latin half as written (apostrophes, '&'), for the existing Latin title rules.
  const latinText = text.replace(/[؀-ۿݐ-ݿ‌]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { display, year, latin, persian, latinText };
}

function persianKey(words) {
  return (words || []).join('');
}

function yearsAgree(a, b) {
  const x = parseInt(a, 10), y = parseInt(b, 10);
  if (!x || !y) return true;
  return Math.abs(x - y) <= 1;
}

// Does a local folder/file name AGREE with one TMDB candidate? A weak match is worse than none:
//   - Persian words in the name: a candidate with a Persian title must have the SAME Persian words
//     (spelling-folded, spaces and ZWNJ ignored); Kaval is not Kavalda, a lone year is never enough.
//   - A name with Persian AND Latin words may bind a non-Persian candidate (dubbed foreign films)
//     only when the Latin words agree AND both sides carry a year within one year.
//   - Latin-only names keep the existing Latin rules (articles, catalog halves, Crystal != Crystal Skull).
//   - Movies need the years within one year when both sides have one; TV shows do not (a folder year
//     is often the latest season).
function libraryNameAgrees(label, labelYear, titles, hitYear, kind, opts = {}) {
  const f = libraryNameParts(label, opts);
  const year = f.year || (labelYear ? String(solarToGregorian(asciiDigits(labelYear))) : null);
  const list = (titles || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!list.length) return false;
  const tv = isTvKind(kind);
  const yearOk = tv || yearsAgree(year, hitYear);
  const candPersian = list.filter(hasArabicScript).map((t) => persianKey(libraryNameParts(t).persian)).filter(Boolean);
  if (f.persian.length) {
    const latinWords = f.latin.filter((w) => /[a-z]/.test(w));
    if (candPersian.length) return yearOk && candPersian.includes(persianKey(f.persian));
    if (!latinWords.length) return false;
    if (!year || !hitYear || !yearsAgree(year, hitYear)) return false;
    return libraryTitleMatchesAny(f.latinText || f.latin.join(' '), year, list, hitYear, kind);
  }
  // Latin-only and digits-only names (1917, 2012) keep the old rules, which anchor on the words.
  if (f.latin.length) return libraryTitleMatchesAny(f.latinText || f.latin.join(' '), year, list, hitYear || year, kind);
  return false;
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

// `label` is the folder name (or file name with opts.file), not a pre-cut title: the Persian
// half of "Do Sag (2025) دو سگ" is what proves a Persian candidate.
function pickLibraryTmdbHit(results, label, year, kind, opts = {}) {
  const list = Array.isArray(results) ? results : [];
  for (const hit of list) {
    if (!hit || typeof hit !== 'object') continue;
    const hitYear = String(hit.release_date || hit.first_air_date || '').slice(0, 4) || null;
    if (libraryNameAgrees(label, year, tmdbHitTitles(hit), hitYear, kind, opts)) return hit;
  }
  return null;
}

// TMDB search texts for a name, best first: the whole cleaned name, then its Persian half, then its
// Latin half ("Golbarg گلبرگ" -> "Golbarg گلبرگ", "گلبرگ", "Golbarg"). Tags like [1080p] never reach TMDB.
function libraryTmdbQueries(label, opts = {}) {
  const p = libraryNameParts(label, opts);
  const out = [p.display];
  const fa = (p.display.match(/[؀-ۿ‌][؀-ۿ‌\s]*/g) || []).join(' ').replace(/\s+/g, ' ').trim();
  const la = p.display.replace(/[؀-ۿ‌]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (fa && /[\p{L}]/u.test(la)) { out.push(fa); out.push(la); }
  return [...new Set(out.filter(Boolean))].slice(0, 3);
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

/** Per-library scan: default auto; `local` skips TMDB search (folder/NFO only). */
function libraryAutoTmdbMatch(lib) {
  return !!(lib && lib.tmdbMatch !== 'local');
}

/** True when a scan row should not auto-bind or reuse TMDB (library-wide local mode). */
function libraryScanUsesLocalMetaOnly(lib, matchOverride, nfoLocal) {
  if (matchOverride === 'none' || nfoLocal) return true;
  if (!libraryAutoTmdbMatch(lib)) return typeof matchOverride !== 'number';
  return false;
}

// A season sub-folder: "Season 01", "Specials", "فصل ۱", "S02".
function isLibrarySeasonDir(name) {
  const n = foldPersian(name).trim();
  return /season|specials/i.test(n) || /^(?:فصل|سری)\s*\d{1,3}\b/.test(n) || /^s\d{1,2}$/i.test(n);
}

function librarySeasonFromDir(name) {
  const n = foldPersian(name);
  if (/specials/i.test(n)) return 0;
  const m = /(?:season|فصل|سری|^s)\s*0*(\d{1,3})/i.exec(n);
  return m ? +m[1] : null;
}

// Episode number from a video file name.
//   strong: S01E02 / 1x02 (always an episode)
//   weak:   E001, EP001, Episode 1, قسمت ۱, or a bare number ("10.mp4") - only trusted inside a
//           season folder or when a folder holds several such files.
function libraryEpisodeNumber(fileName, opts = {}) {
  const base = foldPersian(String(fileName || '').replace(VIDEO_EXT, ''));
  let m = /s(\d{1,2})[ ._-]?e(\d{1,3})/i.exec(base);
  if (m) return { s: +m[1], e: +m[2], strong: true };
  m = /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?![0-9])/i.exec(base);
  if (m && !/\d{3,4}x\d{3,4}/.test(base.slice(Math.max(0, m.index - 2), m.index + m[0].length + 2))) {
    return { s: +m[1], e: +m[2], strong: true };
  }
  if (opts.strongOnly) return null;
  const s = Number.isInteger(opts.season) ? opts.season : 1;
  m = /(?:^|[^a-z])(?:episode|ep|e)[ ._-]?(\d{1,4})(?![0-9])/i.exec(base);
  if (m && +m[1] > 0) return { s, e: +m[1], strong: false };
  m = /(?:قسمت|ق)\s*(\d{1,4})(?![0-9])/.exec(base);
  if (m && +m[1] > 0) return { s, e: +m[1], strong: false };
  m = /^\s*(\d{1,4})\s*(?:\(\d+\))?\s*$/.exec(base);
  if (m && +m[1] > 0) return { s, e: +m[1], strong: false };
  return null;
}

// The show folder name of an episode (skips a season folder).
function libraryShowFolderLabel(item) {
  if (!item) return '';
  if (item.kind === 'show' && item.dir) return path.basename(item.dir);
  let dir = item.file ? path.dirname(item.file) : '';
  if (dir && isLibrarySeasonDir(path.basename(dir))) dir = path.dirname(dir);
  return dir ? path.basename(dir) : '';
}

// The titles a stored match was made on. New rows keep them in matchTitle/originalTitle (the
// shown title is the folder name); rows scanned before that kept the TMDB title in `title`.
function storedMatchTitles(item) {
  const titles = [];
  if (item.matchTitle) titles.push(item.matchTitle);
  else if (!item.titleSource) titles.push(item.kind === 'episode' ? String(item.title || '').split(' · ')[0] : item.title);
  if (item.originalTitle) titles.push(item.originalTitle);
  return titles.filter(Boolean);
}

function libraryItemMatchesTmdb(item) {
  if (!item || !item.tmdbId) return false;
  if (typeof item.matchOverride === 'number') return true;
  // An NFO TMDB id and an admin pick on the show are explicit choices, not guesses.
  if (item.matchSource === 'nfo' || item.matchSource === 'manual') return true;
  const kind = libraryItemKind(item);
  const titles = storedMatchTitles(item);
  if (!titles.length) return false;
  if (item.kind === 'episode') {
    const label = libraryShowFolderLabel(item);
    if (label && libraryNameAgrees(label, null, titles, item.year, kind)) return true;
    // Rows scanned before the show folder rule: keep the old file-label check.
    const parsedEp = parseLibraryName(libraryFileLabel(item));
    return !!parsedEp.title && libraryTitleMatchesAny(parsedEp.title, parsedEp.year || item.year, titles, item.year, kind);
  }
  const label = libraryFileLabel(item);
  const loose = !!(item.file && !item.dir && label === path.basename(item.file, path.extname(item.file)));
  return libraryNameAgrees(label, null, titles, item.year, kind, { file: loose });
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
      matchTitle: null,
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
    // An NFO plot is the owner's own text, not the match's: keep it.
    overview: item.overviewSource === 'nfo' ? item.overview : '',
    originalTitle: null,
    matchTitle: null,
    // Rows with a recorded title source already show the folder (or NFO) title.
    title: item.titleSource ? item.title : (parsed.title || item.title),
    year: item.titleSource ? item.year : (parsed.year || item.year),
  };
}

const ART_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const POSTER_NAMES = ['poster', 'folder', 'cover', 'thumb', 'movie', 'show', 'tvshow'];
const BACKDROP_NAMES = ['fanart', 'backdrop', 'background', 'landscape', 'banner'];

function artBase(name) {
  return path.parse(name).name.toLowerCase();
}

function pickNamed(images, names) {
  return images.find((img) => names.some((n) => img.base === n || img.base.startsWith(`${n}-`) || img.base.startsWith(`${n}.`) || img.base.endsWith(`-${n}`)));
}

function nfoInner(xml, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml || '');
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
}

// A Kodi/Emby .nfo names the cover. Ignore web links. A path outside this folder is ignored.
function nfoImageValue(xml, wide) {
  const local = (value) => {
    const v = String(value || '').trim();
    if (!v || /^https?:/i.test(v)) return '';
    return v;
  };
  const art = nfoInner(xml, 'art');
  if (wide) {
    const fanart = nfoInner(xml, 'fanart');
    const fromFanart = local(nfoInner(fanart, 'thumb') || fanart);
    if (fromFanart) return fromFanart;
    const fromArt = local(nfoInner(art, 'fanart'));
    if (fromArt) return fromArt;
  }
  const fromArt = local(nfoInner(art, 'poster'));
  if (fromArt) return fromArt;
  const aspect = wide ? 'fanart|backdrop' : 'poster';
  const tagged = new RegExp(`<thumb\\b[^>]*aspect="(?:${aspect})"[^>]*>([\\s\\S]*?)</thumb>`, 'i').exec(xml || '');
  const fromAspect = local(tagged && tagged[1]);
  if (fromAspect) return fromAspect;
  if (wide) return '';
  const thumb = local(nfoInner(xml, 'thumb'));
  if (thumb && !/fanart|backdrop|banner/i.test(thumb)) return thumb;
  return '';
}

// `entries` (optional): the folder's listing (Dirent[]) from the caller's scan. A picture that sits
// in the folder itself is then looked up in that listing instead of asking the disk again.
function resolveNfoImage(dir, value, entries = null) {
  const rel = String(value || '').trim().replace(/[\\/]/g, path.sep);
  if (!rel) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, rel);
  const rootKey = root.toLowerCase();
  const fullKey = full.toLowerCase();
  if (fullKey !== rootKey && !fullKey.startsWith(rootKey + path.sep)) return null;
  const candidates = ART_EXT.has(path.extname(full).toLowerCase())
    ? [full]
    : ['.jpg', '.jpeg', '.png', '.webp'].map((ext) => full + ext);
  const fold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  return candidates.find((file) => {
    if (Array.isArray(entries) && path.dirname(file) === root) {
      const want = fold(path.basename(file));
      const ent = entries.find((e) => fold(e.name) === want);
      if (!ent) return false;
      if (!ent.isSymbolicLink()) return ent.isFile();
    }
    try { return fs.existsSync(file) && fs.statSync(file).isFile(); } catch { return false; }
  }) || null;
}

const readNfoText = (file) => {
  try { return fs.readFileSync(file, 'utf8').slice(0, 200000); } catch { return null; }
};

function folderNames(dir, entries) {
  if (Array.isArray(entries)) return entries.map((e) => e.name);
  try { return fs.readdirSync(dir); } catch { return null; }
}

function findNfoArt(dir, videoBase, wide, names, readText = readNfoText, entries = null) {
  if (!names) return null;
  const wanted = new Set(['movie.nfo', 'tvshow.nfo']);
  if (videoBase) wanted.add(`${String(videoBase).toLowerCase()}.nfo`);
  const nfo = names.find((name) => wanted.has(name.toLowerCase()))
    || names.find((name) => name.toLowerCase().endsWith('.nfo'));
  if (!nfo) return null;
  const xml = readText(path.join(dir, nfo));
  if (xml === null || xml === undefined) return null;
  return resolveNfoImage(dir, nfoImageValue(xml, wide), entries);
}

// Kodi and Emby drop a jpg next to the video. It is often not named poster.jpg.
// A library scan passes the folder listing it already has (`entries`) and its NFO reader
// (`readText`), so the folder is listed once and each NFO read once per pass.
function findLibraryArt(dir, { videoBase = '', wide = false, entries = null, readText = readNfoText } = {}) {
  const names = folderNames(dir, entries);
  if (!names) return null;
  const fromNfo = findNfoArt(dir, videoBase, wide, names, readText, entries);
  if (fromNfo) return fromNfo;
  const images = names
    .filter((name) => ART_EXT.has(path.extname(name).toLowerCase()))
    .map((name) => ({ name, base: artBase(name) }));
  if (!images.length) return null;
  if (wide) {
    const back = pickNamed(images, BACKDROP_NAMES);
    if (back) return path.join(dir, back.name);
  }
  const poster = pickNamed(images, POSTER_NAMES);
  if (poster) return path.join(dir, poster.name);
  const base = String(videoBase || '').toLowerCase();
  if (base) {
    const twin = images.find((img) => img.base === base);
    if (twin) return path.join(dir, twin.name);
  }
  if (images.length === 1) return path.join(dir, images[0].name);
  return null;
}

module.exports = {
  cleanNfoTitle,
  foldPersian,
  libraryNameParts,
  libraryNameAgrees,
  libraryTmdbQueries,
  isLibrarySeasonDir,
  librarySeasonFromDir,
  libraryEpisodeNumber,
  libraryShowFolderLabel,
  solarToGregorian,
  parseLibraryName,
  libraryFileLabel,
  libraryTitleMatches,
  pickLibraryTmdbHit,
  libraryNfoPrefersLocal,
  libraryAutoTmdbMatch,
  libraryScanUsesLocalMetaOnly,
  libraryItemMatchesTmdb,
  unboundLibraryItem,
  findLibraryArt,
};
