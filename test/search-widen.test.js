'use strict';
// Before/after Play search: more CORRECT files, zero wrong-title leaks.
// Extra aka/yearless queries are SEARCH only. releaseQualifies still uses the catalog title.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  Pipeline, aliasSearchQueries, yearlessSearchQuery, qualitySearchQuery, seasonPackSearchQuery,
  widenSearchQueries, parseWantedTitle, releaseMatches,
} = require('../server/pipeline');

function rssFor(items) {
  return `<?xml version="1.0"?><rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel>
${items.map((i) => `<item><title>${i.name}</title><link>${i.url}</link>
<enclosure url="${i.url}" length="${i.size}" type="application/x-nzb"/>
<newznab:attr name="size" value="${i.size}"/>${i.imdb ? `<newznab:attr name="imdbid" value="${i.imdb}"/>` : ''}${i.tvdbid ? `<newznab:attr name="tvdbid" value="${i.tvdbid}"/>` : ''}</item>`).join('\n')}
</channel></rss>`;
}

const CASES = [
  {
    id: 'mutiny-2026',
    params: { q: 'Mutiny 2026', imdbid: 'tt32918441', aliases: ['The Mutiny'] },
    byQuery: {
      'Mutiny 2026': [
        { name: 'Mutiny.2026.WEB-DL.1080p.x264.ENG.5.1-STARCKFILMES', url: 'http://x/stark', size: 3e9 },
        { name: 'Mutiny.on.the.Bounty.1962.1080p.BluRay-x', url: 'http://x/bounty', size: 8e9 },
        { name: 'Mutiny.2019.1080p.WEB-DL-x', url: 'http://x/2019', size: 4e9 },
      ],
      'The Mutiny 2026': [
        { name: 'The.Mutiny.2026.2160p.WEB-DL.H.265-FLUX', url: 'http://x/aka-4k', size: 12e9 },
        { name: 'The.Mutiny.2026.1080p.WEB-DL-NTb', url: 'http://x/aka-1080', size: 5e9 },
      ],
      'Mutiny': [
        { name: 'Mutiny.2026.2160p.WEB-DL.H.265-FLUX', url: 'http://x/yl-4k', size: 14e9 },
        { name: 'Mutiny.2026.1080p.WEB-DL-NTb', url: 'http://x/yl-1080', size: 4e9 },
        { name: 'Mutiny.on.the.Bounty.1962.1080p.BluRay-x', url: 'http://x/bounty2', size: 8e9 },
      ],
      'Mutiny 1080p': [
        { name: 'Mutiny.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb', url: 'http://x/hd-ntb', size: 6e9 },
      ],
      'Mutiny remux': [
        { name: 'Mutiny.2026.1080p.BluRay.REMUX.AVC.DTS-HD.MA-FGT', url: 'http://x/remux', size: 22e9 },
      ],
      'Mutiny bluray': [
        { name: 'Mutiny.2026.1080p.BluRay-SPARKS', url: 'http://x/bluray', size: 10e9 },
      ],
      'Mutiny 2160p': [
        { name: 'Mutiny.2026.2160p.WEB-DL.H.265-FLUX', url: 'http://x/uhd-flux', size: 14e9 },
      ],
      'Mutiny 2026 2160p': [
        { name: 'Mutiny.2026.2160p.AMZN.WEB-DL.DDP5.1.H.264.HUNSUB-BBM', url: 'http://x/hunsub', size: 12e9 },
      ],
    },
    mustIncludeAfter: [
      'The.Mutiny.2026.2160p.WEB-DL.H.265-FLUX',
      'The.Mutiny.2026.1080p.WEB-DL-NTb',
      'Mutiny.2026.2160p.WEB-DL.H.265-FLUX',
      'Mutiny.2026.1080p.WEB-DL-NTb',
      'Mutiny.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb',
      'Mutiny.2026.1080p.BluRay.REMUX.AVC.DTS-HD.MA-FGT',
      'Mutiny.2026.1080p.BluRay-SPARKS',
    ],
    mustReject: [
      'Mutiny.on.the.Bounty.1962.1080p.BluRay-x',
      'Mutiny.2019.1080p.WEB-DL-x',
    ],
  },
  {
    id: 'from-s01e01',
    params: { q: 'From S01E01', aliases: ['Tales From'] },
    byQuery: {
      'From S01E01': [
        { name: 'FROM.S01E01.Long.Days.Journey.Into.Night.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX', url: 'http://x/from', size: 3e9 },
      ],
      'From S01E01 1080p': [
        { name: 'FROM.S01E01.1080p.WEB-DL-NTb', url: 'http://x/from-hd', size: 2.4e9 },
      ],
      'From S01': [
        { name: 'FROM.S01.1080p.WEB-DL-NTb', url: 'http://x/from-pack', size: 18e9 },
      ],
      'Tales From S01E01': [
        { name: 'Stranger.Things.Tales.From.85.S01E01.2160p.WEBRip-x', url: 'http://x/st', size: 6e9 },
      ],
      'From S01E01 remux': [
        { name: 'FROM.S01E01.1080p.BluRay.REMUX.AVC.DTS-HD.MA-NTb', url: 'http://x/from-remux', size: 12e9 },
      ],
      'From S01E01 bluray': [
        { name: 'FROM.S01E01.1080p.BluRay-SPARKS', url: 'http://x/from-bd', size: 8e9 },
      ],
    },
    mustIncludeAfter: [
      'FROM.S01E01.Long.Days.Journey.Into.Night.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX',
      'FROM.S01E01.1080p.WEB-DL-NTb',
      'FROM.S01.1080p.WEB-DL-NTb',
      'FROM.S01E01.1080p.BluRay.REMUX.AVC.DTS-HD.MA-NTb',
      'FROM.S01E01.1080p.BluRay-SPARKS',
    ],
    mustReject: [
      'Stranger.Things.Tales.From.85.S01E01.2160p.WEBRip-x',
    ],
  },
  {
    id: 'office-us-2005',
    params: { q: 'The Office', season: 1, ep: 1, imdbid: 'tt0386679', aliases: ['The Office US'] },
    policy: { wantedYear: 2005 },
    byQuery: {
      'The Office S01E01': [
        { name: 'The.Office.S01E01.1080p.WEB-DL-NTb', url: 'http://x/us', size: 2e9, imdb: '0386679' },
        { name: 'The.Office.S01E01.1080p.AMZN.WEB-DL-HONE', url: 'http://x/remake', size: 3e9, imdb: '31806028' },
        { name: 'The.Office.2024.S01E01.2160p.AMZN.WEB-DL-HONE', url: 'http://x/y2024', size: 4e9 },
      ],
      'The Office US S01E01': [
        { name: 'The.Office.US.S01E01.1080p.WEB-DL-NTb', url: 'http://x/us2', size: 2.2e9, imdb: '0386679' },
      ],
    },
    mustIncludeAfter: [
      'The.Office.S01E01.1080p.WEB-DL-NTb',
      'The.Office.US.S01E01.1080p.WEB-DL-NTb',
    ],
    mustReject: [
      'The.Office.S01E01.1080p.AMZN.WEB-DL-HONE',
      'The.Office.2024.S01E01.2160p.AMZN.WEB-DL-HONE',
    ],
  },
  {
    id: 'simpsons-s35',
    params: { q: 'The Simpsons', season: 35, ep: 5 },
    policy: { wantedYear: 1989 },
    byQuery: {
      'The Simpsons S35E05': [
        { name: 'The.Simpsons.S35E05.2024.1080p.WEB-DL-NTb', url: 'http://x/s35', size: 1.2e9 },
        { name: 'The.Simpsons.S35E05.1080p.WEB-DL-NTb', url: 'http://x/s35b', size: 1.1e9 },
      ],
    },
    mustIncludeAfter: [
      'The.Simpsons.S35E05.2024.1080p.WEB-DL-NTb',
      'The.Simpsons.S35E05.1080p.WEB-DL-NTb',
    ],
    mustReject: [],
  },
  {
    id: 'lioness',
    params: { q: 'Lioness', season: 1, ep: 1, tvdbid: '421590', aliases: ['Special Ops Lioness'] },
    byQuery: {
      'Lioness S01E01': [
        { name: 'Lioness.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb', url: 'http://x/ntb', size: 4.7e9 },
      ],
      'Lioness S01E01 1080p': [
        { name: 'Lioness.S01E01.1080p.WEB-DL.H.264-NTb', url: 'http://x/lioness-hd', size: 3.8e9 },
      ],
      'Lioness S01': [
        { name: 'Lioness.S01.1080p.AMZN.WEB-DL-NTb', url: 'http://x/lioness-pack', size: 40e9 },
      ],
      'Special Ops Lioness S01E01': [
        { name: 'Special.Ops.Lioness.S01E01.1080p.WEB-DL.H.264-GRP', url: 'http://x/special', size: 3e9 },
      ],
    },
    extraForTvdb: [
      { name: 'Lioness.S01E01.1080p.WEB-DL.H.264-BAWLS', url: 'http://x/bawls', size: 1.2e9 },
    ],
    mustIncludeAfter: [
      'Lioness.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb',
      'Special.Ops.Lioness.S01E01.1080p.WEB-DL.H.264-GRP',
      'Lioness.S01E01.1080p.WEB-DL.H.264-NTb',
      'Lioness.S01.1080p.AMZN.WEB-DL-NTb',
    ],
    mustReject: [
      'The.Lion.King.S01E01.1080p.WEB-DL.H.264-GRP',
    ],
  },
  {
    id: 'batman-2022',
    params: { q: 'The Batman 2022', aliases: ['Batman'] },
    byQuery: {
      'The Batman 2022': [
        { name: 'The.Batman.2022.2160p.WEB-DL-NTb', url: 'http://x/2022', size: 12e9 },
      ],
      'Batman 2022': [
        { name: 'The.Batman.2022.1080p.WEB-DL-NTb', url: 'http://x/aka', size: 6e9 },
        { name: 'The.Batman.S01E01.1080p.WEB-DL-x', url: 'http://x/tv', size: 2e9 },
      ],
      'The Batman remux': [
        { name: 'The.Batman.2022.2160p.UHD.BluRay.REMUX.HEVC.TrueHD-FraMeSToR', url: 'http://x/bat-remux', size: 66e9 },
      ],
      'The Batman bluray': [
        { name: 'The.Batman.2022.1080p.BluRay-SPARKS', url: 'http://x/bat-bd', size: 14e9 },
      ],
    },
    mustIncludeAfter: [
      'The.Batman.2022.2160p.WEB-DL-NTb',
      'The.Batman.2022.1080p.WEB-DL-NTb',
      'The.Batman.2022.2160p.UHD.BluRay.REMUX.HEVC.TrueHD-FraMeSToR',
      'The.Batman.2022.1080p.BluRay-SPARKS',
    ],
    mustReject: [
      'The.Batman.S01E01.1080p.WEB-DL-x',
    ],
  },
  {
    id: 'it-2017',
    params: { q: 'It 2017' },
    byQuery: {
      'It 2017': [],
      'It': [
        { name: 'It.2017.1080p.BluRay.REMUX.AVC.DTS-HD.MA-FGT', url: 'http://x/it', size: 20e9 },
        { name: 'It.Chapter.Two.2019.2160p.UHD.BluRay.x265-TERMiNAL', url: 'http://x/ch2', size: 15e9 },
        { name: 'Power.Rangers.2017.2160p.UHD.BDRip-x', url: 'http://x/pr', size: 10e9 },
      ],
      'It remux': [
        { name: 'It.2017.2160p.UHD.BluRay.REMUX.HEVC.TrueHD-FraMeSToR', url: 'http://x/it-4k', size: 55e9 },
      ],
      'It bluray': [
        { name: 'It.2017.1080p.BluRay-SPARKS', url: 'http://x/it-bd', size: 12e9 },
      ],
    },
    mustIncludeAfter: [
      'It.2017.1080p.BluRay.REMUX.AVC.DTS-HD.MA-FGT',
      'It.2017.2160p.UHD.BluRay.REMUX.HEVC.TrueHD-FraMeSToR',
      'It.2017.1080p.BluRay-SPARKS',
    ],
    mustReject: [
      'It.Chapter.Two.2019.2160p.UHD.BluRay.x265-TERMiNAL',
      'Power.Rangers.2017.2160p.UHD.BDRip-x',
    ],
  },
];

