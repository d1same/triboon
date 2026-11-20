'use strict';

// Owner report 2026-11-19: leaving the player for a show's title page landed at the top or on another
// section, not on the episode just watched. These run the real return functions from web/index.html
// against a tiny fake DOM. Names are made up.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

function extractFunction(name) {
  let start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in web/index.html`);
  if (html.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  // Body starts at the first ") {" — a default param like `opts = {}` holds braces of its own.
  for (let i = html.indexOf(') {', start) + 2; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${name} has no end`);
}

// ---- tiny fake DOM: just enough selectors for the detail rows ----
class FakeClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) { const v = on === undefined ? !this.set.has(c) : !!on; if (v) this.set.add(c); else this.set.delete(c); return v; }
}
function parseCompound(sel) {
  const out = { id: null, classes: [], attrs: [] };
  const re = /#([\w-]+)|\.([\w-]+)|\[data-([\w-]+)="([^"]*)"\]/g;
  let m;
  while ((m = re.exec(sel))) {
    if (m[1]) out.id = m[1];
    else if (m[2]) out.classes.push(m[2]);
    else out.attrs.push([m[3].replace(/-(\w)/g, (_, c) => c.toUpperCase()), m[4]]);
  }
  return out;
}
function matchCompound(el, c) {
  if (c.id && el.id !== c.id) return false;
  if (!c.classes.every((x) => el.classList.contains(x))) return false;
  return c.attrs.every(([k, v]) => String(el.dataset[k]) === v);
}
function matches(el, sel) {
  const parts = sel.trim().split(/\s+/).map(parseCompound);
  if (!matchCompound(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  for (let p = el.parentNode; p && i >= 0; p = p.parentNode) if (matchCompound(p, parts[i])) i--;
  return i < 0;
}
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this.parentNode = null; this.id = '';
    this.classList = new FakeClassList(this); this.dataset = {}; this.style = {};
    this._scrollLeft = 0; this.textContent = '';
  }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classList.set].join(' '); }
  get scrollLeft() { return this._scrollLeft; }
  set scrollLeft(v) { this._scrollLeft = this.children.length ? Math.max(0, v) : 0; }
  get childElementCount() { return this.children.length; }
  get isConnected() { let p = this; while (p.parentNode) p = p.parentNode; return p === doc.root; }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.children; return s[s.indexOf(this) + 1] || null;
  }
  set innerHTML(v) {
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
    this._scrollLeft = 0; // a browser clamps scrollLeft to 0 once the row is emptied
    if (/class="art"/.test(v)) { const a = new FakeEl('div'); a.className = 'art'; this.appendChild(a); }
  }
  appendChild(c) { if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1); c.parentNode = this; this.children.push(c); return c; }
  addEventListener() {}
  setAttribute() {}
  focus() {}
  closest(sel) { for (let p = this; p; p = p.parentNode) if (p !== doc.root && matches(p, sel)) return p; return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (sel.split(',').some((s) => matches(c, s))) out.push(c); walk(c); });
    walk(this); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
let doc;
function freshDom() {
  const root = new FakeEl('html');
  doc = { root, body: new FakeEl('body'), createElement: (t) => new FakeEl(t),
    querySelector: (s) => root.querySelector(s), querySelectorAll: (s) => root.querySelectorAll(s), activeElement: null };
  root.appendChild(doc.body);
  const ids = {};
  for (const id of ['dPlay', 'dPlayed', 'seasonsTitle', 'seasonTabs', 'seasonGrid', 'epGrid', 'cwMenu', 'dStartOver']) {
    const el = new FakeEl(id === 'dPlay' || id === 'dPlayed' ? 'button' : 'div');
    el.id = id; ids[id] = el; doc.body.appendChild(el);
  }
  ids.seasonGrid.style.display = 'none'; ids.epGrid.style.display = 'none';
  return ids;
}
const focused = () => doc.querySelectorAll('.focus');

