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
function fuzzLimit(len) {
  if (len <= 2) return 0;
  if (len <= 5) return 1;
  return 2;
}
function closeWord(a, b, singleToken) {
  if (a === b || a + 's' === b || b + 's' === a) return true;
  const d = dist(a, b);
  if (d <= fuzzLimit(a.length) && d <= fuzzLimit(b.length)) return true;
  if (singleToken && a.length >= 6 && d <= 3 && Math.abs(a.length - b.length) <= 2) return true;
  return false;
}
function wordAffix(a, b) {
  if (Math.min(a.length, b.length) < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}
function contentWords(list) {
  const stop = new Set(['the', 'a', 'an', 'of']);
  const content = list.filter((w) => !stop.has(w));
  return content.length ? content : list;
}
function closeTitle(query, title) {
  const qw = words(query), tw = words(title);
  if (!qw.length || !tw.length) return false;
  const need = contentWords(qw);
  const single = need.length === 1;
  return need.every((w) => tw.some((t) => closeWord(w, t, single) || wordAffix(w, t)));
}
function wholeTitleClose(query, title) {
  const qw = words(query);
  const qk = qw.join('');
  if (qk.length < 4) return false;
  const single = contentWords(qw).length === 1;
  if (closeWord(qk, words(title).join(''), single)) return true;
  const tw = words(title);
  const noArt = tw[0] && ['the', 'a', 'an'].includes(tw[0]) ? tw.slice(1) : tw;
  if (noArt.length && closeWord(qk, noArt.join(''), single)) return true;
  if (noArt.length >= 2 && noArt[0].length === 1 && closeWord(qk, noArt.slice(1).join(''), single)) return true;
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
  assert.ok(closeTitle('oddyse', 'Odyssey'), 'oddyse → Odyssey');
  assert.ok(closeTitle('oddyse', 'The Odyssey'), 'oddyse → The Odyssey');
  assert.ok(closeTitle('office', 'The Office'), 'office → The Office');
  assert.ok(closeTitle('longst yard', 'The Longest Yard'), 'longst yard → The Longest Yard');
  assert.ok(!closeTitle('longst yard', 'The Lord of the Rings'), 'yard must not become lord');
  assert.ok(!closeTitle('office', 'The Lord of the Rings'), 'office must not match a title just because it has of');
  assert.ok(!closeTitle('office', 'Game of Thrones'), 'office must not match Game of Thrones');
  assert.ok(!closeTitle('office', 'Off Campus'), 'office must not beat The Office with Off Campus');
  assert.ok(closeTitle('matrice', 'The Matrix'), 'extra letters on a short title');
  assert.ok(closeTitle('batman', 'Batman'), 'exact still matches');
  assert.ok(!closeTitle('zzz', 'Frankenstein'), 'unrelated junk stays out');
  assert.ok(!closeTitle('cars', 'Frankenstein'), 'short unrelated stays out');
  assert.ok(wholeTitleClose('frankestein', 'Frankenstein'), 'frankestein is the Frankenstein title');
  assert.ok(wholeTitleClose('frankenstein', 'I, Frankenstein'), 'I, Frankenstein still counts as a Frankenstein title');
  assert.ok(!wholeTitleClose('frankestein', 'Young Frankenstein'), 'Young Frankenstein must not cancel Did you mean');
  assert.ok(wholeTitleClose('office', 'The Office'), 'office is the Office title');
});