function summarize(candidates) {
  const names = candidates.map((c) => c.name);
  const playable = candidates.filter((c) => c.score > -5000);
  return { verified: names.length, playable: playable.length, names, top: playable[0] && playable[0].name || '' };
}

async function searchCase(c, { widenSearch, withAliases }) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams.get('q') || '';
    let items = [];
    if (u.searchParams.get('tvdbid') && c.extraForTvdb) items = items.concat(c.extraForTvdb);
    items = items.concat(c.byQuery[q] || []);
    if (c.id === 'lioness' && !u.searchParams.get('tvdbid') && /lion king/i.test(q)) {
      items = items.concat([{ name: 'The.Lion.King.S01E01.1080p.WEB-DL.H.264-GRP', url: 'http://x/wrong-show', size: 2e9 }]);
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(rssFor(items));
  });
  const ixPort = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const pipeline = new Pipeline({
    pool: () => null, verdicts: { get: () => null, set: () => {} }, mounts: new Map(),
    indexers: () => [{ name: 'mock', url: `http://127.0.0.1:${ixPort}`, apikey: 'k' }],
  });
  try {
    const params = { ...c.params };
    if (!withAliases) delete params.aliases;
    const r = await pipeline.search(params, c.policy || {}, { widenSearch });
    return summarize(r.candidates);
  } finally {
    server.close();
  }
}

