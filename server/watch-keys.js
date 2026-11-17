'use strict';
// Moves saved progress, watched ticks and watchlist rows of local library items onto their stable
// keys (library-keys.js). Runs at the end of every library pass (a scan, or the boot pass that keys
// the stored items), so it also catches rows that an old page or a Jellyfin app wrote under a scan
// position after the last pass.
//
// Three kinds of move, all for every user and profile at once:
//   1. A legacy row `local:<lib>:<position>`: the position named an item of the PREVIOUS pass. The row
//      goes to that item only when its saved title (or the 3.4.15 file name) confirms it; else to the
//      one item of that pass with that title; else it is parked, never guessed.
//   2. The same item's watch key changed: a match gained, lost or changed (Fix match, a switch to
//      "Folder & NFO only"). `tmdb:` rows of a match that another library item still claims stay put,
//      and rows imported from Trakt never leave their `tmdb:` key.
//   3. A rename or move: an item that vanished and one that appeared, with the same file name and size
//      (never the modified time). One candidate on each side, or nothing moves.
// Parked rows live in their own table (`watchOrphans`) with the original key and the date; they are
// deleted after 30 days. Undo is a move back.

const path = require('path');
const { cleanNfoTitle, libraryNameParts } = require('./library-match');
const { parseLocalKey } = require('./library-keys');

const ORPHAN_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const SE_RE = /\bS(\d{1,3})\s*E(\d{1,4})\b/i;