const NAMES = [
  'closingEpisodeFocus', 'episodeKeyParts', 'rememberPlayerReturnFocus', 'playerReturnFocusFor', 'playerReturnCard',
  'focusDetailAfterPlayer', 'refreshDetailEpisodesKeepingFocus',
  'keepRowScroll', 'appendAllSeasonsTab', 'focusRenderedDetailEpisode', 'openLocalShowSeasonEpisodes', 'openSeasonEpisodes',
];
function load() {
  const ids = freshDom();
  const S = { watchMap: {}, view: 'detail', pointer: false, detailReq: 1 };
  const calls = { api: [], scrolled: 0 };
  const stubs = {
    S, document: doc, $: (id) => ids[id],
    api: async (url) => {
      calls.api.push(url);
      const m = /\/api\/tmdb\/tv\/(\d+)\/season\/(\d+)/.exec(url);
      if (m) return { episodes: Array.from({ length: 10 }, (_, i) => ({ episode_number: i + 1, name: 'E' + (i + 1) })) };
      return {};
    },
    applyFocus: (el) => { focused().forEach((f) => f.classList.remove('focus')); if (el) el.classList.add('focus'); },
    retargetDetailFromEpisodeCard() {}, scrollDetailRowIntoView() {}, scrollDetailFocusIntoView: () => { calls.scrolled++; },
    bindEpisodeOptionsButton() {}, bindEdgeScroll() {}, play() {}, toast() {},
    artBackgroundHtml: () => '', artFallback: () => '', img: () => '', esc: (s) => String(s), pad2: (n) => String(n).padStart(2, '0'),
    localEpisodeDisplayName: (ep) => 'Episode ' + ep.e, STILL_W: 300, PAGE_CACHE_MS: 60000,
    todayStr: () => '2026-11-19', fmtDate: (d) => d,
    watchLooksFinished: (w) => !!(w && w.duration && w.position / w.duration > 0.92),
    localEpisodeItemOf: (show, ep) => ({ key: `local:L:${ep.idx}`, backdrop: '' }),
    epItemOf: (show, season, ep) => ({ key: `tmdb:tv:${show.tmdbId}:s${season.season_number || 1}e${ep.episode_number}` }),
  };
  const src = `const PLAYER_RETURN_FOCUS_MS = 30000;\n${NAMES.map(extractFunction).join('\n')}`;
  const fns = new Function(...Object.keys(stubs), `${src}\nreturn { ${NAMES.join(', ')} };`)(...Object.values(stubs));
  return { S, ids, fns, calls };
}
const card = (ids) => { const f = doc.querySelectorAll('.focus'); assert.equal(f.length, 1, 'exactly one focused control'); return f[0]; };

function catalogShow(t, seasons = 3) {
  const show = { title: 'Catalog Show', tmdbId: 77, type: 'tv' };
  t.S.detailItem = show; t.S.view = 'detail';
  t.S.detailSeasons = Array.from({ length: seasons }, (_, i) => ({ season_number: i + 1, name: 'Season ' + (i + 1), episode_count: 10 }));
  // The title page as it was under the player: the season covers (season grid) are showing.
  t.ids.seasonGrid.style.display = 'flex'; t.ids.epGrid.style.display = 'none';
  t.ids.dPlay.classList.add('focus');
  return show;
}
function libraryShow(t) {
  const show = { title: 'Library Show', _localShow: true, type: 'local-tv', _lib: { id: 'L' }, _showOpen: 4 };
  const eps = [
    { s: 1, e: 1, idx: 1 }, { s: 1, e: 2, idx: 2 },
    ...Array.from({ length: 8 }, (_, i) => ({ s: 2, e: i + 1, idx: 100 + i })),
  ];
  t.S.detailItem = show; t.S.localDetailEpisodes = eps;
  t.S.detailSeasons = [1, 2].map((n) => ({ season_number: n, name: 'Season ' + n, _local: true }));
  t.ids.seasonGrid.style.display = 'flex'; t.ids.epGrid.style.display = 'none';
  t.ids.dPlay.classList.add('focus');
  return show;
}