test('aliasSearchQueries keeps year/episode on the aka query and skips dupes', () => {
  const movie = parseWantedTitle('Mutiny 2026');
  assert.deepStrictEqual(aliasSearchQueries('Mutiny 2026', ['The Mutiny', 'Mutiny 2026'], movie), ['The Mutiny 2026']);
  const ep = parseWantedTitle('Lioness S01E01');
  assert.deepStrictEqual(
    aliasSearchQueries('Lioness S01E01', ['Special Ops: Lioness'], ep),
    ['Special Ops Lioness S01E01']
  );
  assert.strictEqual(yearlessSearchQuery('Mutiny 2026', movie), 'Mutiny');
  assert.strictEqual(yearlessSearchQuery('From S01E01', parseWantedTitle('From S01E01')), '');
  assert.strictEqual(qualitySearchQuery('Mutiny 2026', movie, '1080p'), 'Mutiny 1080p');
  assert.strictEqual(qualitySearchQuery('Mutiny 2026', movie, '2160p'), 'Mutiny 2160p');
  assert.strictEqual(qualitySearchQuery('From S01E01', parseWantedTitle('From S01E01'), '1080p'), 'From S01E01 1080p');
  assert.strictEqual(seasonPackSearchQuery('From S01E01', parseWantedTitle('From S01E01')), 'From S01');
  assert.strictEqual(seasonPackSearchQuery('Mutiny 2026', movie), '');
  assert.deepStrictEqual(
    widenSearchQueries('Mutiny 2026', movie, { wantUhd: false, aliases: ['The Mutiny'] }),
    ['Mutiny', 'Mutiny 1080p', 'Mutiny remux', 'Mutiny bluray', 'The Mutiny 2026']
  );
  assert.deepStrictEqual(
    widenSearchQueries('Mutiny 2026', movie, { wantUhd: true, aliases: ['The Mutiny'] }),
    ['Mutiny 2026 2160p', 'Mutiny', 'Mutiny 2160p', 'Mutiny remux', 'Mutiny bluray', 'The Mutiny 2026']
  );
  assert.deepStrictEqual(
    widenSearchQueries('From S01E01', parseWantedTitle('From S01E01'), { wantUhd: false, aliases: ['Tales From'] }),
    ['From S01E01 1080p', 'From S01', 'From S01E01 remux', 'From S01E01 bluray', 'Tales From S01E01']
  );
});