function normTitle(s) {
  return cleanNfoTitle(String(s || '')).normalize('NFC')
    .replace(/[‌‍‎‏]/g, '')
    .replace(/\s*\(\s*(?:19|20|13|14)\d{2}\s*\)\s*$/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// "Show — S01E02 · Name", "Show · S01E02", "Show S01E02" -> { title: 'show', s: 1, e: 2 }.
function savedTitleParts(meta) {
  const raw = String((meta && meta.title) || '');
  const m = SE_RE.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw;
  const out = { title: normTitle(head.replace(/[\s—·|:-]+$/, '')), s: null, e: null };
  if (m) { out.s = parseInt(m[1], 10); out.e = parseInt(m[2], 10); }
  const ms = meta && Number.isInteger(+meta.season) ? +meta.season : null;
  const me = meta && Number.isInteger(+meta.episode) ? +meta.episode : null;
  if (out.s === null && ms !== null && me !== null) { out.s = ms; out.e = me; }
  return out;
}

// Every title an item has been shown or saved under across 3.4.13 to 3.4.16: the current title, the
// catalog title of a match, the folder name parsed, and (through normTitle) the raw NFO title of 3.4.14.
// Name parsing is the costly part of a pass: computed once per item object.
const titleMemo = new WeakMap();
function titlesOf(item) {
  if (!item) return new Set();
  const hit = titleMemo.get(item);
  if (hit) return hit;
  const out = new Set();
  titleMemo.set(item, out);
  const add = (t) => { const n = normTitle(t); if (n) out.add(n); };
  const own = item.kind === 'episode' ? String(item.title || '').split(' · ')[0] : item.title;
  add(own);
  add(item.matchTitle);
  add(item.originalTitle);
  const label = item.kind === 'show' && item.dir ? path.basename(item.dir)
    : (item.file ? (path.basename(path.dirname(item.file)) || '') : '');
  if (label) {
    add(label);
    try { add(libraryNameParts(label).display); } catch {}
  }
  if (item.file && item.kind === 'movie') {
    const base = path.basename(item.file, path.extname(item.file));
    try { add(libraryNameParts(base, { file: true }).display); } catch {}
  }
  return out;
}

function makeIndex(items) {
  const byIdx = new Map();
  const byKey = new Map();
  for (const it of items || []) {
    if (!it) continue;
    if (Number.isInteger(it.idx)) byIdx.set(it.idx, it);
    if (it.key) byKey.set(it.key, it);
  }
  const index = { byIdx, byKey, items: items || [] };
  // The items a saved row could belong to: those carrying its title (an episode also by its show's
  // titles) or its file name. Built on first use, so a pass with no old rows pays nothing; a row then
  // looks at a handful of items instead of the whole library (20,000 items x thousands of rows).
  let byTitle = null;
  let byFile = null;
  index.candidates = (meta) => {
    if (!byTitle) {
      byTitle = new Map();
      byFile = new Map();
      const put = (map, k, it) => { if (!k) return; if (!map.has(k)) map.set(k, new Set()); map.get(k).add(it); };
      for (const it of index.items) {
        if (!it) continue;
        for (const t of titlesOf(it)) put(byTitle, t, it);
        if (it.kind === 'episode') for (const t of titlesOf(byIdx.get(it.showIdx))) put(byTitle, t, it);
        if (it.file) put(byFile, path.basename(it.file), it);
      }
    }
    const want = savedTitleParts(meta);
    const src = meta && meta.source && typeof meta.source.name === 'string' ? meta.source.name : '';
    const out = new Set(byTitle.get(want.title) || []);
    if (src) for (const it of byFile.get(src) || []) out.add(it);
    return [...out];
  };
  return index;
}

// Does a saved row (its meta) belong to `item`? `showOf` gives an episode's show item.
// The kind a saved row says it is ('movie', 'episode', 'show'), or null when it does not say.
function savedKind(meta) {
  const k = meta && (meta._kind || meta.type);
  if (k === 'movie') return 'movie';
  if (k === 'episode') return 'episode';
  if (k === 'show' || k === 'tv') return 'show';
  return null;
}

function rowConfirms(item, meta, showOf) {
  if (!item || !item.key) return false;
  const want = savedTitleParts(meta);
  // A row that names its kind (or a season and episode) never belongs to another kind of item.
  const kind = want.s !== null ? 'episode' : savedKind(meta);
  if (kind && kind !== item.kind) return false;
  const src = meta && meta.source && typeof meta.source.name === 'string' ? meta.source.name : '';
  // A file name must agree, and so must the saved title when there is one: generic names
  // (01.mp4, S01E01.mkv) repeat across shows.
  if (src && item.file && path.basename(item.file) !== src) return false;
  if (!want.title) return !!(src && item.file);
  if (item.kind === 'episode') {
    const show = showOf(item);
    const names = new Set([...titlesOf(show), ...titlesOf(item)]);
    if (!names.has(want.title)) return false;
    if (want.s !== null && (want.s !== +item.s || want.e !== +item.e)) return false;
    return true;
  }
  return titlesOf(item).has(want.title);
}

// The item a legacy position row belongs to, from the pass it was written against, or null.
function resolveLegacyRow(row, pos, prev) {
  const meta = (row && row.meta) || {};
  const showOf = (ep) => prev.byIdx.get(ep.showIdx);
  const at = prev.byIdx.get(pos);
  const want = savedTitleParts(meta);
  const byFile = !!(meta.source && meta.source.name);
  // The file name (3.4.15 rows) names one file exactly.
  if (at && byFile && rowConfirms(at, meta, showOf)) return at;
  // A title at its position is trusted only when no other item of that pass carries the same title
  // (another film of that name, or an episode of another show of that name): a scan before this one
  // could have swapped the two, and the row cannot tell (result 85: about 248 such film groups).
  if (at && !byFile && rowConfirms(at, meta, showOf)) {
    const rival = (it) => it && it !== at && (at.kind === 'episode'
      ? it.kind === 'episode' && it.showIdx !== at.showIdx
      : it.kind !== 'episode') && rowConfirms(it, meta, showOf);
    return prev.candidates(meta).some(rival) ? null : at;
  }
  // Elsewhere in that pass: exactly one item with that file name or title, else nothing.
  // An episode row needs its own s/e or file name (a show title alone names every episode).
  // What the row says it is wins over what its old position holds now (a film row whose position
  // now holds an episode is still a film row).
  const kind = savedKind(meta);
  const episodeRow = want.s !== null || kind === 'episode' || (!kind && at && at.kind === 'episode');
  if (episodeRow && want.s === null && !byFile) return null;
  const hits = prev.candidates(meta).filter((it) => it && it !== at
    && (byFile ? it.kind !== 'show' : (episodeRow ? it.kind === 'episode' : it.kind !== 'episode'))
    && rowConfirms(it, meta, showOf));
  return hits.length === 1 ? hits[0] : null;
}

// Moves 2 and 3 (match change, rename). `watchKeyOf(item)` gives the key progress is saved under.
// `claimedElsewhere(tmdbKey)` is true when another library item still owns that catalog key.
function planMoves({ prevItems, items, watchKeyOf, claimedElsewhere = () => false }) {
  const prev = makeIndex(prevItems);
  const next = makeIndex(items);
  const moves = [];
  const add = (from, to, reason, item) => {
    if (!from || !to || from === to) return;
    if (/^tmdb:/i.test(from) && claimedElsewhere(from)) return;
    moves.push({ from, to, reason, item });
  };
  for (const [key, it] of next.byKey) {
    const before = prev.byKey.get(key);
    if (!before) continue;
    add(watchKeyOf(before), watchKeyOf(it), 'match', it);
  }
  // Renames and moves: vanished vs appeared, paired by file name + size.
  const gone = prevItems.filter((it) => it && it.key && it.file && !next.byKey.has(it.key) && Number.isFinite(it.fileSize));
  const born = items.filter((it) => it && it.key && it.file && !prev.byKey.has(it.key) && Number.isFinite(it.fileSize));
  const sig = (it) => `${it.kind}\0${path.basename(it.file).normalize('NFC')}\0${it.fileSize}`;
  const count = (list) => { const m = new Map(); for (const it of list) m.set(sig(it), (m.get(sig(it)) || 0) + 1); return m; };
  const goneN = count(gone);
  const bornN = count(born);
  const bornBy = new Map(born.map((it) => [sig(it), it]));
  const paired = new Map(); // old item -> new item
  for (const old of gone) {
    const s = sig(old);
    if (goneN.get(s) !== 1 || bornN.get(s) !== 1) continue;
    const fresh = bornBy.get(s);
    paired.set(old, fresh);
    add(watchKeyOf(old), watchKeyOf(fresh), 'rename', fresh);
  }
  // A show whose folder was renamed or moved: at least half its episodes paired to one new show.
  const prevShows = prevItems.filter((it) => it && it.kind === 'show' && it.key && !next.byKey.has(it.key));
  for (const show of prevShows) {
    const eps = prevItems.filter((e) => e && e.kind === 'episode' && e.showIdx === show.idx);
    if (!eps.length) continue;
    const votes = new Map();
    for (const e of eps) {
      const n = paired.get(e);
      if (n) votes.set(n.showIdx, (votes.get(n.showIdx) || 0) + 1);
    }
    const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] * 2 < eps.length) continue;
    const target = next.byIdx.get(top[0]);
    if (target && target.kind === 'show' && !prev.byKey.has(target.key)) add(watchKeyOf(show), watchKeyOf(target), 'rename', target);
  }
  return moves;
}

