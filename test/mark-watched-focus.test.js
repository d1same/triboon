'use strict';

// Owner report 2026-11-17: on a title page, marking an episode watched sent D-pad focus to Play
// ("I have to go down again"); the same for seasons. A watched mark re-renders the row with
// innerHTML, which destroys the focused card; with no .focus left the detail key handler restarts
// at row 0 (Play). These run the real mark + render functions from web/index.html against a tiny
// fake DOM and check where .focus ends up and that the row keeps its scroll position.

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
  'markFocusGone', 'episodeMarkFocusPlan', 'seasonMarkFocusSeason', 'renderedEpisodeCardByKey',
  'focusDetailMarkCard', 'focusSeasonCardAfterMark', 'keepRowScroll', 'appendAllSeasonsTab',
  'focusRenderedDetailEpisode', 'setLocalEpisodeWatched', 'openLocalShowSeasonEpisodes',
  'localEpisodeGroupWatched', 'markLocalEpisodeGroupWatched', 'isLocalSeasonWatched', 'renderLocalShowSeasonGrid',
  'setEpisodeWatched', 'openSeasonEpisodes', 'isSeasonWatched', 'renderSeasonGrid', 'markSeasonWatched', 'markShowWatched',
];
function load() {
  const ids = freshDom();
  const S = { watchMap: {}, view: 'detail', pointer: false };
  const calls = { api: [] };
  const stubs = {
    S, document: doc, $: (id) => ids[id],
    api: async (url, o) => {
      calls.api.push(url);
      const m = /\/api\/tmdb\/tv\/(\d+)\/season\/(\d+)/.exec(url);
      if (m) return { episodes: Array.from({ length: 12 }, (_, i) => ({ episode_number: i + 1, name: 'E' + (i + 1) })) };
      return {};
    },
    trackWatchPost: (p) => p, upsertWatchCache() {}, removeWatchCacheKey() {}, invalidateWatchCache() {},
    wlMeta: () => ({}), pickLocalShowPlayTarget() {}, pickNextUp() {}, toast() {}, play() {},
    applyFocus: (el) => { focused().forEach((f) => f.classList.remove('focus')); if (el) el.classList.add('focus'); },
    retargetDetailFromEpisodeCard() {}, scrollDetailRowIntoView() {}, bindEpisodeOptionsButton() {}, bindEdgeScroll() {},
    artBackgroundHtml: () => '', artFallback: () => '', img: () => '', esc: (s) => String(s), pad2: (n) => String(n).padStart(2, '0'),
    localEpisodeDisplayName: (ep) => 'Episode ' + ep.e, seasonEpisodeCountLabel: () => '', seasonYearLabel: () => '',
    openSeasonMenu() {}, CARD_MENU_DOTS: '…', STILL_W: 300, POSTER_W: 300, PAGE_CACHE_MS: 60000,
    todayStr: () => '2026-11-17', fmtDate: (d) => d,
    localEpisodeItemOf: (show, ep) => ({ key: `local:L:${ep.idx}`, backdrop: '' }),
    epItemOf: (show, season, ep) => ({ key: `tmdb:tv:${show.tmdbId}:s${season.season_number || 1}e${ep.episode_number}` }),
  };
  const src = NAMES.map(extractFunction).join('\n');
  const fns = new Function(...Object.keys(stubs), `${src}\nreturn { ${NAMES.join(', ')} };`)(...Object.values(stubs));
  return { S, ids, fns, calls };
}

// Persian-style local show: season 1 has a gap (E1, E2, E4) — "next" is the next card, not e+1.
function localShow(t) {
  const show = { title: 'Local Show', _localShow: true, _lib: { id: 'L' } };
  const eps = [
    { s: 1, e: 1, idx: 1 }, { s: 1, e: 2, idx: 2 }, { s: 1, e: 4, idx: 4 },
    ...Array.from({ length: 10 }, (_, i) => ({ s: 2, e: i + 1, idx: 100 + i })),
  ];
  t.S.detailItem = show; t.S.localDetailEpisodes = eps;
  t.S.detailSeasons = [1, 2, 3].map((n) => ({ season_number: n, name: 'Season ' + n, episode_count: 3, _local: true,
    _episodeKeys: eps.filter((ep) => ep.s === n).map((ep) => `local:L:${ep.idx}`) }));
  return { show, eps };
}
const card = (ids, ep) => ids.epGrid.querySelectorAll('.epCard').find((c) => c.dataset.episode === String(ep));
const cardAfterMark = (ids) => { const f = focused(); assert.equal(f.length, 1, 'exactly one focused control after the mark'); return f[0]; };