test('leading The on a scene name still matches a catalog title that dropped it', () => {
  const wanted = parseWantedTitle('Mutiny 2026');
  assert.ok(releaseMatches('The.Mutiny.2026.2160p.WEB-DL.H.265-FLUX', wanted));
  assert.ok(!releaseMatches('Mutiny.on.the.Bounty.1962.1080p.BluRay-x', wanted));
});

test('Play search widen: before vs after on several titles, no wrong files', async () => {
  const rows = [];
  for (const c of CASES) {
    const before = await searchCase(c, { widenSearch: false, withAliases: false });
    const after = await searchCase(c, { widenSearch: true, withAliases: true });
    for (const name of c.mustReject) {
      assert.ok(!after.names.includes(name), `${c.id} after must not pick ${name}`);
      assert.ok(!before.names.includes(name), `${c.id} before must not pick ${name}`);
    }
    for (const name of c.mustIncludeAfter) {
      assert.ok(after.names.includes(name), `${c.id} after must include ${name}`);
    }
    assert.ok(after.verified >= before.verified, `${c.id} must not lose verified files`);
    rows.push({
      id: c.id,
      beforeVerified: before.verified,
      afterVerified: after.verified,
      beforePlayable: before.playable,
      afterPlayable: after.playable,
      topAfter: after.top,
    });
  }
  const gained = rows.filter((r) => r.afterVerified > r.beforeVerified);
  assert.ok(gained.length >= 3, 'at least three titles should find more correct files');
  console.log('[search-widen] before/after');
  for (const r of rows) {
    console.log(`  ${r.id}: verified ${r.beforeVerified}→${r.afterVerified}  playable ${r.beforePlayable}→${r.afterPlayable}  top=${r.topAfter || '(none)'}`);
  }
});