test('the return record knows the show and episode; a film or another show gets none', () => {
  const t = load();
  const rec = t.fns.rememberPlayerReturnFocus({ key: 'tmdb:tv:77:s2e5', tmdbId: 77, type: 'episode', season: 2, episode: 5 }, false);
  assert.equal(rec.season, 2); assert.equal(rec.episode, 5); assert.equal(rec.finished, false);
  assert.ok(t.fns.playerReturnFocusFor({ type: 'tv', tmdbId: 77 }), 'same catalog show');
  assert.equal(t.fns.playerReturnFocusFor({ type: 'tv', tmdbId: 78 }), null, 'another show');
  assert.equal(t.fns.playerReturnFocusFor({ type: 'movie', tmdbId: 77 }), null, 'a film page');
  t.S._playerReturnFocus.at -= 31000;
  assert.equal(t.fns.playerReturnFocusFor({ type: 'tv', tmdbId: 77 }), null, 'expires');
  assert.equal(t.fns.rememberPlayerReturnFocus({ key: 'tmdb:movie:9', tmdbId: 9, type: 'movie' }, true), null, 'a film leaves no record');
  const lrec = t.fns.rememberPlayerReturnFocus({ key: 'local:L:103', type: 'episode', season: 2, episode: 4, _lib: { id: 'L' }, _showOpen: 4 }, true);
  assert.equal(lrec.finished, true);
  assert.ok(t.fns.playerReturnFocusFor({ _localShow: true, _lib: { id: 'L' }, _showOpen: 4 }), 'same library show');
  assert.equal(t.fns.playerReturnFocusFor({ _localShow: true, _lib: { id: 'L' }, _showOpen: 5 }), null);
  // Continue Watching straight into the player: the item has only its watch key.
  t.fns.rememberPlayerReturnFocus({ key: 'local:L:101', type: 'episode', season: 2, episode: 2 }, false);
  t.S.localDetailEpisodes = [{ s: 2, e: 1, idx: 100 }, { s: 2, e: 2, idx: 101 }];
  assert.ok(t.fns.playerReturnFocusFor({ _localShow: true, _lib: { id: 'L' }, _showOpen: 0 }), 'matched by its episode key');
  t.S.localDetailEpisodes = [{ s: 1, e: 1, idx: 900 }];
  assert.equal(t.fns.playerReturnFocusFor({ _localShow: true, _lib: { id: 'L' }, _showOpen: 0 }), null, 'another show’s episodes do not match');
});

test('catalog show: back from season 2 episode 5 (unfinished) opens season 2 on THAT card, not Play or season 1', async () => {
  const t = load(); const show = catalogShow(t);
  t.fns.rememberPlayerReturnFocus({ key: 'tmdb:tv:77:s2e5', tmdbId: 77, type: 'episode', season: 2, episode: 5 }, false);
  const ok = await t.fns.focusDetailAfterPlayer(show, t.fns.playerReturnFocusFor(show));
  assert.equal(ok, true);
  assert.equal(t.ids.epGrid.style.display, 'flex', 'the episode row is showing');
  const f = card(t.ids);
  assert.ok(f.classList.contains('epCard'));
  assert.deepEqual([f.dataset.season, f.dataset.episode], ['2', '5']);
  assert.ok(t.calls.scrolled >= 1, 'the page scrolls the row into view');
});

test('catalog show: a finished episode returns to the NEXT episode (like a watched mark); the finale stays', async () => {
  const t = load(); const show = catalogShow(t);
  t.fns.rememberPlayerReturnFocus({ key: 'tmdb:tv:77:s2e5', tmdbId: 77, type: 'episode', season: 2, episode: 5 }, true);
  await t.fns.focusDetailAfterPlayer(show, t.fns.playerReturnFocusFor(show));
  assert.equal(card(t.ids).dataset.episode, '6');
  t.fns.rememberPlayerReturnFocus({ key: 'tmdb:tv:77:s2e10', tmdbId: 77, type: 'episode', season: 2, episode: 10 }, true);
  await t.fns.focusDetailAfterPlayer(show, t.fns.playerReturnFocusFor(show));
  assert.equal(card(t.ids).dataset.episode, '10', 'last episode of the season keeps focus');
});

