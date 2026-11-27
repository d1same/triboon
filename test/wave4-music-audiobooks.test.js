'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { scoreAudiobook, rankAudiobooks } = require('../server/scoring');
const { Pipeline, parseWantedBook, bookMatches } = require('../server/pipeline');
const { Store, VerdictCache } = require('../server/store');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('wave4: scoreAudiobook honors health verdicts and disqualifies 7z/iso containers', () => {
  const ranked = rankAudiobooks([
    { name: 'Author - Book [M4B] Unabridged', sizeBytes: 400e6, health: 'missing' },
    { name: 'Author - Book [M4B] Unabridged.7z', sizeBytes: 400e6 },
    { name: 'Author - Book Unabridged MP3 64kbps', sizeBytes: 380e6, health: 'verified' },
    { name: 'Author - Book [M4B] Unabridged', sizeBytes: 400e6, health: 'playback-failed' },
  ]);
  assert.ok(ranked[0].name.includes('MP3 64kbps'), `healthy MP3 must beat dead/7z/failed M4Bs (got ${ranked[0].name})`);
  assert.ok(ranked.find((r) => r.health === 'missing').score < -5000, 'missing verdict disqualifies audiobook');
  assert.ok(ranked.find((r) => r.name.endsWith('.7z')).score < -5000, '7z container disqualifies audiobook');
  assert.ok(ranked.find((r) => r.health === 'playback-failed').score < ranked[0].score, 'playback-failed demotes audiobook');
});

test('wave4: bookMatches folds diacritics, handles Audible subtitles, and requires surname (not first name)', () => {
  // Diacritics
  const lesMis = parseWantedBook('Les Misérables', 'Victor Hugo');
  assert.ok(bookMatches('Victor Hugo - Les Miserables [M4B] Unabridged', lesMis), 'diacritics fold cleanly');

  // Audible subtitle stripped fallback
  const phm = parseWantedBook('Project Hail Mary: A Novel (Unabridged)', 'Andy Weir');
  assert.ok(bookMatches('Andy Weir - Project Hail Mary [M4B]', phm), 'Audible subtitle does not block clean Usenet release');

  // Surname required — first name alone ("John") must not match another author
  const grisham = parseWantedBook('The Firm', 'John Grisham');
  assert.ok(bookMatches('The Firm - Grisham [M4B]', grisham), 'surname matches');
  assert.ok(!bookMatches('The Firm - John Smith [M4B]', grisham), 'different author sharing first name rejected');
});

test('wave4: searchAudiobook does not early-break when strategy 1 only finds an ebook', async () => {
  const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) =>
    `<item><title>${i.name}</title><enclosure url="${i.url}" length="${i.size}"/></item>`).join('')}</channel></rss>`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const cat = u.searchParams.get('cat');
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    if (cat === '3030') {
      return res.end(rss([{ name: 'Andy Weir - Project Hail Mary EPUB', url: 'http://x/eb.nzb', size: 3e6 }]));
    }
    return res.end(rss([{ name: 'Andy Weir - Project Hail Mary [M4B] Unabridged', url: 'http://x/ab.nzb', size: 420e6 }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-w4-'));
  try {
    const pipeline = new Pipeline({
      pool: () => null,
      verdicts: new VerdictCache(new Store(dir)),
      mounts: new Map(),
      indexers: () => [{ name: 'ix', url: `http://127.0.0.1:${srv.address().port}`, apikey: 'k' }],
    });
    const { candidates } = await pipeline.searchAudiobook({ title: 'Project Hail Mary', author: 'Andy Weir' });
    assert.ok(candidates.some((c) => c.name.includes('[M4B]') && c.score > 0), 'continued past ebook-only cat 3030 hit to find playable M4B');
  } finally {
    await new Promise((r) => srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wave4: playAudiobook marks session.audiobook so advance() preserves audiobook: true', async () => {
  const pipeline = new Pipeline({
    pool: () => null,
    verdicts: { get: () => null, set: () => {} },
    mounts: new Map(),
  });
  let seenAdvanceOpts = [];
  pipeline.searchAudiobook = async () => ({
    candidates: [
      { name: 'Author - Book [M4B] A', pickKey: 'a', score: 100, nzbUrl: 'http://x/a.nzb' },
      { name: 'Author - Book [M4B] B', pickKey: 'b', score: 90, nzbUrl: 'http://x/b.nzb' },
    ],
    errors: [],
  });
  pipeline._advance = async (session, opts) => {
    seenAdvanceOpts.push({ audiobook: !!opts.audiobook, sid: session.id });
    return { session, vf: { id: 'm1', streamable: true }, candidate: session.candidates[0], attempts: [] };
  };
  const first = await pipeline.playAudiobook({ title: 'Book', author: 'Author' });
  assert.equal(first.session.audiobook, true, 'PlaySession persists audiobook flag');
  await pipeline.advance(first.session.id, {});
  assert.equal(seenAdvanceOpts.length, 2);
  assert.equal(seenAdvanceOpts[1].audiobook, true, 'advance() preserves audiobook: true');
});

