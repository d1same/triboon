'use strict';
// TMDB vs release episode numbering (brief 127). A made-up show shaped like the real case: TMDB merges
// a two-part hour-long into one episode, the releases number its parts separately, so from there every
// release number is one ahead of TMDB's. Every title, group and file name here is made up.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('node:http');
const episodeOrder = require('../server/episode-order');
const { Pipeline, parseWantedTitle, releaseMatches } = require('../server/pipeline');

// TMDB season 3: E04 "Harbor Lights" is the merged hour-long (44 min).
const TMDB_S3 = [
  ['Cold Open', 22], ['The Audit', 22], ['Night Shift', 22], ['Harbor Lights', 44], ['Ledger', 22],
  ['The Raise', 22], ['Fire Drill', 22], ['Snow Day', 22], ['Inventory', 22], ['Finale Party', 22],
].map(([name, runtime], i) => ({ episode_number: i + 1, name, runtime }));
const SEASON = TMDB_S3.map((x) => ({ n: x.episode_number, name: x.name }));
// The "Original air date" group: Harbor Lights left out, so slots 4 and 5 are its two parts.
const AIR_GROUP = {
  id: 'grp-air', type: 1,
  groups: [{
    name: 'Season 3', order: 3,
    episodes: TMDB_S3.filter((x) => x.episode_number !== 4).map((x) => ({
      season_number: 3, episode_number: x.episode_number, order: x.episode_number < 4 ? x.episode_number - 1 : x.episode_number,
    })),
  }],
};
// Release numbering: E04 + E05 are Harbor Lights Part 1 and 2; Ledger is E06 … Finale Party is E11.
const RELEASE_TITLE = { 1: 'Cold.Open', 2: 'The.Audit', 3: 'Night.Shift', 4: 'Harbor.Lights.Part.1', 5: 'Harbor.Lights.Part.2', 6: 'Ledger', 7: 'The.Raise', 8: 'Fire.Drill', 9: 'Snow.Day', 10: 'Inventory', 11: 'Finale.Party' };
const pad = (n) => String(n).padStart(2, '0');
function releasesFor(ep, titles = RELEASE_TITLE, season = 3) {
  const s = pad(season);
  const out = [
    { name: `Paper.Street.S${s}E${pad(ep)}.${titles[ep]}.720p.WEB-DL.DD5.1.H.264-GRP`, url: `http://x/${s}t${ep}`, size: 7e8 },
    { name: `Paper.Street.S${s}E${pad(ep)}.1080p.BluRay.x264-BLU`, url: `http://x/${s}b${ep}`, size: 1.4e9 },
    { name: `Paper.Street.S${s}E${pad(ep)}.${titles[ep]}.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb`, url: `http://x/${s}n${ep}`, size: 1.1e9 },
  ];
  if (season === 3 && (ep === 4 || ep === 5)) out.push({ name: 'Paper.Street.S03E04E05.1080p.BluRay.x264-BLU', url: 'http://x/b45', size: 2.8e9 });
  return out;
}
function rssFor(items) {
  return `<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel>
${items.map((i) => `<item><title>${i.name}</title><link>${i.url}</link><enclosure url="${i.url}" length="${i.size}" type="application/x-nzb"/><newznab:attr name="size" value="${i.size}"/></item>`).join('\n')}
</channel></rss>`;
}
async function withIndexer(fn, titles = RELEASE_TITLE, season = 3) {
  const asked = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let ep = Number(u.searchParams.get('ep'));
    const m = new RegExp(`S${pad(season)}E(\\d{2})`, 'i').exec(u.searchParams.get('q') || '');
    if (!ep && m) ep = Number(m[1]);
    if (ep) asked.push(ep);
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rssFor(ep && titles[ep] ? releasesFor(ep, titles, season) : []));
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const pipeline = new Pipeline({
    pool: () => null, verdicts: { get: () => null, set: () => {} }, mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${port}`, apikey: 'k' }],
  });
  try { return await fn(pipeline, asked); } finally { server.close(); }
}
// What index.js hands the pipeline for TMDB S03E{e}: the TMDB title list and, when the group gives
// a difference, the release number(s).
function policyFor(e, list = SEASON, s = 3) {
  return {
    maxResolutionRank: 4, mediaType: 'tv',
    tmdbEpisode: { s, e }, seasonEpisodes: list,
    episodeTitle: list[e - 1].name, otherEpisodeTitles: list.filter((x) => x.n !== e).map((x) => x.name),
  };
}
const top = (r) => (r.candidates.find((c) => c.score > -5000) || {}).name || '';

test('order: the air-order episode group gives the release numbers, with merged two-parters filling the gaps', () => {
  assert.equal(episodeOrder.pickAirOrderGroup({ results: [
    { id: 'dvd', type: 3, episode_count: 40 }, { id: 'grp-air', type: 1, episode_count: 30 }, { id: 'digital', type: 4, episode_count: 50 },
  ] }), 'grp-air', 'type 1 ("Original air date") is the release order');
  assert.equal(episodeOrder.pickAirOrderGroup({ results: [{ id: 'dvd', type: 3, episode_count: 40 }] }), null);
  const map = episodeOrder.releaseNumbering(TMDB_S3, AIR_GROUP, 3);
  assert.deepEqual([...map].map(([e, r]) => `${e}:${r.join('+')}`),
    ['1:1', '2:2', '3:3', '4:4+5', '5:6', '6:7', '7:8', '8:9', '9:10', '10:11']);
  // Same numbering as TMDB: nothing to translate, the normal path stays.
  const same = { groups: [{ episodes: TMDB_S3.map((x) => ({ season_number: 3, episode_number: x.episode_number, order: x.episode_number - 1 })) }] };
  assert.equal(episodeOrder.releaseNumbering(TMDB_S3, same, 3), null);
  // A different order (DVD-style, numbers not rising) is not a release order.
  const shuffled = { groups: [{ episodes: [{ season_number: 3, episode_number: 1, order: 5 }, { season_number: 3, episode_number: 2, order: 1 }] }] };
  assert.equal(episodeOrder.releaseNumbering(TMDB_S3, shuffled, 3), null);
  // A merged episode at the end of the season takes two slots by its runtime.
  const tail = TMDB_S3.slice(0, 3).concat([{ episode_number: 4, name: 'Harbor Lights', runtime: 44 }]);
  const tailGroup = { groups: [{ episodes: [1, 2, 3].map((e) => ({ season_number: 3, episode_number: e, order: e - 1 })) }] };
  assert.deepEqual(episodeOrder.releaseNumbering(tail, tailGroup, 3).get(4), [4, 5]);
});

test('order: a group whose numbers jump for another reason is not trusted at all', () => {
  // A flat whole-show numbering: season 3 starts at slot 41.
  const flat = { groups: [{ episodes: AIR_GROUP.groups[0].episodes.map((x) => ({ ...x, order: x.order + 40 })) }] };
  assert.equal(episodeOrder.releaseNumbering(TMDB_S3, flat, 3), null);
  // A special sits between two episodes: its slot would shift every later number by one.
  const withSpecial = { groups: [{ episodes: AIR_GROUP.groups[0].episodes.map((x) => ({ ...x, order: x.order >= 6 ? x.order + 1 : x.order }))
    .concat([{ season_number: 0, episode_number: 9, order: 6 }]) }] };
  assert.equal(episodeOrder.releaseNumbering(TMDB_S3, withSpecial, 3), null);
  // A jump with no left-out TMDB episode to fill it (an extra slot after E06).
  const unexplained = { groups: [{ episodes: AIR_GROUP.groups[0].episodes.map((x) => ({ ...x, order: x.episode_number >= 7 ? x.order + 1 : x.order })) }] };
  assert.equal(episodeOrder.releaseNumbering(TMDB_S3, unexplained, 3), null);
});

test('order: a release title is read right after the episode number, part markers dropped', () => {
  assert.deepEqual(episodeOrder.positionalTitle('Paper.Street.S03E09.Snow.Day.720p.WEB-DL'), ['snow', 'day']);
  assert.deepEqual(episodeOrder.positionalTitle('Paper.Street.S03E04.Harbor.Lights.Part.1.720p'), ['harbor', 'lights']);
  assert.deepEqual(episodeOrder.positionalTitle('Paper.Street.S03E09.1080p.BluRay.x264-BLU'), []);
  assert.deepEqual(episodeOrder.positionalTitle('Paper.Street.S03E06.Ledger.EXTENDED.1080p.WEB-DL'), ['ledger']);
  assert.equal(episodeOrder.namedEpisode('Paper.Street.S03E09.Snow.Day.720p', SEASON), 8);
  assert.equal(episodeOrder.namedEpisode('Paper.Street.S03E05.Harbor.Lights.Part.2.720p', SEASON), 4);
  assert.equal(episodeOrder.titleNames(['money', 'in', 'bank'], 'Money'), false, 'a longer title is a different title');
});

test('title check: a release that names another episode is skipped, even with a short one-word title', () => {
  const wanted = parseWantedTitle('Paper Street S03E06');
  wanted.episodeTitle = 'The Raise';
  wanted.otherEpisodeTitles = SEASON.filter((x) => x.n !== 6).map((x) => x.name);
  assert.equal(releaseMatches('Paper.Street.S03E06.Ledger.720p.WEB-DL.DD5.1.H.264-GRP', wanted), false,
    '"Ledger" right after the number names TMDB E05, not The Raise');
  assert.equal(releaseMatches('Paper.Street.S03E06.The.Raise.720p.WEB-DL', wanted), true);
  assert.equal(releaseMatches('Paper.Street.S03E06.1080p.BluRay.x264-BLU', wanted), true, 'no title: the number check alone, as before');
});

test('search: with the group translation, TMDB S03E08 plays release S03E09 "Snow Day"', async () => {
  const map = episodeOrder.releaseNumbering(TMDB_S3, AIR_GROUP, 3);
  await withIndexer(async (pipeline, asked) => {
    const r = await pipeline.search({ q: 'Paper Street', season: 3, ep: map.get(8)[0] }, policyFor(8));
    assert.match(top(r), /S03E09/);
    assert.ok(r.candidates.every((c) => c.score <= -5000 || /S03E09/.test(c.name)), 'nothing from release E08 (Fire Drill)');
    assert.ok(asked.every((e) => e === 9), 'one release number searched, no retry');
  });
});

test('search: a TMDB two-parter prefers the release that holds both parts', async () => {
  const map = episodeOrder.releaseNumbering(TMDB_S3, AIR_GROUP, 3);
  const [e, eTo] = [map.get(4)[0], map.get(4)[1]];
  await withIndexer(async (pipeline) => {
    const r = await pipeline.search({ q: 'Paper Street', season: 3, ep: e, epTo: eTo }, policyFor(4));
    assert.equal(top(r), 'Paper.Street.S03E04E05.1080p.BluRay.x264-BLU');
    const part1 = r.candidates.find((c) => /S03E04\.Harbor\.Lights\.Part\.1/.test(c.name));
    assert.ok(part1 && part1.score > -5000, 'Part 1 alone stays a fallback');
  });
});

test('search: without a group, the release titles move the search to the right number', async () => {
  // TMDB S03E08 "Snow Day" searched as E08: release E08 is "Fire Drill" (TMDB E07). One retry at E09.
  await withIndexer(async (pipeline, asked) => {
    const r = await pipeline.search({ q: 'Paper Street', season: 3, ep: 8 }, policyFor(8));
    assert.match(top(r), /S03E09/, `played ${top(r)}`);
    assert.ok(r.candidates.every((c) => !/S03E08/.test(c.name)), 'the untitled S03E08 copies are Fire Drill too');
    assert.deepEqual(r.episodeNumbering, { from: 8, to: 9, evidence: 7 });
    assert.ok(r.candidates.every((c) => c.releaseEpisode && c.releaseEpisode.e === 9), 'a pack would mount release E09');
    assert.ok(asked.includes(9));
  });
});

test('search: two merged two-parters before the episode: the names are followed for several hops', async () => {
  // TMDB season 4: E01 "Kickoff" and E02 "Two Lunches" are merged hour-longs; releases split both.
  const s4 = ['Kickoff', 'Two Lunches', 'Payday', 'Quiet Week', 'Last Call'].map((name, i) => ({ n: i + 1, name }));
  const titles = { 1: 'Kickoff.Part.1', 2: 'Kickoff.Part.2', 3: 'Two.Lunches.Part.1', 4: 'Two.Lunches.Part.2', 5: 'Payday', 6: 'Quiet.Week', 7: 'Last.Call' };
  await withIndexer(async (pipeline, asked) => {
    // TMDB E04 "Quiet Week" searched as E04: E04 names TMDB E02, E06 names TMDB E04.
    const r = await pipeline.search({ q: 'Paper Street', season: 4, ep: 4 }, policyFor(4, s4, 4));
    assert.match(top(r), /S04E06/, `played ${top(r)}`);
    assert.equal(r.episodeNumbering.to, 6);
    // TMDB E03 "Payday" searched as E03: E03 names E02, E04 names E02 again, E05 is Payday.
    const p = await pipeline.search({ q: 'Paper Street', season: 4, ep: 3 }, policyFor(3, s4, 4));
    assert.match(top(p), /S04E05/, `played ${top(p)}`);
    assert.deepEqual(p.episodeNumbering, { from: 3, to: 5, evidence: 2 });
  }, titles, 4);
});

test('search: when no number confirms the episode, Play does not start a copy of the wrong one', async () => {
  // TMDB E05 "Last Call" has no release at all; release E05 names TMDB E03 (twice: titled and named).
  const s4 = ['Kickoff', 'Two Lunches', 'Payday', 'Quiet Week', 'Last Call'].map((name, i) => ({ n: i + 1, name }));
  const titles = { 1: 'Kickoff.Part.1', 2: 'Kickoff.Part.2', 3: 'Two.Lunches.Part.1', 4: 'Two.Lunches.Part.2', 5: 'Payday', 6: 'Quiet.Week' };
  await withIndexer(async (pipeline) => {
    const r = await pipeline.search({ q: 'Paper Street', season: 4, ep: 5 }, policyFor(5, s4, 4));
    assert.equal(top(r), '', 'nothing auto-plays');
    const listed = r.candidates.filter((c) => /S04E05/.test(c.name));
    assert.ok(listed.length >= 1, 'the copies stay listed for Sources');
    assert.ok(listed.every((c) => c.reasons.includes('episode-number names TMDB E3')));
  }, titles, 4);
});

// The episode card sends its own query with the TMDB number in it ("Paper Street S03E08"), next to
// season/ep. The release number in ep (or a title-evidence hop) must win over that token, or the
// indexer and the verifier keep asking for the TMDB number (3.5.4 second check, The Office S06E15).
test('search: a card query with the TMDB SxxEyy token still searches the release number (group path)', async () => {
  const map = episodeOrder.releaseNumbering(TMDB_S3, AIR_GROUP, 3);
  await withIndexer(async (pipeline, asked) => {
    const r = await pipeline.search({ q: 'Paper Street S03E08', season: 3, ep: map.get(8)[0] }, policyFor(8));
    assert.match(top(r), /S03E09/, `played ${top(r)}`);
    assert.ok(r.candidates.every((c) => c.score <= -5000 || /S03E09/.test(c.name)), 'nothing from release E08 (Fire Drill)');
    assert.ok(asked.length && asked.every((e) => e === 9), `searched ${asked.join(',')}`);
  });
});
test('search: a card query with the TMDB token follows the release titles (evidence path)', async () => {
  await withIndexer(async (pipeline, asked) => {
    const r = await pipeline.search({ q: 'Paper Street S03E08', season: 3, ep: 8 }, policyFor(8));
    assert.match(top(r), /S03E09/, `played ${top(r)}`);
    assert.deepEqual(r.episodeNumbering, { from: 8, to: 9, evidence: 7 });
    assert.ok(asked.includes(9), `searched ${asked.join(',')}`);
  });
});
test('search: a card query for a TMDB two-parter prefers the file that holds both parts', async () => {
  const map = episodeOrder.releaseNumbering(TMDB_S3, AIR_GROUP, 3);
  const [e, eTo] = [map.get(5)[0], undefined];
  await withIndexer(async (pipeline) => {
    // TMDB E05 "Ledger" is release E06; the card still says S03E05.
    const r = await pipeline.search({ q: 'Paper Street S03E05', season: 3, ep: e, epTo: eTo }, policyFor(5));
    assert.match(top(r), /S03E06/, `played ${top(r)}`);
    const both = await pipeline.search({ q: 'Paper Street S03E04', season: 3, ep: map.get(4)[0], epTo: map.get(4)[1] }, policyFor(4));
    assert.equal(top(both), 'Paper.Street.S03E04E05.1080p.BluRay.x264-BLU');
  });
});
test('search: a card query for a normal show is unchanged', async () => {
  await withIndexer(async (pipeline, asked) => {
    const r = await pipeline.search({ q: 'Paper Street S03E02', season: 3, ep: 2 }, policyFor(2));
    assert.match(top(r), /S03E02/);
    assert.ok(!r.episodeNumbering);
    assert.ok(asked.every((x) => x === 2));
  });
});

test('search: a normal show (names agree with TMDB) takes one search, no retry', async () => {
  await withIndexer(async (pipeline, asked) => {
    const r = await pipeline.search({ q: 'Paper Street', season: 3, ep: 2 }, policyFor(2));
    assert.match(top(r), /S03E02/);
    assert.ok(!r.episodeNumbering);
    assert.ok(asked.every((e) => e === 2));
  });
});

test('part: a file holding this episode and the one before starts at this part', () => {
  assert.deepEqual(episodeOrder.episodePartOf('Show.S05E14E15.1080p.BluRay', 5, 15), { index: 2, of: 2 });
  assert.deepEqual(episodeOrder.episodePartOf('Show.S05E14-E15.1080p.WEB', 5, 15), { index: 2, of: 2 });
  assert.equal(episodeOrder.episodePartOf('Show.S05E14E15.1080p.BluRay', 5, 14), null, 'the first part starts at 0:00');
  assert.equal(episodeOrder.episodePartOf('Show.S05E15.1080p', 5, 15), null);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const start = ui.indexOf('async function applyEpisodePartStart(p) {');
  const end = ui.indexOf('\nfunction ', start);
  assert.ok(start > 0 && end > start);
  const seeks = [], toasts = [];
  const S = {};
  const run = (chapters) => new Function('S', 'api', 'seekTo', 'toast', `${ui.slice(start, end)}\nreturn applyEpisodePartStart;`)(
    S, async () => ({ chapters }), (s) => seeks.push(s), (m) => toasts.push(m));
  return (async () => {
    const p = { episodePart: { index: 2, of: 2 }, mountId: 'm1', item: { resume: 0 }, tracks: { duration: 2640 } };
    S.playing = p;
    await run([{ startMs: 0 }, { startMs: 600000 }, { startMs: 1322000 }, { startMs: 2000000 }])(p);
    assert.deepEqual(seeks, [1322], 'the chapter at Part 2');
    const q = { episodePart: { index: 2, of: 2 }, mountId: 'm2', item: { resume: 0 }, tracks: { duration: 2640 } };
    S.playing = q;
    await run([])(q);
    assert.equal(seeks.length, 1, 'no chapter: no guessed jump');
    assert.match(toasts[1], /holds Parts 1 to 2 together\. Part 2 starts later/);
    const r = { episodePart: { index: 2, of: 2 }, mountId: 'm3', item: { resume: 300 }, tracks: { duration: 2640 } };
    S.playing = r;
    await run([{ startMs: 1322000 }])(r);
    assert.equal(seeks.length, 1, 'a saved position wins');
  })();
});

test('server: Play and Sources search the release numbers, while the card keeps TMDB numbers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const grab = (name) => {
    const s = src.indexOf(`function ${name}(`);
    return src.slice(s, src.indexOf('\n}', s) + 2);
  };
  const { playSearchParams } = new Function(`${grab('releaseEpisodeOf')}\n${grab('releaseEpisodeToOf')}\n${grab('playSearchParams')}\nreturn { playSearchParams };`)();
  const body = { q: 'Paper Street', season: 3, ep: 4, releaseEpisodes: [4, 5] };
  assert.deepEqual(playSearchParams(body), { q: 'Paper Street', imdbid: undefined, tvdbid: undefined, season: 3, ep: 4, epTo: 5, aliases: undefined });
  assert.equal(playSearchParams({ ...body, ep: 8, releaseEpisodes: [9] }).ep, 9);
  assert.equal(playSearchParams({ q: 'X', season: 1, ep: 2 }).ep, 2, 'no translation: TMDB number as before');
  assert.equal(body.ep, 4, 'the request body (card, watch key, subtitles) keeps the TMDB number');
  // Subtitles and the watch identity use the body's TMDB numbers, not the search numbers.
  assert.match(src, /vf\._subQuery = episodeSubtitleQuery\(body\.q, body\.season, body\.ep\);/);
  // The merged two-parter skips the per-episode runtime check (a Part 1 file is half the hour).
  assert.match(src, /out\.releaseEpisodes = slots\.slice\(\);\s+if \(slots\.length > 1\) out\.runtimeMin = 0;/);
  // The release order loads beside the season list, not in front of it.
  assert.match(src, /await Promise\.all\(\[\s+tmdb\.get\(`\/tv\/\$\{id\}\/season\/\$\{s\}`\)\.catch\(\(\) => null\),\s+tmdb\.get\(`\/tv\/\$\{id\}\/episode_groups`\)\.catch\(\(\) => null\),/);
});

test('subtitles: the episode number of the file that plays (brief 131, The Office TMDB S07E21 = file S07E22)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const grab = (name) => {
    const s = src.indexOf(`function ${name}(`);
    return src.slice(s, src.indexOf('\n}', s) + 2);
  };
  const { subtitleEpisodeFor, subtitleEpisodeNumber } = new Function(`${grab('releaseEpisodeOf')}\n${grab('subtitleEpisodeFor')}\n${grab('subtitleEpisodeNumber')}\nreturn { subtitleEpisodeFor, subtitleEpisodeNumber };`)();
  const card = { q: 'Paper Street S07E21', season: 7, ep: 21 };
  // Air-order translation (releaseEpisodes from catalogFactsFor).
  assert.deepEqual(subtitleEpisodeFor({ ...card, releaseEpisodes: [22] }, null, 'Paper.Street.S07E22.Goodbye.1080p.WEB-DL-GRP.mkv'), { season: 7, tmdbEp: 21, ep: 22 });
  // Release-title hop (candidate.releaseEpisode from pipeline.search).
  assert.deepEqual(subtitleEpisodeFor(card, { releaseEpisode: { s: 7, e: 22 } }, 'Paper.Street.S07E22.mkv'), { season: 7, tmdbEp: 21, ep: 22 });
  // A two-part file holds the release number.
  assert.deepEqual(subtitleEpisodeFor({ q: 'P', season: 6, ep: 16, releaseEpisodes: [17, 18] }, null, 'Paper.Street.S06E17E18.720p.BluRay-GRP'), { season: 6, tmdbEp: 16, ep: 17 });
  assert.deepEqual(subtitleEpisodeFor({ q: 'P', season: 6, ep: 16, releaseEpisodes: [17, 18] }, null, 'Paper.Street.S06E17-E18.Delivery'), { season: 6, tmdbEp: 16, ep: 17 });
  // An opaque or pack name still follows Play's number.
  assert.deepEqual(subtitleEpisodeFor({ ...card, releaseEpisodes: [22] }, null, 'Feature.mkv'), { season: 7, tmdbEp: 21, ep: 22 });
  // The file's own name has the last word: a file numbered like the card keeps the card's number.
  assert.equal(subtitleEpisodeFor({ ...card, releaseEpisodes: [22] }, null, 'Paper.Street.S07E21.Goodbye.mkv'), null);
  // Normal shows, films and no translation: null, so the subtitle path is today's.
  assert.equal(subtitleEpisodeFor(card, null, 'Paper.Street.S07E21.mkv'), null);
  assert.equal(subtitleEpisodeFor({ ...card, releaseEpisodes: [21] }, null, 'Paper.Street.S07E21.mkv'), null);
  assert.equal(subtitleEpisodeFor({ q: 'Film 2024' }, null, 'Film.2024.mkv'), null);
  assert.equal(subtitleEpisodeFor(card, { releaseEpisode: { s: 6, e: 22 } }, 'x'), null, 'another season is not this translation');
  // The handler translates only the card episode the mount was played for.
  const vf = { _subEpisode: { season: 7, tmdbEp: 21, ep: 22 } };
  assert.equal(subtitleEpisodeNumber(vf, '7', '21'), 22);
  assert.equal(subtitleEpisodeNumber(vf, 7, 22), 22);
  assert.equal(subtitleEpisodeNumber(vf, 7, 23), 23);
  assert.equal(subtitleEpisodeNumber(vf, 6, 21), 21);
  assert.equal(subtitleEpisodeNumber({}, 7, 21), 21);
  // Every usenet play route records it; a backup copy keeps it.
  assert.match(src, /vf\._subEpisode = session\.subEpisode = subtitleEpisodeFor\(body, candidate, subtitleReleaseName\(vf\)\);[\s\S]{0,200}vf\._caps = parseCaps\(body\.caps\); session\.caps = vf\._caps;/);
  assert.match(src, /const subEp = session\.subEpisode;\s+vf\._subEpisode = subEp \? subtitleEpisodeFor\(/);
});