test('pure: episodeMarkFocusPlan moves to the next card in row order, stays on unmark and on the last card', () => {
  const t = load(); const { show } = localShow(t);
  t.fns.openLocalShowSeasonEpisodes(show, 1);
  const [c1, c2, c4] = t.ids.epGrid.querySelectorAll('.epCard');
  assert.deepEqual(t.fns.episodeMarkFocusPlan(c1, c1, true), { mode: 'marked', key: 'local:L:2', episode: 2 });
  assert.deepEqual(t.fns.episodeMarkFocusPlan(c2, c2, true), { mode: 'marked', key: 'local:L:4', episode: 4 }, 'gap: E2 → E4');
  assert.deepEqual(t.fns.episodeMarkFocusPlan(c4, c4, true), { mode: 'marked', key: 'local:L:4', episode: 4 }, 'last card stays');
  assert.deepEqual(t.fns.episodeMarkFocusPlan(c2, c2, false), { mode: 'marked', key: 'local:L:2', episode: 2 }, 'unmark stays');
  assert.deepEqual(t.fns.episodeMarkFocusPlan(null, c1, true).key, 'local:L:2', 'focus already gone → still the next card');
  assert.deepEqual(t.fns.episodeMarkFocusPlan(c4, c1, true), { mode: 'other', key: 'local:L:4', episode: 4 }, 'user moved during the save');
  assert.deepEqual(t.fns.episodeMarkFocusPlan(t.ids.dPlayed, c1, true), { mode: 'none' }, 'a surviving control is not yanked');
  assert.equal(t.fns.seasonMarkFocusSeason(null, 2), 2);
  assert.equal(t.fns.seasonMarkFocusSeason(t.ids.dPlayed, 2), null);
});

test('library (local/Persian) show: marking an episode watched from its menu lands on the NEXT episode, never Play', async () => {
  const t = load(); const { show } = localShow(t);
  t.fns.openLocalShowSeasonEpisodes(show, 1);
  // closeCwMenu hands focus back to the card the menu opened from, then the mark runs.
  t.ids.epGrid.scrollLeft = 340;
  card(t.ids, 1).classList.add('focus');
  await t.fns.setLocalEpisodeWatched({ key: 'local:L:1' }, true, 1);
  assert.equal(cardAfterMark(t.ids).dataset.episode, '2', 'E1 watched → E2');
  assert.equal(t.ids.epGrid.scrollLeft, 340, 'the episode row keeps its scroll position');
  await t.fns.setLocalEpisodeWatched({ key: 'local:L:2' }, true, 1);
  assert.equal(cardAfterMark(t.ids).dataset.episode, '4', 'gap in numbers: E2 → E4 (next card)');
  await t.fns.setLocalEpisodeWatched({ key: 'local:L:4' }, true, 1);
  assert.equal(cardAfterMark(t.ids).dataset.episode, '4', 'last episode of the season keeps focus');
  await t.fns.setLocalEpisodeWatched({ key: 'local:L:4' }, false, 1);
  assert.equal(cardAfterMark(t.ids).dataset.episode, '4', 'unmark stays on the same episode');
});

test('library show: a focus that moved elsewhere during the save is left alone', async () => {
  const t = load(); const { show } = localShow(t);
  t.fns.openLocalShowSeasonEpisodes(show, 1);
  t.ids.dPlayed.classList.add('focus');
  await t.fns.setLocalEpisodeWatched({ key: 'local:L:1' }, true, 1);
  assert.equal(cardAfterMark(t.ids), t.ids.dPlayed);
});