test('wave4 audit: ytmusic ytArgs pins IPv4, enables Node JS runtime on 2026+ yt-dlp, and server/client guard 302/HLS/pubaudio CSP', () => {
  const ytSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'ytmusic.js'), 'utf8');
  const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

  assert.match(ytSrc, /--force-ipv4/, 'yt-dlp pins IPv4 to match Node proxy family:4');
  assert.match(ytSrc, /--js-runtimes', 'node'/, 'yt-dlp 2025.11+ enables Node JS runtime');
  assert.match(ytSrc, /protocol!\*=m3u8/, 'music format selector prefers progressive HTTP audio over HLS');
  assert.match(srvSrc, /\[301, 302, 303, 307, 308\]\.includes\(up\.statusCode\)/, 'proxyResolvedYoutube follows 302 redirects instead of emitting 0-byte 200');
  assert.match(srvSrc, /family: 4/, 'proxyResolvedYoutube pins IPv4');
  assert.match(srvSrc, /\/api\/pubaudio\/stream\?u=/, 'pubaudioTracks rewrites external archive.org URLs to same-origin proxy');
  assert.match(srvSrc, /api\\\/music\\\/token\\\/|musicToken:\s*async/, 'music token refresh route is registered');
  assert.match(webSrc, /id="pinPad"/, 'PIN gate includes touch & D-pad 0-9 keypad');
  assert.match(webSrc, /openGate === \$\('gatePin'\) && \$\('pinPad'\)/, 'PIN keypad supports 2D 3-column TV D-pad navigation');
  assert.match(webSrc, /id="gateOnboard"/, 'First-run host onboarding checklist is present');
  assert.match(webSrc, /function focusHostOnboardingStep\(\)/, 'Host onboarding focuses active step for TV D-pad');
  assert.match(webSrc, /function renderScoringManager\(restoreFocus = null\)/, 'Scoring manager preserves TV D-pad focus when toggling rules or removing chips');
  assert.match(webSrc, /id="pgCloseBtn"/, 'In-player Live TV guide includes Close button');
  assert.match(webSrc, /id="pgSearch"/, 'In-player Live TV guide includes channel filter input');
  assert.match(webSrc, /id="prefSkipProfilePicker"/, 'Profile & Pins exposes per-device skip-picker toggle');
});

test('startup profile picker: asks on fresh open when 2+ profiles exist, keeps session across reloads, and respects device skip toggle', async () => {
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const start = webSrc.indexOf('async function enterApp() {');
  const end = webSrc.indexOf('async function enterAppShell() {', start);
  assert.ok(start > 0 && end > start, 'enterApp() function extracted');
  const enterAppSrc = webSrc.slice(start, end);

  const runEnterApp = async ({ profiles, saved, sessionId, skipPicker, proofs = new Map() }) => {
    const ls = new Map();
    if (saved) ls.set('triboon.profile', saved);
    if (skipPicker) ls.set('triboon.profileSkipPicker', '1');
    const ss = new Map();
    if (sessionId) ss.set('triboon.profileSession', sessionId);
    const S = { user: { id: 'u1', profiles }, serverInfo: { needsSetup: false }, profile: null };
    let outcome = null;
    const fn = new Function(
      'S', 'api', 'localStorage', 'sessionStorage', 'profileProofs', 'enterAppShell', 'showProfilePicker',
      `${enterAppSrc}\nreturn enterApp();`
    );
    await fn(
      S,
      async () => ({}),
      { getItem: (k) => (ls.has(k) ? ls.get(k) : null) },
      { getItem: (k) => (ss.has(k) ? ss.get(k) : null) },
      proofs,
      () => { outcome = { screen: 'app', profile: S.profile && S.profile.id }; },
      () => { outcome = { screen: 'picker', profile: S.profile && S.profile.id }; },
    );
    return outcome;
  };

  const single = [{ id: 'p1', name: 'Owner', locked: false }];
  const multi = [
    { id: 'p1', name: 'Dad', locked: false },
    { id: 'p2', name: 'Kids', locked: false },
  ];
  const multiPin = [
    { id: 'p1', name: 'Dad', locked: true },
    { id: 'p2', name: 'Kids', locked: false },
  ];

  // 1. Single unlocked profile goes straight to app
  assert.deepStrictEqual(await runEnterApp({ profiles: single }), { screen: 'app', profile: 'p1' });
  // 2. 2+ profiles on fresh open (even with saved last profile) asks "Who's watching?"
  assert.deepStrictEqual(await runEnterApp({ profiles: multi, saved: 'p1' }), { screen: 'picker', profile: null });
  // 3. Same-session reload resumes active profile without re-nagging
  assert.deepStrictEqual(await runEnterApp({ profiles: multi, saved: 'p1', sessionId: 'p2' }), { screen: 'app', profile: 'p2' });
  // 4. Device opted into "Skip picker" opens straight to last-used unlocked profile
  assert.deepStrictEqual(await runEnterApp({ profiles: multi, saved: 'p2', skipPicker: true }), { screen: 'app', profile: 'p2' });
  // 5. PIN-locked profile still asks for picker/PIN even when skipPicker is ON
  assert.deepStrictEqual(await runEnterApp({ profiles: multiPin, saved: 'p1', skipPicker: true }), { screen: 'picker', profile: null });
  // 6. Verified PIN proof in session enters smoothly
  assert.deepStrictEqual(
    await runEnterApp({ profiles: multiPin, saved: 'p1', sessionId: 'p1', proofs: new Map([['p1', 'tok']]) }),
    { screen: 'app', profile: 'p1' }
  );
});

