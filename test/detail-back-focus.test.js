'use strict';

// Owner report 2026-11-18: title A → a "More like this" cover → title B → Back (Android TV)
// landed on Play at the top of title A, not on the cover that was pressed. The Back restore ran
// one frame after A re-rendered, but the related row is a separate fetch, so the card did not
// exist yet and the restore fell back to Play.

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
  for (let i = html.indexOf(') {', start) + 2; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${name} has no end`);
}

function loadRelated() {
  const S = { view: 'detail', detailReq: 1 };
  const filled = [];
  const calls = [];
  const api = async (url) => { calls.push(url); await new Promise((r) => setTimeout(r, 20)); return { results: [{ id: url.length }] }; };
  const fn = new Function('S', 'api', 'fillDetailRelated', 'PAGE_CACHE_MS',
    `${extractFunction('loadDetailRelated')}\nreturn loadDetailRelated;`)(S, api, (it, recs) => filled.push(recs.length), 60000);
  return { S, fn, filled, calls };
}

test('"More like this" load returns a promise that resolves after the row is filled', async () => {
  const t = loadRelated();
  const p = t.fn({ type: 'movie', tmdbId: 7 }, {}, 1);
  assert.ok(p && typeof p.then === 'function', 'loadDetailRelated returns a promise');
  assert.equal(t.filled.length, 0, 'not filled before the fetch answers');
  await p;
  assert.equal(t.filled.length, 1, 'filled when the promise resolves');
  assert.equal(t.calls.length, 2);
});

test('Back to a title fills "More like this" at once from the per-title cache (no refetch)', async () => {
  const t = loadRelated();
  await t.fn({ type: 'movie', tmdbId: 7 }, {}, 1);
  t.S.detailReq = 2;
  const p = t.fn({ type: 'movie', tmdbId: 7 }, {}, 2);
  assert.equal(t.filled.length, 2, 'second visit fills synchronously');
  assert.equal(t.calls.length, 2, 'no second fetch');
  await p;
});

test('the Back restore waits for the related row before focusing a related cover', () => {
  const start = html.indexOf('const relatedReady = loadDetailRelated(it, d, reqId);');
  assert.ok(start >= 0, 'openDetail keeps the related promise');
  const block = html.slice(start, start + 900);
  assert.match(block, /snap\.focusKind === 'related' \? relatedReady : Promise\.resolve\(\)/);
  assert.match(block, /ready\.then\(\(\) => requestAnimationFrame\([\s\S]+restoreLeavingDetailFocus\(snap\)/);
  assert.match(extractFunction('queueDetailPlayEpisodeFocus'), /S\._detailRestore\) return;/,
    'the next-up episode auto-focus does not race the Back restore');
});

test('restoreLeavingDetailFocus lands on the remembered related cover and keeps the page scroll', () => {
  const mk = (cls) => ({ cls: new Set(cls.split(' ')), classList: null });
  const cards = [0, 1, 2, 3, 4].map(() => {
    const c = mk('pcard focusable');
    c.classList = { contains: (x) => c.cls.has(x), add: (x) => c.cls.add(x), remove: (x) => c.cls.delete(x) };
    return c;
  });
  const scroller = { style: {}, scrollTop: 0 };
  const row = { scrollLeft: 0 };
  const detail = { classList: { contains: () => true }, querySelector: () => scroller };
  const S = { view: 'detail', detailItem: { type: 'movie', tmdbId: 1 } };
  let focused = null;
  const fn = new Function('S', '$', 'document', 'applyFocus', 'detailRelatedCards', 'sameDetailIdentity',
    'focusRenderedDetailEpisode', 'openSeasonEpisodes', 'openLocalShowSeasonEpisodes',
    `${extractFunction('restoreLeavingDetailFocus')}\nreturn restoreLeavingDetailFocus;`)(
    S, (id) => (id === 'detail' ? detail : id === 'relatedRow' ? row : null), { querySelectorAll: () => [] },
    (el) => { focused = el; }, () => cards, (a, b) => a.tmdbId === b.tmdbId, () => false, () => {}, () => {});
  const ok = fn({ item: { type: 'movie', tmdbId: 1 }, focusKind: 'related', relatedIdx: 3, relatedScrollLeft: 540, detailScrollTop: 1200 });
  assert.equal(ok, true);
  assert.equal(focused, cards[3], 'focus on the 4th related cover');
  assert.equal(row.scrollLeft, 540);
  assert.equal(scroller.scrollTop, 1200, 'page scroll restored, not the top');
});