// Was this row played from this library item? The server's stamp says so; a 3.4.15 row says so by
// its file name.
function rowFromCopy(row, item) {
  const meta = (row && row.meta) || {};
  if (!item) return false;
  if (meta.localKey) return meta.localKey === item.key;
  const src = meta.source && typeof meta.source.name === 'string' ? meta.source.name : '';
  return !!(src && item.file && path.basename(item.file) === src);
}

function stampFor(item, libId) {
  if (!item || !item.key) return null;
  return { localKey: item.key, relPath: item.relPath || undefined, libId };
}

// Applies everything to the stores' documents (mutates them). Returns counts.
//   watch:     { "<uid>:<profile>:<key>": row }
//   watchlist: { "<uid>:<key>": row }
//   orphans:   { "<original full key>": { row, table, at, reason, libId } }
function applyLibraryMoves({ libId, watch, watchlist, orphans, prevItems, items, moves, watchKeyOf, now = Date.now() }) {
  const stats = { moved: 0, merged: 0, parked: 0, legacy: 0, purged: 0, log: [] };
  const note = (entry) => { if (stats.log.length < 2000) stats.log.push(entry); };
  const prev = makeIndex(prevItems);
  const next = makeIndex(items);
  const moveMap = new Map(moves.map((m) => [m.from, m]));
  const targetFor = (it) => {
    if (!it) return null;
    // The item's counterpart in this pass (same stable key), else the key it had.
    const cur = (it.key && next.byKey.get(it.key)) || it;
    return { key: watchKeyOf(cur), item: cur };
  };
  const put = (doc, fromFull, toFull, row, stamp) => {
    const have = doc[toFull];
    const meta = stamp ? { ...(row.meta || {}), ...stamp } : row.meta;
    const moved = { ...row, meta };
    if (!have || (row.updatedAt || row.addedAt || 0) > (have.updatedAt || have.addedAt || 0)) doc[toFull] = moved;
    else stats.merged++;
    if (fromFull !== toFull) delete doc[fromFull];
    stats.moved++;
    note({ from: fromFull, to: toFull });
  };
  const park = (table, doc, fullKey, row, reason) => {
    orphans[fullKey] = { row, table, at: now, reason, libId };
    delete doc[fullKey];
    stats.parked++;
    note({ from: fullKey, parked: table, reason });
  };
  const walk = (table, doc, split) => {
    for (const fullKey of Object.keys(doc || {})) {
      const row = doc[fullKey];
      if (!row) continue;
      const parts = split(fullKey);
      if (!parts) continue;
      const { prefix, key } = parts;
      const mv = moveMap.get(key);
      if (mv) {
        // A catalog row is shared with the Usenet copy, Trakt and other users' history: it leaves its
        // catalog key only when it was played from THIS library copy (the server's stamp, or the
        // 3.4.15 file name). Rows imported from Trakt never move.
        if (/^tmdb:/i.test(key) && (row.fromTrakt || !rowFromCopy(row, mv.item))) continue;
        put(doc, fullKey, prefix + mv.to, row, stampFor(mv.item, libId));
        continue;
      }
      const lk = parseLocalKey(key);
      if (!lk || !lk.legacy || String(lk.libId) !== String(libId)) continue;
      stats.legacy++;
      const owner = resolveLegacyRow(row, lk.pos, prev);
      const target = targetFor(owner);
      if (target && target.key) put(doc, fullKey, prefix + target.key, row, stampFor(target.item, libId));
      else park(table, doc, fullKey, row, 'unconfirmed');
    }
  };
  // watch keys: <uid>:<profile>:<key>; watchlist keys: <uid>:<key>. Ids hold no ':'.
  walk('watch', watch, (full) => {
    const a = full.indexOf(':');
    const b = a < 0 ? -1 : full.indexOf(':', a + 1);
    return b < 0 ? null : { prefix: full.slice(0, b + 1), key: full.slice(b + 1) };
  });
  if (watchlist) {
    walk('watchlist', watchlist, (full) => {
      const a = full.indexOf(':');
      return a < 0 ? null : { prefix: full.slice(0, a + 1), key: full.slice(a + 1) };
    });
  }
  for (const [k, v] of Object.entries(orphans)) {
    if (!v || now - (Number(v.at) || 0) > ORPHAN_KEEP_MS) { delete orphans[k]; stats.purged++; }
  }
  return stats;
}