test('yearless NTb/FLUX still merge when titled search already found a small encode', async () => {
  const c = CASES.find((x) => x.id === 'mutiny-2026');
  const hd = await searchCase({ ...c, policy: { preferResolutionRank: 3, maxResolutionRank: 3 } }, {
    widenSearch: true, withAliases: true,
  });
  assert.ok(hd.names.includes('Mutiny.2026.1080p.WEB-DL-NTb'), 'yearless 1080p NTb');
  assert.ok(hd.names.includes('Mutiny.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb'), 'quality 1080p NTb');
  assert.ok(hd.names.includes('The.Mutiny.2026.1080p.WEB-DL-NTb'), 'aka 1080p NTb');
  assert.ok(!hd.names.includes('Mutiny.on.the.Bounty.1962.1080p.BluRay-x'));

  const uhd = await searchCase({ ...c, policy: { preferResolutionRank: 4, maxResolutionRank: 4 } }, {
    widenSearch: true, withAliases: true,
  });
  assert.ok(uhd.names.includes('Mutiny.2026.2160p.WEB-DL.H.265-FLUX'), 'yearless 4K FLUX');
  assert.ok(uhd.names.includes('The.Mutiny.2026.2160p.WEB-DL.H.265-FLUX'), 'aka 4K FLUX');
  assert.ok(uhd.names.includes('Mutiny.2026.2160p.AMZN.WEB-DL.DDP5.1.H.264.HUNSUB-BBM'), 'titled 4K still listed');
});
