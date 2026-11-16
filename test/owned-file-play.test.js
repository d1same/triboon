'use strict';

// Play of a file you own (result 87). A local file whose name gives no resolution (3.4.14 folder
// titles drop "[1080p]") must not be skipped for a 4K guess, and when a usenet Play fails for a
// title with a local copy under the same key, the page plays the local copy once. Names made up.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${name} has no end`);
}

function fitsWithRank(rank) {
  // eslint-disable-next-line no-new-func
  return new Function('localPlaybackRankForItem', `${extractFunction('localPlaybackFitsQuality')}; return localPlaybackFitsQuality;`)(() => rank);
}

test('an owned file with no resolution in its name fits a 4K Play; a file known to be 1080p still lets usenet try 4K first', () => {
  assert.strictEqual(fitsWithRank(null)({}, 4), true, 'unknown rank: play the owned file');
  assert.strictEqual(fitsWithRank(undefined)({}, 4), true);
  assert.strictEqual(fitsWithRank(4)({}, 4), true, 'a 4K file fits 4K');
  assert.strictEqual(fitsWithRank(3)({}, 4), false, 'a file KNOWN to be 1080p: usenet first (the player contract)');
  assert.strictEqual(fitsWithRank(4)({}, 3), false, 'a 1080p Play still skips a 4K file');
  assert.strictEqual(fitsWithRank(3)({}, 3), true);
  assert.strictEqual(fitsWithRank(null)({}, 3), true);
  assert.strictEqual(fitsWithRank(3)({}, null), true, 'no wanted class: always fits');
});

test('a movie you own is never marked Unavailable by an empty usenet answer that beat the library lookup', () => {
  const start = html.indexOf('async function checkAvailability(it) {');
  const avail = html.slice(start, html.indexOf('function closeDetail() {', start));
  const guard = avail.indexOf('if (!playable && Array.isArray(r.errors) && r.errors.length) {');
  const owned = avail.indexOf("if (!playable && !hasLocal && it.type === 'movie') {");
  const verdict = avail.indexOf('if (!playable && (hadStrongIds || !searchItem.tmdbId)) {');
  assert.ok(guard > 0 && owned > guard && verdict > owned, 'after the indexer-outage branch, before the Unavailable verdict');
  const block = avail.slice(owned, verdict);
  assert.match(block, /startLocalPlaybackLookup\(searchItem\);\s*const owned = await Promise\.race\(\[Promise\.resolve\(searchItem\._localLookupPromise \|\| null\), waitMs\(3000, null\)\]\);/,
    'the library lookup is finished (bounded) before any verdict');
  assert.match(block, /if \(reqId !== S\.detailReq\) return;\s*if \(owned \|\| localTitleHasPlayback\(searchItem\) \|\| localTitleHasPlayback\(it\)\) return;/,
    'an owned film keeps Play, and a page the viewer left is not touched');
});

test('a failed usenet Play falls back to the local copy once, after the local lookup finishes, and says so in the log', () => {
  const play = extractFunction('playStart');
  const at = play.indexOf("await api('/api/play'");
  assert.ok(at > 0, 'playStart calls /api/play');
  const catchAt = play.indexOf('} catch (e) {', at);
  const block = play.slice(catchAt, play.indexOf('closePlayer();', catchAt));
  assert.match(block, /const restricted = !!\(e && e\.detail && e\.detail\.restricted\);/, 'an age-gate refusal never falls back');
  assert.match(block, /if \(!picked && !restricted && !it\._usenetFellBackToLocal\) \{/, 'one fallback only, and not for a hand-picked release');
  assert.match(block, /if \(!fallback && it\._localLookupPromise\) \{[\s\S]+await Promise\.race\(\[it\._localLookupPromise/, 'a still-running local lookup is finished first');
  assert.match(block, /postPlayNote\('trace', `usenet Play failed \(\$\{why\}\) — playing the library file instead`, it\);/, 'the server log says so');
  assert.match(block, /return playLocal\(\{ \.\.\.fallback, _usenetFellBackToLocal: true \}/, 'the local copy plays, marked so it never loops');
  // The older "nothing found" fallback stays first (and now logs); the broader one follows it, so a
  // usenet failure of any other kind falls back too.
  const oldAt = block.indexOf('if (localExact && !picked && /no playable|no .*candidate|all candidates failed/i.test(');
  const newAt = block.indexOf('if (!picked && !restricted && !it._usenetFellBackToLocal) {');
  assert.ok(oldAt > 0 && newAt > oldAt, 'the "nothing found" fallback, then the fallback for any other failure');
  assert.match(block.slice(oldAt, newAt), /postPlayNote\('trace', `usenet found nothing/, 'the older fallback says so in the log too');
  // playLocal never goes back to usenet: no loop.
  const local = extractFunction('playLocal');
  assert.doesNotMatch(local, /\bplayStart\(|\bplay\(\{/, 'a failed local Play does not search usenet again');
});