const splitWatch = (full) => {
  const a = full.indexOf(':');
  const b = a < 0 ? -1 : full.indexOf(':', a + 1);
  return b < 0 ? null : { prefix: full.slice(0, b + 1), key: full.slice(b + 1) };
};
const splitList = (full) => {
  const a = full.indexOf(':');
  return a < 0 ? null : { prefix: full.slice(0, a + 1), key: full.slice(a + 1) };
};

// Rows of local keys whose item left the library in this pass (and did not pair to a rename) are
// parked, so their cards stop saying "not available" (result 85 S-2). Catalog keys stay: the title
// still exists. The caller skips this on a pass that lost most of the library (a half-mounted share).
function parkVanished({ libId, watch, watchlist, orphans, prevItems, items, moves, watchKeyOf, now = Date.now() }) {
  const live = new Set(items.filter(Boolean).map((it) => watchKeyOf(it)));
  const moved = new Set(moves.map((m) => m.from));
  const gone = new Set();
  for (const it of prevItems) {
    if (!it || !it.key) continue;
    const k = watchKeyOf(it);
    if (!k || /^tmdb:/i.test(k) || live.has(k) || moved.has(k)) continue;
    gone.add(k);
  }
  let parked = 0;
  for (const [table, doc, split] of [['watch', watch, splitWatch], ['watchlist', watchlist, splitList]]) {
    for (const full of Object.keys(doc || {})) {
      const p = split(full);
      if (!p || !gone.has(p.key)) continue;
      orphans[full] = { row: doc[full], table, at: now, reason: 'gone', libId, key: p.key };
      delete doc[full];
      parked++;
    }
  }
  return parked;
}

// A parked row whose item is back (the file returned, the share came back) goes back where it was.
function restoreReturned({ libId, watch, watchlist, orphans, items, watchKeyOf }) {
  const live = new Set(items.filter(Boolean).map((it) => watchKeyOf(it)));
  let restored = 0;
  for (const [full, v] of Object.entries(orphans)) {
    if (!v || String(v.libId) !== String(libId) || !v.key || !live.has(v.key)) continue;
    const doc = v.table === 'watchlist' ? watchlist : watch;
    if (!doc || doc[full]) { delete orphans[full]; continue; }
    doc[full] = v.row;
    delete orphans[full];
    restored++;
  }
  return restored;
}

// Library deleted: its local rows are parked for 30 days (catalog-keyed rows stay).
function parkLibraryRows({ libId, watch, watchlist, orphans, now = Date.now() }) {
  const re = new RegExp(`^local:${String(libId).replace(/[^\w-]/g, '')}:`);
  let parked = 0;
  for (const [table, doc, split] of [['watch', watch, splitWatch], ['watchlist', watchlist, splitList]]) {
    for (const full of Object.keys(doc || {})) {
      const p = split(full);
      if (!p || !re.test(p.key)) continue;
      orphans[full] = { row: doc[full], table, at: now, reason: 'library deleted', libId, key: p.key };
      delete doc[full];
      parked++;
    }
  }
  return parked;
}

module.exports = {
  parkVanished, restoreReturned, parkLibraryRows,
  ORPHAN_KEEP_MS, normTitle, savedTitleParts, titlesOf, rowConfirms, resolveLegacyRow, planMoves,
  applyLibraryMoves, makeIndex,
};