test('home favorite IPTV: transient source errors retry instead of poisoning session, and toggleFav/fillLiveState stay synced', async () => {
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const start = webSrc.indexOf('function runOnIdle(');
  const end = webSrc.indexOf('const HOME_CATALOG_INITIAL =', start);
  assert.ok(start > 0 && end > start, 'home enrichment helpers extracted');
  const helpersSrc = webSrc.slice(start, end);

  // Also assert structural guards for catalogOnly _homeLoadRun race and toggleFav/fillLiveState sync.
  assert.match(webSrc, /const runId = S\._homeLoadRun = opts\.catalogOnly \? \(S\._homeLoadRun \|\| 0\) : \(\(S\._homeLoadRun \|\| 0\) \+ 1\);/,
    'background catalogOnly paints must not cancel an in-flight boot watch load');
  assert.match(webSrc, /syncHomeLiveFavFromChannels\(r\.channels, \{ allowEmpty: !S\.liveSourceErrors\.length \}\)/,
    'fillLiveState heals Home favorite IPTV cache');
  assert.match(webSrc, /syncHomeLiveFavFromChannels\(Array\.isArray\(S\.liveChannels\) \? S\.liveChannels : null\)/,
    'toggleFav updates or invalidates Home favorite IPTV cache');

  const S = { view: 'home', zone: 'rows', rowIdx: 2, colIdx: { 2: 3 }, _homeLiveFav: undefined, _homeLiveFavRetryAfter: 0 };
  let refreshes = 0;
  let loadResult = { configured: true, channels: [], sourceErrors: [{ sourceName: 'Server Live TV', error: 'timeout' }] };
  const fakeDoc = { body: { classList: { contains: (c) => false } } }; // mobile / non-TV
  const fakeEl = () => ({ scrollTop: 20 });

  const env = new Function(
    'S', 'window', 'document', '$', 'appMs', 'liveTvAvailable', 'cachedLocalLibraryItemsAvailable',
    'refreshLocalMapFromCachedLibraries', 'loadLiveChannelsCombined', 'warmLocalPlaybackForWatch',
    'cachedWatchRowsForHome', 'loadRows',
    `${helpersSrc}\nreturn { enrichHome, homeIdleAtTop, homeLiveFavNeedsFetch, syncHomeLiveFavFromChannels };`
  )(
    S, {}, fakeDoc, fakeEl, () => 5000, () => true, () => false,
    () => {}, async () => loadResult, async () => {}, () => [],
    () => { refreshes++; }
  );

  // 1. Mobile (non-TV) stays eligible near the top even if rowIdx/colIdx moved
  assert.strictEqual(env.homeIdleAtTop(), true, 'mobile near top allows folding in favorite IPTV row');

  // 2. Transient sourceError must NOT poison S._homeLiveFav = null forever
  await env.enrichHome();
  assert.strictEqual(S._homeLiveFav, undefined, 'sourceErrors keep _homeLiveFav retryable (undefined, not null)');
  assert.ok(S._homeLiveFavRetryAfter > Date.now(), 'sets retry backoff');
  assert.strictEqual(env.homeLiveFavNeedsFetch(), false, 'respects retry backoff window');

  // 3. Once backoff elapses and provider recovers, enrichHome populates favorites and refreshes Home
  S._homeLiveFavRetryAfter = 0;
  assert.strictEqual(env.homeLiveFavNeedsFetch(), true, 'eligible to retry after backoff');
  loadResult = { configured: true, epg: true, channels: [{ idx: 1, id: 'ch1', name: 'ESPN', fav: true }], sourceErrors: [] };
  await env.enrichHome();
  assert.strictEqual(S._homeLiveFav.length, 1);
  assert.strictEqual(S._homeLiveFav[0].id, 'ch1');
  assert.ok(refreshes >= 1, 'triggers Home refresh with new favorites');

  // 4. syncHomeLiveFavFromChannels reflects live favorite toggles immediately
  env.syncHomeLiveFavFromChannels([{ idx: 1, id: 'ch1', fav: false }, { idx: 2, id: 'ch2', fav: true }]);
  assert.deepStrictEqual(S._homeLiveFav.map((c) => c.id), ['ch2']);
});