test('library show: marking a season from the season grid keeps the grid, focus and scroll (stale detailSeason)', async () => {
  const t = load(); const { show, eps } = localShow(t);
  t.fns.openLocalShowSeasonEpisodes(show, 1);           // visited season 1 episodes…
  t.fns.renderLocalShowSeasonGrid(show, t.S.detailSeasons); // …then went to "All seasons"
  t.ids.seasonGrid.scrollLeft = 120;
  t.ids.seasonGrid.querySelectorAll('.seasonCard')[1].classList.add('focus');
  await t.fns.markLocalEpisodeGroupWatched(show, eps.filter((ep) => ep.s === 2), true, '', { season: 2 });
  assert.equal(t.ids.epGrid.style.display, 'none', 'still on the season grid, not season 1 episodes');
  const f = cardAfterMark(t.ids);
  assert.ok(f.classList.contains('seasonCard') && f.dataset.season === 2, 'focus stays on the Season 2 card');
  assert.equal(t.ids.seasonGrid.scrollLeft, 120, 'season row keeps its scroll position');
});

test('library show: the title-page watched button keeps focus on itself', async () => {
  const t = load(); const { show, eps } = localShow(t);
  t.fns.openLocalShowSeasonEpisodes(show, 1);
  t.ids.dPlayed.classList.add('focus');
  await t.fns.markLocalEpisodeGroupWatched(show, eps, true, '');
  assert.equal(cardAfterMark(t.ids), t.ids.dPlayed);
});

function tmdbShow(t) {
  const show = { title: 'Catalog Show', tmdbId: 77, type: 'tv' };
  t.S.detailItem = show; t.S.detailReq = 1; t.S.view = 'detail';
  t.S.detailSeasons = [1, 2, 3].map((n) => ({ season_number: n, name: 'Season ' + n, episode_count: 12 }));
  return show;
}

test('catalog (TMDB) show: watched → next episode, unwatched → same, row scroll kept, no loading flash', async () => {
  const t = load(); const show = tmdbShow(t);
  await t.fns.openSeasonEpisodes(show, 1);
  t.ids.epGrid.scrollLeft = 900;
  card(t.ids, 7).classList.add('focus');
  await t.fns.setEpisodeWatched({ key: 'tmdb:tv:77:s1e7' }, { episode_number: 7 }, show, 1, true);
  assert.equal(cardAfterMark(t.ids).dataset.episode, '8');
  assert.equal(t.ids.epGrid.scrollLeft, 900, 'episode row keeps its scroll position');
  await t.fns.setEpisodeWatched({ key: 'tmdb:tv:77:s1e8' }, { episode_number: 8 }, show, 1, false);
  assert.equal(cardAfterMark(t.ids).dataset.episode, '8', 'unmark stays');
  card(t.ids, 8).classList.remove('focus'); card(t.ids, 12).classList.add('focus');
  await t.fns.setEpisodeWatched({ key: 'tmdb:tv:77:s1e12' }, { episode_number: 12 }, show, 1, true);
  assert.equal(cardAfterMark(t.ids).dataset.episode, '12', 'season finale keeps focus on itself');
});

test('catalog show: season mark and "mark whole show" from the season menu keep focus on that season card', async () => {
  const t = load(); const show = tmdbShow(t);
  t.fns.renderSeasonGrid(show, t.S.detailSeasons);
  t.ids.seasonGrid.scrollLeft = 60;
  const s3 = () => t.ids.seasonGrid.querySelectorAll('.seasonCard')[2];
  s3().classList.add('focus');
  await t.fns.markSeasonWatched(show, t.S.detailSeasons[2], true);
  assert.equal(cardAfterMark(t.ids).dataset.season, 3);
  assert.equal(t.ids.seasonGrid.scrollLeft, 60);
  await t.fns.markShowWatched(show, true, { season: 3 });
  assert.equal(cardAfterMark(t.ids).dataset.season, 3, 'whole-show mark from Season 3 menu stays on Season 3');
  assert.equal(t.ids.seasonGrid.scrollLeft, 60);
});

test('catalog show: the title-page watched button on an episode list keeps the list and its own focus', async () => {
  const t = load(); const show = tmdbShow(t);
  await t.fns.openSeasonEpisodes(show, 2);
  t.ids.dPlayed.classList.add('focus');
  await t.fns.markShowWatched(show, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(t.ids.epGrid.style.display, 'flex', 'still on the season 2 episode list');
  assert.equal(cardAfterMark(t.ids), t.ids.dPlayed);
});