test('one-season catalog show keeps its tab-free row', async () => {
  const t = load(); const show = catalogShow(t, 1);
  t.fns.rememberPlayerReturnFocus({ key: 'tmdb:tv:77:s1e3', tmdbId: 77, type: 'episode', season: 1, episode: 3 }, false);
  await t.fns.focusDetailAfterPlayer(show, t.fns.playerReturnFocusFor(show));
  assert.equal(card(t.ids).dataset.episode, '3');
  assert.equal(t.ids.seasonTabs.style.display, 'none', 'no Season 1 / All seasons tabs for a one-season show');
});

test('library (Persian-style) show: back opens the played season on that card; after Up next it is the last one played', async () => {
  const t = load(); const show = libraryShow(t);
  // Up next played S02E03 then S02E04; the player closed on S02E04, unfinished.
  t.fns.rememberPlayerReturnFocus({ key: 'local:L:103', type: 'episode', season: 2, episode: 4, _lib: { id: 'L' }, _showOpen: 4 }, false);
  assert.equal(await t.fns.focusDetailAfterPlayer(show, t.fns.playerReturnFocusFor(show)), true);
  const f = card(t.ids);
  assert.deepEqual([f.dataset.season, f.dataset.episode], ['2', '4']);
  assert.equal(t.ids.seasonGrid.style.display, 'none', 'episodes, not the season covers');
});

test('refresh after the watch save keeps the card the viewer moved to; a focus outside the row stays', async () => {
  const t = load(); const show = catalogShow(t);
  const rec = t.fns.rememberPlayerReturnFocus({ key: 'tmdb:tv:77:s2e5', tmdbId: 77, type: 'episode', season: 2, episode: 5 }, false);
  await t.fns.focusDetailAfterPlayer(show, rec);
  // The viewer moved right to E7 while the save was running.
  doc.querySelectorAll('.focus').forEach((e) => e.classList.remove('focus'));
  t.ids.epGrid.querySelectorAll('.epCard').find((c) => c.dataset.episode === '7').classList.add('focus');
  await t.fns.refreshDetailEpisodesKeepingFocus(show, rec);
  assert.equal(card(t.ids).dataset.episode, '7');
  doc.querySelectorAll('.focus').forEach((e) => e.classList.remove('focus'));
  t.ids.dPlayed.classList.add('focus');
  await t.fns.refreshDetailEpisodesKeepingFocus(show, rec);
  assert.equal(card(t.ids), t.ids.dPlayed, 'a control outside the row is not yanked');
});

test('every path back onto the title page uses the return record, before any watch-state wait', () => {
  const close = extractFunction('closePlayer');
  assert.match(close, /rememberPlayerReturnFocus\(closingItem, finished\)/, 'closePlayer records the episode it closed');
  const open = close.indexOf("if ($('detail').classList.contains('open')) {");
  const land = close.indexOf('await focusDetailAfterPlayer(show, rec)', open);
  const wait = close.indexOf('await loadWatchState(true)', open);
  assert.ok(open > 0 && land > open && land < wait, 'the open title page lands on the episode BEFORE the watch-state refetch');
  assert.match(close, /const rec = playerReturnFocusFor\(S\.detailItem\);\s*if \(rec\) refreshDetailEpisodesKeepingFocus\(S\.detailItem, rec\);/,
    'Continue Watching straight into the player: the refresh keeps the returned card');
  const detail = extractFunction('openDetail');
  assert.match(detail, /const playerReturn = playerReturnFocusFor\(it\);[\s\S]+focusDetailAfterPlayer\(it, playerReturn\)/,
    'a catalog title page opened from the player goes straight to the played season');
  const local = extractFunction('openLocalShowDetail');
  assert.match(local, /const playerReturn = playerReturnFocusFor\(show\);[\s\S]+await focusDetailAfterPlayer\(show, playerReturn\)\)\) renderLocalShowSeasonGrid/,
    'a library title page opened from the player goes straight to the played season');
  assert.match(extractFunction('queueDetailPlayEpisodeFocus'), /if \(playerReturnFocusFor\(show\)\) return;/,
    'the next-up auto-focus does not race the return');
});