test('search close-title: UI shows a Did you mean chip and retries TMDB', () => {
  assert.match(ui, /id="searchSuggest"/);
  assert.match(ui, /function catalogSearchSuggestions\(q\)/);
  assert.match(ui, /label\.textContent = i === 0 \? 'Showing results for' : 'Also try'/);
  assert.match(ui, /if \(i === 0\) btn\.id = 'searchSuggestBtn'/);
  assert.match(ui, /function showSearchSuggest\(hint, original\)/);
  assert.match(ui, /function applySearchSuggest\(hint\)/);
  assert.match(ui, /showSearchSuggest\(catalogSearchSuggestions\(q\), q\)/);
  assert.match(ui, /const closeHit = ok\.some\(\(x\) => searchWholeTitleClose\(q, x\.title \|\| x\.name \|\| ''\)\)/);
  assert.match(ui, /const serverHint = r\.didYouMean \|\| ''/);
  assert.doesNotMatch(ui, /encodeURIComponent\(hintTitle\)/);
  assert.match(ui, /function spellcheckQuery\(q\)/);
  assert.match(ui, /function paintInstantSearch\(q\)/);
  assert.match(ui, /function scoreSearchTitles\(q\)/);
  assert.match(ui, /watchlistMap[\s\S]+S\.watchlist/);
  assert.match(ui, /liveChannelMatchesQuery\(ch, q\) \{[\s\S]+searchCloseTitle\(q, \(ch && ch\.name\) \|\| ''\)/);
  assert.match(ui, /const SEARCH_CLOSE_SEEDS = \[[\s\S]+'Frankenstein'[\s\S]+'Odyssey'[\s\S]+'The Longest Yard'/);
  assert.match(ui, /for \(const title of SEARCH_CLOSE_SEEDS\) add\(title\)/);
  assert.match(ui, /setTimeout\(doSearch, 120\)/);
  assert.match(ui, /function searchSuggestRank\(q, title\)/);
  assert.match(ui, /function searchFuzzLimit\(len\)/);
  assert.match(ui, /if \(Math\.min\(a\.length, b\.length\) < 4\) return false;/);
  assert.match(ui, /'The Longest Yard'/);
  assert.match(idx, /'The Longest Yard'/);
  assert.match(ui, /scored\.sort\(\(a, b\) => b\.rank - a\.rank \|\| a\.d - b\.d\)/);
});

test('search suggestions hang under the field and D-pad walks them', () => {
  assert.match(ui, /#searchSuggest\{display:none;position:relative;left:0;width:min\(680px,100%\);margin-top:4px/);
  assert.match(ui, /<\/div>\s*<div id="searchSuggest"/, 'suggestions sit beside the wrap, not inside it, so the mic cannot jump');
  assert.match(ui, /#micBtn:focus,#micBtn\.focusable\.focus[\s\S]+transform:translateY\(-50%\)!important/);
  assert.match(ui, /function moveSearchDownFromField\(\) \{[\s\S]+if \(searchSuggestVisible\(\)\) return focusSearchSuggest\(0\)/);
  assert.match(ui, /if \(e\.key === 'ArrowDown'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); moveSearchDownFromField\(\); \}/);
  assert.match(ui, /if \(k === 'ArrowDown'\) \{[\s\S]+moveSearchDownFromField\(\)/);
  assert.match(ui, /if \(S\.view === 'search'\) return moveSearchUpFromResults\(\)/);
  assert.match(ui, /function moveSearchUpFromResults\(\) \{[\s\S]+focusSearchSuggest\(els\.length - 1\)/);
  assert.doesNotMatch(ui, /if \(k === 'ArrowRight' && searchClearVisible\(\)\) \{ document\.activeElement\.blur\(\); return focusSearchClear\(\); \}/);
  assert.match(ui, /closest\('#searchSuggest'\)[\s\S]+if \(k === 'ArrowRight'\) return;/);
  assert.match(ui, /function focusSearchResultsNow\(\)/);
  assert.match(ui, /document\.activeElement\.closest\('#searchSuggest'\)/);
  assert.match(ui, /function syncSearchSuggestPad\(\) \{[\s\S]+setProperty\('padding-top', pad \+ 'px', 'important'\)/);
  assert.match(ui, /#browse\.searchMode\.hasSuggest\{padding-top:168px!important\}/);
  assert.match(ui, /body\.tv #browse\.searchMode\.hasSuggest\{padding-top:168px!important\}/);
  assert.match(ui, /body\.mobileShell #browse\.searchMode\.hasSuggest\{padding-top:204px!important\}/);
  assert.match(ui, /const floor = open \? \(mobile \? 204 : 168\) : \(mobile \? 146 : 110\)/);
  assert.doesNotMatch(ui, /#searchBar\.hasSuggest\{min-height:148px\}/);
  assert.doesNotMatch(ui, /open \? 248 : 110/);
  assert.match(ui, /\.searchSuggestItem\{display:block[\s\S]+transform:none!important\}/);
  assert.match(ui, /#searchBar\.hasMic \.searchSuggestItem[\s\S]+padding-left:58px/);
  assert.match(ui, /\.searchSuggestItem:hover,\.searchSuggestItem\.focusable\.focus[\s\S]+transform:none!important/);
  assert.match(ui, /if \(!S\.gridItems\.length\) grid\.innerHTML = '<div class="gridMore">No matches\.<\/div>';\s*\n\s*syncSearchSuggestPad\(\);/);
});

test('search close-title: server retries TMDB with a cached close title', () => {
  assert.match(idx, /async function tmdbSearchWithCloseHint\(route, search\)/);
  assert.match(idx, /const data = await tmdbSearchWithCloseHint\(ctx\.m\[1\], search\)/);
  assert.match(idx, /didYouMean: hint, spellQuery: fixed, originalQuery: q/);
  assert.match(idx, /function cachedTmdbTitles\(\)/);
  assert.match(idx, /function spellcheckQuery\(q\)/);
  assert.match(idx, /hintP = tmdb\.get\('\/' \+ route \+ '\?' \+ hp\.toString\(\)\)/);
  assert.match(idx, /'The Odyssey', '2001: A Space Odyssey', 'Odyssey'/);
  assert.match(idx, /function searchWholeTitleClose\(query, title\)/);
  assert.match(idx, /tmdbListHasCloseTitle[\s\S]+searchWholeTitleClose\(q, x\.title/);
});
