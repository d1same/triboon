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
function releasesFor(ep) {
  const out = [
    { name: `Paper.Street.S03E${pad(ep)}.${RELEASE_TITLE[ep]}.720p.WEB-DL.DD5.1.H.264-GRP`, url: `http://x/t${ep}`, size: 7e8 },
    { name: `Paper.Street.S03E${pad(ep)}.1080p.BluRay.x264-BLU`, url: `http://x/b${ep}`, size: 1.4e9 },
  ];
  if (ep === 4 || ep === 5) out.push({ name: 'Paper.Street.S03E04E05.1080p.BluRay.x264-BLU', url: 'http://x/b45', size: 2.8e9 });
  return out;
}
function rssFor(items) {
  return `<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel>
${items.map((i) => `<item><title>${i.name}</title><link>${i.url}</link><enclosure url="${i.url}" length="${i.size}" type="application/x-nzb"/><newznab:attr name="size" value="${i.size}"/></item>`).join('\n')}
</channel></rss>`;
}
async function withIndexer(fn) {
  const asked = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let ep = Number(u.searchParams.get('ep'));
    const m = /S03E(\d{2})/i.exec(u.searchParams.get('q') || '');
    if (!ep && m) ep = Number(m[1]);
    if (ep) asked.push(ep);
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rssFor(ep && RELEASE_TITLE[ep] ? releasesFor(ep) : []));
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
function policyFor(e) {
  return {
    maxResolutionRank: 4, mediaType: 'tv',
    tmdbEpisode: { s: 3, e }, seasonEpisodes: SEASON,
    episodeTitle: SEASON[e - 1].name, otherEpisodeTitles: SEASON.filter((x) => x.n !== e).map((x) => x.name),
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
  const tailGroup = { groups: [{ episodes: [1, 2, 3].map((e) => ({ season_number: 3, episode_number: e, order: e })) }] };
  assert.deepEqual(episodeOrder.releaseNumbering(tail, tailGroup, 3).get(4), [5, 6]);
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
