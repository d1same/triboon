'use strict';
// Close misspellings in Search: "frekestein" must still surface Frankenstein.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}
function dist(a, b) {
  a = String(a || ''); b = String(b || '');
  const m = a.length, n = b.length;
  if (a === b) return 0;
  if (!m) return n;
  if (!n) return m;
  if (Math.abs(m - n) > 4) return 99;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const cur = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = cur;
    }
  }
  return dp[n];
}
function closeWord(a, b) {
  if (a === b || a + 's' === b || b + 's' === a) return true;
  const maxL = Math.max(a.length, b.length);
  if (maxL < 4) return false;
  const d = dist(a, b);
  return d <= 2 || (maxL >= 8 && d <= 4) || d / maxL <= 0.35;
}
function closeTitle(query, title) {
  const qw = words(query), tw = words(title);
  if (!qw.length || !tw.length) return false;
  if (closeWord(qw.join(''), tw.join(''))) return true;
  return qw.every((w) => tw.some((t) => closeWord(w, t) || t.startsWith(w) || w.startsWith(t)));
}
function wholeTitleClose(query, title) {
  const qk = words(query).join('');
  if (qk.length < 4) return false;
  if (closeWord(qk, words(title).join(''))) return true;
  const tw = words(title);
  const noArt = tw[0] && ['the', 'a', 'an'].includes(tw[0]) ? tw.slice(1) : tw;
  if (noArt.length && closeWord(qk, noArt.join(''))) return true;
  if (noArt.length >= 2 && noArt[0].length === 1 && closeWord(qk, noArt.slice(1).join(''))) return true;
  return false;
}

test('search close-title: common typos still match the real name', () => {
  assert.ok(closeTitle('frekestein', 'Frankenstein'), 'frekestein → Frankenstein');
  assert.ok(closeTitle('frankenstien', 'Frankenstein'), 'transposed ie');
  assert.ok(closeTitle('avngers', 'Avengers'), 'dropped letter');
  assert.ok(closeTitle('godfater', 'The Godfather'), 'missing h + leading The');
  assert.ok(closeTitle('harry poter', 'Harry Potter'), 'one-letter word typo');
  assert.ok(closeTitle('strager things', 'Stranger Things'), 'dropped n');
  assert.ok(closeTitle('lord of the ringz', 'The Lord of the Rings'), 'z for s');
  assert.ok(closeTitle('matrice', 'The Matrix'), 'extra letters on a short title');
  assert.ok(closeTitle('batman', 'Batman'), 'exact still matches');
  assert.ok(!closeTitle('zzz', 'Frankenstein'), 'unrelated junk stays out');
  assert.ok(!closeTitle('cars', 'Frankenstein'), 'short unrelated stays out');
  assert.ok(wholeTitleClose('frankestein', 'Frankenstein'), 'frankestein is the Frankenstein title');
  assert.ok(wholeTitleClose('frankenstein', 'I, Frankenstein'), 'I, Frankenstein still counts as a Frankenstein title');
  assert.ok(!wholeTitleClose('frankestein', 'Young Frankenstein'), 'Young Frankenstein must not cancel Did you mean');
});

test('search close-title: UI shows a Did you mean chip and retries TMDB', () => {
  assert.match(ui, /id="searchSuggest"/);
  assert.match(ui, /Did you mean <b>\$\{esc\(String\(title\)\)\}<\/b>\?/);
  assert.match(ui, /function showSearchSuggest\(hint, original\)/);
  assert.match(ui, /function applySearchSuggest\(\)/);
  assert.match(ui, /showSearchSuggest\(closestCatalogTitle\(q\), q\)/);
  assert.match(ui, /const closeHit = ok\.some\(\(x\) => searchWholeTitleClose\(q, x\.title \|\| x\.name \|\| ''\)\)/);
  assert.match(ui, /const serverHint = r\.didYouMean \|\| ''/);
  assert.match(ui, /closestCatalogTitle\(q\)[\s\S]+\/api\/tmdb\/search\/multi\?query=' \+ encodeURIComponent\(hintTitle\)/);
  assert.match(ui, /watchlistMap[\s\S]+S\.watchlist/);
  assert.match(ui, /liveChannelMatchesQuery\(ch, q\) \{[\s\S]+searchCloseTitle\(q, \(ch && ch\.name\) \|\| ''\)/);
  assert.match(ui, /const SEARCH_CLOSE_SEEDS = \[[\s\S]+'Frankenstein'[\s\S]+for \(const title of SEARCH_CLOSE_SEEDS\)/);
});

test('search close-title: server retries TMDB with a cached close title', () => {
  assert.match(idx, /async function tmdbSearchCloseHint\(route, search, data\)/);
  assert.match(idx, /data = await tmdbSearchCloseHint\(ctx\.m\[1\], search, data\)/);
  assert.match(idx, /didYouMean: hint, originalQuery: q/);
  assert.match(idx, /function cachedTmdbTitles\(\)/);
  assert.match(idx, /closestTitleInList\(q, cachedTmdbTitles\(\)\)/);
  assert.match(idx, /closestTitleInList\(q, SEARCH_CLOSE_SEEDS\)/);
  assert.match(idx, /function searchWholeTitleClose\(query, title\)/);
  assert.match(idx, /tmdbListHasCloseTitle[\s\S]+searchWholeTitleClose\(q, x\.title/);
});