test('display cover size and content text size scale cleanly across phone, tablet, desktop, 4K, and TV', () => {
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

  // 1. Mobile #grid / #personGrid must follow --phoneCols (not hardcoded minmax(102px,1fr))
  assert.match(webSrc, /body:not\(\.tv\) #grid,body:not\(\.tv\) #personGrid\{grid-template-columns:repeat\(var\(--phoneCols,3\),minmax\(0,1fr\)\)/);
  assert.match(webSrc, /body\.mobileShell:not\(\.tv\) #grid,body\.mobileShell:not\(\.tv\) #personGrid\{grid-template-columns:repeat\(var\(--phoneCols,3\),minmax\(0,1fr\)\)/);

  // 2. Quiet Graphite & mobile/TV surfaces must consume --ct* tokens instead of hardcoded px overrides
  assert.match(webSrc, /body\[data-theme="graphite"\] \.gCh \.gChName\{display:block;font:600 var\(--ctLiveTitle\)/);
  assert.match(webSrc, /body\[data-theme="graphite"\] \.guideTimeline \.gProg \.gpT\{font:600 var\(--ctLiveNow\)/);
  assert.match(webSrc, /body\[data-theme="graphite"\] \.guideTimeline \.gProg \.gpS\{font:500 var\(--ctLiveMeta\)/);
  assert.match(webSrc, /body\[data-theme="graphite"\] \.srcRow \.srcMeta\{font:600 var\(--ctSrcTitle\)/);
  assert.match(webSrc, /body\[data-theme="graphite"\] \.srcRow \.chip\{font:600 var\(--ctSrcChip\)/);
  assert.match(webSrc, /body\[data-theme="graphite"\] #prefs \.hint\{font:400 var\(--ctSetMeta\)\/1\.45/);
  assert.match(webSrc, /body\[data-theme="graphite"\]\.mobileShell:not\(\.tv\) #prefs \.hint\{font:400 var\(--ctSetMeta\)\/1\.45/);
  assert.match(webSrc, /body\.tv \.mSearchSongs \.musicRow \.mT\{font-size:var\(--ctMusicSearchTitle\)/);
  assert.match(webSrc, /@media \(min-width:1760px\)\{\s*body\.tv\{/);
  assert.match(webSrc, /@media \(min-width:2200px\)\{\s*body:not\(\.tv\):not\(\.mobileShell\)\{/);
  assert.match(webSrc, /@media \(min-width:3000px\)\{\s*body:not\(\.tv\):not\(\.mobileShell\)\{/);

  // 3. Execute extracted applyCoverSize / phoneCatalogCols / desktopCoverPx across resolutions
  const start = webSrc.indexOf('const COVER_SIZES =');
  const end = webSrc.indexOf('// Row windows sized from REAL geometry', start);
  assert.ok(start > 0 && end > start, 'cover size helpers extracted');
  const coverSrc = webSrc.slice(start, end);

  const runCase = ({ w, h, tv = false, mobileShell = false, size = 'M' }) => {
    const props = {};
    const classes = new Set();
    if (tv) classes.add('tv');
    if (mobileShell) classes.add('mobileShell');
    const classList = {
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    };
    const fakeWin = { innerWidth: w, innerHeight: h };
    const fakeDoc = {
      body: { classList },
      documentElement: {
        style: {
          setProperty: (k, v) => { props[k] = String(v); },
          removeProperty: (k) => { delete props[k]; },
        },
      },
    };
    const fakeLS = { getItem: (k) => (k === 'triboon.cover' ? size : null) };
    const fn = new Function(
      'window', 'document', 'localStorage', 'innerWidth', 'innerHeight', 'getComputedStyle',
      '$', 'S', 'adaptRowWindows', 'refreshVirtualGridGeometry', 'scheduleVirtualGridGeometryRefresh', 'maybeFillBrowseWindow',
      `${coverSrc}\nreturn { applyCoverSize, phoneCatalogCols, desktopCoverPx };`
    );
    const api = fn(
      fakeWin, fakeDoc, fakeLS, w, h,
      () => ({ getPropertyValue: () => '' }),
      () => null, { view: 'movies' },
      () => {}, () => {}, () => {}, () => {}
    );
    api.applyCoverSize();
    return {
      poster: parseFloat(props['--poster']),
      thumb: props['--thumb'] ? parseFloat(props['--thumb']) : null,
      phoneCols: props['--phoneCols'] ? parseInt(props['--phoneCols'], 10) : null,
      homePoster: props['--homePoster'] ? parseFloat(props['--homePoster']) : null,
      coverS: classes.has('coverS'),
      coverL: classes.has('coverL'),
    };
  };

  // Phone portrait 390x844: S=4 cols < M=3 cols < L=2 cols, poster & thumb strictly increase
  const phS = runCase({ w: 390, h: 844, mobileShell: true, size: 'S' });
  const phM = runCase({ w: 390, h: 844, mobileShell: true, size: 'M' });
  const phL = runCase({ w: 390, h: 844, mobileShell: true, size: 'L' });
  assert.deepStrictEqual([phS.phoneCols, phM.phoneCols, phL.phoneCols], [4, 3, 2]);
  assert.ok(phS.poster < phM.poster && phM.poster < phL.poster, `phone portrait posters monotonic: ${phS.poster} < ${phM.poster} < ${phL.poster}`);
  assert.ok(phS.thumb < phM.thumb && phM.thumb < phL.thumb && phM.thumb > phM.poster, `phone portrait thumbs scale > poster`);

  // Phone landscape 844x390: S=6 cols, M=5 cols, L=4 cols
  const plS = runCase({ w: 844, h: 390, mobileShell: true, size: 'S' });
  const plM = runCase({ w: 844, h: 390, mobileShell: true, size: 'M' });
  const plL = runCase({ w: 844, h: 390, mobileShell: true, size: 'L' });
  assert.deepStrictEqual([plS.phoneCols, plM.phoneCols, plL.phoneCols], [6, 5, 4]);
  assert.ok(plS.poster < plM.poster && plM.poster < plL.poster);

  // Tablet 768x1024, Desktop 1920x1080, 4K 3840x2160: strictly monotonic S < M < L AND scales up with resolution
  const tabM = runCase({ w: 768, h: 1024, size: 'M' });
  const d1080S = runCase({ w: 1920, h: 1080, size: 'S' });
  const d1080M = runCase({ w: 1920, h: 1080, size: 'M' });
  const d1080L = runCase({ w: 1920, h: 1080, size: 'L' });
  const d4kM = runCase({ w: 3840, h: 2160, size: 'M' });
  const d4kL = runCase({ w: 3840, h: 2160, size: 'L' });
  assert.ok(d1080S.poster < d1080M.poster && d1080M.poster < d1080L.poster, '1080p desktop S < M < L');
  assert.ok(d1080L.poster - d1080M.poster >= 40, '1080p desktop L visibly larger than M');
  assert.ok(tabM.poster < d1080M.poster && d1080M.poster < d4kM.poster && d4kM.poster < d4kL.poster,
    `resolution scaling tablet(${tabM.poster}) < 1080p(${d1080M.poster}) < 4K M(${d4kM.poster}) < 4K L(${d4kL.poster})`);

  // TV 1440x810 (Android TV) and 1920x1080 (LG webOS): S < M < L posters & thumbs
  for (const [w, h] of [[1440, 810], [1920, 1080]]) {
    const tS = runCase({ w, h, tv: true, size: 'S' });
    const tM = runCase({ w, h, tv: true, size: 'M' });
    const tL = runCase({ w, h, tv: true, size: 'L' });
    assert.ok(tS.poster < tM.poster && tM.poster < tL.poster, `TV ${w}x${h} posters monotonic`);
    assert.ok(tS.thumb < tM.thumb && tM.thumb < tL.thumb, `TV ${w}x${h} thumbs monotonic`);
  }
});

test('toast notifications sanitize raw technical errors, drop aborts/duplicates, classify tones, and stay quiet on noisy events', () => {
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const start = webSrc.indexOf('let _lastToastText =');
  const end = webSrc.indexOf('function hideToast()', start);
  assert.ok(start > 0 && end > start, 'toast helpers extracted');
  const toastSrc = webSrc.slice(start, end);

  // Noisy/redundant internal toasts removed
  assert.ok(!webSrc.includes("toast('TMDB error: '"), 'Home background TMDB catch does not toast raw errors');
  assert.ok(!webSrc.includes("toast('Connection hiccup. Retrying...')"), 'auto-retry connection hiccup does not toast');
  assert.ok(!webSrc.includes("toast('Opened Home after update.')"), 'no redundant Opened Home after update toast');
  assert.ok(!webSrc.includes("toast('Direct play not supported here"), 'no technical remux jargon toast on startup');
  assert.ok(!webSrc.includes("toast('Still waiting for the server"), 'no noisy waiting-for-server toast');
  assert.ok(!webSrc.includes("toast('Server restarted — picking up where you left off')"), 'no noisy server-restarted toast');

  let shown = [];
  let timer = null;
  const fakeEl = {
    dataset: {},
    classList: { add: () => {}, remove: () => {} },
    addEventListener: () => {},
  };
  const fakeMsg = { textContent: '' };
  const api = new Function(
    '$', 'toastTimer', 'setTimeout', 'clearTimeout',
    `${toastSrc}\nreturn { cleanToastMessage, classifyToastTone, toast };`
  )(
    (id) => (id === 'toast' ? fakeEl : id === 'toastMsg' ? fakeMsg : null),
    timer,
    (fn) => { shown.push({ text: fakeMsg.textContent, tone: fakeEl.dataset.tone }); return 1; },
    () => {}
  );

  // Silent drop for empty and AbortError / cancelled
  assert.strictEqual(api.cleanToastMessage(''), '');
  assert.strictEqual(api.cleanToastMessage('AbortError: The user aborted a request.'), '');
  assert.strictEqual(api.cleanToastMessage('The operation was aborted'), '');
  assert.strictEqual(api.cleanToastMessage('signal is aborted without reason'), '');

  // Clean human copy for raw network / HTTP / JSON / player errors, stripping URLs & tokens
  assert.strictEqual(api.cleanToastMessage('TypeError: Failed to fetch https://secret.host/api?t=abc123'), 'Could not reach the server. Check your connection.');
  assert.strictEqual(api.cleanToastMessage('HTTP 502 Bad Gateway'), 'Server is temporarily unavailable. Try again in a moment.');
  assert.strictEqual(api.cleanToastMessage('HTTP 401'), 'Session expired — sign in again.');
  assert.strictEqual(api.cleanToastMessage('SyntaxError: Unexpected token < in JSON'), 'Unexpected response from the server. Try again.');
  assert.strictEqual(api.cleanToastMessage('ExoPlaybackException: ERROR_CODE_IO_BAD_HTTP_STATUS'), 'Playback could not start — try another source.');

  // Tone classification
  assert.strictEqual(api.classifyToastTone('Provider added (encrypted)'), 'ok');
  assert.strictEqual(api.classifyToastTone('Live stream unavailable'), 'warn');
  assert.strictEqual(api.classifyToastTone('Could not reach the server. Check your connection.'), 'err');
  assert.strictEqual(api.classifyToastTone('Shuffle on'), 'info');

  // Deduplication suppresses duplicate rapid calls
  api.toast('Added to watchlist');
  api.toast('Added to watchlist');
  assert.strictEqual(shown.length, 1, 'duplicate toast within 2.5s suppressed');
  assert.strictEqual(shown[0].tone, 'ok');
});

test('subtitle sizing scales cleanly across portrait phone, landscape phone, desktop, TV, 4K, Android, and Windows', () => {
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const start = webSrc.indexOf('const SUB_SIZES =');
  const end = webSrc.indexOf('applySubSize(); // boot', start);
  assert.ok(start > 0 && end > start, 'SUB_SIZES and applySubSize extracted');
  const subSrc = webSrc.slice(start, end);

  // Live preview element exists in Settings -> Playback
  assert.ok(webSrc.includes('id="subSizePreview"'), 'Settings includes live caption size preview');

  const props = {};
  let stored = 'M';
  const api = new Function(
    'localStorage', 'document',
    `${subSrc}\nreturn { SUB_SIZES, applySubSize };`
  )(
    { getItem: (k) => (k === 'triboon.subsize' ? stored : null) },
    { documentElement: { style: { setProperty: (k, v) => { props[k] = String(v); } } } }
  );

  // Evaluate clamp(minPx, pctVmin, maxPx) across real device viewports
  const evalClamp = (expr, w, h) => {
    const m = /^clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vmin\s*,\s*([\d.]+)px\s*\)$/.exec(expr.trim());
    assert.ok(m, `SUB_SIZES uses vmin clamp: ${expr}`);
    const min = parseFloat(m[1]);
    const mid = (parseFloat(m[2]) / 100) * Math.min(w, h);
    const max = parseFloat(m[3]);
    return Math.min(max, Math.max(min, mid));
  };

  for (const [label, w, h] of [
    ['phone portrait 390x844', 390, 844],
    ['phone landscape 844x390', 844, 390],
    ['tablet 768x1024', 768, 1024],
    ['TV 1440x810', 1440, 810],
    ['desktop 1920x1080', 1920, 1080],
    ['4K 3840x2160', 3840, 2160],
  ]) {
    const sizes = {};
    for (const code of ['S', 'M', 'L']) {
      stored = code;
      assert.strictEqual(api.applySubSize(), code);
      sizes[code] = evalClamp(props['--subFs'], w, h);
    }
    assert.ok(sizes.S < sizes.M && sizes.M < sizes.L, `${label}: S(${sizes.S}) < M(${sizes.M}) < L(${sizes.L})`);
    assert.ok(sizes.S >= 14 && sizes.L <= 72, `${label}: bounded within 14..72px (${sizes.S}..${sizes.L})`);
    if (w === 390 && h === 844) {
      assert.ok(sizes.L <= 24, `portrait phone Large caption stays <=24px (got ${sizes.L})`);
    }
  }

  // Invalid storage falls back to M
  stored = 'BOGUS';
  assert.strictEqual(api.applySubSize(), 'M');

  // Android SubtitleText scales separately for TV vs phone, and Windows subtitle_scale has distinct S/M/L steps
  const androidSub = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'app', 'triboon', 'tv', 'SubtitleText.java'), 'utf8');
  assert.match(androidSub, /static float sizeSp\(String preference, boolean isTv\)/);
  const winPlayer = fs.readFileSync(path.join(__dirname, '..', 'clients', 'windows-px8', 'src-tauri', 'src', 'player.rs'), 'utf8');
  assert.match(winPlayer, /"S" => 0\.78,\s*"L" => 1\.28,/);
});

test('Kids rotates popular pages daily with fresh unwatched leads, and Discover strictly deduplicates across all rows including trailers', () => {
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

  // Structural checks on Discover trailer re-dedupe, tomorrow-start Upcoming, and day-keyed caches
  assert.match(webSrc, /const soonFrom = isoDateOffset\(1\);/);
  assert.match(webSrc, /rows\.unshift\(row\);\s*const deduped = dedupeRows\(rows\)/);
  assert.match(webSrc, /function kidsDailyPopularPage\(page = 1\)/);
  assert.match(webSrc, /S\.discoverDay = today;/);

  // Extract dedupeRows, kidsDayShift, rotateKidsItems, weaveKidsPopularAndFresh, kidsDailyPopularPage
  const dedupeStart = webSrc.indexOf('function dedupeItemKey(');
  const dedupeEnd = webSrc.indexOf('\n}', webSrc.indexOf('function dedupeRows(', dedupeStart)) + 2;
  const kidsStart = webSrc.indexOf('function kidsDayShift(');
  const kidsEnd = webSrc.indexOf('function homeKidsCatalogRow(', kidsStart);
  const popPageStart = webSrc.indexOf('function kidsDailyPopularPage(');
  const popPageEnd = webSrc.indexOf('\n}', popPageStart) + 2;
  assert.ok(dedupeStart > 0 && kidsStart > 0 && popPageStart > 0);

  let fakeDay = '2026-11-27';
  const watchedKeys = new Set(['tmdb:movie:101']);
  const api = new Function(
    'todayStr', 'isWatched',
    `${webSrc.slice(dedupeStart, dedupeEnd)}\n${webSrc.slice(kidsStart, kidsEnd)}\n${webSrc.slice(popPageStart, popPageEnd)}\nreturn { dedupeRows, weaveKidsPopularAndFresh, kidsDailyPopularPage };`
  )(() => fakeDay, (it) => watchedKeys.has(it.key));

  // 1. Cross-row dedupe catches matching TMDB items even with different key formats or trailer wrappers
  const rows = api.dedupeRows([
    { name: '▶ Latest trailers', items: [{ key: 'trailer:1', type: 'movie', tmdbId: 55, trailer: { key: 'yt1' } }, { key: 'tmdb:tv:77', type: 'tv', tmdbId: 77, trailer: { key: 'yt2' } }] },
    { name: 'New movies', poster: true, items: [{ key: 'tmdb:movie:55', type: 'movie', tmdbId: 55 }, { key: 'tmdb:movie:56', type: 'movie', tmdbId: 56 }] },
    { name: 'New series', poster: true, items: [{ key: 'tv:77', type: 'tv', tmdbId: 77 }, { key: 'tmdb:tv:78', type: 'tv', tmdbId: 78 }] },
  ]);
  assert.deepStrictEqual(rows[1].items.map((x) => x.tmdbId), [56], 'movie in Latest trailers does not repeat in New movies');
  assert.deepStrictEqual(rows[2].items.map((x) => x.tmdbId), [78], 'show in Latest trailers does not repeat in New series');

  // 2. Kids weaves fresh 1:1 with popular, pushes watched items to the back, and rotates popular pages across days
  const popular = [
    { key: 'tmdb:movie:101', type: 'movie', tmdbId: 101, tag: 'pop' },
    { key: 'tmdb:movie:102', type: 'movie', tmdbId: 102, tag: 'pop' },
    { key: 'tmdb:movie:103', type: 'movie', tmdbId: 103, tag: 'pop' },
  ];
  const fresh = [
    { key: 'tmdb:movie:201', type: 'movie', tmdbId: 201, tag: 'fresh' },
    { key: 'tmdb:movie:202', type: 'movie', tmdbId: 202, tag: 'fresh' },
  ];
  const woven = api.weaveKidsPopularAndFresh(popular, fresh);
  assert.strictEqual(woven[0].tag, 'fresh', 'Kids leads with a fresh release');
  assert.strictEqual(woven[woven.length - 1].tmdbId, 101, 'already-watched Kids title moves to the end');

  const seenPages = new Set();
  for (let d = 1; d <= 15; d++) {
    fakeDay = `2026-11-${String(d).padStart(2, '0')}`;
    const p1 = api.kidsDailyPopularPage(1);
    const p2 = api.kidsDailyPopularPage(2);
    const p3 = api.kidsDailyPopularPage(3);
    assert.deepStrictEqual([p1, p2, p3].sort(), [1, 2, 3], 'pages 1..3 permute without repeats');
    seenPages.add(p1);
  }
  assert.ok(seenPages.size >= 2, `Kids popular page rotates across days (saw ${[...seenPages].join(',')})`);
});

test('trailers prefer highest direct muxed HD MP4 over 360p/HLS and wire full playback UX controls', () => {
  const ytmusic = require('../server/ytmusic');
  const pick = ytmusic._pickBestMuxedTrailerFormat;
  assert.strictEqual(typeof pick, 'function');

  // Picks 1080p progressive MP4/H.264 over 360p itag 18 and ignores m3u8 manifests
  const best = pick({
    formats: [
      { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', protocol: 'https', url: 'https://cdn.example/360.mp4', tbr: 500 },
      { format_id: '96', ext: 'mp4', height: 1080, vcodec: 'avc1.640028', acodec: 'mp4a.40.2', protocol: 'm3u8_native', url: 'https://cdn.example/1080.m3u8', tbr: 4500 },
      { format_id: '22', ext: 'mp4', height: 720, vcodec: 'avc1.64001F', acodec: 'mp4a.40.2', protocol: 'https', url: 'https://cdn.example/720.mp4', tbr: 2100 },
      { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1.640028', acodec: 'none', protocol: 'https', url: 'https://cdn.example/video-only.mp4', tbr: 3800 },
      { format_id: 'hd1080', ext: 'mp4', height: 1080, vcodec: 'avc1.640028', acodec: 'mp4a.40.2', protocol: 'https', url: 'https://cdn.example/1080.mp4', tbr: 4000 },
    ],
  });
  assert.strictEqual(best.format_id, 'hd1080', 'picks direct muxed 1080p H.264 MP4 over 360p, video-only, and m3u8');

  // Falls back to 720p direct muxed over 360p when 1080p is m3u8-only
  const hd720 = pick({
    formats: [
      { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a', protocol: 'https', url: 'https://cdn.example/360.mp4' },
      { format_id: '22', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'mp4a', protocol: 'https', url: 'https://cdn.example/720.mp4' },
      { format_id: '96', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'mp4a', protocol: 'm3u8', url: 'https://cdn.example/1080.m3u8' },
    ],
  });
  assert.strictEqual(hd720.format_id, '22');

  // Web UI trailer modal exposes transport controls, clip switcher, details button, quality badge, autoplay mute fallback, and startup watchdog
  const webSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  for (const id of ['trailerToggle', 'trailerMute', 'trailerUnmute', 'trailerNextClip', 'trailerDetails', 'trailerFs', 'trailerEnded']) {
    assert.ok(webSrc.includes(`id="${id}"`), `trailer modal includes #${id}`);
  }
  assert.match(webSrc, /function updateTrailerQualityBadge\(video\)/);
  assert.match(webSrc, /err\.name === 'NotAllowedError'/);
  assert.match(webSrc, /trailer startup timed out/);
  assert.match(webSrc, /if \(k === ' ' \|\| k === 'k' \|\| k === 'K'\) return toggleTrailerPlayPause\(\);/);
});
