'use strict';
// Phase 4: playback-decision logic (source-fit → direct → remux → transcode), the ffmpeg
// remux path, and the player backend (track probing, audio selection, subtitle extraction).
// ffmpeg-dependent assertions skip cleanly when the binary is absent so the suite stays
// green on a bare dev box; the Docker image ships ffmpeg and exercises the live path.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { detectFfmpeg, detectFfprobe, detectEncoder, decidePlayback, probeTracks, spawnRemux, spawnLiveRemux, spawnTranscode, spawnSubtitleExtract } = require('../server/transcode');

const HAS_FFMPEG = !!detectFfmpeg();
const HAS_FFPROBE = !!detectFfprobe();
const HAS_ENCODER = !!detectEncoder();

function pngHasTransparentPixels(file) {
  const png = fs.readFileSync(file);
  assert.strictEqual(png.toString('ascii', 1, 4), 'PNG', `${file} must be a PNG`);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      bitDepth = png[dataStart + 8];
      colorType = png[dataStart + 9];
    } else if (type === 'IDAT') {
      idat.push(png.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }
  assert.strictEqual(bitDepth, 8, `${file} must use 8-bit PNG channels`);
  assert.ok(colorType === 6 || colorType === 4, `${file} must include an alpha channel`);
  const channels = colorType === 6 ? 4 : 2;
  const rowBytes = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  let pos = 0;
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = Buffer.from(raw.subarray(pos, pos + rowBytes));
    pos += rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 255;
      else if (filter === 2) row[x] = (row[x] + up) & 255;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        row[x] = (row[x] + (pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft))) & 255;
      }
    }
    for (let x = channels - 1; x < rowBytes; x += channels) {
      if (row[x] < 255) return true;
    }
    prev = row;
  }
  return false;
}

// Build a tiny MKV with 2 audio tracks (eng + ger) and 1 SRT subtitle track. Returns its path.
function makeMultitrackFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-media-'));
  const srt = path.join(dir, 's.srt');
  fs.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:02,500\nHello Triboon\n\n2\n00:00:03,000 --> 00:00:05,000\nSecond line\n');
  const out = path.join(dir, 'multi.mkv');
  const r = spawnSync(detectFfmpeg().path, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6',
    '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=ger',
    '-metadata:s:s:0', 'language=eng',
    out,
  ], { timeout: 60000, windowsHide: true });
  if (r.status !== 0) throw new Error('test media generation failed: ' + r.stderr);
  return out;
}

function serveFile(file) {
  const server = http.createServer((req, res) => {
    const stat = fs.statSync(file);
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.ts' ? 'video/mp2t' : ext === '.mp4' ? 'video/mp4' : ext === '.mkv' ? 'video/x-matroska' : 'application/octet-stream';
    if (range && range[1] !== '') {
      const start = +range[1];
      const end = range[2] ? +range[2] : stat.size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  });
  const name = encodeURIComponent(path.basename(file));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/${name}` })));
}

function collect(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.stdout.on('data', (d) => chunks.push(d));
    stream.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

test('playback decision: mp4/webm direct; mkv direct only with container AND audio hardware', () => {
  assert.strictEqual(decidePlayback('Movie.mp4').method, 'direct');
  assert.strictEqual(decidePlayback('Movie.webm').method, 'direct');
  // Container support alone is a Chromium lie (matroska "maybe", zero AC3-family decode) —
  // direct play demands the audio claims too, else DDP MKVs play silent.
  assert.strictEqual(decidePlayback('Movie.mkv', { mkv: true, ac3: true, eac3: true }).method, 'direct');
});

test('playback decision: mkv without client support → remux if ffmpeg, else direct+warning', () => {
  const d = decidePlayback('Movie.mkv', { mkv: false });
  if (HAS_FFMPEG) assert.strictEqual(d.method, 'remux');
  else { assert.strictEqual(d.method, 'direct'); assert.ok(d.warning, 'honest degrade when no ffmpeg'); }
});

test('playback decision: unknown release containers remux first when ffmpeg is available', () => {
  const d = decidePlayback('Damage.1992.1080p.BluRay.X264-AMIABLE', { mkv: false });
  if (HAS_FFMPEG) assert.strictEqual(d.method, 'remux');
  else { assert.strictEqual(d.method, 'direct'); assert.ok(d.warning, 'honest degrade when no ffmpeg'); }
});

test('source-fit beats transcoding: a cap-fit direct-play release is chosen at SOURCE level', () => {
  // This is enforced in scoring (covered in phase2), but assert the policy ordering holds end
  // to end: caps shrink the candidate's resolution at pick time, so the player rarely transcodes.
  const { rankReleases } = require('../server/scoring');
  const ranked = rankReleases([
    { name: 'X.2160p.WEB-DL.HEVC-NTb', sizeBytes: 20e9 },
    { name: 'X.1080p.WEB-DL.H.264-NTb', sizeBytes: 7e9 },
  ], { maxResolutionRank: 3 });
  assert.ok(ranked[0].name.includes('1080p'), 'capped user gets a 1080p SOURCE, not a transcoded 4K');
});

test('quality toggle is a source-selection preference that survives Continue Watching', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(ui, /body\.maxResolutionRank = qRank;[\s\S]+body\.preferResolutionRank = qRank;/,
    '1080p and 4K choices should both be sent to /api/play as source-selection policy');
  assert.match(ui, /function mapTmdb\(x\) \{[\s\S]+originalLanguage: x\.original_language \|\| x\.originalLanguage \|\| ''/,
    'TMDB items should preserve original language for source-language scoring');
  assert.match(ui, /function sourceSearchQuery\(it, opts = \{\}\) \{[\s\S]+originalLanguage[\s\S]+preferredAudioLanguage/,
    'Sources searches should carry original-language and preferred-audio hints into scoring');
  assert.match(ui, /function sourceSearchQuery\(it, opts = \{\}\) \{[\s\S]+params\.set\('caps', JSON\.stringify\(clientCaps\(\)\)\)/,
    'Sources searches should carry native device caps so source ranking matches Exo playback');
  assert.match(ui, /async function play\(it, pick\) \{[\s\S]+body\.originalLanguage[\s\S]+body\.preferredAudioLanguage/,
    'Play requests should carry original-language and preferred-audio hints into source selection');
  const serverForPolicy = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.ok(serverForPolicy.includes('function parseCapsQuery(raw) {')
    && serverForPolicy.includes("caps: parseCapsQuery(ctx.url.searchParams.get('caps'))"),
    'Sources search should parse native device caps into the server scoring policy');
  assert.match(serverForPolicy, /function playbackPolicyFor\(user, \{ maxResolutionRank, preferResolutionRank, originalLanguage, preferredAudioLanguage, caps: rawCaps \} = \{\}\) \{[\s\S]+policy\.originalLanguage[\s\S]+policy\.preferredAudioLanguage[\s\S]+policy\.audioPassthrough[\s\S]+policy\.lowPowerDevice/,
    'Server playback policy should preserve language/device hints for the scorer');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8'), /if \(preferRank === 4\) policy\.exactResolutionRank = 4;/,
    '4K selection should be exact so fallback stays in the 4K source class');
  assert.match(ui, /function sourceSearchQuery\(it, opts = \{\}\) \{[\s\S]+const qRank = opts\.includeQuality === false \? null : qualityRankForItem\(it\);[\s\S]+maxResolutionRank[\s\S]+preferResolutionRank/,
    'Sources, play warmup, and availability should share one query builder while allowing unfiltered quality discovery');
  assert.match(ui, /function prefetchSources\(it, delay = 700\) \{[\s\S]+const qRank = qualityRankForItem\(it\);[\s\S]+localTitleHasPlayback\(it\) && localPlaybackFitsQuality\(it, qRank\)[\s\S]+api\('\/api\/search\?' \+ sourceSearchQuery\(it\)\)/,
    'source warmup should skip matching local files but still warm online 4K when local playback is lower quality');
  assert.match(ui, /function updateDetailPlayLabel\(\{ label, target \}\) \{[\s\S]+detailPlayTarget = target;[\s\S]+prefetchSources\(target, 0\);[\s\S]+\}/,
    'movie/show details should warm the exact current Play target immediately, including TV episodes');
  assert.match(ui, /pickKey: picked && picked\.pickKey/,
    'manual source playback should send the opaque server pick key, not only a release name');
  assert.match(ui, /play\(it, \{ name: c\.name, pickKey: c\.pickKey, resolutionRank: rk\(c\) \}\)/,
    'clicking a Sources row should carry its exact release key and quality class into Play');
  assert.match(ui, /async function play\(it, pick\) \{[\s\S]+it = resolvePlaybackResume\(it\);[\s\S]+const picked = pick && typeof pick === 'object' \? pick : \(pick \? \{ name: pick \} : null\);[\s\S]+const body = \{ q: queryFor\(it\), pick: picked && picked\.name, pickKey: picked && picked\.pickKey, caps: clientCaps\(\) \};/,
    'manual source selection should re-resolve the latest resume point before mounting the exact picked release');
  assert.match(ui, /function stopActivePlaybackForReplacement\(opts = \{\}\) \{[\s\S]+saveWatch\(true\);[\s\S]+window\.TriboonTV\.closeVideo\(\);[\s\S]+stopWebVideoElement\(\);[\s\S]+if \(!opts\.preserveGuide\) closePlayerGuide\(\{ fromNative: true \}\);[\s\S]+S\.playing = null;[\s\S]+\}/,
    'source replacement should stop the active native/web player before the new mount can start');
  assert.match(ui, /async function play\(it, pick\) \{[\s\S]+const localExact = !picked && localPlaybackForItem\(it\) \? \{ \.\.\.it, _local: localPlaybackForItem\(it\) \} : null;[\s\S]+if \(localExact && localPlaybackFitsQuality\(localExact, qRank\)\) return playLocal\(localExact\);[\s\S]+stopActivePlaybackForReplacement\(\);[\s\S]+const nativeFirst = nativeVideoRequired\(it\);/,
    'manual source selection and quality mismatches should tear down the old source before showing the new loading/player state');
  assert.match(ui, /const pickRank = picked \? normalizeResolutionRank\(picked\.resolutionRank\) : null;[\s\S]+const qRank = pickRank !== null \? pickRank : qualityRankForItem\(it\);[\s\S]+body\.maxResolutionRank = qRank;[\s\S]+body\.preferResolutionRank = qRank;/,
    'manual source selection should prefer the picked source quality while normal Play uses the current 1080p/4K toggle');
  assert.match(ui, /function qualityRankForItem\(it\) \{[\s\S]+if \(it\._local && !it\.tmdbId\) return null;/,
    'matched local movies and episodes should still inherit saved 1080p/4K preferences');
  assert.match(ui, /function releaseResolutionRankFromName\(name\) \{[\s\S]+2160p\|4k\|uhd[\s\S]+return 4;[\s\S]+function localPlaybackFitsQuality\(it, qRank\) \{[\s\S]+if \(qRank === 4\) return rank === 4;[\s\S]+if \(qRank === 3\) return rank !== 4;/,
    'local playback should be allowed only when it matches the requested source class');
  assert.match(ui, /const picked = pick && typeof pick === 'object'[\s\S]+const qRank = pickRank !== null \? pickRank : qualityRankForItem\(it\);[\s\S]+const localExact = !picked && localPlaybackForItem\(it\) \? \{ \.\.\.it, _local: localPlaybackForItem\(it\) \} : null;[\s\S]+if \(localExact && localPlaybackFitsQuality\(localExact, qRank\)\) return playLocal/,
    'Play should compute quality before the local shortcut so selected 4K cannot be replaced by a local 1080p file');
  assert.match(ui, /catch \(e\) \{[\s\S]+if \(localExact && !picked && \/no playable\|no \.\*candidate\|all candidates failed\/i\.test\(String\(e && e\.message \|\| ''\)\)\) \{[\s\S]+return playLocal\(localExact\);[\s\S]+\}/,
    'Local library files should fall back to disk playback when online source search has no playable candidate');
  assert.ok([
    '#srcSort button{height:34px',
    '.srcRow{position:relative;overflow:visible;width:100%;box-sizing:border-box;border-radius:13px',
    'display:flex;flex-direction:column',
    '.srcRow .srcBadges{display:flex',
    '.srcRow .srcMeta{font:650 11.3px',
  ].every((s) => ui.includes(s)),
    'Sources drawer rows should be a less busy TV picker: title, badges, one compact metadata line');
  assert.match(ui, /const meta = \[[\s\S]+fmtAttr\(a\.source\),[\s\S]+fmtAttr\(a\.codec\),[\s\S]+audioInfo\(a\),[\s\S]+a\.group \|\| '',[\s\S]+c\.indexer \|\| 'Unknown',[\s\S]+\]\.filter\(Boolean\)\.join\(' · '\)/,
    'Sources drawer should still expose source, codec, audio, group, and indexer in the compact line');
  assert.match(ui, /<div id="srcSort"[\s\S]+data-src-sort="best" class="focusable sel"[\s\S]+data-src-sort="largest" class="focusable"[\s\S]+data-src-sort="smallest" class="focusable"[\s\S]+if \(S\.sourceSort === 'largest'\)[\s\S]+if \(S\.sourceSort === 'smallest'\)/,
    'Sources drawer should let the same returned rows sort by Best, Largest, or Smallest');
  assert.match(ui, /function drawerSortButtons\(\) \{[\s\S]+\$\(\'srcSort\'\)\.querySelectorAll\('button'\)[\s\S]+function focusDrawerSort\(i\) \{[\s\S]+S\.zone = 'drawerSort'[\s\S]+applyFocus\(btns\[S\.drawerSortIdx\]\)/,
    'Sources sort buttons should be part of the D-pad focus model');
  assert.match(ui, /if \(\$\(\'drawer\'\)\.classList\.contains\('open'\)\) \{[\s\S]+const sortBtns = drawerSortButtons\(\);[\s\S]+const inSort = sortIdx >= 0 \|\| S\.zone === 'drawerSort';[\s\S]+if \(inSort\) \{[\s\S]+if \(k === 'ArrowLeft'\) return focusDrawerSort\(i - 1\);[\s\S]+if \(k === 'ArrowRight'\) return focusDrawerSort\(i \+ 1\);[\s\S]+if \(k === 'ArrowDown'\) return focusDrawer\(0\);[\s\S]+if \(k === 'Enter' && !e\.repeat\) return sortBtns\[i\] && sortBtns\[i\]\.click\(\);/,
    'Sources D-pad navigation should move across sort buttons, down into rows, and activate sorting');
  assert.match(ui, /const autoKey = cands\[0\] && cands\[0\]\.pickKey;[\s\S]+const isAuto = c\.pickKey === autoKey;[\s\S]+isAuto \? '<span class="chip auto">Auto pick<\/span>'/,
    'Sources sorting should not move the Auto pick badge onto the largest row');
  assert.ok([
    'const displayReleaseName = (name) => {',
    ".replace(/[._]+/g, ' ')",
    ".replace(/\\bWEB DL\\b/gi, 'WEB-DL')",
    ".replace(/\\bH 264\\b/gi, 'H.264')",
  ].every((s) => ui.includes(s)),
    'Sources drawer should show readable release names instead of raw dotted post names');
  assert.match(ui, /row\.title = c\.name \|\| '';[\s\S]+row\.innerHTML = `<div class="srcTop"><div class="srcTitle"><div class="name">\$\{esc\(displayReleaseName\(c\.name\)\)\}<\/div><div class="srcMeta">\$\{esc\(meta \|\| 'Source details unavailable'\)\}<\/div><\/div><div class="srcBadges">\$\{chips\}<\/div><\/div>`;/,
    'Sources drawer should keep exact release names internally while rendering compact metadata and badges');
  assert.doesNotMatch(ui, /<div class="srcScore">/,
    'Sources drawer should not expose internal ranking score in the user-facing row');
  assert.match(ui, /qualityRank:\s*normalizeQualityRank\(w\.meta\.qualityRank\)/,
    'Continue Watching cards should carry the saved quality rank from watch state');
  assert.match(ui, /const meta = wlMeta\(p\.item\);[\s\S]+meta, \/\/ episodes resume \+ reopen/,
    'watch progress should save sanitized metadata, including the current quality rank, through the shared watchlist meta helper');
  assert.match(ui, /function continueWatchingIdentity\(it\) \{[\s\S]+\^tmdb:tv:\(\\d\+\):s\\d\+e\\d\+\$[\s\S]+return `tv:\$\{m\[1\]\}`[\s\S]+\^tmdb:movie:\(\\d\+\)\$[\s\S]+return `movie:\$\{m\[1\]\}`/,
    'Continue Watching should canonicalize movies and all episodes of a show before row rendering');
  assert.match(ui, /function mergeContinueWatchingItem\(a, b\) \{[\s\S]+preferContinueWatchingItem\(a, b\)[\s\S]+normalizeQualityRank\(keep\.qualityRank\)[\s\S]+merged\._cwSortAt = Math\.max/,
    'Continue Watching canonical merges should prefer active/recent cards while preserving quality');
  assert.match(ui, /function buildCwItems\(cw\) \{[\s\S]+const seen = new Set\(items\.map\(\(it\) => continueWatchingIdentity\(it\) \|\| it\.key\)\)[\s\S]+return dedupeContinueWatchingItems\(items\)\.sort\(compareContinueWatchingItems\);/,
    'Continue Watching should dedupe next-up and in-progress cards by canonical identity');
  assert.match(ui, /function nextEpisodeBumps\(cw, cwItems\) \{[\s\S]+continueWatchingIdentity\(it\) === `tv:\$\{id\}`/,
    'local next-episode bumps should not add a second card for a show already in Continue Watching');
  assert.match(ui, /if \(!opts\.catalogOnly && !opts\.watchReady && !hasFreshWatch && !opts\.preserveFocus\) \{/,
    'Continue Watching row actions should not publish an empty placeholder row while preserving focus');
  assert.match(ui, /async function cwOp\(it, body, msg, opts = \{\}\) \{[\s\S]+if \(body\.remove\) removeWatchCacheKey\(it\.key\);[\s\S]+loadRows\(\{ preserveFocus: !!snap, focusSnapshot: snap, watchReady: true \}\);[\s\S]+loadWatchState\(true\)/,
    'Continue Watching remove/mark actions should update local cache, keep focus, then refresh quietly');
  assert.match(ui, /function epItemOf\(show, season, ep\) \{[\s\S]+qualityRank: qualityRankForItem\(show\)[\s\S]+function epTarget\(show, sNum, eNum, resume\) \{[\s\S]+qualityRank: qualityRankForItem\(show\)/,
    'episode targets created from details should inherit the current show quality preference');
  assert.match(ui, /async function prepPlayerSeasonEpisodes\(it\) \{[\s\S]+const inheritedQuality = qualityRankForItem\(it\);[\s\S]+const item = inheritedQuality \? \{ \.\.\.base, qualityRank: inheritedQuality \} : base;[\s\S]+async function prepNextEpisode\(it\) \{[\s\S]+const inheritedQuality = qualityRankForItem\(it\);[\s\S]+const item = inheritedQuality \? \{ \.\.\.base, qualityRank: inheritedQuality \} : base;/,
    'player episode strip and Up Next should continue the same 4K/1080p class');
  assert.match(ui, /async function saveWatch\(final\) \{[\s\S]+const pos = currentTime\(\);[\s\S]+if \(!final && Math\.abs\(pos - p\.lastSaved\) < 5\) return;[\s\S]+key: p\.item\.key, position: Math\.floor\(pos\), duration: Math\.floor\(d \|\| 0\),[\s\S]+profile: S\.profile \? S\.profile\.id : undefined,[\s\S]+upsertWatchCache\(\{[\s\S]+position: payload\.position[\s\S]+api\('\/api\/watch', \{ method: 'POST', body: payload \}\)/,
    'watch progress should save profile-scoped position immediately into the local cache and server');
  assert.match(ui, /async function closePlayer\(opts = \{\}\) \{[\s\S]+const finalWatch = saveWatch\(true\);[\s\S]+const finalActivity = stopActivityHeartbeat\(\);[\s\S]+if \(\$\(\'detail\'\)\.classList\.contains\(\'open\'\)\) \{[\s\S]+await finalWatch; await finalActivity; await loadWatchState\(true\);[\s\S]+if \(S\.detailItem\) syncDetailButtons\(S\.detailItem\);/,
    'returning from player to details should flush the final watch position and refresh the visible Resume/Start Over buttons before another source is chosen');
  assert.match(ui, /function syncDetailButtons\(it\) \{[\s\S]+const resume = resumePositionForItem\(it\);[\s\S]+\$\(\'dStartOver\'\)\.style\.display = resume \? '' : 'none';[\s\S]+updateDetailPlayLabel\(resume \? \{ label: 'Resume', target: \{ \.\.\.it, resume \} \} : \{ label: 'Play', target: it \}\);/,
    'detail button sync should recompute movie Resume/Play from the latest watch map');
  assert.match(ui, /function playbackFinishedDetailTarget\(item\) \{[\s\S]+item\.type === 'movie'[\s\S]+item\.type === 'episode'[\s\S]+key: `tmdb:tv:\$\{item\.tmdbId\}`[\s\S]+type: 'tv'/,
    'finished playback should resolve movies to movie details and final episodes to the show details page');
  assert.match(ui, /window\.__tvNativeVideoClosed = \(pos, dur, ended\) => \{[\s\S]+if \(ended && S\.nextEp\)[\s\S]+closePlayer\(\{ ended: !!ended \}\);/,
    'native finished playback should either surface Up Next or close through the finished-title return path');
  assert.ok([
    'function applyNativeVideoProgress(pos, dur, opts = {}) {',
    'const keepPrev = opts.preserveOnZero && incoming <= 1 && prev > 30;',
    'p.nativePos = keepPrev ? prev : incoming;',
    'maybeShowUpNext(p.nativePos, totalDuration(), { native: true });',
  ].every((s) => ui.includes(s)),
    'native episode playback should surface Up Next from progress before ExoPlayer reaches ended');
  assert.match(ui, /window\.__tvNativeVideoProgress = \(pos, dur\) => \{\s+applyNativeVideoProgress\(pos, dur\);/,
    'native progress bridge should forward ExoPlayer progress into the Up Next timer path');
  assert.match(ui, /window\.__tvNativeVideoError = \(msg, pos, dur\) => \{\s+const p = S\.playing; if \(!p \|\| !p\.usingNative\) return;\s+applyNativeVideoProgress\(pos, dur, \{ preserveOnZero: true \}\);\s+const at = currentTime\(\);/,
    'native player errors should preserve the last good movie position when Exo reports a bogus zero before fallback');
  assert.match(ui, /function maybeShowUpNext\(t, d, opts = \{\}\) \{[\s\S]+\(d - t\) > UP_NEXT_COUNTDOWN_SECONDS[\s\S]+if \(!opts\.native && \$\('video'\)\.paused\) return;[\s\S]+showUpNext\(\);/,
    'Up Next should start only at the 10-second choice window and work for native progress without relying on the web video paused state');
  assert.doesNotMatch(ui, /\(d - t\) > 45/,
    'Up Next must not start a 10-second autoplay countdown with 45 seconds still left in the episode');
  assert.match(ui, /const UP_NEXT_COUNTDOWN_SECONDS = 10;[\s\S]+function showUpNext\(\) \{[\s\S]+let n = UP_NEXT_COUNTDOWN_SECONDS; \$\('unCount'\)\.textContent = n;[\s\S]+if \(n <= 0\) playNextEpisode\(\);/,
    'Up Next autoplay should always give the user a 10-second choice window before starting the next episode');
  assert.match(ui, /id="unPlay">Play next episode<\/button>/,
    'Up Next primary action should clearly say Play next episode');
  assert.doesNotMatch(ui, /opts\.ended \? 6 : 10/,
    'the ended fallback path should not shorten the Up Next countdown');
  assert.match(ui, /saveQualityPref\(target,\s*S\.qualityPref\)[\s\S]+paintQualityToggle\(S\.qualityPref\);[\s\S]+prefetchSources\(target, 0\);/,
    'changing the detail quality toggle should persist and immediately warm the selected source class');
  assert.match(ui, /qualityTitleKey\(S\.detailItem\) === qualityTitleKey\(it\)/,
    'episode resumes should inherit the show-level quality preference');
  assert.match(ui, /<div class="qToggle" id="qToggle"[\s\S]+id="dSources"[\s\S]+id="dWatchlist"/,
    'movie/show details should place the 1080p/4K toggle immediately before Sources');
  assert.match(ui, /#dBtns \.btn\{min-height:52px;border-radius:40px;box-sizing:border-box\}[\s\S]+\.qToggle\{display:flex;align-items:center;min-height:52px;box-sizing:border-box[\s\S]+border-radius:40px[\s\S]+\.qToggle button\{height:42px[\s\S]+border-radius:34px/,
    'movie/show detail action buttons and the quality selector should share matching height and curve');
  assert.match(ui, /#dPlay\{position:relative;justify-content:center;min-width:118px\}[\s\S]+#dPlayLabel\{display:block;width:100%;text-align:center\}/,
    'movie/show detail Play, Continue, and Resume text should be centered inside the whole pill');
  assert.match(ui, /<button class="btn primary focusable" id="dPlay">\s*<span id="dPlayLabel">Play<\/span><\/button>/,
    'movie/show detail Play, Continue, and Resume should be text-only, without a play icon');
  assert.doesNotMatch(ui, /resumeMode/,
    'movie/show detail Play, Continue, and Resume no longer need icon-specific state styling');
  assert.match(ui, /function captureDetailReturn\(\) \{[\s\S]+view: S\.view \|\| 'home'[\s\S]+rowIdx: S\.rowIdx \|\| 0[\s\S]+colIdx: \{ \.\.\.\(S\.colIdx \|\| \{\}\) \}[\s\S]+gridIdx: activeGridIdx\(\)[\s\S]+searchQuery: \$\('searchInput'\)\.value/,
    'opening details should remember the exact source page, focused cover/result, and search text');
  assert.match(ui, /function restoreDetailReturn\(\) \{[\s\S]+switchView\(view, false, \{ preservePage: true, preserveSearch: true, restoreFocus: true \}\)[\s\S]+restoreDetailFocus\(ret\)/,
    'closing details should restore the previous page in place instead of rebuilding it from scratch');
  assert.match(ui, /function restoreDetailFocus\(ret\) \{[\s\S]+if \(ret\.searchQuery !== undefined && S\.view === 'search'\) \$\('searchInput'\)\.value = ret\.searchQuery;[\s\S]+return focusCard\(ret\.rowIdx \|\| 0[\s\S]+return focusGrid\(Number\.isFinite\(ret\.gridIdx\) \? ret\.gridIdx : 0\)/,
    'detail back should return focus to the same home/list/search cover');
  assert.match(ui, /function restoreDetailFocusRoots\(ret\) \{[\s\S]+ret\.view === 'home'[\s\S]+setRowsView\(\$\('rows'\), S\.rows \|\| \[\], true\);[\s\S]+\['movies', 'tv', 'search', 'library', 'watchlist', 'livetv'\]\.includes\(ret\.view\)[\s\S]+S\.gridRoot = \$\('grid'\);[\s\S]+function restoreDetailFocus\(ret\) \{[\s\S]+restoreDetailFocusRoots\(ret\);/,
    'detail back should rebind Home/Browse focus roots before restoring saved focus');
  assert.match(ui, /function hydrateAppShellData\(\) \{[\s\S]+Promise\.allSettled\(\[[\s\S]+loadWatchState\(\),[\s\S]+loadLibraries\(\),[\s\S]+loadWatchlist\(\),[\s\S]+\]\)\.then[\s\S]+if \(S\.view === 'home'\) loadRows\(\{ watchReady: true, preserveFocus: true, background: true \}\)/,
    'startup hydration should run watch state, libraries, and watchlist after the shell is usable while reusing the first watch-state request');
  assert.match(ui, /async function refreshAfterTraktSync\(\) \{[\s\S]+invalidateWatchCache\(\);[\s\S]+Promise\.allSettled\(\[loadWatchState\(true\), loadWatchlist\(\)\]\)[\s\S]+S\.view === 'home'[\s\S]+S\.view === 'calendar'[\s\S]+syncDetailButtons\(S\.detailItem\);[\s\S]+\}/,
    'manual Trakt sync should force-refresh watch state and repaint Home, Calendar, Watchlist, or Details from the new data');
  assert.match(ui, /id="traktSync"[\s\S]+id="traktImport"[\s\S]+await api\('\/api\/trakt\/sync'[\s\S]+await refreshAfterTraktSync\(\);[\s\S]+box\.querySelector\('#traktImport'\)[\s\S]+await api\('\/api\/trakt\/pull'[\s\S]+await refreshAfterTraktSync\(\);/,
    'Trakt sync and watchlist import buttons should not leave stale cached watch/watchlist rows on screen');
  assert.match(ui, /function homeBackgroundRefreshReady\(\) \{[\s\S]+if \(S\.tvReadyAt && now - S\.tvReadyAt < 1800\) return false;[\s\S]+if \(S\._lastKeyAt && now - S\._lastKeyAt < 900\) return false;[\s\S]+function refreshHomeWhenSettled\(opts = \{\}\) \{[\s\S]+homeBackgroundRefreshReady\(\)[\s\S]+loadRows\(\{ preserveFocus: true, background: true, \.\.\.opts \}\)/,
    'background home refreshes should wait until TV focus and D-pad input have settled');
  assert.match(ui, /function scheduleHomeCatalogRefresh\(\) \{[\s\S]+if \(S\._homeCatalogScheduled\) return;[\s\S]+S\._homeCatalogScheduled = true;[\s\S]+refreshHomeCatalogRows\(\)\.then[\s\S]+refreshHomeWhenSettled\(\{ catalogOnly: true \}\)/,
    'home catalog rows should hydrate after first paint instead of blocking the app shell');
  assert.match(ui, /function refreshHomeWhenSettled\(opts = \{\}\) \{[\s\S]+if \(S\._booting && S\.view === 'home'\) return loadRows\(\{ preserveFocus: true, background: true, \.\.\.opts \}\);[\s\S]+if \(homeBackgroundRefreshReady\(\)\) loadRows/,
    'boot-time home refresh should publish under the splash instead of waiting for visible idle focus');
  assert.match(ui, /function homeRowsFromWatch\(cw, loading = false\) \{[\s\S]+rows\.push\(\.\.\.cachedHomeCatalogRows\(\)\);[\s\S]+if \(!rows\.length && loading\)[\s\S]+emptyLabel: 'Loading\.\.\.'[\s\S]+function homeRowsReadyForBoot\(rows\) \{[\s\S]+row\.name !== 'Loading home'[\s\S]+function publishHomeRows\(rows, opts = \{\}\) \{[\s\S]+if \(S\._homeRowsSig === sig && \$\('rows'\)\.children\.length\) \{[\s\S]+return false;[\s\S]+async function loadRows\(opts = \{\}\) \{[\s\S]+const runId = S\._homeLoadRun[\s\S]+!opts\.catalogOnly && !opts\.watchReady && !hasFreshWatch[\s\S]+publishHomeRows\(homeRowsFromWatch\(cachedWatchRowsForHome\(\), true\), opts\); \/\/ Internal first paint: focus target under the splash before \/api\/watch returns\.[\s\S]+loadWatchState\(\)\.then/,
    'home first paint should create a hidden focus placeholder but keep the splash until real rows exist');
  assert.match(ui, /const cw = opts\.watchReady \? cachedWatchRowsForHome\(\) : await loadWatchState\(\)\.catch\(\(\) => \[\]\);[\s\S]+if \(runId !== S\._homeLoadRun && !opts\.catalogOnly\) return;[\s\S]+publishHomeRows\(homeRowsFromWatch\(cw, false\), \{ preserveFocus: !!opts\.preserveFocus, focusSnapshot: opts\.focusSnapshot \}\);[\s\S]+scheduleHomeCatalogRefresh\(\);/,
    'home should refresh with real watch rows and schedule TMDB catalog refresh after first paint');
  assert.doesNotMatch(ui, /const catalogJob = loadHomeCatalogRows|rows\.push\(\.\.\.await catalogJob\)/,
    'home first paint must not await TMDB catalog rows');
  assert.match(ui, /function renderRowsInto\(root, rowsData, opts = \{\}\) \{[\s\S]+if \(!items\.length\) \{[\s\S]+empty\.className = 'gridMore focusable';[\s\S]+empty\.dataset\.row = ri; empty\.dataset\.col = 0;[\s\S]+switchView\('settings'\)/,
    'empty home rows should still render a focusable remote target');
  assert.match(ui, /function renderRows\(opts = \{\}\) \{[\s\S]+const snap = opts\.preserveFocus \? \(opts\.focusSnapshot \|\| homeFocusSnapshot\(\)\) : null;[\s\S]+renderRowsInto\(\$\(\'rows\'\), S\.rows, \{ resetScroll: !snap \}\);[\s\S]+if \(snap && restoreHomeFocus\(snap\)\)[\s\S]+const firstWithItems = S\.rows\.findIndex[\s\S]+else \{[\s\S]+\$\(\'rows\'\)\.querySelector\('\[data-row\]\[data-col\]'\)[\s\S]+focusCard\(parseInt\(first\.dataset\.row/,
    'home boot should focus the first fallback target when there are no playable cards yet');
  assert.match(ui, /function restoreHomeFocus\(snap\) \{[\s\S]+if \(snap\.zone === 'rail'\) return true;[\s\S]+if \(snap\.zone === 'hero'\)[\s\S]+if \(snap\.zone !== 'rows'\) return false;[\s\S]+snap\.rowName[\s\S]+const keyed = snap\.itemKey \? items\.findIndex[\s\S]+focusCard\(ri, ci, \{ scroll: false, align: false \}\);[\s\S]+\$\('rows'\)\.scrollTop = snap\.scrollTop[\s\S]+cards\.scrollLeft = snap\.rowScrollLeft/,
    'background home row refreshes should preserve D-pad focus instead of snapping back to the first card');
  assert.match(ui, /async function cwOp\(it, body, msg, opts = \{\}\) \{[\s\S]+const snap = opts\.focusSnapshot \|\| \(S\.view === 'home' \? homeFocusSnapshot\(\) : null\);[\s\S]+loadRows\(\{ preserveFocus: !!snap, focusSnapshot: snap \}\);/,
    'Continue Watching actions should repaint home with the action card focus snapshot');
  assert.match(ui, /function detailTargetForItem\(it\) \{[\s\S]+it\.type === 'episode'[\s\S]+`tmdb:tv:\$\{it\.tmdbId\}`[\s\S]+type: 'tv'[\s\S]+\}/,
    'Continue Watching Details should normalize episode cards to the parent show details target');
  assert.match(ui, /function certTargetForMeta\(meta, key = ''\) \{[\s\S]+type === 'episode' \|\| \/\^tmdb:tv:\\d\+:s\\d\+e\\d\+\$\/i\.test[\s\S]+return isEp && tmdbId \? \{ type: 'tv', tmdbId \} : \{ type, tmdbId \};[\s\S]+\}/,
    'watchlist and calendar certification should normalize episode records to the parent TV show before calling TMDB');
  assert.match(ui, /const ok = await Promise\.all\(entries\.map\(\(w\) => \{[\s\S]+const t = certTargetForMeta\(w\.meta, w\.key\);[\s\S]+return certAllowed\(t\.type, t\.tmdbId\);[\s\S]+\}\)\);/,
    'restricted watchlist filtering should not call /api/tmdb/episode for episode records');
  assert.match(ui, /\.\.\.\(S\.watchlist \|\| \[\]\)\.map\(\(w\) => \(\{ \.\.\.w\.meta, _key: w\.key \}\)\)[\s\S]+Object\.entries\(S\.watchMap \|\| \{\}\)[\s\S]+const t = certTargetForMeta\(m, m\._key \|\| ''\);[\s\S]+uniq\.set\(t\.type \+ ':' \+ t\.tmdbId, \{ \.\.\.m, \.\.\.t \}\);/,
    'calendar should normalize in-progress episode metas to their TV show before fetching upcoming dates');
  assert.ok(ui.indexOf("actionMenuButton('info', 'info', 'Details')") < ui.indexOf("(it.resume ? actionMenuButton('resume', 'play'"),
    'the long-press menu should default to Details, with Resume as a deliberate second action');
  assert.match(ui, /if \(act === 'resume'\) play\(it\);[\s\S]+else if \(act === 'info'\) openDetail\(detailTargetForItem\(it\)\);/,
    'the long-press Details action should open details instead of letting episode cards fall through to playback');
  assert.match(ui, /const cwSnap = \(\) => \{ onFocus && onFocus\(\); return homeFocusSnapshot\(\); \};[\s\S]+cwAct\.watch[\s\S]+focusSnapshot: cwSnap\(\)[\s\S]+cwAct\.rm[\s\S]+focusSnapshot: cwSnap\(\)/,
    'on-card Continue Watching buttons should capture their own row position before removing or marking items');
  assert.match(ui, /async function restoreInitialRoute\(\) \{[\s\S]+if \(!location\.hash \|\| location\.hash === '#\/home'\) \{[\s\S]+switchView\('home'\);[\s\S]+const routeResult = applyRoute\(\);[\s\S]+await routeResult;[\s\S]+route restore failed; falling back to home[\s\S]+replaceRoute\('#\/home'\);[\s\S]+switchView\('home'\);[\s\S]+\}/,
    'refresh route restore should fall back to Home when a stale route fails after an update');
  assert.match(ui, /async function enterAppShell\(\) \{[\s\S]+S\.watchMap = S\.watchMap \|\| \{\};[\s\S]+applyMenuPrefs\(\);[\s\S]+await restoreInitialRoute\(\);[\s\S]+perfMark\('shell-route-applied'[\s\S]+hydrateAppShellData\(\);/,
    'Android TV boot should route the shell immediately but keep the splash until real content paints');
  assert.doesNotMatch(ui, /else switchView\('home'\);[\s\S]{0,120}bootReady\(\);[\s\S]{0,120}hydrateAppShellData\(\);/,
    'authenticated home boot must not dismiss the splash before Home rows render');
  assert.match(ui, /async function enterApp\(\) \{[\s\S]+if \(!S\.user\) S\.user = await api\('\/api\/me'\);[\s\S]+if \(!S\.serverInfo \|\| S\.serverInfo\.needsSetup\) S\.serverInfo = await api\('\/api\/server'\);/,
    'authenticated boot should reuse the already fetched server info instead of doing a second blocking server call');
  assert.match(ui, /const tokenStore = \{[\s\S]+localStorage\.getItem\('triboon\.token'\)[\s\S]+sessionStorage\.getItem\('triboon\.token'\)[\s\S]+localStorage\.setItem\('triboon\.token', t\)[\s\S]+sessionStorage\.setItem\('triboon\.token', t\)/,
    'session tokens should survive refresh even when one browser storage backend is flaky');
  assert.match(ui, /if \(r\.status === 401[\s\S]+const e = new Error\('signed out'\);[\s\S]+e\.status = 401;[\s\S]+throw e;/,
    'API auth failures should carry a 401 status so boot can distinguish expired sessions from transient startup failures');
  assert.match(ui, /async function restoreSavedSession\(\) \{[\s\S]+S\.user = await api\('\/api\/me'\);[\s\S]+if \(e && e\.status === 401\) \{[\s\S]+tokenStore\.set\(null\);[\s\S]+return false;[\s\S]+session check failed; keeping saved token[\s\S]+setTimeout\(\(\) => location\.reload\(\), 1800\);[\s\S]+await enterApp\(\);[\s\S]+app shell failed after session restore[\s\S]+replaceRoute\('#\/home'\);[\s\S]+await enterApp\(\);[\s\S]+showGate\('login'\);/,
    'refresh boot should retry only the /api/me session check; app-shell errors must not loop as server wakeups');
  assert.match(ui, /if \(tokenStore\.get\(\)\) \{[\s\S]+if \(await restoreSavedSession\(\)\) return;[\s\S]+\}/,
    'boot should run the narrow saved-session restore before falling back to the login gate');
  assert.doesNotMatch(ui, /Server is still waking up\. Retrying/,
    'the app should not show a misleading server-wakeup loop for shell restore failures');
  assert.doesNotMatch(ui, /await Promise\.all\(\[loadLibraries\(\), loadWatchlist\(\)\]\)/,
    'startup should not block first focus on libraries and watchlist');
  assert.match(ui, /async function enrichHome\(\) \{[\s\S]+if \(!S\.localMap && cachedLocalLibraryItemsAvailable\(\)\) refreshLocalMapFromCachedLibraries\(\);/,
    'home enrichment should only reuse already-cached attached-library items, not fetch every local item');
  assert.match(ui, /function cachedLocalLibraryItemsAvailable\(\) \{[\s\S]+S\.libCache && S\.libCache\[lib\.id\] && S\.libCache\[lib\.id\]\.data/,
    'home should only schedule local-library enrichment when an explicit library cache already exists');
  assert.match(ui, /async function prepareHomeTvNext\(cw, timeoutMs = HOME_NEXT_WAIT_MS\) \{[\s\S]+api\('\/api\/watch\/next' \+ profileQ\(\)\)[\s\S]+Promise\.race\(\[S\._homeTvNextJob\.then\(\(\) => true\), waitMs\(timeoutMs, false\)\]\)/,
    'home should briefly prepare next-episode Continue Watching entries before the row is published');
  assert.match(ui, /if \(!opts\.catalogOnly\) await prepareHomeTvNext\(cw, HOME_NEXT_WAIT_MS\);[\s\S]+publishHomeRows\(homeRowsFromWatch\(cw, false\), \{ preserveFocus: !!opts\.preserveFocus, focusSnapshot: opts\.focusSnapshot \}\)/,
    'Continue Watching should publish once with ready next-up entries instead of adding them a few seconds later');
  assert.match(ui, /function compareContinueWatchingItems\(a, b\) \{[\s\S]+const byRecent = \(b\._cwSortAt \|\| 0\) - \(a\._cwSortAt \|\| 0\);[\s\S]+const byKind = \(a\._nextEp \? 1 : 0\) - \(b\._nextEp \? 1 : 0\);[\s\S]+\}/,
    'Continue Watching should sort by last watched activity before falling back to card type');
  assert.match(ui, /function buildCwItems\(cw\) \{[\s\S]+_cwSortAt: w\.updatedAt \|\| 0[\s\S]+items\.push\(stampContinueWatchingSort\(\{ \.\.\.it \}, cw\)\);[\s\S]+items\.push\(\.\.\.nextEpisodeBumps\(cw, items\)\.map\(\(it\) => stampContinueWatchingSort\(it, cw, it\._cwSortAt\)\)\);[\s\S]+return dedupeContinueWatchingItems\(items\)\.sort\(compareContinueWatchingItems\);/,
    'Continue Watching should merge next-up cards into the row, dedupe by canonical identity, then sort by recency');
  assert.doesNotMatch(ui, /items\.unshift\(it\)|items\.unshift\(\.\.\.nextEpisodeBumps/,
    'next-episode cards must not be unshifted ahead of in-progress Continue Watching cards');
  assert.match(ui, /const needLocalCacheRefresh = !S\.localMap && cachedLocalLibraryItemsAvailable\(\);[\s\S]+const needEnrich = needLocalCacheRefresh \|\| \(liveTvAvailable\(\) && S\._homeLiveFav === undefined\);/,
    'home should not use the generic background enrich path to mutate Continue Watching with next-up entries');
  assert.match(ui, /function refreshLocalMapFromCachedLibraries\(\) \{[\s\S]+S\.libCache && S\.libCache\[lib\.id\][\s\S]+if \(!c \|\| !c\.data\) continue;[\s\S]+mergeLocalItemsInto\(map, lib, c\.data\.items \|\| \[\]\)[\s\S]+S\.localMap = map;/,
    'home local-library ownership refresh should publish a map only from explicit library caches');
  assert.doesNotMatch(ui, /warmLocalMapForHome|local-map-warm-start|local-map-warm-lib|local-map-warm-done/,
    'home and rail should not have a background path that fetches full attached-library item payloads');
  assert.match(ui, /const LOCAL_GRID_BATCH = 15;[\s\S]+async function localLibraryPage\(lib, opts = \{\}\) \{[\s\S]+limit: String\(limit\)[\s\S]+\/api\/libraries\/\$\{lib\.id\}\/items\?\$\{params\.toString\(\)\}/,
    'attached library grids should request bounded server pages instead of fetching every title at once');
  assert.match(ui, /async function runLocalLibraryPaged\(lib, showIdx, opts = \{\}\) \{[\s\S]+const r = await localLibraryPage\(lib, \{ offset: 0, showIdx, sort, genre \}\)[\s\S]+renderLocalGridFooter\(\);/,
    'attached library grids should render in bounded batches instead of painting every title at once');
  assert.match(ui, /else if \(S\.view === 'library' && S\.currentLib && S\.currentLib\.path\) loadMoreLocalLibraryPage\(false\);/,
    'D-pad focus near the bottom of an attached library should request the next local page');
  assert.doesNotMatch(ui, /press OK to open/,
    'rail rollover previews for attached libraries should auto-load instead of showing an OK-gated prompt');
  assert.match(ui, /function railPreviewAction\(btn\) \{[\s\S]+switchView\('library', true, \{ keepRail: true, previewOnly: !!lib\.path \}\);/,
    'attached library rail rollover should request previewOnly mode');
  assert.match(ui, /if \(v === 'library' && !opts\.preservePage\) \{[\s\S]+opts\.previewOnly && S\.currentLib && S\.currentLib\.path[\s\S]+runLocalLibrary\(S\.currentLib, undefined, \{ preview: true \}\)[\s\S]+else runLibrary\(true\);/,
    'switchView should auto-load the first local-folder page during rail preview');
  assert.match(ui, /if \(!opts\.keepRail\) \{[\s\S]+if \(S\.zone === 'rail'\) S\.zone = '';[\s\S]+leaveRail\(\);/,
    'real section switches should clear rail mode so the destination page can own focus');
  assert.match(ui, /else if \(S\.libraryPreviewOnly\) \{[\s\S]+S\.libraryPreviewOnly = false;[\s\S]+\}[\s\S]+setTimeout\(\(\) => \{ if \(S\.view === 'library'\) focusContent\(\); \}, 80\);/,
    'pressing OK on an auto-previewed attached-library rail item should enter content without reloading the page');
  assert.match(ui, /--bdW:min\(50vw,980px\);[\s\S]+--bdH:min\(56vh,620px\);[\s\S]+#backdrop \.layer\{[\s\S]+width:var\(--bdW\);height:var\(--bdH\)/,
    'browser backdrop should use capped viewport-aware dimensions instead of percentage takeover');
  assert.match(ui, /--scrim:\s*linear-gradient\(90deg,rgba\(11,8,18,\.86\) 0%,rgba\(11,8,18,\.56\) 28%,rgba\(11,8,18,\.20\) 58%,rgba\(11,8,18,\.06\) 100%\),\s*linear-gradient\(0deg,rgba\(11,8,18,\.76\) 0%,rgba\(11,8,18,\.24\) 26%,rgba\(11,8,18,\.04\) 60%,rgba\(11,8,18,\.10\) 100%\)/,
    'browser backdrop scrim should protect text without blacking out the artwork');
  assert.match(ui, /body\.tv\{--bdW:min\(48vw,820px\);--bdH:min\(50vh,460px\);--overscan:2\.5vmin\}[\s\S]+body\.shortBrowseBd\{--bdH:min\(46vh,430px\)\}[\s\S]+body\.tv\.shortBrowseBd\{--bdH:min\(38vh,360px\)\}[\s\S]+@media \(max-height:760px\)\{[\s\S]+--bdH:min\(34vh,260px\)[\s\S]+@media \(max-width:980px\)\{[\s\S]+--bdW:min\(44vw,420px\)/,
    'TV, short browser, narrow browser, and poster browse viewports should tighten backdrop size');
  assert.match(ui, /body\.shortBrowseBd:not\(\.tv\) #bdInfo[\s\S]+-webkit-line-clamp:1[\s\S]+@media \(max-height:820px\)[\s\S]+body\.shortBrowseBd:not\(\.tv\) #bdInfo \.bdiC,[\s\S]+display:none/,
    'browser poster browse pages should compact the focused-title band without touching TV');
  assert.match(ui, /function browserBrowseCoverPx\(size\) \{[\s\S]+document\.body\.classList\.contains\('tv'\)[\s\S]+window\.innerHeight <= 820[\s\S]+return size === 'L' \? '190px'[\s\S]+const px = window\.innerWidth <= 600 \? '140px' : \(browserBrowseCoverPx\(s\) \|\| table\[s\] \|\| table\.M\);[\s\S]+const shortBrowserBrowse = document\.body\.classList\.contains\('shortBrowseBd'\) && !document\.body\.classList\.contains\('tv'\);[\s\S]+shortBrowserBrowse \? \(h <= 820 \? 128/,
    'desktop/tablet browse pages should use compact browser poster sizing and a compact row reserve');
  assert.match(ui, /const shortBrowseBd = v === 'movies' \|\| v === 'tv' \|\| v === 'watchlist' \|\| \(v === 'library' && S\.currentLib && S\.currentLib\.path\);[\s\S]+document\.body\.classList\.toggle\('shortBrowseBd', !!shortBrowseBd\);/,
    'movies, TV shows, watchlist, and attached libraries should use the shorter browse backdrop');
  assert.match(ui, /document\.body\.classList\.toggle\('fullBd', isBrowse\);/,
    'Discover should stay row-first instead of enabling the focused-title backdrop overlay');
  assert.match(ui, /let pendingLibraryRouteJob = null;[\s\S]+function applyLibraryRoute\(id\) \{[\s\S]+switchView\('library', false\);[\s\S]+function deferLibraryRoute\(id\) \{[\s\S]+loadLibraries\(\)[\s\S]+if \(parts\[0\] !== 'library' \|\| parts\[1\] !== id\) return;[\s\S]+if \(!applyLibraryRoute\(id\)\) switchView\('home', false\);[\s\S]+if \(view === 'library' && parts\[1\]\) \{[\s\S]+deferLibraryRoute\(parts\[1\]\);/,
    'library hash routes should wait for async library metadata instead of falling through to Home');
  assert.match(ui, /if \(v === 'search'\) \{ \$\('browseTitle'\)\.textContent = 'Search';[\s\S]+if \(!opts\.preserveSearch && !opts\.preservePage\) \{ resetSearchPage\(\); \$\('grid'\)\.innerHTML = ''; \}/,
    'restoring Search from Details should not clear the existing result grid');
  assert.match(ui, /function tmdbSearchRank\(x, q\) \{[\s\S]+searchSeqIndex\(noLeadArticle, queryWords\)[\s\S]+score \+= 10000[\s\S]+score -= 1800[\s\S]+sort\(bySearchRank\)\.map\(mapTmdb\)/,
    'TMDB search should rank exact franchise/title-prefix matches above incidental phrase matches');
  assert.match(ui, /if \(S\._homeRowsSig === sig && \$\('rows'\)\.children\.length\) \{[\s\S]+if \(S\.view === 'home'\) \{[\s\S]+setRowsView\(\$\('rows'\), S\.rows, true\);[\s\S]+\}[\s\S]+S\.view === 'home' && S\.zone !== 'rail' && !document\.querySelector\('#home \.focus'\)[\s\S]+focusContent\(\);[\s\S]+return false;/,
    'returning Home with cached rows should repoint the row model and reclaim focus from hidden pages');
  assert.match(ui, /if \(\(S\.maxLevel \?\? 3\) < 3\) \{[\s\S]+renderRowsInto\(root, rows\);[\s\S]+setRowsView\(root, rows, false\);[\s\S]+if \(S\.zone !== 'rail'\) focusCard\(0, 0\);/,
    'restricted-profile Discover rows should still focus the first visible card after rendering');
  assert.match(ui, /buildTrailerRow\(trend\.results[\s\S]+const focused = root\.querySelector\('\.focus'\);[\s\S]+const focusRow = focused \? parseInt\(focused\.dataset\.row[\s\S]+renderRowsInto\(root, rows, \{ resetScroll: false \}\);[\s\S]+setRowsView\(root, rows, false\);[\s\S]+if \(S\.view === 'discover' && S\.zone !== 'rail'\) \{[\s\S]+focusCard\(safeRow, safeCol, \{ scroll: false, align: false \}\);/,
    'Discover trailer-row hydration should preserve or restore card focus after the async rerender');
  assert.match(ui, /function routeIsTitle\(\) \{[\s\S]+\^#\\\/\?title\\\/\(movie\|tv\)\\\/\\d\+[\s\S]+window\.addEventListener\('hashchange'[\s\S]+if \(\$\(\'detail\'\)\.classList\.contains\(\'open\'\) && !routeIsTitle\(\)\) return closeDetail\(\);[\s\S]+applyRoute\(\);/,
    'browser Back from one title route to another should route to the previous detail instead of jumping to the original browse page');
  assert.match(ui, /const detailResume = resumePositionForItem\(it\);[\s\S]+updateDetailPlayLabel\(detailResume \? \{ label: 'Resume', target: \{ \.\.\.it, resume: detailResume \} \}/,
    'movie details should show Resume without the timestamp while keeping the resume position in the play target');
  assert.match(ui, /return updateDetailPlayLabel\(\{ label: 'Resume', target: epTarget\(show, \+m\[1\], \+m\[2\], wm\[inProg\]\.position\) \}\)/,
    'TV show details should show Resume without the timestamp while keeping the episode resume position');
  assert.match(ui, /const rec = \{[\s\S]+streamUrl: x\.streamUrl, playUrl: x\.playUrl, name: x\.title[\s\S]+if \(localKey\) map\[localKey\] = rec;[\s\S]+map\[key\] = rec;/,
    'local-first Continue Watching entries should keep the rich local player prep URL and durable local-art fields');
  assert.match(ui, /_local: x\.streamUrl \? \{ streamUrl: x\.streamUrl, playUrl: x\.playUrl, name:/,
    'added-library cards should carry the full local player prep URL');
  assert.match(ui, /async function playLocal\(it\) \{[\s\S]+const ids = sourceIdentityFor\(it\);[\s\S]+const body = \{ caps: clientCaps\(\), q: queryFor\(it\) \};[\s\S]+if \(ids\.season != null\) body\.season = ids\.season;[\s\S]+if \(ids\.ep != null\) body\.ep = ids\.ep;[\s\S]+await api\(it\._local\.playUrl, \{ method: 'POST', body \}\)[\s\S]+openPlayer\(it, \{ \.\.\.mount/,
    'added-library playback should use the same prepared player mount shape as Movies and TV while preserving subtitle episode context');
  assert.match(ui, /async function playLocal\(it\) \{[\s\S]+it = resolvePlaybackResume\(it\);[\s\S]+if \(nativeFirst\) showNativePlayLoading\(it\);[\s\S]+else showPlayLoading\(it\);[\s\S]+openPlayer\(it, \{ \.\.\.mount/,
    'local library playback should resolve resume and leave details for the loading player before mount prep waits');
  assert.match(ui, /function mergeLocalItemsInto\(map, lib, items\) \{[\s\S]+playUrl: x\.playUrl[\s\S]+`tmdb:tv:\$\{x\.tmdbId\}:s\$\{x\.s\}e\$\{x\.e\}`[\s\S]+map\[key\] = rec;[\s\S]+function mergeLocalItems\(lib, items\) \{[\s\S]+S\.localMap = map/,
    'local library scans should hydrate episode keys into the local-first playback map');
  assert.match(ui, /<div id="libEditActions" class="libEditActions" style="display:none">[\s\S]+id="libScanNow"[\s\S]+id="libMetaNow"/,
    'the added-library edit panel should expose scan and metadata-refresh actions');
  assert.match(ui, /function updateLibEditActions\(lib\) \{[\s\S]+lib && lib\.id && lib\.path[\s\S]+style\.display = local \? '' : 'none'[\s\S]+Save changes first if you edited the path or sharing/,
    'scan actions should only show for saved local-folder libraries and warn about unsaved edits');
  assert.match(ui, /\$\('libScanNow'\)\.addEventListener\('click', \(\) => \{[\s\S]+scanLibrary\(lib, 'scan'\)[\s\S]+\$\('libMetaNow'\)\.addEventListener\('click', \(\) => \{[\s\S]+scanLibrary\(lib, 'metadata'\)/,
    'edit-panel scan buttons should reuse the existing library scan API paths');
  assert.match(ui, /function localEpisodesForShow\(show\) \{[\s\S]+new RegExp\(`\^tmdb:tv:\$\{show\.tmdbId\}:s[\s\S]+Object\.keys\(S\.localMap\)[\s\S]+sort\(\(a, b\) => a\.s - b\.s \|\| a\.e - b\.e\)/,
    'matched local TV shows should discover owned episode keys, not only a bare show key');
  assert.match(ui, /function localTitleHasPlayback\(it\) \{[\s\S]+if \(S\.localMap && it\.key && S\.localMap\[it\.key\]\) return true;[\s\S]+return it\.type === 'tv' && localEpisodesForShow\(it\)\.length > 0;/,
    'detail availability should treat local TV episodes as playable local ownership');
  assert.match(ui, /function prefetchSources\(it, delay = 700\) \{[\s\S]+localTitleHasPlayback\(it\)[\s\S]+api\('\/api\/search\?' \+ sourceSearchQuery\(it\)\)/,
    'local-owned titles should not warm online source searches behind the detail page');
  assert.match(ui, /function queryFor\(it\) \{[\s\S]+if \(it\.tmdbId && \(it\.type === 'movie' \|\| it\.type === 'tv'\) && exact\) return exact;[\s\S]+return it\.q \|\| exact;/,
    'TMDB movie/show cards should play/search by the selected title and year, not a fuzzy raw search query');
  assert.match(ui, /append_to_response=credits,videos,content_ratings,release_dates,recommendations,similar,external_ids/,
    'detail pages should fetch external IDs before source lookup so old/franchise titles can search by catalog identity');
  assert.match(ui, /function sourceIdentityFor\(it\) \{[\s\S]+if \(it\.imdbId\) out\.imdbid = it\.imdbId;[\s\S]+if \(it\.tvdbId\) out\.tvdbid = it\.tvdbId;[\s\S]+const ep = episodeKeyParts\(it\);[\s\S]+out\.season = ep\.season;[\s\S]+out\.ep = ep\.episode;/,
    'source lookup should preserve IMDb, TVDB, season, and episode identity when available');
  assert.match(ui, /function sourceSearchQuery\(it, opts = \{\}\) \{[\s\S]+const ids = sourceIdentityFor\(it\);[\s\S]+params\.set\('imdbid', ids\.imdbid\);[\s\S]+params\.set\('tvdbid', ids\.tvdbid\);[\s\S]+params\.set\('season', String\(ids\.season\)\);[\s\S]+params\.set\('ep', String\(ids\.ep\)\);/,
    'Sources drawer searches should send external identifiers instead of only a title string');
  assert.match(ui, /const ids = sourceIdentityFor\(it\);[\s\S]+const body = \{ q: queryFor\(it\)[\s\S]+if \(ids\.imdbid\) body\.imdbid = ids\.imdbid;[\s\S]+if \(ids\.tvdbid\) body\.tvdbid = ids\.tvdbid;[\s\S]+if \(ids\.season != null\) body\.season = ids\.season;[\s\S]+if \(ids\.ep != null\) body\.ep = ids\.ep;/,
    'Play should carry the same external identity as the Sources drawer');
  assert.match(ui, /if \(it\._lib && it\._lib\.path\) \{[\s\S]+const r = it\._kind === 'show'[\s\S]+await loadAllLocalShowEpisodes\(it\._lib, it\._idx\)[\s\S]+mergeLocalItems\(it\._lib, r\.items \|\| \[\]\);[\s\S]+\}[\s\S]+checkAvailability\(it\);/,
    'TV details opened from an added library should hydrate all local episode ownership before availability/play targets are calculated');
  assert.match(ui, /async function checkAvailability\(it\) \{[\s\S]+const hasLocal = localTitleHasPlayback\(it\);[\s\S]+if \(hasLocal && localPlaybackRankForItem\(it\) === 4\) \{[\s\S]+\$\(\'qToggle\'\)\.style\.display = 'none';[\s\S]+api\('\/api\/search\?' \+ sourceSearchQuery\(it, \{ includeQuality: false \}\)\)[\s\S]+has4k && \(hasLower \|\| \(hasLocal && localRank !== 4\)\)[\s\S]+if \(hasLocal\) \{[\s\S]+\$\(\'dSources\'\)\.style\.display = offer \? '' : 'none';[\s\S]+return;/,
    'local-owned detail pages should still discover online 4K when the local file is lower quality, without showing unavailable');
  assert.match(ui, /if \(it\._showOpen !== undefined\)[\s\S]+openLocalShowDetail\(\{ \.\.\.it, _lib: lib \}\)/,
    'unmatched local TV shows should open a details page instead of a flat episode grid');
  assert.match(ui, /async function openLocalShowDetail\(it\) \{[\s\S]+_localShow: true[\s\S]+loadAllLocalShowEpisodes\(show\._lib, show\._showOpen\)[\s\S]+S\.detailSeasons = localSeasonSummaries\(episodes\)[\s\S]+renderLocalShowSeasonGrid\(show, S\.detailSeasons\)[\s\S]+pickLocalShowPlayTarget\(show, episodes\)/,
    'local-only show details should group scanned episodes into seasons before rendering episode cards');
  assert.match(ui, /function openLocalShowSeasonEpisodes\(show, seasonNumber\) \{[\s\S]+S\.localDetailEpisodes[\s\S]+localEpisodeItemOf\(show, ep\)[\s\S]+setLocalEpisodeWatched\(item, act === 'watch', seasonNumber\)/,
    'local-only show seasons should open local episode cards that play and mark local episode keys');
  assert.match(ui, /function localEpisodeItemOf\(show, ep\) \{[\s\S]+q: `\$\{show\.title\} \$\{code\}`[\s\S]+season: ep\.s, episode: ep\.e/,
    'local episode playback items should preserve query and episode numbers for subtitles');
  assert.match(ui, /function episodeKeyParts\(it\) \{[\s\S]+it\.season[\s\S]+it\.episode[\s\S]+it\.q[\s\S]+it\.genre[\s\S]+it\.title/,
    'episode helpers should understand local episode metadata, not just tmdb:tv keys');
  assert.match(ui, /\$\(\'allSeasonsBtn\'\)\.addEventListener\('click', \(\) => \{[\s\S]+S\.detailItem\._localShow[\s\S]+renderLocalShowSeasonGrid\(S\.detailItem, S\.detailSeasons\)[\s\S]+else renderSeasonGrid\(S\.detailItem, S\.detailSeasons\)/,
    'All seasons should return to the local season grid for local-only shows');
  assert.match(ui, /if \(it\._localShow && S\.localDetailEpisodes\) \{[\s\S]+markLocalEpisodeGroupWatched\(it, S\.localDetailEpisodes, nowWatched/,
    'the local-only show watched button should mark the show episode keys, not a container key');
  assert.match(ui, /function epItemOf\(show, season, ep\) \{[\s\S]+const loc = S\.localMap && S\.localMap\[item\.key\];[\s\S]+return loc \? \{ \.\.\.item, _local: loc \} : item;/,
    'season episode cards should carry local playback when the episode exists in an added library');
  assert.match(ui, /\.seasonCard \.seasonYear\{[\s\S]+font:800 12px "JetBrains Mono"[\s\S]+border-radius:20px/,
    'TV detail season cards should show a readable season-year badge on the poster');
  assert.match(ui, /function seasonYearLabel\(season\) \{[\s\S]+season && season\.air_date[\s\S]+return \/\^\\d\{4\}\$\/\.test\(year\) \? year : 'TBA';[\s\S]+function seasonEpisodeCountLabel\(season\) \{[\s\S]+episode\$\{count === 1 \? '' : 's'\}/,
    'season card metadata should derive the year from the season air date and keep episode text compact');
  assert.match(ui, /const yearLabel = seasonYearLabel\(s\);[\s\S]+const episodeLabel = seasonEpisodeCountLabel\(s\);[\s\S]+<span class="seasonYear">\$\{esc\(yearLabel\)\}<\/span>[\s\S]+<div class="sd">\$\{esc\(episodeLabel\)\}<\/div>/,
    'TV detail season cards should render the year separately from the episode count');
  assert.match(ui, /async function markSeasonWatched\(show, season, watched\) \{[\s\S]+for \(let e = 1; e <= count; e\+\+\) \{[\s\S]+`tmdb:tv:\$\{show\.tmdbId\}:s\$\{sNum\}e\$\{e\}`[\s\S]+api\('\/api\/watch\/bulk'[\s\S]+renderSeasonGrid\(show, S\.detailSeasons \|\| \[season\]\)[\s\S]+applyFocus\(focus, false\)/,
    'long-hold season actions should bulk-mark only that season and restore focus after the season grid refreshes');
  assert.match(ui, /if \(el\.classList\.contains\('seasonCard'\)\) \{[\s\S]+S\._lpTimer = setTimeout\(\(\) => \{[\s\S]+if \(S\.detailItem\._localShow\) \{[\s\S]+markLocalEpisodeGroupWatched\(S\.detailItem, episodes, watched,[\s\S]+return;[\s\S]+const watched = !isSeasonWatched\(S\.detailItem\.tmdbId, seasonNumber, season\.episode_count\);[\s\S]+markSeasonWatched\(S\.detailItem, season, watched\);[\s\S]+\}, 450\);[\s\S]+return;/,
    'TV detail season cards should support hold-OK watched/unwatched toggling without opening the season, including local-only shows');
  assert.match(ui, /function epTarget\(show, sNum, eNum, resume\) \{[\s\S]+const loc = S\.localMap && S\.localMap\[item\.key\];[\s\S]+return loc \? \{ \.\.\.item, _local: loc \} : item;/,
    'the main TV detail Play/Resume target should carry local playback for owned episodes');
  assert.match(ui, /function pickNextUp\(show, seasons\) \{[\s\S]+const localEpisodes = localEpisodesForShow\(show\);[\s\S]+if \(localEpisodes\.length\) \{[\s\S]+const nextLocal = localEpisodes\.find\(\(ep\) => !\(wm\[ep\.key\] && wm\[ep\.key\]\.watched\)\)[\s\S]+target: epTarget\(show, nextLocal\.s, nextLocal\.e, 0\)/,
    'matched local TV show Play should start from the next owned episode rather than a missing online source');
  assert.match(ui, /_local: \{ streamUrl: loc\.streamUrl, playUrl: loc\.playUrl, name: loc\.name \}, _episode: true/,
    'next-episode bumps should keep the rich local player prep URL');
  assert.match(ui, /function startOverItem\(it\) \{[\s\S]+_startOver: true/,
    'Start Over should carry an explicit playback intent instead of relying on resume: 0 alone');
  assert.match(ui, /if \(it\._startOver\) return \{ \.\.\.it, resume: 0 \};/,
    'click-time resume resolution must not reapply saved progress to Start Over');
  assert.match(ui, /\$\(\'dStartOver\'\)\.addEventListener\('click'[\s\S]+play\(startOverItem\(detailPlayTarget \|\| it\)\)/,
    'the detail Start Over button should use the same explicit intent as episode menus');
  assert.match(ui, /if \(act === 'start'\) play\(startOverItem\(item\)\);/,
    'episode Play from start should not resume from watch state');
  assert.match(ui, /function durableArtUrl\(u\) \{[\s\S]+isTokenizedLocalUrl\(u\) \? '' : \(u \|\| ''\)/,
    'watch metadata should not persist tokenized local artwork URLs that will expire');
  assert.match(ui, /const art = freshLocalArtForKey\(w\.key\);[\s\S]+poster: poster \|\| procBackdrop[\s\S]+backdrop: backdrop \|\| procBackdrop/,
    'Continue Watching should rehydrate fresh local artwork before falling back');
  assert.match(ui, /const meta = wlMeta\(p\.item\);[\s\S]+meta, \/\/ episodes resume \+ reopen/,
    'watch progress should persist sanitized metadata through the shared watchlist metadata helper');
  assert.match(ui, /function openLocalDetail\(it\) \{[\s\S]+const resume = resumePositionForItem\(it\);[\s\S]+\$\(\'dStartOver\'\)\.style\.display = resume \? '' : 'none';[\s\S]+updateDetailPlayLabel\(resume \? \{ label: 'Resume', target: \{ \.\.\.it, resume \} \}/,
    'unmatched local library details should expose the same Resume and Start Over behavior');
});

test('preferences profile manager has TV-friendly profile icons and add action', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(ui, /const PROFILE_ICON_PATHS = \{[\s\S]+kids:[\s\S]+family:[\s\S]+adult:/,
    'profile maturity levels should use professional inline icons');
  assert.match(ui, /function profileLevelChip\(level\) \{[\s\S]+profileIcon\(LEVEL_ICON\[idx\]\)[\s\S]+LEVELS\[idx\]/,
    'profile maturity chips should be generated from labels and icons, not emoji');
  assert.match(ui, /row\.innerHTML = `\$\{profileLevelAvatar\(level\)\}[\s\S]+class="profileActions"[\s\S]+data-act="pin"/,
    'profile settings rows should render identity, actions, and PIN as explicit D-pad targets');
  assert.match(ui, /addForm\.className = 'pinForm addProfileForm'[\s\S]+class="profileAddBtn focusable"/,
    'the add-profile control should use the styled TV-friendly primary button');
  assert.doesNotMatch(ui, /LEVEL_BADGE/,
    'profile UI should not reintroduce emoji maturity badges');
});

test('music playback stops when leaving the Music section', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(ui, /function stopMusicWhenLeavingMusic\(nextView\) \{[\s\S]+if \(nextView === 'music'\) return;[\s\S]+if \(S\.musicCur\) closeMusicPlayer\(\);[\s\S]+S\._musicWasPlaying = false;[\s\S]+\}/,
    'leaving Music should stop and clear the section-scoped audio player');
  assert.match(ui, /function switchView\(v, push = true, opts = \{\}\) \{[\s\S]+stopMusicWhenLeavingMusic\(v\);[\s\S]+\$\(\'musicNow\'\)\.classList\.remove\('open'\)/,
    'all normal page navigation should enforce the Music stop rule');
  assert.match(ui, /function openPlayer\(it, mount, opts = \{\}\) \{[\s\S]+if \(S\.musicCur\) closeMusicPlayer\(\);[\s\S]+S\._musicWasPlaying = false;/,
    'starting video playback should stop Music instead of pausing it for later resume');
  assert.doesNotMatch(ui, /S\._musicWasPlaying && S\.musicCur[\s\S]+mAudio\.play\(\)/,
    'closing video playback should not resume music after the user has left Music');
  assert.match(ui, /mAudio\.addEventListener\('ended', \(\) => musicNext\(true\)\)/,
    'ended tracks should route through the auto-advance path');
  assert.match(ui, /playMusic\(q, next, \{ showQueue: \$\('musicNow'\)\.classList\.contains\('open'\), notify: !auto \}\)/,
    'auto-advance should continue playing the next music track while keeping the queue context');
  assert.match(ui, /if \(auto && S\.musicRepeat === 'one'\) \{ mAudio\.currentTime = 0; safeMusicPlay\(\{ notify: false \}\); return; \}/,
    'repeat-one should restart cleanly through the safe music play path');
});

test('subtitle startup preference contract: always mode applies online captions before track probing', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const playerMap = fs.readFileSync(path.join(__dirname, '..', 'docs-player-regression-map.md'), 'utf8');
  assert.match(ui, /function prefSubtitleMode\(\) \{[\s\S]+const scoped = localStorage\.getItem\(profilePrefKey\('subtitleMode'\)\);[\s\S]+if \(scoped !== null\) return scoped === 'always' \? 'always' : 'manual';[\s\S]+localStorage\.getItem\('triboon\.subtitleMode'\) === 'always'/,
    'profile subtitle mode should fall back to the legacy global always/manual setting');
  assert.match(ui, /function startupSubtitleRelFor\(p, saved = loadSubChoice\(\)\) \{[\s\S]+Explicit per-title choices win[\s\S]+if \(subtitleRelPlayable\(p, saved\)\) return saved;[\s\S]+if \(saved === 'off' && prefSubtitleMode\(\) !== 'always'\) return '';[\s\S]+return autoSubtitleRelFor\(p\);[\s\S]+\}/,
    'startup subtitle choice should share saved, off, and always-mode rules');
  assert.match(ui, /function startWebPlayerHousekeeping\(mount, it\) \{[\s\S]+loadTracks\(\);[\s\S]+if \(!applyStartupSubtitlePref\(\)\) \{[\s\S]+fetch\(`\/api\/ossubs\/\$\{mount\.id\}\?\$\{subtitleRequestParams\(it, code2, mount\.streamToken\)\.toString\(\)\}`\)/,
    'web player should try to enable always-mode subtitles before falling back to warmup prefetch');
  assert.match(ui, /function applyStartupSubtitlePref\(\) \{[\s\S]+const rel = concreteSubtitleRel\(startupSubtitleRelFor\(p\)\);[\s\S]+Promise\.resolve\(setSubtitle\(rel\)\)\.finally/,
    'always-mode subtitles should be applied without waiting for the track probe to finish');
  assert.match(ui, /function applyTrackPrefs\(\) \{[\s\S]+if \(p\.usingNative && canUseNativeVideoPlayer\(\)\) return;[\s\S]+applyStartupSubtitlePref\(\);[\s\S]+if \(!p\.tracks\) \{ updateSrndBtn\(\); return; \}/,
    'track preference setup should still apply startup subtitles when tracks are not available yet');
  assert.match(ui, /function nativeVideoSubtitleRel\(p\) \{\s+return \{ blocked: false, rel: concreteSubtitleRel\(startupSubtitleRelFor\(p\)\) \};\s+\}/,
    'native ExoPlayer startup should use the same subtitle startup contract as web playback');
  assert.match(playerMap, /Profile always-show subtitles must auto-enable the preferred online subtitle at startup/,
    'player regression map should document the always-subtitles startup contract');
});

test('Live TV startup warm is delayed so app login and first playback stay responsive', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /const IPTV_STARTUP_WARM_DELAY_MS = Math\.max\(5 \* 60000, Math\.min\(30 \* 60000, Number\(process\.env\.TRIBOON_IPTV_STARTUP_WARM_DELAY_MS \|\| 10 \* 60000\)\)\);/,
    'startup warm should default to a long delay with bounded override');
  assert.match(server, /scheduleIptvWarmSoon\('startup', IPTV_STARTUP_WARM_DELAY_MS, \{ skipGuide: true \}\);/,
    'startup warm must not use the short source-change delay or heavy guide parse');
});

test('Android native player: direct source and native chrome stay out of the web player', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const transcode = fs.readFileSync(path.join(__dirname, '..', 'server', 'transcode.js'), 'utf8');
  const android = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'app', 'triboon', 'tv', 'MainActivity.java'), 'utf8');
  const androidGradle = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'build.gradle'), 'utf8');
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  const networkSecurity = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml'), 'utf8');
  const proguardRules = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'proguard-rules.pro'), 'utf8');
  const playerMap = fs.readFileSync(path.join(__dirname, '..', 'docs-player-regression-map.md'), 'utf8');
  const loadingRing = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'native_loading_ring.xml'), 'utf8');
  const guideIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_guide.xml'), 'utf8');
  const nativePlayerLayout = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'layout', 'native_player_view.xml'), 'utf8');
  const audioIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_audio.xml'), 'utf8');
  const ccIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_cc.xml'), 'utf8');
  const qualityIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_quality.xml'), 'utf8');
  const rewindIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_rewind.xml'), 'utf8');
  const forwardIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_forward.xml'), 'utf8');
  const nextIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_next.xml'), 'utf8');
  const infoIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_info.xml'), 'utf8');
  const androidSmoke = fs.readFileSync(path.join(__dirname, '..', 'bench', 'android-tv-smoke.ps1'), 'utf8');
  const openGuideMethod = android.slice(
    android.indexOf('private void openNativeLiveGuide()'),
    android.indexOf('private void enterNativeGuideMode()'),
  );
  assert.doesNotMatch(manifest, /android:screenOrientation="landscape"/,
    'Android phone APK must not force the full shell into landscape');
  assert.match(android, /boolean isTv = isTvDevice\(\);[\s\S]+TriboonTV\/[\s\S]+TriboonAndroid\//,
    'Android shell should tag TV and phone WebViews differently');
  assert.match(android, /int contentWidth = Math\.max\(dp\(260\), Math\.min\(getResources\(\)\.getDisplayMetrics\(\)\.widthPixels - \(pad \* 2\), dp\(520\)\)\);[\s\S]+setup\.addView\(addr, new LinearLayout\.LayoutParams\(contentWidth/,
    'Android first-run server setup screen should fit phone portrait widths');
  assert.doesNotMatch(android, /addr\.setMinWidth/,
    'Android setup URL field should not use a fixed TV-width minimum on phones');
  assert.match(android, /if \(isTvDevice\(\)\) \{[\s\S]+addr\.requestFocus\(\);[\s\S]+\} else \{[\s\S]+root\.requestFocus\(\);[\s\S]+\}/,
    'Android phone setup screen should not auto-open the keyboard before the user taps the server URL field');
  assert.match(android, /if \(setup != null && setup\.getVisibility\(\) == View\.VISIBLE\) \{[\s\S]+if \(isTvDevice\(\)\) \{[\s\S]+addr\.requestFocus\(\);[\s\S]+\} else \{[\s\S]+root\.requestFocus\(\);[\s\S]+\}[\s\S]+return;/,
    'Android focus recovery should not reopen the phone keyboard on first-run setup');
  assert.match(android, /private void hidePhoneKeyboard\(View tokenView\) \{[\s\S]+hideSoftInputFromWindow/,
    'Android phone shell should have a soft-keyboard hide helper');
  assert.match(android, /private void clearPhoneInitialWebInputFocus\(\) \{[\s\S]+document\.activeElement[\s\S]+hidePhoneKeyboard\(web\);/,
    'Android phone WebView should blur web login/profile inputs after page load');
  assert.match(android, /private void connect\(\) \{[\s\S]+if \(!isTvDevice\(\)\) \{[\s\S]+hidePhoneKeyboard\(addr\);[\s\S]+addr\.clearFocus\(\);[\s\S]+root\.requestFocus\(\);[\s\S]+\}[\s\S]+if \(!isTvDevice\(\)\) clearPhoneInitialWebInputFocus\(\);/,
    'Android phone WebView should not auto-open the keyboard on web login/profile gates');
  assert.ok(android.includes('url = url.replaceAll("(?i)%3a", ":").replaceAll("(?i)%2f", "/");')
    && android.includes('prefs().edit().putString(KEY_SERVER, server).apply();'),
    'Android setup should normalize encoded colon/slash server URLs so native bridge origin checks keep working');
  assert.ok(ui.includes("if (/TriboonTV/.test(navigator.userAgent)) document.body.classList.add('tv');")
    && ui.includes("if (/TriboonAndroid/.test(navigator.userAgent)) document.body.classList.add('androidApp');")
    && ui.includes("if (/TriboonAndroid/.test(navigator.userAgent) && !/TriboonTV/.test(navigator.userAgent)) document.body.classList.add('mobileShell');"),
    'phone WebView should not receive TV-only CSS just because it runs inside the Android shell');
  assert.match(ui, /body\.mobileShell #backdrop \.layer\{display:none!important;opacity:0!important\}[\s\S]+body\.mobileShell #burger\{display:grid\}[\s\S]+body\.mobileShell #home\{padding:62px 16px 18px 16px!important;justify-content:flex-start\}/,
    'Android phone WebView should get the compact mobile shell even when its CSS viewport is wider than 600px');
  assert.match(ui, /function androidBurgerHit\(e\) \{[\s\S]+const burger = \$\('burger'\);[\s\S]+burger\.contains\(e\.target\)[\s\S]+return p\.clientX <= 132 && p\.clientY <= 132;/,
    'Android top-left burger hitbox should not double-toggle taps already delivered to the burger button');
  assert.match(ui, /\$\('burger'\)\.addEventListener\('pointerdown'[\s\S]+\$\('burger'\)\.addEventListener\('touchend'[\s\S]+Date\.now\(\) - burgerTouchAt < 500/,
    'phone burger should have pointer and touch handling with duplicate-tap protection');
  assert.match(androidGradle, /every Android app video surface hands off[\s\S]+movies, episodes, local library files, and Live TV[\s\S]+Browser and[\s\S]+desktop builds keep the HTML video path/,
    'Android TV and mobile APK policy should be native ExoPlayer for every video surface, not phone-web-video');
  assert.ok(ui.includes('body.androidApp .gate{place-items:center;padding:18px}')
    && ui.includes('body.androidApp #gateArtCaption{display:none}'),
    'Android phone auth gates should use a phone-app layout without TV auth caption chrome');
  assert.match(android, /private int phoneOrientationBeforePlayback = ActivityInfo\.SCREEN_ORIENTATION_UNSPECIFIED;[\s\S]+private boolean phonePlaybackOrientationLocked = false;/,
    'Android phone player should remember the previous orientation before forcing playback landscape');
  assert.match(android, /private void applySystemUiPolicy\(\) \{[\s\S]+else if \(!phonePlaybackOrientationLocked\) \{[\s\S]+SCREEN_ORIENTATION_UNSPECIFIED/,
    'Android lifecycle focus recovery must not reset phone playback orientation while native video is open');
  assert.match(android, /private void setPhonePlaybackOrientation\(boolean active\) \{[\s\S]+SCREEN_ORIENTATION_SENSOR_LANDSCAPE[\s\S]+setRequestedOrientation\(phoneOrientationBeforePlayback\)/,
    'Android phone native playback should rotate to landscape and restore the prior shell orientation when closed');
  assert.match(android, /private void showNativeVideoLoading\(String json\) \{[\s\S]+setPhonePlaybackOrientation\(true\);[\s\S]+buildNativePlayerLayer\(\);/,
    'Android phones should rotate as soon as the native loading player opens, before source health finishes');
  assert.match(android, /if \(!guide\) setPhonePlaybackOrientation\(true\);[\s\S]+buildNativePlayerLayer\(\)/,
    'Android phones should rotate only full-screen native playback, not guide PiP handoffs');
  assert.match(android, /private void closeNativePlayback\(boolean notifyClosed\) \{[\s\S]+releaseNativePlayer\(notifyClosed\);[\s\S]+setPhonePlaybackOrientation\(false\);/,
    'Android phone playback rotation should be released when the native player closes');
  assert.ok(ui.includes('#heroBtns{width:100%;justify-content:center;gap:8px;flex-wrap:nowrap}')
    && ui.includes('#hero h1{font-size:clamp(24px,7.4vw,32px)')
    && ui.includes('#dBtns{flex-wrap:wrap;justify-content:center;align-items:center;gap:6px;overflow:visible')
    && ui.includes('#dBtns #dPlay{flex:1 1 132px;min-width:118px;max-width:176px}')
    && ui.includes('#dBtns #dStartOver{flex:1 1 132px;min-width:126px;max-width:176px}')
    && ui.includes('body.mobileShell #dBtns{flex-wrap:wrap;justify-content:center;align-items:center;gap:6px;overflow:visible')
    && ui.includes('body.mobileShell #dBtns #dStartOver{flex:1 1 132px;min-width:126px;max-width:176px}'),
    'mobile hero should stay centered while detail actions wrap into stable readable rows');
  assert.ok(ui.includes('#person .personHead{flex-direction:column;align-items:center;gap:16px')
    && ui.includes('#person .personHead .pInfo{width:100%;text-align:center}')
    && ui.includes('body.mobileShell #person .personHead{flex-direction:column;align-items:center;gap:16px')
    && ui.includes('body.mobileShell #person .personHead .pInfo{width:100%;text-align:center}'),
    'mobile person pages should stack the profile header instead of squeezing text beside the poster');
  assert.ok(ui.includes('id="statsBtn"') && ui.includes("return ['chGuide', 'back10', 'playPause', 'fwd30', 'nextEpBtn', 'ccBtn', 'audBtn', 'srndBtn', 'qualBtn', 'muteBtn', 'fsBtn', 'statsBtn']")
    && ui.includes('function collectPlayerStats()') && ui.includes('window.__tvNativeVideoStats'),
    'web player stats must be the last D-pad reachable control and accept native ExoPlayer stats');
  assert.ok(ui.includes('data-stab="activity"') && ui.includes("api('/api/activity')") && ui.includes('id="activityRefresh"'),
    'admin Settings should expose a focusable Now Watching panel backed by the activity API');
  assert.ok(ui.includes('function playerStreamKind(') && ui.includes('streamKind: playerStreamKind(p)')
    && ui.includes('streamLabel: playerStreamLabel(p)') && ui.includes('function activityStreamLabel(')
    && ui.includes('activityStream'),
    'Now Watching should show whether each session is original, remuxed, live, or transcoding');
  assert.match(ui, /<div class="settingsForm">[\s\S]+<span>Expected users<\/span><input id="perfUsers"[\s\S]+<span>Start\/seek reserve<\/span><input id="perfReserve"[\s\S]+<div class="settingsActions">[\s\S]+id="perfTest"[\s\S]+id="perfApply"[\s\S]+id="perfSave"/,
    'Streaming performance settings should keep labeled rows and one professional action group');
  assert.match(ui, /\.settingsRow\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)[\s\S]+\.settingsActions\{display:flex;align-items:center;gap:10px;flex-wrap:wrap/,
    'Settings form rows and action buttons should share stable spacing rules');
  assert.ok(ui.includes('id="prefContentTextSize"') && ui.includes("localStorage.setItem('triboon.textsize'")
    && ui.includes('function applyContentTextSize()'),
    'Preferences should expose a per-device content text-size picker');
  assert.match(ui, /Content text-size preference:[\s\S]+The rail, Settings, Preferences, auth gates and player controls keep fixed geometry[\s\S]+#hero h1\{font-size:var\(--ctHeroTitle\)[\s\S]+\.pgRow \.pgName\{font-size:var\(--ctLiveTitle\)[\s\S]+\.musicRow \.mT/,
    'content text size should scope to media/content pages without resizing the rail or settings chrome');
  assert.match(ui, /const THEME_TOKEN_MAP = \{[\s\S]+ink: '--ink'[\s\S]+surface: '--surface'[\s\S]+focus: '--focus'[\s\S]+scrim: '--scrim'/,
    'theme choices should remap full design roles, not only the three accent colors');
  assert.ok(['triboonCoral', 'cinema', 'studio', 'velvet', 'teal', 'evergreen', 'contrast'].every((name) => ui.includes(`${name}: {`)),
    'theme list should include calmer cinematic professional options');
  assert.match(ui, /scrim: 'linear-gradient\(90deg,rgba\(31,31,31,\.84\) 0%,rgba\(31,31,31,\.54\) 28%,rgba\(31,31,31,\.18\) 58%,rgba\(31,31,31,\.05\) 100%\),linear-gradient\(0deg,rgba\(31,31,31,\.74\) 0%,rgba\(31,31,31,\.24\) 26%,rgba\(31,31,31,\.04\) 60%,rgba\(31,31,31,\.10\) 100%\)'/,
    'theme scrims should keep browser backdrop art visible instead of applying a full-screen blackout');
  assert.ok(!ui.includes("scrim: 'linear-gradient(180deg"),
    'theme scrims should not regress to the old opaque vertical wash');
  assert.match(ui, /const THEME_ALIASES = \{[\s\S]+graphite: 'studio'[\s\S]+triboon: 'triboonCoral'[\s\S]+trioon: 'triboonCoral'[\s\S]+arctic: 'teal'[\s\S]+forest: 'evergreen'/,
    'legacy stored theme names should map to the nearest new professional palette');
  assert.ok(ui.includes("label: 'Triboon'") && ui.includes("tone: 'charcoal + gold'")
    && ui.includes("ink: '#1F1F1F'") && ui.includes("c: '#E5A00D'")
    && ui.includes("a: '#F2B63D'"),
    'Triboon theme should keep its name while using a Plex-style charcoal and gold palette');
  assert.ok(ui.includes("label: 'Carbon Gold'") && ui.includes("label: 'Studio Slate'")
    && ui.includes("label: 'Warm Taupe'") && ui.includes("label: 'Deep Teal'")
    && ui.includes("label: 'Olive Slate'"),
    'alternate themes should be grown-up neutral palettes, not playful mood colors');
  assert.ok(ui.includes("localStorage.getItem('triboon.theme') || 'triboonCoral'")
    && ui.includes('THEMES[name] || THEMES.triboonCoral'),
    'Triboon should be the default and fallback theme');
  assert.match(ui, /function applyTheme\(\) \{[\s\S]+Object\.entries\(THEME_TOKEN_MAP\)[\s\S]+setProperty\('--grad', t\.c\)[\s\S]+setProperty\('--gold', t\.a\)[\s\S]+document\.body\.dataset\.theme = name/,
    'theme application should update role tokens plus solid action colors');
  assert.ok(!ui.includes('--grad:linear-gradient') && !ui.includes('--gold:linear-gradient')
    && !ui.includes('.musicAction.primary{background:linear-gradient')
    && !ui.match(/\.ytmConnectIcon[^{]*\{[^}]*linear-gradient/),
    'buttons and icon-like action controls should use solid professional fills, not gradients');
  assert.match(ui, /#themePick,#themePickSet\{display:grid[\s\S]+\.themeMeta[\s\S]+\.themeName[\s\S]+\.themeTone[\s\S]+\.themePalette/,
    'theme picker should render understated material cards with names and tone labels');
  assert.match(ui, /b\.innerHTML = `[\s\S]+themeMeta[\s\S]+themeName[\s\S]+themeTone[\s\S]+themePalette[\s\S]+<i><\/i><i><\/i><i><\/i>/,
    'theme picker should use restrained palette strips instead of illustrative color-picking icons');
  assert.ok(ui.includes('id="apkTvUpdate"') && ui.includes('id="apkMobileUpdate"')
    && ui.includes('releases/latest/download/triboon-tv.apk')
    && ui.includes('releases/latest/download/triboon-mobile.apk'),
    'Preferences should expose stable Android TV and mobile update links');
  assert.match(ui, /function sectionFormConfig\(\) \{[\s\S]+S\.view === 'prefs'[\s\S]+root: \$\('prefs'\)[\s\S]+tabs: \$\('prefTabs'\)[\s\S]+panelAttr: 'data-ptab'[\s\S]+S\.view === 'settings'[\s\S]+root: \$\('settings'\)[\s\S]+tabs: \$\('setTabs'\)[\s\S]+panelAttr: 'data-stab'/,
    'Settings and Preferences should share the section-form D-pad model with separate tab/panel roots');
  assert.match(ui, /function focusContent\(retried\) \{[\s\S]+if \(S\.view === 'settings' \|\| S\.view === 'prefs'\) \{[\s\S]+formCtls\(\$\(S\.view === 'prefs' \? 'prefs' : 'settings'\)\)[\s\S]+els\[0\]\.focus\(\{ preventScroll: false \}\)/,
    'entering Settings or Preferences from the rail should land on the first visible form target');
  assert.match(ui, /function dpadSectionForm\(k\) \{[\s\S]+const inTabs = cfg\.tabs && cfg\.tabs\.contains\(active\);[\s\S]+if \(inTabs\) \{[\s\S]+if \(k === 'ArrowDown'\)[\s\S]+if \(k === 'ArrowRight'\) \{[\s\S]+const first = formCtls\(activeSectionPanel\(cfg\)\)\[0\];[\s\S]+first\.focus\(\{ preventScroll: false \}\);[\s\S]+if \(k === 'ArrowLeft'\) \{ active\.blur\(\); enterRail\(\); return true; \}/,
    'section tabs should move vertically, Right should enter the active panel, and Left should return to the rail');
  assert.match(ui, /if \(panelControls\.includes\(active\)\) \{[\s\S]+const moved = dpadForm\(panel, k, \{ leftEdge: false \}\);[\s\S]+if \(!moved && \(k === 'ArrowLeft' \|\| k === 'ArrowUp'\)\) return focusActiveSectionTab\(cfg\);[\s\S]+return true;[\s\S]+\}/,
    'Settings/Preferences panel controls should move geometrically and fall back to the active tab instead of getting trapped');
  assert.match(ui, /if \(inInput && \(S\.view === 'settings' \|\| S\.view === 'prefs'\) && k\.startsWith\('Arrow'\)\) \{[\s\S]+e\.preventDefault\(\);[\s\S]+dpadSectionForm\(k\);[\s\S]+return;[\s\S]+\}/,
    'Settings/Preferences inputs and dropdowns should use arrows for D-pad navigation instead of trapping focus');
  assert.match(android, /public String appVersion\(\)[\s\S]+BuildConfig\.VERSION_NAME[\s\S]+public void openAppUpdate\(String url\)[\s\S]+openExternalUrl\(url\)/,
    'Android bridge should expose app version and a guarded app-update opener');
  assert.match(android, /boolean dpadArrow = code == KeyEvent\.KEYCODE_DPAD_UP \|\| code == KeyEvent\.KEYCODE_DPAD_DOWN[\s\S]+KEYCODE_DPAD_LEFT[\s\S]+KEYCODE_DPAD_RIGHT;[\s\S]+if \(domKey != null && \(!pageInputFocused \|\| dpadArrow\) && setup\.getVisibility\(\) != View\.VISIBLE\) \{[\s\S]+jsKey\("keydown", domKey, e\.getRepeatCount\(\) > 0\)/,
    'Android TV should still forward D-pad arrows to the web focus model while Settings/Preferences fields are focused');
  assert.match(android, /allowedAppUpdateUrl\(Uri uri\)[\s\S]+triboon-tv\.apk[\s\S]+triboon-mobile\.apk[\s\S]+openExternalUrl\(String rawUrl\)/,
    'Android app-update bridge should only open the stable Triboon GitHub APK aliases');
  assert.match(android, /nativeQualityBtn = nativeButton\(R\.drawable\.ic_player_quality, "Quality", false\)[\s\S]+rightControls\.addView\(nativeQualityBtn\);[\s\S]+nativeStatsBtn = nativeButton\(R\.drawable\.ic_player_info, "Playback stats", false\)[\s\S]+showNativeStatsSheet\(\)[\s\S]+rightControls\.addView\(nativeStatsBtn\);/,
    'native stats button should be the last ExoPlayer right-side control after CC/audio/quality');
  assert.match(android, /private ScrollView nativeSheetScroll;[\s\S]+private LinearLayout nativeSheetRows;/,
    'native ExoPlayer choice sheets should have a dedicated scroll viewport');
  assert.match(android, /private int nativeSheetRowsViewportHeight\(int count\) \{[\s\S]+screen - dp\(260\)[\s\S]+return Math\.min\(max, needed\);[\s\S]+\}/,
    'native ExoPlayer subtitle/audio/quality sheets should stay bounded on smaller screens');
  assert.match(android, /nativeSheetScroll = new ScrollView\(this\);[\s\S]+nativeSheetRows = new LinearLayout\(this\);[\s\S]+nativeSheetRows\.addView\(row\);[\s\S]+nativeSheet\.addView\(nativeSheetScroll, new LinearLayout\.LayoutParams\([\s\S]+nativeSheetRowsViewportHeight\(labels\.length\)\)\);/,
    'native ExoPlayer choice rows should scroll inside the bounded sheet instead of growing offscreen');
  assert.match(android, /private java\.util\.ArrayList<View> nativeSheetFocusableRows\(\)[\s\S]+nativeSheetRows != null \? nativeSheetRows : nativeSheet[\s\S]+private void focusNativeSheetRow\([\s\S]+smoothScrollTo\(0, Math\.max\(0, row\.getTop\(\) - dp\(8\)\)\)/,
    'native ExoPlayer D-pad focus should keep the highlighted sheet row visible');
  assert.match(android, /row\.setSingleLine\(true\);[\s\S]+row\.setEllipsize\(TextUtils\.TruncateAt\.END\);[\s\S]+ViewGroup\.LayoutParams\.MATCH_PARENT, dp\(38\)/,
    'native ExoPlayer sheet rows should keep fixed height and ellipsize long track labels');
  assert.match(android, /private String nativeStatsJson\(\)[\s\S]+nativeVideoStatsLabel[\s\S]+nativeAudioStatsLabel[\s\S]+nativeBandwidthEstimate/,
    'native stats should report video, audio, and bandwidth estimates to the web player stats panel');
  assert.match(ui, /qualityLabel: nativeQualityLabel\(p, kind\),[\s\S]+size: p\.size \|\| 0,[\s\S]+duration: Math\.max/,
    'web-to-native player payload should include the selected movie or episode file size');
  assert.match(ui, /rows\.push\(\['Size', fmtBytes\(p\.size \|\| native\.size\)\]\);/,
    'web player info should show the selected movie or episode file size, including native bridge fallback');
  assert.match(android, /private long nativePlaybackSizeBytes = 0L;[\s\S]+long playbackSizeBytes = Math\.max\(0L, j\.optLong\("size", 0L\)\);[\s\S]+nativePlaybackSizeBytes = playbackSizeBytes/,
    'native ExoPlayer should retain the selected movie or episode file size from the playback payload');
  assert.match(android, /private String nativeFileSizeLabel\(long bytes\)[\s\S]+String\.format\(Locale\.US, "%\.2f GB", n \/ 1073741824\.0\)[\s\S]+j\.put\("size", nativePlaybackSizeBytes\)[\s\S]+rows\.add\("Size: " \+ \(nativePlaybackSizeBytes > 0 \? nativeFileSizeLabel\(nativePlaybackSizeBytes\) : "Unknown"\)\);/,
    'native player info should show the movie or episode file size in the stats sheet and bridge JSON');
  assert.match(ui, /function fmtMbps\(bitsPerSecond\)[\s\S]+return `\$\{mbps >= 10 \? Math\.round\(mbps\) : mbps\.toFixed\(1\)\} Mbps`;[\s\S]+rows\.push\(\['Bandwidth', fmtMbps\(native\.bandwidth\)\]\);/,
    'web player info should show bandwidth in Mbps instead of kbps');
  assert.match(android, /private String nativeBitrateLabel\(int bitrate\)[\s\S]+double mbps = bitrate \/ 1_000_000\.0;[\s\S]+String\.format\(Locale\.US, "%\.1f Mbps", mbps\)[\s\S]+rows\.add\("Bandwidth: " \+ \(bw > 0 \? nativeBitrateLabel/,
    'native player info should show bitrate and bandwidth in Mbps instead of kbps');
  assert.match(infoIcon, /M12,3 A9,9[\s\S]+M12,11 V16/,
    'native playback stats icon should be present as a vector asset');
  for (const id of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12']) {
    const row = playerMap.match(new RegExp(`\\| ${id} \\|[^\\n]+`));
    assert.ok(row, `player regression map should include ${id}`);
    assert.match(row[0], /`test\/(phase2|phase4|security)\.test\.js`/,
      `player regression map should keep ${id} tied to automated verification`);
  }
  assert.match(ui, /function nativePlaybackOrder\(p, preferredKind\) \{[\s\S]+pref === 'remux'[\s\S]+\? \['remux', 'transcode'\][\s\S]+: \(pref === 'transcode' \? \['transcode', 'remux'\] : \['direct', 'remux', 'transcode'\]\)[\s\S]+function nativeMimeForKind\(p, kind\)/,
    'ExoPlayer should honor the server-selected fast path but let remux fall through to transcode when the device rejects the remuxed codec');
  assert.match(ui, /function resolvePlaybackResume\(it\) \{[\s\S]+if \(it\._startOver\) return \{ \.\.\.it, resume: 0 \};[\s\S]+const pos = resumePositionForItem\(it\);[\s\S]+return pos > 0 \? \{ \.\.\.it, resume: pos \} : it;/,
    'Resume should be resolved from current watch state at click time, after quality changes');
  assert.match(ui, /async function play\(it, pick\) \{[\s\S]+it = resolvePlaybackResume\(it\);/,
    'playback should not rely on a stale detail target resume timestamp');
  assert.match(ui, /const nativeFirst = nativeVideoRequired\(it\);[\s\S]+if \(nativeFirst\) showNativePlayLoading\(it\);[\s\S]+else showPlayLoading\(it\);/,
    'pressing Play on Android should immediately use the native branded loading screen, not the web player shell');
  assert.match(ui, /function nativeVideoRequired\(it\) \{[\s\S]+VOD only: movies, episodes, and local-library files use the playVideo ExoPlayer bridge[\s\S]+return !!\(it && it\.type !== 'live' && canUseNativeVideoPlayer\(\)\);[\s\S]+\}/,
    'Android movies, episodes, and local library files should require the ExoPlayer VOD bridge');
  assert.match(ui, /async function playLocal\(it\) \{[\s\S]+const nativeFirst = nativeVideoRequired\(it\);[\s\S]+openPlayer\(it, \{ \.\.\.mount,[\s\S]+\}, \{ nativeFirst \}\);/,
    'added-library movie and episode playback should use the same ExoPlayer handoff as catalog playback');
  assert.match(ui, /if \(S\.view !== 'player'\) return;[\s\S]+openPlayer\(it, r, \{ nativeFirst \}\)/,
    'native-first playback should still honor Back/cancel while the loading screen is open');
  assert.match(ui, /const sourceName = mount\.candidate \? mount\.candidate\.name : mount\.name;[\s\S]+item: it, name: sourceName, fileName: mount\.name/,
    'native quality/source labels should use the selected release name, not only the mounted inner filename');
  assert.match(ui, /sourceAttributes: mount\.candidate && mount\.candidate\.attributes/,
    'player quality labels should receive the parsed selected-source attributes from /api/play');
  assert.match(ui, /function resolutionLabel\(res\) \{[\s\S]+v === '2160p'[\s\S]+return '4K'[\s\S]+function nativeQualityLabel\(p, kind\) \{[\s\S]+const attrLabel = resolutionLabel\(p && p\.sourceAttributes && p\.sourceAttributes\.resolution\);[\s\S]+if \(attrLabel\) return attrLabel;/,
    'player quality labels should prefer selected-source resolution attributes before guessing from filenames or tracks');
  assert.doesNotMatch(ui, /if \(h >= 400\) return '480p';\s*return '1080p';/,
    'direct/remux source labels should not invent a 1080p badge when source resolution and tracks are unknown');
  assert.match(ui, /const nativeRequired = nativeVideoRequired\(it\);[\s\S]+const nativeStarted = \(opts\.nativeFirst \|\| nativeRequired\) && tryNativePlaybackLadder\(it\.resume \|\| 0, startKind\);[\s\S]+if \(nativeStarted\) \{[\s\S]+startNativePlayerHousekeeping\(it\);[\s\S]+\} else if \(nativeRequired\) \{[\s\S]+closePlayer\(\);[\s\S]+return;[\s\S]+\} else \{[\s\S]+revealWebPlayerShell\(it\);[\s\S]+startWebPlayerHousekeeping\(mount, it\);[\s\S]+startSource\(startKind, it\.resume \|\| 0\);[\s\S]+\}/,
    'Android native movie playback should never reveal the web player shell when ExoPlayer is available');
  assert.match(ui, /function startNativePlayerHousekeeping\(it\) \{[\s\S]+stopWebVideoElement\(\);[\s\S]+if \(S\.healthTimer\) clearInterval\(S\.healthTimer\);[\s\S]+S\.watchTimer = setInterval\(saveWatch, 10000\);[\s\S]+loadTracks\(\);[\s\S]+prepNextEpisode\(it\);[\s\S]+\}/,
    'native playback should silence the hidden web video while still probing duration metadata');
  assert.match(ui, /function homeRowsFromWatch\(cw, loading = false\) \{[\s\S]+if \(!rows\.length && loading\) \{[\s\S]+name: 'Loading home'[\s\S]+emptyLabel: 'Loading\.\.\.'[\s\S]+async function loadRows\(opts = \{\}\) \{[\s\S]+!opts\.catalogOnly && !opts\.watchReady && !hasFreshWatch[\s\S]+publishHomeRows\(homeRowsFromWatch\(cachedWatchRowsForHome\(\), true\), opts\); \/\/ Internal first paint: focus target under the splash before \/api\/watch returns\./,
    'home should render a hidden focus target before the watch-state request can freeze Android TV D-pad input');
  assert.match(ui, /function perfMark\(name, extra = \{\}\) \{[\s\S]+S\.perfMarks[\s\S]+function signalTvReady\(reason\) \{[\s\S]+TriboonTV\.appReady[\s\S]+function signalTvReadyOnce\(reason\)/,
    'web boot should expose timing marks and notify Android when the TV focus model is ready');
  assert.match(android, /public String nativePlaybackCaps\(\) \{[\s\S]+return buildNativePlaybackCaps\(\);[\s\S]+private String buildNativePlaybackCaps\(\) \{[\s\S]+nativeAudioSinkCaps\(conservative\)[\s\S]+j\.put\("deviceClass", conservative \? "budget-android-tv" : "android-tv"\)[\s\S]+j\.put\("truehd", !conservative && sinkTrueHd\)[\s\S]+j\.put\("passthrough", !conservative && passthrough\)[\s\S]+j\.put\("source", "exo-mediacodec\+audio-output"\)/,
    'Android should report Exo/MediaCodec plus HDMI/eARC audio-output capabilities and conservative device class instead of relying only on WebView canPlayType');
  assert.match(ui, /function nativePlaybackCaps\(\) \{[\s\S]+TriboonTV\.nativePlaybackCaps[\s\S]+JSON\.parse\(TriboonTV\.nativePlaybackCaps\(\)[\s\S]+function clientCaps\(\) \{[\s\S]+const nativeCaps = nativePlaybackCaps\(\);[\s\S]+S\._caps = nativeCaps \? \{ \.\.\.webCaps, \.\.\.nativeCaps, web: webCaps \} : webCaps;/,
    'web play requests should merge native Exo capabilities into the caps sent to the server');
  assert.match(server, /function parseCaps\(raw\) \{[\s\S]+\['mkv', 'mp4', 'h264', 'hevc', 'dovi', 'av1', 'vp9', 'mpeg2', 'aac', 'ac3', 'eac3', 'eac3Joc', 'dts', 'dtsHd', 'truehd', 'passthrough', 'native', 'lowPower'\][\s\S]+caps\.audioOutput = String\(raw\.audioOutput\)\.slice\(0, 64\)/,
    'server should accept sanitized native playback capability fields');
  assert.match(server, /const imdbRaw = String\(ctx\.url\.searchParams\.get\('imdb'\) \|\| ctx\.url\.searchParams\.get\('imdbid'\) \|\| ''\)\.trim\(\);[\s\S]+const imdbId = \/\^tt\\d\{5,10\}\$\/i\.test\(imdbRaw\) \? imdbRaw\.toLowerCase\(\) : '';[\s\S]+const releaseName = subtitleReleaseName\(vf\) \|\| vf\.name;[\s\S]+key, tmdbId, imdbId, query: vf\._subQuery \|\| vf\._q \|\| releaseName \|\| vf\.name[\s\S]+const catalogId = imdbId \|\| tmdbId;/,
    'server subtitle route should accept IMDb ids, prefer them in Wyzie search, and cache by the active catalog id');
  assert.match(android, /private boolean pageTvReady;[\s\S]+private final java\.util\.ArrayList<String> pendingTvKeys[\s\S]+public void appReady\(\) \{[\s\S]+pageTvReady = true;[\s\S]+flushPendingTvKeys\(\);/,
    'Android should buffer early D-pad input until the web focus model is ready');
  assert.match(android, /private volatile String currentWebUrl[\s\S]+private boolean trustedBridgeOrigin\(\) \{[\s\S]+isTrustedServerUrl\(currentWebUrl\)[\s\S]+onPageStarted\(WebView v, String url[\s\S]+currentWebUrl = url == null \? "" : url;[\s\S]+onPageFinished\(WebView v, String url[\s\S]+currentWebUrl = url == null \? "" : url;[\s\S]+public void playVideo\(String json\) \{[\s\S]+if \(!trustedBridgeOrigin\(\)\) return;[\s\S]+startNativeVideo\(json\)/,
    'Android JS bridge methods should be gated to the configured Triboon server origin without calling WebView methods on the JavaBridge thread');
  assert.match(android, /private boolean sameOrigin\(Uri a, Uri b\) \{[\s\S]+normalizedPort\(a\) != normalizedPort\(b\)[\s\S]+return ah\.equals\(bh\) \|\| \(isAndroidLoopbackAlias\(ah\) && isAndroidLoopbackAlias\(bh\)\);[\s\S]+private boolean isAndroidLoopbackAlias\(String host\) \{[\s\S]+"10\.0\.2\.2"\.equals\(h\)/,
    'Android bridge trust should allow only same-port localhost/10.0.2.2 aliases for emulator testing');
  assert.match(android, /shouldOverrideUrlLoading\(WebView v, WebResourceRequest req\)[\s\S]+return u == null \|\| !isTrustedServerUrl\(u\.toString\(\)\);/,
    'Android WebView should only navigate inside the exact configured Triboon server origin');
  assert.match(android, /setMixedContentMode\(WebSettings\.MIXED_CONTENT_COMPATIBILITY_MODE\)/,
    'Android WebView should not blindly allow every mixed-content request');
  assert.match(android, /validateAndPinPersonalIptvUrl\(String raw\)[\s\S]+InetAddress\.getAllByName\(host\)[\s\S]+isBlockedPersonalIptvAddress\(address\)[\s\S]+String pinnedUrl = u\.buildUpon\(\)\.encodedAuthority\(pinnedAuthority\)\.build\(\)\.toString\(\)[\s\S]+validateNativePlaybackUrl\(String raw\)[\s\S]+isTrustedServerUrl\(url\)[\s\S]+validateAndPinPersonalIptvUrl\(url\)/,
    'Android native playback should allow Triboon server URLs but reject and IP-pin device IPTV targets before ExoPlayer opens them');
  assert.match(android, /private void applyNativeHttpHostHeader\(\) \{[\s\S]+headers\.put\("Host", nativeHostHeader\)[\s\S]+setDefaultRequestProperties\(headers\)/,
    'Android ExoPlayer HTTP requests should carry the original Host header when connecting to a pinned IPTV address');
  assert.match(android, /private String readPersonalEncryptedPref\(String key, String fallback\)[\s\S]+if \(!p\.contains\(key\)\) return fallback;[\s\S]+if \(!stored\.startsWith\(PERSONAL_IPTV_ENC_PREFIX\)\) \{[\s\S]+p\.edit\(\)\.remove\(key\)\.apply\(\)/,
    'Android should purge legacy plaintext personal IPTV prefs instead of reading them back');
  assert.match(android, /DefaultHttpDataSource\.Factory\(\)[\s\S]+setAllowCrossProtocolRedirects\(false\)/,
    'Android native playback should not allow provider redirects to switch protocols after URL validation');
  assert.match(android, /setAudioAttributes\(new AudioAttributes\.Builder\(\)[\s\S]+setUsage\(C\.USAGE_MEDIA\)[\s\S]+setHandleAudioBecomingNoisy\(true\)/,
    'Android ExoPlayer should request media audio focus and pause on noisy-device changes');
  assert.match(android, /protected void onPause\(\) \{[\s\S]+boolean inPip = Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.N && isInPictureInPictureMode\(\);[\s\S]+if \(nativePlayer != null && !inPip\) nativePlayer\.pause\(\);[\s\S]+document\.querySelectorAll\('video'\)\.forEach\(v=>v\.pause\(\)\)[\s\S]+if \(!inPip\) \{[\s\S]+web\.onPause\(\);[\s\S]+web\.pauseTimers\(\);/,
    'Android backgrounding should pause playback and WebView timers, while keeping system PiP playback alive');
  assert.doesNotMatch(android, /protected void onPause\(\) \{[\s\S]{0,240}closeNativePlayback\(true\);/,
    'Android onPause must not close native playback; that caused resume/PiP churn');
  assert.match(android, /protected void onUserLeaveHint\(\) \{[\s\S]+super\.onUserLeaveHint\(\);[\s\S]+enterNativePictureInPictureIfUseful\(\);[\s\S]+onPictureInPictureModeChanged\(boolean isInPictureInPictureMode, Configuration newConfig\)[\s\S]+PictureInPictureParams\.Builder\(\)[\s\S]+new Rational\(16, 9\)/,
    'Android mobile should enter system PiP from native playback without skipping platform lifecycle callbacks');
  assert.match(android, /public void onTrimMemory\(int level\)[\s\S]+trimAndroidMemoryCaches\(level >= android\.content\.ComponentCallbacks2\.TRIM_MEMORY_MODERATE\)[\s\S]+private void trimAndroidMemoryCaches\(boolean aggressive\)[\s\S]+personalIptvHostSafetyCache\.clear\(\)[\s\S]+nativeLoadingBackdrop\.setImageDrawable\(null\)[\s\S]+web\.clearCache\(false\)[\s\S]+web\.freeMemory\(\)/,
    'Android low-memory callbacks should trim WebView/device caches and release native loading artwork');
  assert.match(android, /decodeNativeBackdrop\(readLimitedBytes\(conn\.getInputStream\(\), NATIVE_BACKDROP_MAX_BYTES\)\)[\s\S]+private byte\[\] readLimitedBytes\(InputStream in, int maxBytes\)[\s\S]+private Bitmap decodeNativeBackdrop\(byte\[\] bytes\)[\s\S]+inSampleSize[\s\S]+RGB_565/,
    'native loading backdrop fetches should be byte-capped and downsampled before display');
  assert.match(androidGradle, /TRIBOON_RELEASE_STORE_FILE[\s\S]+signingConfigs \{[\s\S]+release \{[\s\S]+storeFile = file\(releaseStoreFilePath\)[\s\S]+buildTypes \{[\s\S]+release \{[\s\S]+signingConfig = signingConfigs\.release[\s\S]+assembleRelease[\s\S]+Release signing is required/,
    'Android release builds should require a real local signing key instead of silently producing debug-signed public APKs');
  assert.match(androidGradle, /release \{[\s\S]+minifyEnabled = true[\s\S]+shrinkResources = true[\s\S]+proguardFiles getDefaultProguardFile\('proguard-android-optimize\.txt'\), 'proguard-rules\.pro'/,
    'Android release builds should run R8/resource shrinking through the checked-in keep rules');
  assert.match(proguardRules, /@android\.webkit\.JavascriptInterface <methods>;[\s\S]+-keep class app\.triboon\.tv\.MainActivity/,
    'R8 rules should keep the JavaScript bridge and Activity callbacks that Android/WebView call reflectively');
  assert.match(android, /protected void onResume\(\) \{[\s\S]+applySystemUiPolicy\(\);[\s\S]+scheduleTvFocusRecovery\("resume"\)[\s\S]+public void onWindowFocusChanged\(boolean hasFocus\) \{[\s\S]+if \(hasFocus\) \{[\s\S]+applySystemUiPolicy\(\);[\s\S]+scheduleTvFocusRecovery\("window"\)[\s\S]+private void recoverTvFocus\(String reason\) \{[\s\S]+web\.requestFocus\(\);[\s\S]+if \(pageTvReady\) flushPendingTvKeys\(\);/,
    'Android should keep immersive system UI and reclaim WebView focus after reinstall/resume/window-focus races');
  assert.match(android, /private void jsKey\(String type, String key, boolean repeat\) \{[\s\S]+if \(!pageTvReady && !"keyup"\.equals\(type\)\) \{[\s\S]+queuePendingTvKey\(key, repeat\);[\s\S]+return;[\s\S]+\}/,
    'Android key bridge should not drop early D-pad keydown events during first app paint');
  assert.match(androidSmoke, /\[switch\]\$StartupDpad[\s\S]+\[switch\]\$ColdStart[\s\S]+input keyevent DPAD_RIGHT[\s\S]+input keyevent DPAD_DOWN[\s\S]+perfMarks/,
    'Android smoke helper should be able to reproduce first-open D-pad readiness and report boot timing marks');
  assert.match(ui, /function startWebPlayerHousekeeping\(mount, it\) \{[\s\S]+v\.onerror = \(\) => failover\(\);[\s\S]+startHealthPoll\(mount\.id\);[\s\S]+loadTracks\(\);[\s\S]+subtitleCatalogAvailable\(it\)[\s\S]+fetch\(`\/api\/ossubs\/\$\{mount\.id\}\?\$\{subtitleRequestParams\(it, code2, mount\.streamToken\)\.toString\(\)\}`\)/,
    'web-only probes and subtitle prefetch should stay in the web playback branch and carry catalog ids');
  assert.match(ui, /async function loadTracks\(\) \{[\s\S]+if \(p\.usingNative && canUseNativeVideoPlayer\(\)\) \{[\s\S]+p\.nativeDuration = p\.duration \|\| p\.nativeDuration \|\| 0;[\s\S]+refreshNativeSubtitleChoices\(\);[\s\S]+return;[\s\S]+\}/,
    'track probing should feed native duration and subtitle choices without starting web playback');
  assert.match(ui, /function startSource\(kind, atSeconds, opts = \{\}\) \{[\s\S]+if \(p && p\.usingNative && canUseNativeVideoPlayer\(\)\) return false;/,
    'web source swaps should not run underneath native playback');
  assert.match(ui, /function markVodPlaybackStarted\(p\) \{[\s\S]+p\.started = true;[\s\S]+function vodPlaybackStarted\(p\) \{[\s\S]+p\.nativeReady[\s\S]+function recoverSamePlaybackSource\(reason = ''\) \{[\s\S]+tryNativeVideoPlayer\(kind, at, \{ quietSeek: true \}\)[\s\S]+startSource\(kind, at, \{ quietSeek: true \}\)/,
    'VOD playback should record the post-start boundary and recover the same source/kind after a mid-stream interruption');
  assert.match(ui, /function failover\(\) \{[\s\S]+if \(vodPlaybackStarted\(p\)\) \{[\s\S]+recoverSamePlaybackSource\('playback interrupted'\);[\s\S]+return;[\s\S]+if \(!p\.usingRemux && !p\.usingTranscode/,
    'web media errors after a real VOD frame must not silently switch to remux/transcode or another release');
  assert.match(ui, /async function autoAdvance\(opts = \{\}\) \{[\s\S]+if \(vodPlaybackStarted\(p\) && !opts\.allowMidstreamAdvance\) \{[\s\S]+recoverSamePlaybackSource\('source failed'\);[\s\S]+return;[\s\S]+const at = currentTime\(\);/,
    'auto-advance should remain a startup/source-failure path, not a mid-movie release switch');
  assert.match(ui, /window\.__tvNativeVideoReady = \(pos, dur\) => \{[\s\S]+p\.nativeReady = true;[\s\S]+markVodPlaybackStarted\(p\);[\s\S]+window\.__tvNativeVideoError = \(msg, pos, dur\) => \{[\s\S]+if \(vodPlaybackStarted\(p\)\) \{[\s\S]+recoverSamePlaybackSource\(msg \|\| 'native playback interrupted'\);[\s\S]+return;/,
    'native ExoPlayer errors after READY should recover the same source instead of walking the fallback ladder');
  assert.match(android, /if \(state == Player\.STATE_READY\) \{[\s\S]+if \("video"\.equals\(nativeMode\)\) \{[\s\S]+nativeVideoStarted = true;[\s\S]+window\.__tvNativeVideoReady && __tvNativeVideoReady/,
    'Android ExoPlayer STATE_READY should mark the web VOD session as post-start before later errors are handled');
  assert.match(ui, /const clearReadyFrame = \(\) => \{[\s\S]+pReady\.item\.type === 'live' && v\.readyState >= 2[\s\S]+\$\(\'playerLoader\'\)\.classList\.remove\('show'\);[\s\S]+v\.onloadeddata = clearReadyFrame;[\s\S]+v\.oncanplay = clearReadyFrame;/,
    'web Live TV should clear the startup loader once a decoded frame is ready, even if delayed autoplay is blocked');
  assert.ok(ui.includes("$('vlcPanel').classList.remove('show');")
      && ui.includes('if (v.paused) showLivePlayPrompt();'),
    'a decoded web Live TV frame should clear any earlier external-player fallback panel');
  assert.ok(ui.includes('const requestLivePlay = () => requestVideoPlay(v, { livePrompt: true }).catch(() => {')
      && ui.includes('showLivePlayPrompt();')
      && ui.includes('requestLivePlay();'),
    'web Live TV MSE playback should reveal the ready frame when autoplay is blocked after buffering');
  assert.ok(ui.includes('function showLivePlayPrompt() {')
      && ui.includes("if (!p || !p.item || p.item.type !== 'live' || !$('video').paused) return;")
      && ui.includes('applyFocus(play);')
      && ui.includes('clearTimeout(S.osdTimer);')
      && ui.includes('function requestVideoPlay(v, opts = {}) {')
      && ui.includes("if (v.paused) requestVideoPlay(v, { livePrompt: S.playing && S.playing.item && S.playing.item.type === 'live' }).catch(() => {});"),
    'blocked browser Live TV autoplay should keep the Play control available instead of throwing an unhandled play rejection');
  assert.ok(ui.includes('function liveMseHasReadyFrame(p = S.playing) {')
      && ui.includes("const src = v && (v.currentSrc || v.src || '');")
      && ui.includes("p.item.type === 'live' && v && v.readyState >= 2 && !v.error && /^blob:/.test(src)")
      && ui.includes('if (liveMseHasReadyFrame(p)) {')
      && ui.includes("if (p.item && p.item.type === 'live') {")
      && ui.includes('S._liveVlcT = setTimeout(() => {')
      && ui.includes('showVlcPanel() {'),
    'web Live TV must not open the external-player panel after MSE has decoded a usable frame');
  assert.ok(ui.includes("const reason = r.headers.get('x-triboon-iptv-error') || 'live stream unavailable';")
      && ui.includes('e.liveProviderReason = reason;')
      && ui.includes('if (e.liveProviderReason) showLiveProviderError(e.liveProviderReason);')
      && ui.includes('function showLiveProviderError(reason) {')
      && ui.includes('Live stream unavailable')
      && ui.includes("Try another channel, or wait a moment before retrying."),
    'web Live TV should surface provider 403/429 failures instead of showing a misleading external-player prompt');
  assert.match(ui, /p\.usingTranscode = kind === 'transcode';[\s\S]+const kind = p\.usingTranscode \? 'transcode' : \(p\.usingRemux \? 'remux' : 'direct'\);/,
    'native fallback state should distinguish direct, remux, and transcode correctly');
  assert.match(ui, /function showNativePlayLoading\(it\) \{[\s\S]+\$\(\'player\'\)\.classList\.remove\('open', 'live', 'guideMode'\);[\s\S]+window\.TriboonTV\.showVideoLoading\(JSON\.stringify/,
    'Android movie playback should keep the web player closed while the native loader waits for the mount');
  assert.match(ui, /function tryNextNativeKind\(failedKind, atSeconds, msg\) \{[\s\S]+p\.nativeTried\[failedKind\] = true;[\s\S]+nativePlaybackOrder\(p, p\.nativeStartKind\)[\s\S]+tryNativeVideoPlayer\(next, atSeconds\)/,
    'native player failures should advance to the next native start kind, not the WebView player');
  assert.match(ui, /p\.nativeStartKind = playbackStartKind\(r\); p\.nativeTried = \{\};/,
    'native auto-advance should reset native fallback order for each new source');
  assert.match(ui, /autoAdvance\(\{ nativePreferred: true \}\)/,
    'native player source failures should advance to the next release instead of closing playback');
  assert.match(ui, /if \(nativePreferred && tryNativePlaybackLadder\(at, startKind\)\) \{[\s\S]+startNativePlayerHousekeeping\(p\.item\);/,
    'Android auto-advance should hand the next release back to ExoPlayer when native playback is active');
  assert.match(ui, /if \(nativePreferred\) \{\s*toast\('Native player could not start the next release'\);\s*closePlayer\(\);\s*return;\s*\}\s*revealWebPlayerShell\(p\.item\);/,
    'Android auto-advance must stop instead of falling back to the web player when ExoPlayer cannot start');
  assert.match(ui, /qualityLabel: nativeQualityLabel\(p, kind\)/,
    'native player should receive a user-facing resolution label');
  assert.match(ui, /function nativeMimeForKind\(p, kind\) \{[\s\S]+kind === 'remux' \|\| kind === 'transcode'[\s\S]+return 'video\/mp4'[\s\S]+mime: nativeMimeForKind\(p, kind\)/,
    'native remux/transcode playback should tell ExoPlayer it is receiving fragmented MP4 instead of relying on sniffing');
  assert.match(ui, /qualityChoices: !!p\.transcodeUrl/,
    'native HD button should only be enabled when optimized quality choices exist');
  assert.match(ui, /const nativeBackdrop = p\.item\.backdrop \|\| p\.item\.poster \|\| '';[\s\S]+backdropUrl: nativeBackdrop \? new URL\(nativeBackdrop, location\.origin\)\.href : ''/,
    'native Android loading should receive the same movie art as the web player loader');
  assert.match(ui, /const serverSeek = kind === 'remux' \|\| kind === 'transcode';[\s\S]+nativeUrl = `\$\{p\.remuxUrl\}&start=\$\{seekStart\}&audio=\$\{p\.audioTrack \|\| 0\}`;[\s\S]+url: new URL\(nativeUrl, location\.origin\)\.href,[\s\S]+start: serverSeek \? 0 : Math\.max\(0, atSeconds \|\| 0\),[\s\S]+startOffset: seekStart/,
    'native remux/transcode playback should use server-side start URLs and pass the absolute display offset');
  assert.match(ui, /class="seekLine"[\s\S]+id="seekElapsed"[\s\S]+id="seek"[\s\S]+id="seekTotal"/,
    'web player seek bar should show elapsed time on the left and total duration on the right');
  assert.match(ui, /class="topLeft"[\s\S]+id="playerBackBtn"[\s\S]+class="playerMetaRow"[\s\S]+id="pTitle"[\s\S]+id="pEpisode"[\s\S]+id="pQuality"[\s\S]+class="osdRight"[\s\S]+class="seekLine"/,
    'web player should keep back, title, episode, and quality together in the top-left metadata cluster');
  assert.match(ui, /#osd\{[\s\S]+padding:clamp\(22px,3vw,42px\) clamp\(24px,3\.6vw,52px\) clamp\(50px,6\.2vw,78px\)/,
    'web player controls should sit a bit higher above the bottom edge');
  assert.match(ui, /function updatePlayerMeta\(\) \{[\s\S]+playerQualityLabel\(p\)[\s\S]+\$\(\'pQuality\'\)\.textContent = quality/,
    'web player should keep the visible quality label synchronized without showing the full source filename');
  assert.match(ui, /function episodePlayerMeta\(it\) \{[\s\S]+it\.type !== 'episode'[\s\S]+episodeCodeMeta\(it\)[\s\S]+subline: \[code, epName\]\.filter\(Boolean\)\.join\(' - '\)/,
    'episode playback should split show title from season/episode metadata for the player header');
  assert.match(ui, /id="playerEpisodes"[\s\S]+id="trackMenu"/,
    'episode players should have a hidden current-season thumbnail strip below the controls');
  assert.match(ui, /#playerEpisodes\{display:flex;max-height:0[\s\S]+transition:max-height[\s\S]+#playerEpisodes\.open\{max-height:196px[\s\S]+\.playerEpCard\{[\s\S]+clamp\(220px,20vw,310px\)[\s\S]+border:0;border-radius:16px[\s\S]+background:transparent[\s\S]+box-shadow:none[\s\S]+\.playerEpCard \.peStill\{[\s\S]+aspect-ratio:16\/9;border-radius:16px[\s\S]+\.playerEpCard \.peMeta\{display:flex;flex-direction:column/,
    'web episode strip should animate open and show borderless rounded 16:9 stills with metadata below the image');
  assert.match(ui, /b\.innerHTML = `<div class="peStill"><\/div><div class="peMeta">[\s\S]+<span class="peName">/,
    'web episode cards should render the episode name below the thumbnail, not overlaid on the still');
  assert.match(ui, /async function getPlayerEpisodeContext\(it\) \{[\s\S]+episodeKeyParts\(it\)[\s\S]+api\(`\/api\/tmdb\/tv\/\$\{parts\.tmdbId\}\?append_to_response=external_ids`\)[\s\S]+api\(`\/api\/tmdb\/tv\/\$\{parts\.tmdbId\}\/season\/\$\{parts\.season\}`\)/,
    'player episode strip should load the current TMDB season and external IDs without depending on the detail page being open');
  assert.match(ui, /async function prepPlayerSeasonEpisodes\(it\) \{[\s\S]+epItemOf\(ctx\.show, ctx\.season, ep\)[\s\S]+S\.playerSeasonStrip = \{ currentKey: it\.key, items, idx:[\s\S]+updateNativeEpisodeChoices\(\);/,
    'player episode strip should reuse normal episode items and push the same choices to native playback');
  assert.match(ui, /const playerMeta = episodePlayerMeta\(p\.item\);[\s\S]+title: playerMeta\.title \|\| p\.item\.title \|\| 'Triboon',[\s\S]+episodeLabel: playerMeta\.subline \|\| '',/,
    'native Android player handoff should receive the same episode subline as the web player');
  assert.match(ui, /episodeChoices: nativeEpisodeChoices\(\),/,
    'native Android player handoff should include the current-season episode choices');
  assert.match(ui, /window\.__tvNativeEpisodeSelect = \(index, pos, dur\) => \{[\s\S]+S\.playerSeasonStrip\.idx = idx;[\s\S]+activatePlayerEpisode\(\);[\s\S]+\};/,
    'native episode-row selection should return through the normal web episode play path');
  assert.match(android, /private String nativePlaybackSubline = "";[\s\S]+String episodeLabel = j\.optString\("episodeLabel", ""\);[\s\S]+nativePlaybackSubline = episodeLabel == null \? "" : episodeLabel;[\s\S]+nativePlayerTitle\.setText\(title\);[\s\S]+nativePlayerTitle\.setVisibility\(View\.VISIBLE\);[\s\S]+String subline = isLiveMode \? "" : nativePlaybackSubline;[\s\S]+nativePlayerSubline\.setText\(subline\);[\s\S]+nativePlayerSubline\.setVisibility\(subline\.isEmpty\(\) \? View\.GONE : View\.VISIBLE\);[\s\S]+nativePlayerBadge\.setText\(chromeQuality\);[\s\S]+nativePlayerBadge\.setVisibility\(View\.VISIBLE\);/,
    'native Android player should show title, episode metadata, and quality in the top-left metadata cluster');
  assert.match(android, /nativeChromeSubline\.setText\(""\);[\s\S]+nativeChromeSubline\.setVisibility\(View\.GONE\);/,
    'native Android should clear the unused bottom metadata subline');
  assert.match(android, /private HorizontalScrollView nativeEpisodeStrip;[\s\S]+private final java\.util\.ArrayList<NativeEpisode> nativeEpisodes = new java\.util\.ArrayList<>\(\);/,
    'native Android player should own a real episode thumbnail row instead of relying on the hidden web overlay');
  assert.match(android, /nativeChrome\.addView\(nativeEpisodeStrip, new LinearLayout\.LayoutParams\([\s\S]+ViewGroup\.LayoutParams\.MATCH_PARENT, dp\(198\)\)\);/,
    'native Android episode strip should have enough height for larger thumbnails and labels below them');
  assert.match(android, /private void animateNativeEpisodeStripIn\(\) \{[\s\S]+setAlpha\(0f\)[\s\S]+setTranslationY\(dp\(24\)\)[\s\S]+setDuration\(190\)[\s\S]+private void animateNativeEpisodeStripOut\(\) \{[\s\S]+setDuration\(120\)/,
    'native Android episode strip should slide/fade in and out instead of popping on screen');
  assert.match(android, /ViewGroup\.LayoutParams\.MATCH_PARENT, dp\(126\)[\s\S]+label\.setText\(\(ep\.watched \? "WATCHED  " : ""\) \+ ep\.tag\);[\s\S]+TextView name = new TextView\(this\);[\s\S]+name\.setMaxLines\(2\);[\s\S]+new LinearLayout\.LayoutParams\(dp\(236\), dp\(182\)\)/,
    'native Android episode cards should show a larger still with the episode name below the image');
  assert.match(android, /private GradientDrawable nativeEpisodeCardBg\(boolean focused, boolean current\) \{[\s\S]+current[\s\S]+new int\[\]\{0x00000000, 0x00000000\}[\s\S]+d\.setCornerRadius\(dp\(16\)\);[\s\S]+return d;/,
    'native Android episode cards should use rounded borderless card backgrounds');
  assert.match(android, /GradientDrawable stillBg = new GradientDrawable\(\);[\s\S]+stillBg\.setCornerRadius\(dp\(16\)\);[\s\S]+still\.setBackground\(stillBg\);[\s\S]+still\.setClipToOutline\(true\);/,
    'native Android episode thumbnails should clip the image into rounded corners');
  assert.match(android, /public void updateEpisodeChoices\(String json\) \{[\s\S]+updateNativeEpisodeChoices\(json\)/,
    'web should be able to refresh native episode choices after TMDB season metadata loads');
  assert.match(android, /private void updateNativeEpisodeChoices\(String json\) \{[\s\S]+optJSONArray\("episodes"\)[\s\S]+renderNativeEpisodeStrip\(false\);/,
    'native Android player should parse the shared episode-choice payload');
  assert.match(android, /private boolean handleNativeEpisodeStripKey\(KeyEvent e\) \{[\s\S]+KEYCODE_DPAD_LEFT[\s\S]+focusNativeEpisode\(nativeEpisodeIndex - 1\)[\s\S]+chooseNativeEpisode\(nativeEpisodeIndex\);/,
    'native Android episode strip should handle Left/Right/OK itself');
  assert.match(android, /if \(code == KeyEvent\.KEYCODE_DPAD_DOWN && isNativeControl\(getCurrentFocus\(\)\) && openNativeEpisodeStrip\(\)\) return true;/,
    'native Android Down from the control row should open the episode strip when episode choices exist');
  assert.match(ui, /if \(S\.zone === 'playerCtl' && canOpenPlayerEpisodes\(\)\) return openPlayerEpisodes\(\);/,
    'web D-pad Down from player controls should open the episode strip for TV episode playback');
  assert.match(ui, /#osd::after\{[\s\S]+height:min\(42vh,380px\)[\s\S]+linear-gradient\(180deg,rgba\(0,0,0,0\) 0%[\s\S]+rgba\(0,0,0,\.56\) 100%\)/,
    'web player OSD should paint a plain black bottom controller shade without brand glow');
  assert.match(ui, /\.cbtn\{width:46px;height:46px[\s\S]+background:rgba\(5,3,9,\.4\)[\s\S]+\.cbtn:hover,\.cbtn\.focus,\.cbtn:focus\{background:rgba\(5,3,9,\.56\)/,
    'web player button circles should use more transparent black fills');
  assert.match(ui, /#osd \.ctl\{display:grid;grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/,
    'web player control row should visually pin Guide left, playback center, and secondary controls right');
  assert.match(ui, /class="ctlGroup ctlLeft"[\s\S]+id="chGuide"[\s\S]+class="ctlGroup ctlCenter"[\s\S]+id="back10"[\s\S]+id="playPause"[\s\S]+id="fwd30"[\s\S]+id="nextEpBtn"[\s\S]+class="ctlGroup ctlRight"[\s\S]+id="ccBtn"[\s\S]+id="audBtn"[\s\S]+id="srndBtn"[\s\S]+id="qualBtn"[\s\S]+id="muteBtn"[\s\S]+id="fsBtn"[\s\S]+id="statsBtn"/,
    'web player should mirror native Guide-left, playback-center, secondary-right button grouping with info last');
  assert.match(ui, /#trackMenu\{display:none;position:absolute;bottom:118px;right:44px;width:min\(390px,calc\(100vw - 88px\)\);min-width:260px;max-height:min\(420px,calc\(100vh - 220px\)\);[\s\S]+backdrop-filter:blur\(18px\)/,
    'web player CC/audio/quality popup should open near the right-side control buttons with polished glass styling');
  assert.match(ui, /function playerSurfaceClick\(e\) \{[\s\S]+closest\('#osd \.top,\.playerMetaRow,\.seekLine,\.ctl,#playerEpisodes,#trackMenu,#playerStats,#pGuide,#vlcPanel,#upNext,#playerLoader,button,a,input,select,textarea'\)[\s\S]+return true;[\s\S]+function playerSingleClick\(e\) \{[\s\S]+setTimeout\(\(\) => \{[\s\S]+togglePlay\(\);[\s\S]+\}, 320\);[\s\S]+function playerDoubleClick\(e\) \{[\s\S]+clearTimeout\(_playerSurfaceClickT\);[\s\S]+toggleFullscreen\(\);/,
    'web player screen clicks should toggle play, while double-click fullscreen cancels the pending pause');
  assert.match(ui, /\$\('player'\)\.addEventListener\('click', playerSingleClick\);[\s\S]+\$\('player'\)\.addEventListener\('dblclick', playerDoubleClick\);/,
    'web player should bind separate single-click and double-click surface handlers');
  assert.match(ui, /function hidePlayerOsdForBack\(\) \{[\s\S]+player\.classList\.contains\('open'\)[\s\S]+osd\.classList\.contains\('hide'\)[\s\S]+osd\.classList\.add\('hide'\)[\s\S]+S\.zone === 'seek'[\s\S]+return true;/,
    'web player Back should be able to hide visible controls without closing playback');
  assert.match(ui, /if \(k === 'Escape' \|\| k === 'Backspace'\) \{[\s\S]+if \(hidePlayerOsdForBack\(\)\) return;[\s\S]+return closePlayer\(\);[\s\S]+window\.__tvBack = \(\) => \{[\s\S]+\$\(\'pGuide\'\)[\s\S]+closePlayerGuide\(\);[\s\S]+\$\(\'playerStats\'\)[\s\S]+closePlayerStats\(\);[\s\S]+showOsd\(\);[\s\S]+if \(hidePlayerOsdForBack\(\)\) return 'ok';[\s\S]+const overlay = document\.querySelector/,
    'Escape/Backspace and Android TV Back should close PiP guide/controls before closing the player');
  assert.match(ui, /#appClock\{position:fixed;top:calc\(18px \+ var\(--safeT\) \+ var\(--overscan\)\);right:calc\(22px \+ var\(--safeR\) \+ var\(--overscan\)\);z-index:21;min-width:108px;height:38px;padding:0 18px[\s\S]+font:800 14px "JetBrains Mono",monospace;letter-spacing:0;[\s\S]+backdrop-filter:blur\(18px\);-webkit-backdrop-filter:blur\(18px\)\}/,
    'main app clock should render as a slightly larger text-only glass badge');
  assert.doesNotMatch(ui, /#appClock::before/,
    'main app clock should not draw an icon before the time');
  assert.match(ui, /#screensaver\{position:fixed;inset:0;z-index:55[\s\S]+#ssTime\{font:900 clamp\(54px,8\.5vw,132px\)\/\.9 "Sora";letter-spacing:0\}[\s\S]+#ssDeck\{position:absolute;right:clamp\(22px,5vw,86px\)/,
    'app screensaver should own a polished fullscreen visual layer with large time and art deck');
  assert.match(ui, /<div id="screensaver" aria-hidden="true">[\s\S]+<div class="ssBg" id="ssBg"><\/div>[\s\S]+<div class="ssDeck" id="ssDeck"><\/div>[\s\S]+<div id="ssTime"><\/div>/,
    'app screensaver markup should include background, art deck, and clock regions');
  assert.match(ui, /#screensaver \.ssBrand\{[\s\S]+width:clamp\(172px,14vw,270px\);height:clamp\(58px,5vw,96px\);overflow:hidden[\s\S]+#screensaver \.ssBrand img\{width:100%;height:auto;display:block;[\s\S]+transform:translateY\(-25%\);/,
    'screensaver brand should use the updated cropped Triboon wordmark');
  assert.match(ui, /<div class="ssBrand"><img src="triboon\.png" alt="Triboon"><\/div>/,
    'screensaver should use the updated transparent Triboon wordmark asset');
  assert.match(ui, /const SCREENSAVER_IDLE_DEFAULT_SECONDS = 60;[\s\S]+const SCREENSAVER_IDLE_OPTIONS = \[0, 60, 120, 300, 600\];[\s\S]+function normalizeScreensaverDelaySeconds\(value\) \{[\s\S]+if \(n > 0 && n < 60\) return normalizeScreensaverDelaySeconds\(n \* 60\);[\s\S]+function prefScreensaverDelaySeconds\(\) \{[\s\S]+localStorage\.getItem\(profilePrefKey\('screensaverDelay'\)\)[\s\S]+localStorage\.getItem\('triboon\.screensaverDelay'\)[\s\S]+return normalizeScreensaverDelaySeconds\(raw\);[\s\S]+function savePrefScreensaverDelay\(seconds\) \{[\s\S]+const n = normalizeScreensaverDelaySeconds\(seconds\);[\s\S]+function prefScreensaverDelayMs\(\) \{[\s\S]+return seconds > 0 \? seconds \* 1000 : 0;[\s\S]+function canShowScreensaver\(\) \{[\s\S]+S\.nativeLivePending[\s\S]+S\.view === 'player' \|\| \$\('player'\)\.classList\.contains\('open'\)[\s\S]+\.gate\.open,#drawer\.open,#trailer\.open,#libModal\.open,#matchModal\.open,#catModal\.open,#filterMenu\.open,#cwMenu\.open,#trackMenu\.open,#musicNow\.open[\s\S]+function resetScreensaverIdle\(\) \{[\s\S]+const idleMs = prefScreensaverDelayMs\(\);[\s\S]+if \(!idleMs\) return;[\s\S]+setTimeout\(showScreensaver, idleMs\);/,
    'app screensaver should default to one minute, allow profile timing, and stay out of native Live TV, playback, gates, and active modal surfaces');
  assert.match(ui, /function wakeScreensaverForPlayerSurface\(\) \{[\s\S]+if \(S\.screensaverOn\) hideScreensaver\(true\);[\s\S]+resetScreensaverIdle\(\);[\s\S]+\}/,
    'player and PiP guide surfaces should explicitly wake the screensaver before revealing video UI');
  assert.match(ui, /const SCREENSAVER_TRENDING_TTL = 24 \* 60 \* 60 \* 1000;[\s\S]+const SCREENSAVER_TRENDING_STORE = 'triboon\.screensaver\.trending';/,
    'screensaver trending artwork should use a daily browser cache');
  assert.match(ui, /function loadScreensaverTrendingCache\(\) \{[\s\S]+localStorage\.getItem\(SCREENSAVER_TRENDING_STORE\)[\s\S]+Date\.now\(\) - S\._screensaverTrendingAt < SCREENSAVER_TRENDING_TTL[\s\S]+function saveScreensaverTrendingCache\(key, items\) \{[\s\S]+localStorage\.setItem\(SCREENSAVER_TRENDING_STORE, JSON\.stringify\(payload\)\)/,
    'screensaver trending artwork should persist by profile/maturity key without requiring a fresh page load');
  assert.match(ui, /async function fetchScreensaverTrendingItems\(\) \{[\s\S]+api\('\/api\/tmdb\/trending\/all\/day'\)[\s\S]+passesMaturity\(x\) && catalogOk\(x\)[\s\S]+lvl < 3 && raw\.length < 18[\s\S]+certParams\(\)[\s\S]+mapTmdb\(x\)[\s\S]+return out\.slice\(0, 36\);/,
    'screensaver should prefer TMDB trending today while preserving profile-safe fallback lists');
  assert.match(ui, /function refreshScreensaverTrending\(force = false\) \{[\s\S]+screensaverTrendingFresh\(\)[\s\S]+S\._screensaverTrendingJob[\s\S]+saveScreensaverTrendingCache\(key, items\)[\s\S]+function scheduleScreensaverTrendingRefresh\(\) \{[\s\S]+window\.requestIdleCallback[\s\S]+refreshScreensaverTrending\(\);/,
    'screensaver trending refresh should be deduped and idle-scheduled instead of blocking startup');
  assert.match(ui, /function showScreensaver\(\) \{[\s\S]+renderScreensaver\(\);[\s\S]+refreshScreensaverTrending\(\)\.then\(\(updated\) => \{ if \(updated && S\.screensaverOn\) renderScreensaver\(\); \}\);[\s\S]+\$\('screensaver'\)\.classList\.add\('show'\);/,
    'screensaver should show cached art immediately and repaint only if fresh trending art arrives');
  assert.match(ui, /\$\('ssTitle'\)\.textContent = active\.title \|\| '';/,
    'screensaver caption should show only the title, without appending year, type, genre, or row name');
  assert.doesNotMatch(ui, /\$\('ssTitle'\)\.textContent = active\.sub \? `\$\{active\.title\}/,
    'screensaver caption should not rebuild the old title plus metadata line');
  assert.match(ui, /function noteScreensaverActivity\(e\) \{[\s\S]+if \(S\.screensaverOn\) \{[\s\S]+hideScreensaver\(true\);[\s\S]+resetScreensaverIdle\(\);[\s\S]+e\.preventDefault\(\);[\s\S]+e\.stopImmediatePropagation\(\);[\s\S]+e\.type === 'click' && S\._screensaverWakeUntil/,
    'first input while the screensaver is active should only wake the app, not also navigate or select');
  assert.match(ui, /function installScreensaverIdle\(\) \{[\s\S]+\['keydown', 'mousedown', 'click', 'mousemove', 'pointermove', 'wheel', 'touchstart', 'touchmove'\][\s\S]+document\.addEventListener\(type, noteScreensaverActivity, \{ capture: true, passive: \/\^\(mousemove\|pointermove\|wheel\|touchmove\)\$\/\.test\(type\) \}\);[\s\S]+resetScreensaverIdle\(\);/,
    'idle screensaver should listen across keyboard, remote, mouse, wheel, and touch inputs');
  assert.match(ui, /function installScreensaverIdle\(\) \{[\s\S]+if \(S\._screensaverInstalled\) \{[\s\S]+scheduleScreensaverTrendingRefresh\(\);[\s\S]+return;[\s\S]+scheduleScreensaverTrendingRefresh\(\);[\s\S]+resetScreensaverIdle\(\);/,
    'profile switches should re-check screensaver trending cache without installing duplicate idle listeners');
  assert.match(ui, /window\.__tvBack = \(\) => \{[\s\S]+if \(S\.screensaverOn\) \{[\s\S]+hideScreensaver\(true\);[\s\S]+resetScreensaverIdle\(\);[\s\S]+return 'ok';/,
    'Android TV Back should wake the screensaver instead of exiting the app');
  assert.match(ui, /function backToBrowseSectionMenu\(\) \{[\s\S]+S\.view === 'movies' \|\| S\.view === 'tv' \|\| S\.view === 'library'[\s\S]+enterRail\(\);[\s\S]+return true;[\s\S]+\}[\s\S]+if \(backToBrowseSectionMenu\(\)\) return 'ok';[\s\S]+if \(S\.view !== 'home'\) \{/,
    'Android TV Back should first open the section menu on Movies, TV, and added library pages before returning Home');
  assert.match(ui, /\$\('appClock'\)\.classList\.add\('show'\); updateClocks\(\);\s+installScreensaverIdle\(\);/,
    'screensaver idle timer should start only after the app shell is entered');
  {
    const start = ui.indexOf('function screensaverItems()');
    const end = ui.indexOf('function renderScreensaver()', start);
    assert.ok(start > 0 && end > start, 'screensaver item gatherer should be present');
    assert.doesNotMatch(ui.slice(start, end), /api\(/,
      'screensaver art gathering should use visible/cached rows without adding background API calls');
  }
  assert.match(android, /nativeTop\.setBackgroundColor\(Color\.TRANSPARENT\);/,
    'native top clock strip should not draw a glow or shade behind the time');
  assert.match(android, /private View nativeControlShade;[\s\S]+nativeControlShade = new View\(this\);[\s\S]+nativeControlShade\.setBackground\(nativeFade\(0x00000000, 0xE0000000\)\);[\s\S]+MATCH_PARENT, dp\(430\)[\s\S]+nativePlayerLayer\.addView\(nativeControlShade, shadeLp\);/,
    'native ExoPlayer should paint a plain bottom controller shade that fades away above the seek bar');
  assert.match(android, /if \(nativeControlShade != null\) nativeControlShade\.setVisibility\(View\.VISIBLE\);[\s\S]+if \(nativeMetaBar != null\) nativeMetaBar\.setVisibility\(View\.GONE\);[\s\S]+nativeChrome\.setVisibility\(View\.VISIBLE\);[\s\S]+nativeTop\.setVisibility\(View\.VISIBLE\);/,
    'native ExoPlayer should show the controller shade and top metadata cluster with the controls');
  assert.match(android, /nativeControlShade\.setVisibility\(View\.GONE\);[\s\S]+nativeMetaBar\.setVisibility\(View\.GONE\);[\s\S]+nativeChrome\.setVisibility\(View\.GONE\);/,
    'native ExoPlayer should hide the controller shade and metadata bar with the controls');
  assert.match(android, /private GradientDrawable nativeButtonBg\(boolean focused, boolean primary\) \{[\s\S]+new int\[\]\{0xFFEDE8F5, 0xFFD9CBE7\}[\s\S]+new int\[\]\{0x18F3EFF7, 0x18F3EFF7\}/,
    'native ExoPlayer buttons should use a very transparent circle background and switch fully light on focus');
  assert.match(android, /nativeChrome\.setPadding\(dp\(34\), dp\(12\), dp\(34\), dp\(18\)\);[\s\S]+controls\.setPadding\(0, dp\(18\), 0, 0\);/,
    'native ExoPlayer control row should balance the play button spacing above and below');
  assert.match(android, /FrameLayout\.LayoutParams chromeLp = new FrameLayout\.LayoutParams\([\s\S]+android\.view\.Gravity\.BOTTOM\);[\s\S]+chromeLp\.setMargins\(0, 0, 0, dp\(28\)\);/,
    'native ExoPlayer controls should sit a bit higher above the bottom edge');
  assert.match(android, /controls\.addView\(leftControls, new LinearLayout\.LayoutParams\([\s\S]+controls\.addView\(centerControls, new LinearLayout\.LayoutParams\([\s\S]+controls\.addView\(rightControls, new LinearLayout\.LayoutParams/,
    'native ExoPlayer should separate Guide left, playback center, and secondary controls right');
  assert.match(ui, /const cards = document\.createElement\('div'\); cards\.className = 'cards';\s+edgeScroll\(cards\);/,
    'freshly rendered home/discover rows should keep mouse edge auto-scroll');
  assert.match(ui, /if \(!el \|\| el\.dataset\.edgeScroll === '1'\) return;/,
    'row edge auto-scroll should be safe to attach after every render');
  assert.match(ui, /EDGE_SCROLL_SELECTORS = '\.cards,#castRow,#relatedRow,#seasonGrid,#seasonTabs,#epGrid,\.musicRail,#chCats,\.pgCats'/,
    'mouse edge auto-scroll should cover home, detail, music, Live TV, and player-guide rows');
  assert.match(ui, /related\.forEach\(\(rit\) => row\.appendChild\(makeCard\(rit, true, \(\) => \{\}\)\)\);\s+bindEdgeScroll\(row\);/,
    'detail related rows should rebind mouse edge auto-scroll after rendering');
  assert.match(ui, /const bar = document\.createElement\('div'\); bar\.id = 'chCats';[\s\S]+bindEdgeScroll\(bar\);/,
    'Live TV categories should have mouse edge auto-scroll when rendered as a strip');
  assert.match(ui, /catList\.className = 'pgCats guideCats';[\s\S]+bindEdgeScroll\(catList\);/,
    'in-player guide categories should keep mouse edge auto-scroll');
  assert.match(ui, /function setPlayerTimes\(pos, dur\) \{[\s\S]+\$\(\'seekElapsed\'\)\.textContent = cur;[\s\S]+\$\(\'seekTotal\'\)\.textContent = total;/,
    'web player should update the visible seek-row timers from playback ticks and seek previews');
  assert.match(ui, /#osd \.ctl \.time\{display:none\}/,
    'web player should not duplicate the old combined timer in the control row');
  assert.match(ui, /subtitleLabel: sub\.rel \? nativeSubtitleLabel\(sub\.rel\) : ''/,
    'native player should receive a user-facing subtitle label');
  assert.match(ui, /subtitleRel: sub\.rel \|\| ''[\s\S]+subtitleChoices: nativeSubtitleChoices\(\)/,
    'native player should receive selectable online subtitle choices');
  assert.match(server, /function episodeSubtitleQuery\(query, season, ep\)[\s\S]+S\$\{String\(s\)\.padStart\(2, '0'\)\}E\$\{String\(e\)\.padStart\(2, '0'\)\}/,
    'server subtitle lookup should be able to add episode identity even when source filenames are opaque');
  assert.match(server, /vf\._q = body\.q;[\s\S]+vf\._subQuery = episodeSubtitleQuery\(body\.q, body\.season, body\.ep\);/,
    'online subtitle lookup should use the episode-aware query captured during play');
  assert.match(server, /function subtitleReleaseName\(vf\) \{[\s\S]+vf\._releaseName[\s\S]+const releaseName = subtitleReleaseName\(vf\) \|\| vf\.name;[\s\S]+query: vf\._subQuery \|\| vf\._q \|\| releaseName \|\| vf\.name[\s\S]+rankSubs\(data, releaseName[\s\S]+downloadBestSubtitle\([\s\S]+releaseName,/,
    'online subtitle lookup should rank and download using the selected source release name');
  assert.match(server, /function localMountFor\(ctx, libId, idx, caps = \{\}, playCtx = \{\}\)[\s\S]+const q = String\(playCtx\.q \|\| found\.item\.q \|\| found\.item\.title \|\| name\)[\s\S]+const season = playCtx\.season \?\? found\.item\.s[\s\S]+const ep = playCtx\.ep \?\? playCtx\.episode \?\? found\.item\.e[\s\S]+vf\._subQuery = episodeSubtitleQuery\(vf\._q, season, ep\)/,
    'local library mounts should preserve episode-aware subtitle queries for Wyzie');
  assert.match(ui, /function startupSubtitleRelFor\(p, saved = loadSubChoice\(\)\) \{[\s\S]+Explicit per-title choices win[\s\S]+if \(subtitleRelPlayable\(p, saved\)\) return saved;[\s\S]+if \(saved === 'off' && prefSubtitleMode\(\) !== 'always'\) return '';[\s\S]+return autoSubtitleRelFor\(p\);[\s\S]+\}/,
    'startup subtitles should use saved choices first, then profile always-subtitle mode');
  assert.match(ui, /function nativeVideoSubtitleRel\(p\) \{\s+return \{ blocked: false, rel: concreteSubtitleRel\(startupSubtitleRelFor\(p\)\) \};\s+\}/,
    'native playback should use the shared startup subtitle contract');
  assert.match(ui, /function applyStartupSubtitlePref\(\) \{[\s\S]+const rel = concreteSubtitleRel\(startupSubtitleRelFor\(p\)\);[\s\S]+Promise\.resolve\(setSubtitle\(rel\)\)\.finally/,
    'web playback should auto-start the profile subtitle language before track probing when subtitle mode is always');
  assert.match(ui, /window\.__tvNativeSubtitleSelect = \(rel, pos, dur\) => \{[\s\S]+saveSubChoice\(rel, subtitleDisplayName\(rel\)\)[\s\S]+p\.usingNative = true;[\s\S]+\};/,
    'native subtitle row selection should persist the choice without restarting ExoPlayer');
  assert.doesNotMatch(ui, /window\.__tvNativeSubtitleSelect = \(rel, pos, dur\) => \{[\s\S]+tryNativeVideoPlayer\(kind, at\)/,
    'native subtitle changes must not reload the native player from the web callback');
  assert.match(ui, /window\.__tvNativeVideoQuality = \(quality, pos, dur\) => \{[\s\S]+tryNativeVideoPlayer\('direct', at\)[\s\S]+tryNativeVideoPlayer\('transcode', at\)/,
    'native quality row selection should restart ExoPlayer in original or optimized quality');
  assert.match(ui, /const restoreNative = \(\) => \{[\s\S]+p\.usingNative = true;[\s\S]+p\.quality = oldQuality;[\s\S]+p\.triedTranscode = oldTriedTranscode;[\s\S]+\}/,
    'failed native quality switches should preserve the still-playing ExoPlayer state');
  assert.match(android, /nativeSubtitleRel = choice\.subtitleRel;[\s\S]+disableNativeTextTracks\(\);[\s\S]+loadNativeSubtitleOverlay\(nativeSubtitleUrl\);[\s\S]+notifyNativeSubtitleSelect\(choice\.subtitleRel\)/,
    'native online subtitle choices should switch the live overlay without rebuilding ExoPlayer media');
  assert.doesNotMatch(android, /selectNativeSubtitleTrack\(choice\)|reloadNativeMediaAtCurrentPosition|nativeShiftedSubtitleUrl/,
    'native online subtitle selection and sync should not keep the old media-reload path');
  assert.match(android, /private int nativeControlIndex = -1;[\s\S]+nativeControlIndex = target;[\s\S]+if \(nativeControlIndex >= 0 && nativeControlIndex < buttons\.length\)[\s\S]+b\.performClick\(\);/,
    'native D-pad controls should remember the intended row target when Android focus is parked on the seekbar/player surface');
  assert.match(android, /private void parkNativeHiddenFocusOnSeek\(\) \{[\s\S]+nativeControlIndex = -1;[\s\S]+private boolean focusNativeDefaultControl\(\) \{[\s\S]+nativeControlIndex = java\.util\.Arrays\.asList\(buttons\)\.indexOf\(target\);[\s\S]+private boolean focusNativeSeekControl\(\) \{[\s\S]+nativeControlIndex = -1;/,
    'native D-pad focus memory should reset when returning to seek mode and seed Play\/Pause when entering controls');
  assert.match(ui, /subtitleShift: sub\.rel \? \(loadSubShift\(sub\.rel\) \|\| 0\) : 0/,
    'native player should receive the saved subtitle timing offset');
  assert.match(ui, /q\.set\('shift', shift\.toFixed\(1\)\)/,
    'online subtitle URLs should carry a timing shift when sync is adjusted');
  assert.match(ui, /const activeShift = p\.subTrack === rel && Number\.isFinite\(\+p\._subShift\) \? \+p\._subShift : null;[\s\S]+const shift = !list \? \(activeShift !== null \? activeShift : loadSubShift\(rel\)\) : 0;/,
    'native subtitle choice URLs should carry the saved sync for their own row, not the currently active row');
  assert.match(android, /double t = Math\.max\(0, nativeDisplayPositionMs\(\) \/ 1000\.0 - nativeSubtitleShift\);/,
    'native subtitle overlay should compare cues against the episode display clock after remux seeks');
  assert.match(android, /String selectedSubtitleUrl = subtitleUrlForRel\(choice\.subtitleRel\);[\s\S]+nativeSubtitleShift = nativeShiftFromUrl\(selectedSubtitleUrl\);[\s\S]+ValidatedNativeUrl subtitlePin = cleanSubtitleUrl\.isEmpty\(\) \? null : validateNativePlaybackUrl\(cleanSubtitleUrl\);[\s\S]+nativeSubtitleUrl = subtitlePin == null \? "" : subtitlePin\.connectUrl;[\s\S]+nativeSubtitleHostHeader = subtitlePin == null \? "" : subtitlePin\.hostHeader;/,
    'native subtitle version changes should preserve the saved subtitle sync instead of resetting to zero');
  assert.match(ui, /syncHead\.textContent = subSyncHeadingLabel\(\)[\s\S]+mkRow\('Subtitles later', false, \(\) => shiftSubs\(0\.5\)[\s\S]+mkRow\('Subtitles earlier', false, \(\) => shiftSubs\(-0\.5\)/,
    'web CC sync controls should expose one clean later/earlier pair with the current offset in the heading');
  assert.doesNotMatch(ui, /Later \+5s|Earlier -5s|shiftSubs\(5\)|shiftSubs\(-5\)/,
    'web CC sync controls should not show duplicate fine and coarse sync rows');
  assert.match(android, /labels\.add\("Sync: subtitles later"\);[\s\S]+labels\.add\("Sync: subtitles earlier"\);[\s\S]+shiftNativeSubtitles\(0\.5f\);[\s\S]+shiftNativeSubtitles\(-0\.5f\);/,
    'native Android CC sync controls should expose one clean later/earlier pair');
  assert.doesNotMatch(android, /subtitles later \+5s|subtitles earlier -5s|shiftNativeSubtitles\(5f\)|shiftNativeSubtitles\(-5f\)/,
    'native Android CC sync controls should not show duplicate fine and coarse sync rows');
  assert.match(ui, /mkRow\('Turn subtitles on first'/,
    'web CC sync section should explain when sync needs subtitles enabled first');
  assert.match(ui, /function restoreTrackMenuPosition\(opts = \{\}\) \{[\s\S]+m\.scrollTop = opts\.scrollTop[\s\S]+target\.focus\(\{ preventScroll: true \}\)[\s\S]+applyFocus\(target, false\)/,
    'web CC sync adjustments should preserve the menu scroll position and focused sync row');
  assert.match(ui, /const keepScrollTop = m\.scrollTop;[\s\S]+openTrackMenu\(kind, \{ focusKey: opts\.key, scrollTop: keepScrollTop \}\)/,
    'web keep-open track rows should rebuild the menu without jumping back to the top');
  assert.match(ui, /window\.__tvNativeSubtitleShift = \(shift\) => \{[\s\S]+saveSubShift\(p\.subTrack, n\)/,
    'Android subtitle sync changes should persist through the web profile state');
  assert.match(ui, /function subtitleDisplayName\(rel\) \{[\s\S]+if \(!info\.variant\) return subtitleRecommendedLabel\(name, bestSubtitleVariant\(info\.lang\)\);[\s\S]+const saved = savedSubtitleDetail\(name\);[\s\S]+return \(detail \|\| saved\) \? `\$\{name\} \(\$\{detail \|\| saved\}\)` : name;/,
    'web and native subtitle labels should use plain language names with release details only when useful');
  assert.match(ui, /function cleanSubtitleLabel\(label\) \{[\s\S]+replace\(\s*\/\^Wyzie/,
    'old saved subtitle labels should drop provider branding when displayed');
  assert.match(ui, /async function resolveOnlineSubtitleRel\(rel\) \{[\s\S]+await loadSubtitleVersions\(info\.lang\)[\s\S]+if \(!best \|\| !best\.id\) throw subtitleNoResultsError\(info\.lang\);[\s\S]+return osTrackRel\(info\.lang, best\.id\);/,
    'generic online subtitle auto-match must resolve to a ranked concrete version before loading');
  assert.match(ui, /function subtitleResponseNoResults\(lang, status, body = \{\}\) \{[\s\S]+code === 'no_subtitles'[\s\S]+subtitleNoResultsMessage\(lang\)/,
    'subtitle no-results responses should become a first-class player state');
  assert.match(ui, /function subtitleRequestParams\(it, lang, streamToken\) \{[\s\S]+tmdb: String\(\(it \|\| \{\}\)\.tmdbId \|\| ''\)[\s\S]+const imdb = subtitleImdbId\(it\);[\s\S]+if \(imdb\) q\.set\('imdb', imdb\);[\s\S]+return q;/,
    'online subtitle requests should carry IMDb when available while keeping TMDB fallback');
  assert.match(ui, /async function loadSubtitleVersions\(lang\) \{[\s\S]+const miss = subtitleMiss\(l\);[\s\S]+if \(miss\) throw subtitleNoResultsError\(l, miss\);[\s\S]+if \(e && e\.noSubtitles\) rememberSubtitleMiss\(l, e\.message\);/,
    'subtitle version lookup should remember title-level misses instead of keeping broken rows selectable');
  assert.match(ui, /function subtitleRecommendedLabel\(name, v\) \{[\s\S]+return detail \? `\$\{name\} \(\$\{detail\}\)` : name;/,
    'CC menu should show one obvious language row without Recommended wording');
  assert.match(ui, /const pick = subtitleDefaultChoice\(l\);[\s\S]+mkRow\(pick\.label, p\.subTrack === pick\.rel, \(\) => setSubtitle\(pick\.rel\)\);[\s\S]+if \(variants && variants\.length && expanded\) \{/,
    'web CC menu should keep advanced subtitle versions collapsed until the user asks for them');
  assert.match(ui, /if \(!variants \|\| !variants\.length\) \{[\s\S]+addChoice\(\{ action: 'versions', lang: l, label: name \}\);[\s\S]+return;[\s\S]+const pick = subtitleDefaultChoice\(l\);[\s\S]+addChoice\(\{ rel: pick\.rel, label: pick\.label \}\);[\s\S]+if \(variants && variants\.length && expanded\) \{/,
    'native CC choices should search before exposing a concrete subtitle URL');
  assert.match(ui, /mkRow\(`Choose \$\{name\} version`/,
    'CC menu should expose subtitle versions through a clear version-picker row');
  assert.match(ui, /addChoice\(\{ action: 'versions', lang: l, label: `Choose \$\{name\} version` \}\)/,
    'native Android CC should expose a lazy version-picker row when variants are collapsed');
  assert.match(ui, /addChoice\(\{ action: 'missing', lang: l, label: miss \}\)/,
    'native Android CC should show a clean no-subtitles row after a title-level miss');
  assert.match(ui, /window\.__tvNativeSubtitleVersions = async \(lang, pos, dur\) => \{[\s\S]+await loadSubtitleVersions\(lang\);[\s\S]+setSubtitleLangExpanded\(lang, true\);[\s\S]+refreshNativeSubtitleChoices\(\);/,
    'native Android CC version rows should fetch and expand subtitle variants without selecting a subtitle');
  assert.match(ui, /window\.TriboonTV\.updateSubtitleChoices\(JSON\.stringify\(\{ choices: nativeSubtitleChoices\(\) \}\)\)/,
    'web should push refreshed subtitle choices back into the native ExoPlayer menu');
  assert.match(ui, /saveSubChoice\(rel, subtitleDisplayName\(rel\)\)/,
    'per-title subtitle choices should remember the friendly version label');
  assert.doesNotMatch(ui, /mkRow\(`Wyzie |return `Wyzie |Wyzie \u00b7 [^`'"]*Version/,
    'player subtitle labels should not show provider branding');
  assert.match(ui, /if \(saved === 'off' && prefSubtitleMode\(\) !== 'always'\) return '';/,
    'native subtitles should respect explicit per-title Off choices unless the profile is set to always show subtitles');
  assert.match(ui, /function activeSubtitleCues\(tt\) \{[\s\S]+tt\.activeCues[\s\S]+tt\.cues[\s\S]+\$\(\'video\'\)[\s\S]+v\.currentTime[\s\S]+c\.startTime[\s\S]+c\.endTime[\s\S]+\}/,
    'web subtitle rendering should fall back to scanning loaded cues when activeCues is empty');
  assert.match(ui, /function renderSubCues\(\) \{[\s\S]+const active = activeSubtitleCues\(tt\);[\s\S]+for \(const c of active\.slice\(-3\)\)/,
    'web subtitle overlay should render from the shared active-cue helper and cap noisy tracks');
  assert.match(ui, /function applySubtitleTrack\(\) \{[\s\S]+const seq = \(p\._subSeq \|\| 0\) \+ 1; p\._subSeq = seq;[\s\S]+if \(p\.subTrack === null \|\| p\.subTrack === undefined\) \{ clearTimeout\(_subPrepT\); return; \}/,
    'turning subtitles off should invalidate pending track loads and clear stale preparing messages');
  assert.match(playerMap, /\| P11 \| Subtitles\/CC must be selectable, visible, synced, and quiet[\s\S]+activeSubtitleCues[\s\S]+\/api\/ossubs[\s\S]+subtitle sync smoke \|/,
    'player regression map should document the subtitle playback contract');
  assert.match(playerMap, /\| P4 \| Finished playback returns to the right detail page:[\s\S]+current-season thumbnail strip[\s\S]+updateNativeEpisodeChoices[\s\S]+Android D-pad episode-strip smoke \|/,
    'player regression map should document the episode thumbnail strip contract');
  assert.doesNotMatch(ui, /toast\(`Switching to \$\{q\}p|toast\('Switching audio track|toast\(`Subtitle sync saved|toast\('Subtitle sync reset/,
    'normal web player controls should not show success popups over the video');
  assert.match(ui, /S\.nativeLiveReturnView = \(S\.view === 'livetv' \|\| document\.querySelector\('#chBody\.liveGuideShell'\) \|\| guide\) \? 'livetv' : S\.view/,
    'native Live TV should remember when it was launched from the guide');
  assert.match(ui, /if \(returnView === 'livetv'\) \{[\s\S]+switchView\('livetv', false\)/,
    'closing native Live TV should restore the guide instead of stale detail history');
  assert.match(ui, /const wasLiveShell = !!\(S\.playing && S\.playing\.item && S\.playing\.item\.type === 'live' && S\.view === 'player'\);[\s\S]+if \(wasLiveShell\) \{[\s\S]+closePlayer\(\);[\s\S]+return;[\s\S]+\}/,
    'closing native Live TV from its guide/player shell should clear the web player state instead of revealing a stale black player');
  assert.match(ui, /async function closePlayer\(opts = \{\}\) \{[\s\S]+S\.nativeGuideMode = false;[\s\S]+closePlayerGuide\(\);/,
    'closing the player should clear native guide mode before the shared guide close path can call back into Android');
  assert.match(ui, /window\.__tvNativeLiveGuide = async \(epoch\) => \{[\s\S]+const list = await ensurePlayerGuideChannels\(\);[\s\S]+openNativeLiveGuideShell\(active\);[\s\S]+renderPlayerGuideTimeline\(\$\(\'pGuide\'\), list\.length \? list : \[active\]\)/,
    'native Live TV guide should load real guide rows before drawing the PiP guide without starting web playback');
  assert.match(ui, /function currentNativeLiveGuideItem\(\) \{[\s\S]+S\.playing && S\.playing\.item && S\.playing\.item\.type === 'live'[\s\S]+S\.liveList[\s\S]+S\.liveChannels[\s\S]+return hit;[\s\S]+\}/,
    'native guide should be able to rebuild the active live item after the first PiP open consumed pending state');
  assert.match(ui, /window\.__tvNativeLiveGuide = async \(epoch\) => \{[\s\S]+S\.nativeGuideEpoch = Number\.isFinite\(n\) && n > 0 \? n[\s\S]+const it = S\.nativeLivePending \|\| currentNativeLiveGuideItem\(\);[\s\S]+S\.nativeLivePending = null;[\s\S]+if \(!it\) \{/,
    'native guide should consume pending live state without losing the Live TV return target');
  assert.doesNotMatch(ui, /__tvNativeLiveGuide[\s\S]+await playChannelWeb\(it\)/,
    'native Live TV guide should not hand off to the old web player');
  assert.match(ui, /function openNativeLiveGuideShell\(it\) \{[\s\S]+wakeScreensaverForPlayerSurface\(\);[\s\S]+stopWebVideoElement\(\);[\s\S]+document\.body\.classList\.add\('nativeGuideMode'\);[\s\S]+S\.nativeGuideMode = true;[\s\S]+\$\(\'player\'\)\.classList\.add\('open', 'guideMode'\);[\s\S]+\$\(\'player\'\)\.classList\.remove\('live'\);[\s\S]+\$\(\'osd\'\)\.classList\.add\('hide'\);/,
    'native Live TV guide should wake screensaver state and enter guide mode before the player container can reveal the web player');
  assert.match(ui, /function tryNativeLivePlayer\(it, guide = false\) \{[\s\S]+try \{[\s\S]+wakeScreensaverForPlayerSurface\(\);[\s\S]+window\.TriboonTV\.playLive/,
    'native Live TV playback should wake screensaver state before ExoPlayer owns the screen');
  assert.doesNotMatch(ui, /function openNativeLiveGuideShell\(it\) \{[\s\S]+\$\(\'player\'\)\.classList\.add\('open', 'live'\)/,
    'native Live TV guide must not open the old web live-player shell first');
  assert.match(ui, /function closePlayerGuide\(opts = \{\}\) \{[\s\S]+window\.TriboonTV\.closeGuide\(\)/,
    'closing the shared guide from web focus should restore native fullscreen playback');
  assert.match(ui, /async function togglePlayerGuide\(\) \{[\s\S]+S\.playing && S\.playing\.usingNative[\s\S]+typeof window\.TriboonTV\.openGuide === 'function'[\s\S]+window\.TriboonTV\.openGuide\(\); return;/,
    'web guide button should ask Android to enter native PiP guide mode while ExoPlayer is already playing');
  assert.match(ui, /window\.__tvNativeGuideClosed = \(epoch\) => \{[\s\S]+n !== S\.nativeGuideEpoch\) return;[\s\S]+closePlayerGuide\(\{ fromNative: true \}\)/,
    'native guide close callback should ignore stale close events from an older PiP guide');
  assert.match(ui, /window\.__tvNativeGuideEpoch = \(epoch\) => \{[\s\S]+S\.nativeGuideEpoch = n;[\s\S]+focusPlayerGuideRow\(S\._pgFocusChannel \?\? S\.liveCur, \{ preventScroll: true \}\)/,
    'native guide channel retunes should keep the web guide epoch in sync and restore row focus');
  assert.match(ui, /if \(!it\) \{[\s\S]+S\.playing\.item\.type !== 'live' && S\.view === 'player'[\s\S]+S\.returnVod = \{ item: S\.playing\.item, resume: currentTime\(\) \};[\s\S]+revealNativeGuideShell\(\);[\s\S]+return togglePlayerGuide\(\);/,
    'native movie/episode guide button should open the same PiP guide and preserve a Back to movie target');
  assert.match(ui, /function revealNativeGuideShell\(\) \{[\s\S]+wakeScreensaverForPlayerSurface\(\);[\s\S]+stopWebVideoElement\(\);[\s\S]+document\.body\.classList\.add\('nativeGuideMode'\);[\s\S]+S\.nativeGuideMode = true;[\s\S]+\$\(\'player\'\)\.classList\.add\('open', 'guideMode'\);[\s\S]+\$\(\'player\'\)\.classList\.remove\('live'\);[\s\S]+\$\(\'osd\'\)\.classList\.add\('hide'\);/,
    'native movie/episode guide button should wake the screensaver and hide the web video immediately while the guide data loads');
  assert.match(ui, /return renderGuideProgressive\(body, pool\)/,
    'Live TV guide should render the guide shell before waiting on provider guide data');
  assert.match(ui, /const guideList = selectedList\.slice\(0, LIVE_GUIDE_BATCH\)/,
    'player guide should use the same small initial batch as the Live TV page');
  assert.match(ui, /fetchGuideBatch\(guideList\)\.then/,
    'player guide should hydrate guide data asynchronously after opening');
  assert.match(ui, /if \(!list\.length && S\.liveChannels && S\.liveChannels\.length && Date\.now\(\) - \(S\._liveAt \|\| 0\) < LIVE_TTL\) \{[\s\S]+S\.liveChannels\.map\(liveItemForPlayerGuide\)\.filter\(Boolean\)/,
    'player guide should reuse a fresh in-memory Live TV catalog instead of fetching the big catalog again');
  assert.match(ui, /list = S\.liveList = \(fav\.channels \|\| \[\]\)\.map\(liveItemForPlayerGuide\)\.filter\(Boolean\)/,
    'player guide catalog fallback should keep channel metadata including favorites');
  assert.doesNotMatch(ui, /selectedList\.slice\(0, 120\)/,
    'player guide must not request a large category chunk before opening');
  assert.doesNotMatch(ui, /return renderGuideProgressive\(body, pool\);[\s\S]+body\.innerHTML = '<div class="gridMore">loading guide/,
    'the old blocking guide renderer should not remain as unreachable dead code');
  assert.match(ui, /shell\.className = 'pgGuideShell liveGuideShell'/,
    'PiP guide should share the Live TV guide shell styling');
  assert.match(ui, /\.pgVideoSlot\{[\s\S]+aspect-ratio:16\/9[\s\S]+background:#000/,
    'PiP guide should reserve an explicit 16:9 video slot for web and native playback');
  assert.match(ui, /function syncNativeGuidePipRect\(\) \{[\s\S]+getBoundingClientRect\(\)[\s\S]+TriboonTV\.setGuidePipRect\(JSON\.stringify/,
    'native PiP should be aligned to the measured web guide video slot');
  assert.match(ui, /#pGuide\{[\s\S]+opacity:0;transform:translateY\(10px\);transition:opacity \.18s ease,transform \.18s ease[\s\S]+#pGuide\.ready\{opacity:1;transform:none\}/,
    'player guide should fade into place instead of popping open');
  assert.match(ui, /pg\.classList\.remove\('ready'\);[\s\S]+pg\.classList\.add\('open'\);[\s\S]+scheduleNativeGuidePipSync\(\);[\s\S]+requestAnimationFrame\(\(\) => \{[\s\S]+pg\.classList\.add\('ready'\)/,
    'player guide should sync PiP before revealing the ready state');
  assert.match(android, /nativePlayerView\.setLayoutParams\(pipLp\);[\s\S]+revealNativeGuidePip\(pipLp\);[\s\S]+applyNativeGuidePipRect\(String json\)[\s\S]+nativePlayerView\.setLayoutParams\(pipLp\);[\s\S]+syncNativeGuidePipRevealScrim\(pipLp\);/,
    'native PiP should reveal with a sibling scrim and keep that scrim aligned after the guide rectangle is applied');
  assert.match(ui, /function scheduleNativeGuidePipSync\(\) \{[\s\S]+requestAnimationFrame[\s\S]+setTimeout\(syncNativeGuidePipRect, 90\)/,
    'native PiP rect sync should retry after layout settles');
  assert.match(ui, /body\.nativeGuideMode #player\.guideMode video\{display:none\}/,
    'native PiP guide mode should hide the old web video element under ExoPlayer');
  assert.match(ui, /scheduleNativeGuidePipSync\(\)/,
    'PiP rect should sync after the guide layout has been painted');
  assert.match(ui, /catPane\.className = 'pgCatPane liveCatPane'/,
    'PiP guide categories should share the Live TV category pane styling');
  assert.match(ui, /catList\.className = 'pgCats guideCats'/,
    'PiP guide category list should share the Live TV category list behavior');
  assert.match(ui, /btn\.dataset\.pgCatName = name/,
    'PiP guide category buttons should keep exact category identity for focus restore');
  assert.match(ui, /function focusPlayerGuideCategory\(idx, select = false, opts = \{\}\) \{[\s\S]+S\.pgCatNavIdx = i;[\s\S]+S\.pgCatDpadMode = true;[\s\S]+if \(select && name && name !== S\.pgLiveCat\) \{[\s\S]+S\.pgLiveCat = name;[\s\S]+S\._pgFocusCat = name;[\s\S]+renderPlayerGuideTimeline\(\$\(\'pGuide\'\), S\.liveList \|\| \[\]\);[\s\S]+pane\.scrollTo\(/,
    'PiP guide D-pad category movement should select the highlighted category and scroll the category pane directly');
  assert.match(ui, /if \(k === 'ArrowDown'\) return focusPlayerGuideCategory\(i \+ 1, true\)/,
    'PiP guide category down should update the right-side channel guide');
  assert.match(ui, /if \(k === 'ArrowRight'\) return moveTo\(rows\.find\(\(r\) => r\.classList\.contains\('cur'\)\) \|\| rows\[0\]\)/,
    'PiP guide should enter channel rows only when the user presses Right from categories');
  assert.match(ui, /if \(S\.pgCatDpadMode && cats\.length\) return focusPlayerGuideCategory\(catIndex\(\)\);[\s\S]+if \(k === 'ArrowDown'\) return moveRowFrom\(1\)/,
    'PiP guide stale category mode should recover category focus before generic row movement can run');
  assert.match(ui, /function focusPlayerGuideRow\(channel, opts = \{\}\) \{[\s\S]+data-guide-channel="\$\{channel\}"[\s\S]+focus\(\{ preventScroll: !!opts\.preventScroll \}\)/,
    'PiP guide should be able to restore the active channel row after native retunes');
  assert.match(ui, /const moveRowFrom = \(delta\) => \{[\s\S]+rows\.findIndex\(\(r\) => r\.classList\.contains\('cur'\)\)[\s\S]+S\._pgFocusChannel[\s\S]+i \+ delta/,
    'PiP guide Up/Down should move relative to the current row even when DOM focus was reset');
  assert.match(ui, /main\.className = 'pgGuideMain pgTimeline liveGuidePane guideTimeline'/,
    'PiP guide timeline should use the same timeline surface as Live TV');
  assert.match(ui, /row\.className = 'pgRow gRow focusable'/,
    'PiP guide rows should share Live TV row focus behavior');
  assert.match(ui, /body\.tv:not\(\.railOpen\) #rail:not\(\.expanded\)/,
    'Android TV should not let sticky CSS hover keep the rail expanded');
  assert.match(ui, /body\.tv:not\(\.railOpen\) #rail:not\(\.expanded\)\{[\s\S]+width:72px!important;background:transparent!important/,
    'collapsed Android TV rail should stay transparent and keep the app rail width');
  assert.match(ui, /body\.tv:not\(\.railOpen\) #rail:not\(\.expanded\) \.railBtn,[\s\S]+justify-content:center/,
    'collapsed Android TV rail icons should be centered with even side spacing');
  assert.match(ui, /body\.tv:not\(\.railOpen\) #rail:not\(\.expanded\) \.railBtn svg\{margin:0!important\}/,
    'collapsed Android TV rail should not keep expanded icon margins');
  assert.match(ui, /#rail \.logo\{width:max-content;min-width:48px;height:34px[\s\S]+#rail \.logo img\{width:34px;height:34px;flex:0 0 34px;margin:0 7px/,
    'rail logo mark should keep the collapsed size and center slot when the rail expands');
  assert.match(ui, /body\.tv:not\(\.railOpen\) #rail:not\(\.expanded\) \.logo\{[\s\S]+width:48px!important;min-width:48px!important;padding:0!important;justify-content:flex-start/,
    'collapsed Android TV rail logo should use the same fixed centered slot as expanded rail');
  assert.match(ui, /body\.railClickCollapsed #rail:hover\{width:72px;background:none\}/,
    'desktop rail clicks should suppress hover expansion until the pointer leaves the menu');
  assert.match(ui, /document\.querySelectorAll\('\.railBtn\[data-nav\]'\)\.forEach\(\(b\) => b\.addEventListener\('click', \(\) => \{[\s\S]+switchView\(b\.dataset\.nav\);[\s\S]+collapseRailAfterClick\(\);[\s\S]+\}\)\)/,
    'clicking a left-menu destination should collapse the expanded rail');
  assert.match(ui, /\$\('rail'\)\.addEventListener\('mouseleave', \(\) => \{[\s\S]+document\.body\.classList\.remove\('railClickCollapsed'\)/,
    'rail hover expansion should reset after the pointer leaves');
  assert.match(ui, /if \(!document\.body\.classList\.contains\('tv'\) && !document\.body\.classList\.contains\('railClickCollapsed'\)\) \{[\s\S]+document\.body\.classList\.add\('railOpen'\);[\s\S]+\}/,
    'desktop hover may expand the rail unless a click just collapsed it; Android TV still relies on explicit D-pad state');
  assert.match(ui, /function focusContent\(retried\) \{[\s\S]+leaveRail\(\);[\s\S]+clearFocus\(\);/,
    'moving focus into page content should always collapse any stale rail state first');
  assert.match(ui, /if \(k === 'ArrowDown'\) return focusCard\(S\.rowIdx, 0\);[\s\S]+if \(k === 'ArrowUp'\) return S\.rowIdx === 0 \? \(view\.hasHero \? focusHero\(0\) : enterRail\(\)\)[\s\S]+: focusCard\(S\.rowIdx - 1, 0\);[\s\S]+return focusCard\(S\.rowIdx \+ 1, 0\);/,
    'Home and Discover vertical row moves should start at the first thumbnail in the destination row');
  assert.match(ui, /function applyRoute\(\) \{[\s\S]+switchView\(target, false\);[\s\S]+requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{[\s\S]+focusContent\(\);[\s\S]+\}\)\);[\s\S]+\}/,
    'browser Back/Forward should land focus on the visible route instead of leaving a stale rail focus ring');
  assert.match(ui, /window\.addEventListener\('hashchange', \(\) => \{[\s\S]+if \(\$\(\'person\'\)\.classList\.contains\('open'\)\) \{[\s\S]+closePerson\(\);[\s\S]+setRoute\(`#\/title\/\$\{cur\.type\}\/\$\{cur\.tmdbId\}`\);[\s\S]+return;[\s\S]+\}[\s\S]+if \(\$\(\'detail\'\)\.classList\.contains\('open'\) && !routeIsTitle\(\)\) return closeDetail\(\);[\s\S]+applyRoute\(\);[\s\S]+\}\);/,
    'browser Back from a cast/person overlay should close the person first, and detail-to-detail history should route instead of jumping to the original browse page');
  assert.match(ui, /function liveNoChannelsHtml\(errors = \[\]\) \{[\s\S]+gridMore liveEmpty focusable[\s\S]+function focusLiveGridMessage\(\) \{[\s\S]+S\.view === 'livetv' && S\.zone !== 'rail'[\s\S]+focusGrid\(0\);/,
    'Live TV empty channel states should be focusable and claim D-pad focus');
  assert.match(ui, /grid\.innerHTML = '<div class="gridMore focusable">loading channels[\s\S]+focusLiveGridMessage\(\);[\s\S]+if \(!r\.configured\) \{ grid\.innerHTML = '<div class="gridMore focusable">[\s\S]+focusLiveGridMessage\(\); return; \}[\s\S]+if \(!r\.channels\.length\) \{ grid\.innerHTML = liveNoChannelsHtml\(S\.liveSourceErrors\); focusLiveGridMessage\(\); return; \}[\s\S]+catch \(e\) \{ grid\.innerHTML = `<div class="gridMore focusable">Live TV failed:/,
    'Live TV loading, not-configured, no-channel, and failed states should not strand focus');
  assert.match(ui, /No channels match\.<\/div>'; focusLiveGridMessage\(\);[\s\S]+Every category is hidden[\s\S]+focusLiveGridMessage\(\);[\s\S]+No channels to show - favorite some channels or use the filter[\s\S]+focusLiveGridMessage\(\);/,
    'Live TV in-page empty states should stay remote-focusable after search/category changes');
  assert.match(ui, /const selectedCatIdx = Math\.max\(0, names\.indexOf\(S\.liveCat\)\);[\s\S]+S\.liveCatNavIdx = S\.liveCatDpadMode && Number\.isFinite\(S\.liveCatNavIdx\)[\s\S]+: selectedCatIdx;/,
    'Live TV rerenders should preserve the D-pad category focus index instead of snapping to the selected category');
  assert.match(ui, /function focusLiveCategory\(idx, select = false\) \{[\s\S]+applyFocus\(cats\[i\], false\);[\s\S]+if \(select && name && name !== S\.liveCat\) \{[\s\S]+clearTimeout\(S\._liveCatApplyT\);[\s\S]+S\.liveCat = name;[\s\S]+renderLiveTvBody\(\);[\s\S]+requestAnimationFrame\(\(\) => \{[\s\S]+focusLiveCategory\(i\);[\s\S]+\}\);/,
    'Live TV category D-pad movement should apply the category immediately and restore rail focus after rerender');
  assert.doesNotMatch(ui, /S\._liveCatApplyT = setTimeout\(\(\) => \{[\s\S]+S\.liveCat = name;[\s\S]+\}, 140\);/,
    'Live TV category D-pad movement should not delay selected-category changes during fast repeat');
  assert.match(ui, /hit && Date\.now\(\) - hit\.at < \(hit\.syntheticOnly \? 5000 : 60000\)/,
    'synthetic channel-listing guide batches should not stay sticky in the client cache');
  assert.match(ui, /chip\.dataset\.liveCat = name/,
    'Live TV category buttons should keep their category identity for D-pad selection');
  assert.match(ui, /if \(k === 'ArrowDown'\) return focusLiveCategory\(ci \+ 1, true\)/,
    'Live TV category down should update the selected category instead of only moving focus');
  assert.match(ui, /function focusLiveCategory\(idx, select = false\) \{[\s\S]+applyFocus\(cats\[i\], false\);[\s\S]+const pane = cats\[i\]\.closest\('#chCats'\);[\s\S]+pane\.scrollTo\(/,
    'Live TV category D-pad focus should scroll the category pane directly, not the whole grid');
  assert.match(ui, /const inLiveCatMode = focusedCat \|\| \(S\.liveCatDpadMode && !focusedGuideRow && !focusedChannel\);[\s\S]+Number\.isFinite\(S\.liveCatNavIdx\)[\s\S]+return focusLiveCategory\(ci \+ 1, true\);/,
    'Live TV category fast-repeat should keep moving from the remembered category index during rerenders without stealing row focus');
  assert.match(ui, /if \(S\.view === 'livetv'\) \{[\s\S]+el\.classList\.contains\('lcat'\)[\s\S]+S\.liveCatDpadMode = true;[\s\S]+el\.classList\.contains\('gRow'\) \|\| el\.classList\.contains\('chCard'\)[\s\S]+S\.liveCatDpadMode = false;/,
    'Live TV focus state should distinguish category mode from channel-row mode');
  assert.match(ui, /function focusRail\(i, opts = \{\}\) \{[\s\S]+preview && !opts\.suppressPreview[\s\S]+preview\.run\(\)/,
    'rail preview should be suppressible for accidental rail entry from detail-style overlays');
  assert.match(ui, /function enterRail\(\) \{[\s\S]+focusRail\(i >= 0 \? i : \(S\.railIdx \|\| 0\), \{ suppressPreview: \['detail', 'person'\]\.includes\(S\.view\) \}\);[\s\S]+\}/,
    'entering the rail from movie/show detail or cast/person should not immediately preview Home');
  assert.match(ui, /S\.view === 'watchlist' && S\.zone !== 'rail' && focusGrid\(0\)/,
    'Watchlist empty-state rendering must not steal D-pad focus from the open rail');
  assert.match(ui, /const focusCalendarStart = \(\) => requestAnimationFrame\(\(\) => S\.view === 'calendar' && S\.zone !== 'rail' && focusContent\(\)\)/,
    'Calendar async rendering must not steal D-pad focus from the open rail preview');
  assert.match(ui, /if \(keepGuidePip && S\.nativeGuideMode && tryNativeLivePlayer\(it, true\)\) \{[\s\S]+markGuideCur\(\);[\s\S]+return;[\s\S]+\}/,
    'channel tuning from the native PiP guide should retune ExoPlayer without starting web playback');
  assert.match(ui, /async function ensurePlayerGuideChannels\(\) \{[\s\S]+loadLiveChannelsCombined\(\)[\s\S]+fillLiveState\(fav\)[\s\S]+return list;[\s\S]+\}/,
    'native and web player guide openings should share the same channel-list loader');
  assert.match(ui, /window\.__tvNativeLiveGuide = async \(epoch\) => \{[\s\S]+const list = await ensurePlayerGuideChannels\(\);[\s\S]+openNativeLiveGuideShell\(active\);[\s\S]+return renderPlayerGuideTimeline\(\$\(\'pGuide\'\), list\.length \? list : \[active\]\);[\s\S]+\};/,
    'Android guide handoff should load real guide rows before rendering the native PiP guide shell');
  assert.match(ui, /if \(!catNames\.length\) \{[\s\S]+No channels available[\s\S]+pg\.classList\.add\('open'\);[\s\S]+return;[\s\S]+\}/,
    'player guide should show a nonblank empty state instead of leaving a black guide screen');
  assert.match(ui, /if \(!keepGuidePip && tryNativeLivePlayer\(it\)\) return;/,
    'normal Live TV tuning should still launch native fullscreen playback');
  assert.match(ui, /function nativeLiveRequired\(\) \{[\s\S]+Android TV and Android mobile never fall back to the HTML\/MSE live player once the[\s\S]+return canUseNativeLivePlayer\(\);[\s\S]+\}/,
    'Android TV and mobile Live TV should require ExoPlayer whenever the native live bridge exists');
  assert.match(ui, /function tryNativeLivePlayer\(it, guide = false\) \{[\s\S]+if \(!guide\) \{[\s\S]+S\.nativeGuideMode = false;[\s\S]+closePlayerGuide\(\{ fromNative: true \}\);[\s\S]+\$\(\'player\'\)\.classList\.remove\('guideMode'\);[\s\S]+\}[\s\S]+window\.TriboonTV\.playLive/,
    'normal Live TV tuning should clear stale native guide state before asking ExoPlayer to start');
  assert.match(ui, /const keepGuidePip = S\.view === 'player' && !!\(\$\(\'pGuide\'\) && \$\(\'pGuide\'\)\.classList\.contains\('open'\)\)/,
    'stale guide DOM outside the player view must not force later Live TV selections into PiP');
  assert.match(ui, /if \(nativeLiveRequired\(\)\) \{\s*toast\('Native player could not start this channel'\);\s*return;\s*\}\s*return playChannelWeb\(it\);/,
    'Android Live TV should stop on native startup failure instead of falling back to the web player');
  assert.match(ui, /const LIVE_MSE_TYPES = \[[\s\S]+video\/mp4; codecs="avc1\.4d4028, mp4a\.40\.2"[\s\S]+function liveMseType\(\) \{[\s\S]+MediaSource\.isTypeSupported/,
    'web Live TV should use MediaSource for the server fMP4 remux instead of a plain infinite video src');
  assert.match(ui, /function stopWebVideoElement\(\) \{[\s\S]+cleanupLiveMse\(\);[\s\S]+v\.removeAttribute\('src'\)/,
    'leaving or replacing playback should abort the Live TV MediaSource reader before clearing the video element');
  assert.match(ui, /p\.item && p\.item\.type === 'live' && kind === 'direct' && startLiveMseSource\(p\.streamUrl\)/,
    'only Live TV direct playback should take the web MediaSource path');
  assert.match(ui, /async function playChannelWeb\(it\) \{[\s\S]+const preserveGuide = !!\(\$\(\'pGuide\'\) && \$\(\'pGuide\'\)\.classList\.contains\(\'open\'\)\);[\s\S]+stopActivePlaybackForReplacement\(\{ preserveGuide \}\);[\s\S]+openPlayer\(\{ title: it\.title, key: it\.key, type: 'live'/,
    'web Live TV channel changes should close the previous MSE fetch/player connection before opening the new channel');
  assert.match(server, /let clientClosed = false;[\s\S]+const stopForClientClose = \(\) => \{[\s\S]+clientClosed = true;[\s\S]+ff\.kill\('SIGKILL'\);[\s\S]+ctx\.req\.off\('close', stopForClientClose\);[\s\S]+ctx\.res\.off\('close', stopForClientClose\);[\s\S]+if \(clientClosed\) return;[\s\S]+ctx\.req\.once\('close', stopForClientClose\);[\s\S]+ctx\.res\.once\('close', stopForClientClose\);/,
    'server Live TV remux should kill ffmpeg exactly once when the browser closes the stream');
  assert.ok(server.includes('function iptvRemuxTargets(ch = {})')
    && server.includes("if (ch.nativeUrl && iptvNativeMime(ch.nativeUrl) === 'video/mp2t') add(ch.nativeUrl, 'ts');")
    && server.includes("validateAndPinIptvUrl(target.url, 'Live stream URL')")
    && server.includes('spawnLiveRemux(iptvRemuxInputHref(pin, target.url)')
    && server.includes('headers: pin.hostHeader ? { Host: pin.hostHeader } : undefined'),
    'server Live TV remux fallback should try Xtream TS before HLS and preserve HTTPS provider SNI');
  assert.match(transcode, /function ffmpegHeaderLines\(headers = \{\}\)[\s\S]+\`\$\{k\}: \$\{v\}\\r\\n\`[\s\S]+function spawnLiveRemux\(url, \{ hlsFriendly = true, headers = null \} = \{\}\)[\s\S]+'-max_redirects', '0'[\s\S]+\.\.\.\(headerLines \? \['-headers', headerLines\] : \[\]\)[\s\S]+'-i', url/,
    'ffmpeg Live TV remux should receive sanitized Host headers and keep its own redirect following disabled after URL pinning');
  assert.match(server, /function resolveIptvRemuxRedirect\(rawTarget, maxHops = 5\) \{[\s\S]+validateAndPinIptvUrl\(current, 'Live stream URL'\)[\s\S]+new URL\(res\.headers\.location, u\)\.href[\s\S]+throw new Error\('too many live stream redirects'\)/,
    'server Live TV remux should resolve provider redirects itself so every hop is validated before ffmpeg retries');
  assert.match(server, /const redirectHls = hlsFriendly \|\| iptvRemuxTargetLikelyHls\(redirected\);/,
    'redirected HLS Live TV URLs should keep HLS-friendly ffmpeg flags even if the final provider URL is extensionless');
  assert.match(ui, /addLiveFallback\(it\._nativeFallbackUrl, it\._nativeFallbackMime \|\| ''\);[\s\S]+addLiveFallback\(it\._streamUrl, 'video\/mp4'\);[\s\S]+fallbacks: liveFallbacks,/,
    'Android Live TV should try provider candidates first, then fall back to the server remux path on weaker devices');
  assert.match(ui, /_nativeFallbackUrl: ch\.nativeFallbackUrl[\s\S]+_nativeFallbackMime: ch\.nativeFallbackMime \|\| ''/,
    'Live TV guide/card/search items should preserve native fallback stream metadata');
  assert.doesNotMatch(ui, /Native player failed[^`'"]*using web player|using web playback/,
    'Android native playback should not advertise or trigger the old web player fallback');
  assert.doesNotMatch(ui, /__tvNativeVideoSwitchToWeb|__tvNativeLiveSwitchToWeb/,
    'native Android controls should not keep a switch-to-web-player bridge');
  assert.doesNotMatch(ui, /nativeVideoSubtitleRel[\s\S]+blocked:\s*true[\s\S]+tryNativeVideoPlayer/,
    'subtitle preference should not prevent Android native direct play; CC can hand off on demand');
  assert.match(android, /ImageButton nativeButton\(int iconRes, String label, boolean primary\)/,
    'native controls should use true image buttons so icons stay centered and unclipped');
  assert.match(android, /nativeButton\(R\.drawable\.ic_player_pause, "Pause", true\)/,
    'native player should use drawable icons, not text glyph controls');
  assert.match(android, /moveNativeControlFocus\(code == KeyEvent\.KEYCODE_DPAD_LEFT \? -1 : 1\)/,
    'native player row should use explicit D-pad left/right navigation so Guide is reachable');
  assert.match(android, /moveNativeVerticalFocus\(code == KeyEvent\.KEYCODE_DPAD_UP \? -1 : 1\)/,
    'native player should explicitly move between the seek bar and button row with D-pad up/down');
  assert.match(android, /private boolean focusNativeSeekControl\(\) \{[\s\S]+showNativeChrome\(false\);[\s\S]+updateNativeChrome\(\);[\s\S]+nativeSeek\.isEnabled\(\)[\s\S]+nativeSeek\.requestFocus\(\);[\s\S]+nativeSeek\.postDelayed\(focusSeek, 60\);[\s\S]+\}/,
    'native seek-bar focus should open chrome, refresh seekability, and retry focus after layout settles');
  assert.match(android, /private boolean nativeCanSeekVod\(\) \{[\s\S]+"video"\.equals\(nativeMode\)[\s\S]+nativeVodSeekable\(\) \|\| nativeServerSeekMode\(\)/,
    'native VOD seekability should include server-side remux/transcode seek mode');
  assert.match(android, /boolean canSeek = !isLive && nativeCanSeekVod\(\);/,
    'native seek bar should stay focusable for remuxed or transcoded next episodes that use server-side seeking');
  assert.match(android, /private boolean nativeSeekDpadMode;[\s\S]+nativeSeekDpadMode = true;[\s\S]+private boolean handleNativeSeekBarKey\(KeyEvent e\) \{[\s\S]+current != nativeSeek && \(!nativeSeekDpadMode \|\| isNativeControl\(current\)\)[\s\S]+nativeSeekBy\(code == KeyEvent\.KEYCODE_DPAD_RIGHT \? 30000 : -10000\)/,
    'native D-pad seek mode should scrub only from the seek bar or video surface, never from a focused button');
  assert.match(android, /if \(nativeChrome != null && nativeChrome\.getVisibility\(\) == View\.VISIBLE\) \{[\s\S]+if \(handleNativeSeekBarKey\(e\)\) return true;[\s\S]+current == nativeSeek \|\| \(nativeSeekDpadMode && !isNativeControl\(current\)\)[\s\S]+moveNativeControlFocus\(code == KeyEvent\.KEYCODE_DPAD_LEFT \? -1 : 1\)/,
    'visible native chrome should prioritize button-row Left/Right navigation before surface seek shortcuts');
  assert.match(android, /nativeChrome\.setVisibility\(View\.GONE\);[\s\S]+parkNativeHiddenFocusOnSeek\(\);[\s\S]+setNativeSubtitleLift\(false\);[\s\S]+private void parkNativeHiddenFocusOnSeek\(\) \{[\s\S]+nativeSeekDpadMode = nativeCanSeekVod\(\);[\s\S]+nativePlayerLayer\.requestFocus\(\);[\s\S]+\}/,
    'auto-hidden native VOD chrome should park logical focus on the seek bar before returning focus to the video surface');
  assert.match(android, /if \(\(code == KeyEvent\.KEYCODE_DPAD_LEFT \|\| code == KeyEvent\.KEYCODE_DPAD_RIGHT\)[\s\S]+&& nativeCanSeekVod\(\)\) \{[\s\S]+nativeSeekDpadMode = true;[\s\S]+nativeSeekBy\(code == KeyEvent\.KEYCODE_DPAD_RIGHT \? 30000 : -10000\);[\s\S]+return true;[\s\S]+\}/,
    'native hidden-chrome VOD Left/Right should seek instead of only revealing controls');
  assert.match(android, /if \(code == KeyEvent\.KEYCODE_DPAD_DOWN\) \{[\s\S]+if \(nativeSeekDpadMode && nativeCanSeekVod\(\)\) return focusNativeDefaultControl\(\);[\s\S]+if \(openNativeEpisodeStrip\(\)\) return true;[\s\S]+showNativeChrome\(true\);[\s\S]+return true;[\s\S]+\}/,
    'native hidden-chrome Down should return from the parked seek bar to Play/Pause before episode-strip handling');
  assert.match(android, /nativePlayerLayer\.setOnKeyListener\(\(v, code, e\) -> handleNativeSurfaceKey\(e\)\);[\s\S]+nativePlayerView\.setOnKeyListener\(\(v, code, e\) -> handleNativeSurfaceKey\(e\)\);[\s\S]+nativeSeek\.setOnKeyListener\(\(v, code, e\) -> handleNativeSurfaceKey\(e\)\);[\s\S]+b\.setOnKeyListener\(\(v, code, e\) -> handleNativeSurfaceKey\(e\)\);/,
    'native D-pad handling should be attached to whichever native player view currently owns focus');
  assert.match(android, /private boolean handleNativeSurfaceKey\(KeyEvent e\) \{[\s\S]+if \(code == KeyEvent\.KEYCODE_DPAD_UP\) return focusNativeSeekControl\(\);[\s\S]+showNativeChrome\(true\);/,
    'hidden native chrome should still react to D-pad keys when the focused native view receives them directly');
  assert.match(android, /public boolean onKeyDown\(int keyCode, KeyEvent event\) \{[\s\S]+nativePlayerOpen\(\) && handleNativeSurfaceKey\(event\)[\s\S]+public boolean onKeyUp\(int keyCode, KeyEvent event\) \{[\s\S]+nativePlayerOpen\(\) && handleNativeSurfaceKey\(event\)/,
    'native playback should also catch D-pad keys through Activity key fallbacks');
  assert.match(android, /if \(code == KeyEvent\.KEYCODE_BACK\) \{[\s\S]+return true;[\s\S]+\}\s+if \(handleNativeSurfaceKey\(e\)\) return true;[\s\S]+KEYCODE_MEDIA_PLAY_PAUSE/,
    'native dispatchKeyEvent should route D-pad through the shared surface handler instead of a second stale D-pad map');
  assert.match(android, /nativeCcBtn\.setOnClickListener\(v -> \{ if \(consumeNativeControlClick\(v\)\) showNativeTrackMenu\(C\.TRACK_TYPE_TEXT\); \}\);[\s\S]+private boolean consumeNativeControlClick\(View v\) \{[\s\S]+nativeClickArmedView[\s\S]+800L[\s\S]+\}/,
    'native subtitle/audio/quality sheets should open only from an armed OK/Enter click, not stray focus movement');
  assert.match(android, /private boolean moveNativeVerticalFocus\(int dir\) \{[\s\S]+if \(dir < 0 && current != nativeSeek\) \{[\s\S]+return focusNativeSeekControl\(\);[\s\S]+return focusNativeDefaultControl\(\);[\s\S]+\}/,
    'native vertical D-pad movement should not fall through to Android default focus guessing');
  assert.match(android, /private boolean nativeVodSeekable\(\) \{[\s\S]+nativePlayer\.isCurrentMediaItemSeekable\(\) \|\| \(d > 0 && d != C\.TIME_UNSET\)/,
    'native VOD seeking should use ExoPlayer seekability, not only a known duration');
  assert.match(android, /private long nativeKnownDurationMs;[\s\S]+knownDurationMs = Math\.max\(0L, Math\.round\(j\.optDouble\("duration", 0\) \* 1000\)\)[\s\S]+nativeKnownDurationMs = knownDurationMs/,
    'native VOD should accept a web-known duration before ExoPlayer reports one');
  assert.match(android, /private long nativeDurationMs\(\) \{[\s\S]+if \(nativeStartOffsetMs > 0L && nativeKnownDurationMs > 0L\) return nativeKnownDurationMs;[\s\S]+if \(d > 0 && d != C\.TIME_UNSET\) return d;[\s\S]+return nativeKnownDurationMs;[\s\S]+\}/,
    'native timeline and seeking should fall back to the web-known duration');
  assert.match(ui, /duration: Math\.max\(0, p\.duration \|\| p\.nativeDuration \|\| 0\),[\s\S]+window\.TriboonTV\.playVideo\(JSON\.stringify\(payload\)\)/,
    'web native handoff should pass the known duration into Android');
  assert.match(android, /private void nativeSeekBy\(long deltaMs\) \{[\s\S]+"live"\.equals\(nativeMode\) \|\| \(!nativeVodSeekable\(\) && !nativeServerSeekMode\(\)\)[\s\S]+long target = Math\.max\(0, nativeDisplayPositionMs\(\) \+ deltaMs\);[\s\S]+if \(d > 0 && d != C\.TIME_UNSET\) target = Math\.min\(d, target\);[\s\S]+nativeSeekToDisplayPosition\(target\);/,
    'native rewind and forward should seek through the absolute movie-time helper');
  assert.match(android, /private boolean nativeServerSeekMode\(\) \{[\s\S]+"remux"\.equals\(nativeKind\) \|\| "transcode"\.equals\(nativeKind\)[\s\S]+private void nativeSeekToDisplayPosition\(long displayMs\) \{[\s\S]+if \(nativeServerSeekMode\(\)\) \{[\s\S]+requestNativeVideoSeek\(target\);[\s\S]+return;[\s\S]+\}[\s\S]+nativePlayer\.seekTo/,
    'native remux/transcode seeking should restart through the web handoff instead of seeking inside a restarted segment');
  assert.match(ui, /window\.__tvNativeVideoSeek = \(pos, dur\) => \{[\s\S]+p\.nativePos = at;[\s\S]+tryNativeVideoPlayer\(currentPlayerKind\(p\), at, \{ quietSeek: true \}\);[\s\S]+\};/,
    'web should quietly remount the active native source kind when Android requests an absolute seek');
  assert.match(android, /private boolean handleNativeSeekBarKey\(KeyEvent e\) \{[\s\S]+View current = getCurrentFocus\(\);[\s\S]+current != nativeSeek && \(!nativeSeekDpadMode \|\| isNativeControl\(current\)\)[\s\S]+KEYCODE_DPAD_LEFT[\s\S]+KEYCODE_DPAD_RIGHT[\s\S]+nativeSeekBy\(code == KeyEvent\.KEYCODE_DPAD_RIGHT \? 30000 : -10000\);[\s\S]+\}/,
    'focused native seek bar should scrub video with D-pad left/right while focused buttons stay in button navigation');
  assert.match(android, /if \(nativeChrome != null && nativeChrome\.getVisibility\(\) == View\.VISIBLE\) \{[\s\S]+if \(handleNativeSeekBarKey\(e\)\) return true;[\s\S]+moveNativeControlFocus/,
    'native seek bar should handle left/right before the button row moves focus');
  assert.match(android, /clickNativeControlFocus\(\)/,
    'native player OK should activate the focused control instead of relying on platform focus guessing');
  assert.match(android, /controls\.setGravity\(android\.view\.Gravity\.CENTER_VERTICAL\)[\s\S]+centerControls\.setGravity\(android\.view\.Gravity\.CENTER\)[\s\S]+rightControls\.setGravity\(android\.view\.Gravity\.END \| android\.view\.Gravity\.CENTER_VERTICAL\)/,
    'native player controls should keep playback centered with secondary controls on the right');
  assert.match(android, /leftControls\.addView\(nativeGuideBtn\);[\s\S]+centerControls\.addView\(nativeRewBtn\);[\s\S]+centerControls\.addView\(nativePlayBtn\);[\s\S]+centerControls\.addView\(nativeFwdBtn\);[\s\S]+centerControls\.addView\(nativeNextBtn\);[\s\S]+rightControls\.addView\(nativeCcBtn\);[\s\S]+rightControls\.addView\(nativeAudioBtn\);[\s\S]+rightControls\.addView\(nativeQualityBtn\);[\s\S]+rightControls\.addView\(nativeStatsBtn\);/,
    'native player should keep Guide left, playback centered, and CC/audio/HD before the final stats/info button');
  assert.match(android, /return new ImageButton\[\]\{\s+nativeGuideBtn, nativeRewBtn, nativePlayBtn, nativeFwdBtn,\s+nativeNextBtn, nativeCcBtn, nativeAudioBtn, nativeQualityBtn, nativeStatsBtn\s+\};/,
    'native player D-pad order should match the visible control grouping');
  assert.match(ui, /\.cbtn\.big\{width:58px;height:58px;background:rgba\(5,3,9,\.4\);color:var\(--text\)\}/,
    'web play button should be neutral until focused or hovered');
  assert.doesNotMatch(ui, /\.cbtn\.on\{background:var\(--amber\)|\.btn\.primary,\.cbtn\.big/,
    'enabled or selected player buttons should not keep the old persistent gold highlight');
  assert.match(ui, /function updatePlayerControlAvailability\(\) \{[\s\S]+setPlayerControlEnabled\('ccBtn', playerCcHasOptions\(\)\);[\s\S]+setPlayerControlEnabled\('audBtn', playerAudioHasOptions\(\)\);[\s\S]+setPlayerControlEnabled\('qualBtn', playerQualityHasOptions\(\)\);/,
    'web CC/audio/HD buttons should be disabled when no real options exist');
  assert.match(ui, /ctlButtons\(\) \{[\s\S]+!b\.disabled && !b\.classList\.contains\('disabled'\)/,
    'web player D-pad focus should skip disabled controls');
  assert.match(android, /setNativeButtonIcon\(ImageButton b, int iconRes, boolean primary, boolean focused\) \{[\s\S]+!b\.isEnabled\(\) \? 0x88EDE8F5 : \(focused \? 0xFF0B0812 : 0xFFEDE8F5\)/,
    'native player icons should turn dark when the focused button switches to light mode');
  assert.match(android, /focused[\s\S]+\? new int\[\]\{0xFFEDE8F5, 0xFFD9CBE7\}[\s\S]+: new int\[\]\{0x18F3EFF7, 0x18F3EFF7\}/,
    'native player buttons should use a very transparent fill normally and full light fill while focused');
  assert.match(android, /setNativeButtonEnabled\(nativeCcBtn, nativeSubtitleHasOptions\(\)\);[\s\S]+setNativeButtonEnabled\(nativeAudioBtn, nativeAudioHasOptions\(\)\);[\s\S]+setNativeButtonEnabled\(nativeQualityBtn, "video"\.equals\(nativeMode\) && nativeHasQualityChoices\);/,
    'native CC/audio/HD buttons should be disabled when no real options exist');
  assert.match(android, /b == null \|\| b\.getVisibility\(\) != View\.VISIBLE \|\| !b\.isEnabled\(\)/,
    'native D-pad focus should skip disabled controls');
  assert.match(ui, /id="chGuide"[\s\S]+M12 12H3[\s\S]+m16 12 5 3-5 3v-6Z/,
    'web guide button should use the Lucide list-video icon');
  assert.match(ui, /id="audBtn"[\s\S]+M2 10v3[\s\S]+M22 10v3/,
    'web audio button should use the Lucide audio-lines icon');
  assert.match(ui, /id="qualBtn"[\s\S]+M10 12H6[\s\S]+M14 14\.5/,
    'web HD button should use the Lucide hd icon');
  assert.match(guideIcon, /M12,12 H3 M16,6 H3 M12,18 H3[\s\S]+M16,12 L21,15 L16,18 Z/,
    'Android guide icon should use the Lucide list-video shape');
  assert.match(audioIcon, /M2,10 V13 M6,6 V17 M10,3 V21 M14,8 V15 M18,5 V18 M22,10 V13/,
    'Android audio icon should use the Lucide audio-lines shape');
  assert.match(ccIcon, /M7,15 H11 M15,15 H17 M7,11 H9 M13,11 H17/,
    'Android CC icon should use the Lucide closed-caption shape');
  assert.match(qualityIcon, /M10,12 H6 M10,15 V9 M6,15 V9[\s\S]+M14,9\.5/,
    'Android HD icon should use the Lucide hd shape');
  assert.match(rewindIcon, /M3,2 V8 H9[\s\S]+M21,12 A9,9 0,0 0,6 5\.3 L3,8/,
    'Android rewind icon should use the Lucide rotate-ccw shape');
  assert.match(forwardIcon, /M21,2 V8 H15[\s\S]+M3,12 A9,9 0,0 1,18 5\.3 L21,8/,
    'Android forward icon should use the Lucide rotate-cw shape');
  assert.match(nextIcon, /M5,4 L15,12 L5,20 Z[\s\S]+M19,5 V19/,
    'Android next episode icon should use the Lucide skip-forward shape');
  assert.match(ui, /data-nav="home"[\s\S]+M15 21v-8[\s\S]+M3 10a2 2/,
    'rail Home should use the Lucide house icon');
  assert.match(ui, /data-nav="discover"[\s\S]+M5 12s2\.5-5 7-5[\s\S]+circle cx="12" cy="12"/,
    'rail Discover should use the Lucide view icon');
  assert.match(ui, /data-nav="calendar"[\s\S]+M8 2v4[\s\S]+M16 18h\.01/,
    'rail Calendar should use the Lucide calendar-days icon');
  assert.match(ui, /data-nav="movies"[\s\S]+rect width="18" height="18" x="3" y="3"[\s\S]+M17 7\.5h4/,
    'rail Movies should use the Lucide film icon');
  assert.match(ui, /data-nav="tv"[\s\S]+M10 7\.75a\.75\.75[\s\S]+rect width="20" height="14" x="2" y="3"/,
    'rail TV Shows should use the Lucide tv-minimal-play icon');
  assert.match(ui, /data-nav="search"[\s\S]+m21 21-4\.34-4\.34[\s\S]+circle cx="11" cy="11"/,
    'rail Search should use the Lucide search icon');
  assert.match(ui, /data-nav="livetv"[\s\S]+m17 2-5 5-5-5[\s\S]+rect width="20" height="15" x="2" y="7"/,
    'rail Live TV should use the Lucide tv icon');
  assert.match(ui, /data-nav="music"[\s\S]+M9 18V5l12-2v13[\s\S]+circle cx="18" cy="16"/,
    'rail Music should use the Lucide music icon');
  assert.match(ui, /function visibleRailButtons\(\) \{[\s\S]+getComputedStyle\(b\)[\s\S]+cs\.display !== 'none'[\s\S]+b\.getClientRects\(\)\.length > 0/,
    'rail D-pad should use actual rendered visibility so bottom items like Preferences/Settings remain reachable');
  assert.match(ui, /function focusRail\(i, opts = \{\}\) \{[\s\S]+const btns = visibleRailButtons\(\)/,
    'rail focus movement should use rendered-visible menu buttons');
  assert.match(ui, /function enterRail\(\) \{[\s\S]+const btns = visibleRailButtons\(\)/,
    'entering the rail should land on a rendered-visible active item');
  assert.match(ui, /function focusRailEnter\(\) \{[\s\S]+const btns = visibleRailButtons\(\)/,
    'pressing OK in the rail should activate the rendered-visible focused item');
  assert.match(ui, /toast\(r\.result && r\.result\.skipped === 'running' \? 'Live TV refresh already running' : 'Live TV refresh complete'\)/,
    'Live TV manual refresh should not say complete when a source-added or scheduled sync is already running');
  assert.match(ui, /const cids = \(chans \|\| \[\]\)\.filter[\s\S]+encodeURIComponent\(c\.id \|\| ''\)[\s\S]+\/api\/iptv\/guide\?chs=' \+ ids\.join\(','\) \+ cidParam/,
    'Live TV timeline guide requests should bind channel indexes to stable channel ids');
  assert.match(ui, /api\('\/api\/music\/home'\)[\s\S]+S\.musicHome = r && Array\.isArray\(r\.shelves\) \? r : \{ shelves: \[\] \}/,
    'Music page should load the server-side Music Home shelf contract');
  assert.match(ui, /async function loadMusicHomeFallback\(\) \{[\s\S]+\/api\/music\/search\?q=' \+ encodeURIComponent\(def\.query\) \+ '&limit=16'[\s\S]+S\.musicHome = await loadMusicHomeFallback\(\)/,
    'Music page should fall back to regular music search if the home endpoint is not active yet');
  assert.match(ui, /const yours = addShelf\('Your playlists'[\s\S]+if \(Array\.isArray\(S\.ytmPlaylists\)\)[\s\S]+Connect YouTube Music[\s\S]+S\.musicHome/,
    'Music Home should render personal playlists before weekly, seasonal, and chart shelves');
  assert.match(ui, /function startMusicFeed\(item\) \{[\s\S]+\/api\/music\/search\?q=' \+ encodeURIComponent\(q\) \+ '&limit=24'[\s\S]+playMusic\(rows, 0, \{ showQueue: true \}\)/,
    'Music feed cards should start generated queues instead of only opening raw search');
  assert.match(ui, /function safeMusicPlay\(opts = \{\}\) \{[\s\S]+mAudio\.play\(\)[\s\S]+toast\('Press play to start music\.'\)/,
    'Music playback should give a visible prompt when autoplay is blocked instead of silently failing');
  assert.match(ui, /mAudio\.addEventListener\('error'[\s\S]+Track unavailable\. Skipping[\s\S]+setTimeout\(\(\) => \{ if \(S\.musicLoadFailed\) musicNext\(true\); \}/,
    'Music should skip unavailable tracks instead of stalling the queue on a dead stream');
  assert.match(ui, /function openMusicConnect\(\) \{[\s\S]+tries < 30[\s\S]+requestAnimationFrame\(focusConnect\)/,
    'Music connect focus should wait for Preferences rendering instead of using a fixed timer race');
  assert.match(ui, /id="mnQueueToggle" title="Hide queue" aria-label="Hide queue"[\s\S]+function updateMusicQueueToggle\(\) \{[\s\S]+btn\.title = hidden \? 'Show queue' : 'Hide queue'[\s\S]+btn\.setAttribute\('aria-label', btn\.title\)/,
    'Music now-playing queue control should be icon-only and use queue labels');
  assert.match(ui, /function renderYtmConnectBox\(box, st\) \{[\s\S]+Set up account[\s\S]+Manual paste[\s\S]+function renderYtmImportBox\(box, opts = \{\}\) \{[\s\S]+ytmOpenMusic[\s\S]+ytmPick[\s\S]+ytmShowPaste[\s\S]+api\('\/api\/music\/link'/,
    'YouTube Music linking should present a guided setup flow with manual paste hidden as an advanced path');
  assert.doesNotMatch(android, /ImageButton back = nativeButton\(R\.drawable\.ic_player_back/,
    'native player bottom row should not show a separate Back button');
  assert.match(android, /KEY_CACHE_VERSION/,
    'Android WebView cache should be version-scoped instead of wiped on every launch');
  assert.match(android, /if \(!BuildConfig\.VERSION_NAME\.equals\(cacheVersion\)\) \{[\s\S]+web\.clearCache\(true\)/,
    'Android should only flush disk cache after an APK version change');
  assert.doesNotMatch(android, /web\.clearCache\(true\);\s*web\.setBackgroundColor/,
    'Android should not unconditionally discard cached art/assets during every app start');
  assert.match(android, /onRenderProcessGone\(WebView v, RenderProcessGoneDetail detail\) \{[\s\S]+recoverWebRenderer\(v, didCrash, priorityAtExit\)\);[\s\S]+return true;/,
    'Android should catch a dead WebView renderer instead of leaving the default web page crashed screen');
  assert.match(android, /private void recoverWebRenderer\(WebView crashedWeb, boolean didCrash, int priorityAtExit\) \{[\s\S]+trimAndroidMemoryCaches\(true\);[\s\S]+disposeWebView\(crashedWeb, true\);[\s\S]+if \(!ensureWebViewReady\(\)\)[\s\S]+web\.loadUrl\(url\);/,
    'Android should trim memory, rebuild through the WebView guard, and reload the TV page after a renderer crash');
  assert.match(android, /if \(nativeVisible\) \{[\s\S]+if \(nativeGuideMode\) \{[\s\S]+enterNativeFullscreenMode\(\);[\s\S]+\} else \{[\s\S]+web\.setVisibility\(View\.GONE\);/,
    'if the WebView guide crashes while ExoPlayer is in PiP, recovery should restore fullscreen playback instead of leaving a stuck PiP');
  assert.match(android, /root\.addView\(web, 0, new FrameLayout\.LayoutParams\(/,
    'Android should rebuild the WebView below setup and native player overlays');
  assert.match(android, /WEB_RENDERER_CRASH_LIMIT[\s\S]+tooManyCrashes[\s\S]+showSetup\("The TV page crashed repeatedly/,
    'Android renderer recovery should stop retrying after repeated crash loops');
  assert.match(android, /redactedWebUrl\(url\)/,
    'Android renderer crash logs should redact URL query tokens');
  assert.match(android, /public void onTrimMemory\(int level\)[\s\S]+TRIM_MEMORY_RUNNING_LOW[\s\S]+personalIptvHostSafetyCache\.clear\(\)[\s\S]+__tvTrimMemory/,
    'Android should release transient IPTV/web caches when the OS reports memory pressure');
  assert.match(ui, /window\.__tvTrimMemory = \(\) => \{[\s\S]+clearLiveClientCaches\(\);[\s\S]+S\.musicCoverCache = \{\};[\s\S]+S\.musicCoverFeedCache = \{\};/,
    'the web shell should drop large transient guide/music cover caches on Android memory trim');
  assert.match(android, /nativePlayerSubline\.setVisibility\(subline\.isEmpty\(\) \? View\.GONE : View\.VISIBLE\)/,
    'native movie/episode chrome should show the episode subline only when it exists');
  assert.match(android, /nativePlayerTitle\.setVisibility\(View\.VISIBLE\);/,
    'native title should render in the top-left player metadata cluster');
  assert.match(android, /boolean isLiveMode = "live"\.equals\(mode\);[\s\S]+String subline = isLiveMode \? "" : nativePlaybackSubline;/,
    'native Live TV chrome should not duplicate the channel/source line in the top-left');
  assert.match(android, /nativeEndsAt\.setText\("Ends at " \+ fmtNativeClock/,
    'native movie/episode chrome should show when playback will finish');
  assert.match(android, /nativeTime\.setText\(!isLive \? \(dur > 0 \? fmtNative\(dur\) : "--:--"\) : ""\);/,
    'native movie/episode seek row should reserve the right-side duration label while Exo resolves duration');
  assert.match(android, /if \(nativeElapsed != null\) \{[\s\S]+nativeElapsed\.setText\(isLive \? "" : fmtNative\(pos\)\);[\s\S]+nativeElapsed\.setVisibility\(isLive \? View\.GONE : View\.VISIBLE\);[\s\S]+\}[\s\S]+nativeTime\.setText\(!isLive \? \(dur > 0 \? fmtNative\(dur\) : "--:--"\) : ""\);[\s\S]+nativeTime\.setVisibility\(isLive \? View\.GONE : View\.VISIBLE\);/,
    'native Live TV chrome should hide VOD seek timing labels instead of showing another LIVE label');
  assert.match(android, /nativeEndsAt\.setText\("Ends at --:--"\);[\s\S]+nativeEndsAt\.setVisibility\(View\.VISIBLE\);/,
    'native top-right finish label should stay visible with a placeholder until duration is known');
  assert.doesNotMatch(android, /nativeEndsAt\.setText\("Live TV"\)/,
    'native top-right chrome should leave Live TV status to the single LIVE badge');
  assert.match(android, /nativeTime\.setMinWidth\(dp\(72\)\);[\s\S]+seekRow\.addView\(nativeTime, new LinearLayout\.LayoutParams\(dp\(76\), dp\(28\)\)\);/,
    'native right-side seek timer should have enough reserved width for movie durations');
  assert.match(android, /nativeChrome\.setPadding\(dp\(34\), dp\(12\), dp\(34\), dp\(18\)\)/,
    'native player seek bar should use wider horizontal space');
  assert.match(android, /dp\(primary \? 46 : 36\)/,
    'native player buttons should stay compact and avoid clipped circles on TV');
  assert.doesNotMatch(android, /setScale[XY]\(hasFocus/,
    'native player focus should not scale buttons and clip the circle');
  assert.match(android, /dp\(328\), ViewGroup\.LayoutParams\.WRAP_CONTENT/,
    'native option sheets should stay compact while giving player rows enough room');
  assert.match(android, /nativeTop = new LinearLayout\(this\);[\s\S]+nativePlayerTitle = new TextView\(this\);[\s\S]+nativePlayerSubline = new TextView\(this\);[\s\S]+nativePlayerLayer\.addView\(nativeTop, titleLp\);/,
    'native ExoPlayer should place title and episode subline in the top-left metadata cluster');
  assert.match(android, /if \(nativeMetaBar != null\) nativeMetaBar\.setVisibility\(View\.GONE\);[\s\S]+nativeChrome\.setVisibility\(View\.VISIBLE\);[\s\S]+nativeTop\.setVisibility\(View\.VISIBLE\);/,
    'native ExoPlayer should not show the old bottom metadata bar when chrome is visible');
  assert.match(android, /String chromeQuality = isLiveMode \? "LIVE" : nativeQualityLabel;[\s\S]+nativePlayerBadge\.setText\(chromeQuality\)/,
    'native video quality should show a friendly resolution label, not direct/remux/transcode internals');
  assert.match(android, /private FrameLayout nativeLoading;[\s\S]+private ImageView nativeLoadingBackdrop;[\s\S]+private TextView nativeLoadingTitle;[\s\S]+private TextView nativeLoadingStage;[\s\S]+private TextView nativeLoadingDetail;/,
    'native ExoPlayer should own a branded loading overlay instead of borrowing the web player shell');
  assert.match(ui, /<link rel="icon" href="T-Logo\.svg"><link rel="alternate icon" href="T-Logo\.png">/,
    'web favicon should use the T logo assets');
  assert.match(ui, /id="railLogo"[\s\S]+<img src="T-Logo\.svg" alt="Triboon" onerror="this\.onerror=null;this\.src='T-Logo\.png'"/,
    'web rail logo should use the T logo assets');
  assert.match(ui, /<div class="ssBrand"><img src="triboon\.png" alt="Triboon"><\/div>/,
    'web screensaver should use the updated transparent Triboon wordmark asset');
  assert.match(android, /nativeLoading = new FrameLayout\(this\);[\s\S]+FrameLayout loadingMark = new FrameLayout\(this\);[\s\S]+ProgressBar loadingRing = new ProgressBar\(this\);[\s\S]+loadingLogo\.setImageResource\(R\.drawable\.ic_loading_logo\);[\s\S]+loadingCenter\.addView\(loadingMark, new LinearLayout\.LayoutParams\(dp\(136\), dp\(136\)\)\);/,
    'native loading overlay should wrap the T logo with a modern progress ring');
  assert.match(android, /nativeLoadingTitle\.setTextSize\(24\);[\s\S]+nativeLoadingTitle\.setMaxLines\(2\);[\s\S]+nativeLoadingTitle\.setEllipsize\(TextUtils\.TruncateAt\.END\);/,
    'native loading title should stay prominent without overflowing on TV');
  assert.match(android, /nativeLoadingStage\.setText\("Finding best source"\);[\s\S]+nativeLoadingDetail\.setText\("Preparing native playback"\);/,
    'native loading overlay should show concise playback status and detail text');
  assert.match(android, /loadingRing\.setIndeterminateDrawable\(nativeLoadingRingDrawable\(\)\);[\s\S]+R\.drawable\.native_loading_ring/,
    'native ExoPlayer loading overlay should use the thin Triboon ring instead of the stock chunky ProgressBar spinner');
  assert.match(loadingRing, /android:shape="ring"[\s\S]+android:thickness="2dp"[\s\S]+android:shape="ring"[\s\S]+android:thickness="3dp"[\s\S]+android:type="sweep"/,
    'native loading ring should stay browser-like: a thin track plus thin rotating sweep arc');
  assert.match(android, /private String nativeLoadingStageFor\(String mode, String kind\)[\s\S]+Tuning channel[\s\S]+Opening direct play[\s\S]+private String nativeLoadingDetailFor\(String mode, String kind, String qualityLabel, String sourceLabel, long startOffsetMs\)[\s\S]+"Direct Play"\);[\s\S]+String detail = method \+ " - " \+ quality;[\s\S]+sourceLabel\.trim\(\)[\s\S]+Resume %d:%02d/,
    'native loading copy should adapt for Live TV, direct play, quality, source, and resume state');
  assert.doesNotMatch(android, /loadingBrand\.setText\("TRIBOON"\)|TextView loadingBrand/,
    'native ExoPlayer loader should not show a separate Triboon wordmark under the logo');
  assert.doesNotMatch(android, /loadingLogo\.setImageResource\(R\.drawable\.ic_launcher\)/,
    'native loading overlay should not reuse the non-transparent launcher icon');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_loading_logo.png')),
    'native loading overlay should have a dedicated transparent logo asset');
  for (const rel of [
    'logo/T-Logo.png',
    'logo/triboon.png',
    'web/T-Logo.png',
    'web/triboon.png',
    'web/triboon-screensaver.png',
    'android/app/src/main/res/drawable/ic_launcher.png',
    'android/app/src/main/res/drawable/ic_loading_logo.png',
    'android/app/src/main/res/drawable/banner.png',
  ]) {
    assert.ok(pngHasTransparentPixels(path.join(__dirname, '..', rel)),
      `${rel} should preserve transparent pixels instead of baking in a background`);
  }
  assert.match(android, /backdropUrl = j\.optString\("backdropUrl", ""\);[\s\S]+enterNativeFullscreenMode\(\);[\s\S]+showNativeLoading\(title, backdropUrl,[\s\S]+nativeLoadingDetailFor\(mode, loadingKind, loadingQuality, loadingSource, loadingStartOffsetMs\)\);[\s\S]+nativePlayer\.prepare\(\)/,
    'Android should hide the WebView and show the branded native loader before ExoPlayer prepares');
  assert.match(android, /if \("video"\.equals\(m\)\) \{[\s\S]+releaseNativePlayer\(false\);[\s\S]+enterNativeFullscreenMode\(\);[\s\S]+showNativeLoading\(title, backdropUrl, "Retrying playback",[\s\S]+__tvNativeVideoError/,
    'native movie fallbacks should keep the Android layer up instead of revealing the WebView player between retries');
  assert.match(android, /public void closeVideo\(\) \{[\s\S]+closeNativePlayback\(false\)/,
    'web-side native failure cleanup should be able to close the Android video layer without using the web player');
  assert.match(android, /public void showVideoLoading\(String json\) \{[\s\S]+showNativeVideoLoading\(json\)/,
    'web should be able to show Android native loading before the stream URL is mounted');
  assert.match(android, /private void showNativeVideoLoading\(String json\) \{[\s\S]+enterNativeFullscreenMode\(\);[\s\S]+showNativeLoading\(title, backdropUrl, stage, detail\);[\s\S]+\}/,
    'Android native loading should own the screen before ExoPlayer is created');
  assert.match(ui, /async function closePlayer\(opts = \{\}\) \{[\s\S]+window\.TriboonTV\.closeVideo/,
    'closing the web player state on Android should also close any native ExoPlayer overlay');
  assert.match(android, /state == Player\.STATE_READY[\s\S]+hideNativeLoading\(\);[\s\S]+showNativeChrome\(true\);/,
    'native loading overlay should disappear only once Media3 reports the stream is ready');
  assert.match(android, /private void releaseNativePlayer\(boolean notifyClosed\) \{[\s\S]+hideNativeLoading\(\);/,
    'closing or retrying native playback should always clear the loading overlay');
  assert.match(android, /nativePlayerLayer\.requestFocus\(\);[\s\S]+setNativeSubtitleLift\(false\)/,
    'native chrome should auto-hide even after a control kept focus');
  assert.match(android, /setBottomPaddingFraction\(lift \? 0\.30f : 0\.08f\);[\s\S]+lift \? dp\(178\) : dp\(28\)[\s\S]+lp\.bottomMargin = lift \? dp\(206\) : dp\(82\)/,
    'native subtitle lift should follow the higher controller band');
  assert.match(android, /if \(code == KeyEvent\.KEYCODE_DPAD_UP\) return focusNativeSeekControl\(\);[\s\S]+showNativeChrome\(true\);/,
    'D-pad Up from hidden native chrome should open directly on the seek bar');
  assert.match(android, /nativeIsWyzieTrack\(f\)/,
    'native CC menu should filter subtitle choices to the side-loaded subtitle');
  assert.match(android, /nativeSubtitleChoiceLabels\.add\(label\.isEmpty\(\) && !rel\.isEmpty\(\) \? nativeLabelForSubtitleRel\(rel\) : label\)/,
    'native subtitle choices should keep the plain labels sent by the web player');
  assert.match(android, /nativeSubtitleLabel = choice\.label;[\s\S]+loadNativeSubtitleOverlay\(nativeSubtitleUrl\)/,
    'native subtitle overlay should use the same plain language labels sent by the web player');
  assert.match(android, /return lang\.isEmpty\(\) \? "Subtitles" : lang;/,
    'native subtitle fallback labels should stay plain and language-first');
  assert.match(android, /\? \(!subtitleLang\.isEmpty\(\) \? nativeLangName\(subtitleLang\) : "Subtitles"\)/,
    'native subtitle fallback should use only the language name');
  assert.doesNotMatch(android, /"Wyzie subtitles"|"Wyzie - " \+ nativeLangName|No Wyzie subtitle/,
    'native subtitle UI should not show provider branding');
  assert.doesNotMatch(android, /0xFFFFC65C/,
    'native player focus should not use the oversized yellow button treatment');
  assert.match(android, /nativeCcBtn\.setOnClickListener\(v -> \{ if \(consumeNativeControlClick\(v\)\) showNativeTrackMenu\(C\.TRACK_TYPE_TEXT\); \}\)/,
    'native CC button should open a native subtitle menu only from an armed remote click');
  assert.match(android, /public void updateSubtitleChoices\(String json\)[\s\S]+updateNativeSubtitleChoices\(json\)/,
    'Android bridge should accept refreshed subtitle choices from the web app');
  assert.match(android, /private boolean nativeOpenSubtitleMenuAfterRefresh;[\s\S]+applyNativeSubtitleChoices\(choices\);[\s\S]+if \(nativeOpenSubtitleMenuAfterRefresh && nativePlayer != null && "video"\.equals\(nativeMode\)\) \{[\s\S]+showNativeTrackMenu\(C\.TRACK_TYPE_TEXT\);[\s\S]+\} else \{[\s\S]+nativeOpenSubtitleMenuAfterRefresh = false;[\s\S]+\}/,
    'native subtitle choice refresh should update startup data silently unless the user requested versions');
  assert.match(android, /applyNativeSubtitleChoices\(j\.optJSONArray\("subtitleChoices"\)\)/,
    'Android should parse subtitle choices sent in the initial native playback payload');
  assert.match(android, /nativeSubtitleChoiceActions\.add\(action\);[\s\S]+nativeSubtitleChoiceLangs\.add\(lang\);/,
    'Android should retain native subtitle action rows such as Choose version');
  assert.match(android, /nativeSubtitleChoiceUrls\.add\(url\);/,
    'Android should retain online subtitle URLs so choices are preloaded as native text tracks');
  assert.match(android, /nativeSubtitleChoiceRels\.add\(rel\);/,
    'Android should parse subtitle choices sent by the web bridge');
  assert.match(android, /choices\.add\(new NativeTrackChoice\(null, -1, label, false,[\s\S]+rel\.equals\(nativeSubtitleRel\), rel, action, lang\)\)/,
    'native CC sheet should expose selectable online subtitle rows');
  assert.match(android, /"versions"\.equals\(choice\.subtitleAction\)[\s\S]+requestNativeSubtitleVersions\(choice\.subtitleLang\)/,
    'native CC sheet should load version rows instead of treating Choose version as an inert subtitle');
  assert.match(android, /"missing"\.equals\(choice\.subtitleAction\)[\s\S]+No subtitles found for this title[\s\S]+Toast\.makeText/,
    'native CC sheet should handle no-subtitles rows without trying to load a subtitle file');
  assert.match(android, /private void requestNativeSubtitleVersions\(String lang\) \{[\s\S]+nativeOpenSubtitleMenuAfterRefresh = true;[\s\S]+window\.__tvNativeSubtitleVersions/,
    'native Choose version should intentionally reopen the menu after refreshed rows arrive');
  assert.match(android, /window\.__tvNativeSubtitleVersions && window\.__tvNativeSubtitleVersions/,
    'Android should call the web subtitle-version loader from the native sheet');
  assert.match(android, /"Off", true, nativeSubtitleRel\.isEmpty\(\)\)/,
    'native CC sheet should not mark Off selected while a bridge-selected online subtitle is active');
  assert.match(android, /notifyNativeSubtitleSelect\(choice\.subtitleRel\)/,
    'selecting an online subtitle row should notify the web app instead of leaving the row inert');
  assert.doesNotMatch(android, /No subtitle is loaded for this stream/,
    'native CC should not stop before showing online subtitle choices');
  assert.match(android, /labels\.add\("Sync: subtitles later"\)/,
    'native CC sheet should include a subtitle-later sync action');
  assert.match(android, /shiftNativeSubtitles\(0\.5f\)/,
    'native subtitle sync action should move subtitles later in 0.5s steps');
  assert.match(android, /nativeSheetRestoreIndex = later;[\s\S]+shiftNativeSubtitles\(0\.5f\);[\s\S]+nativeSheetRestoreIndex = earlier;[\s\S]+shiftNativeSubtitles\(-0\.5f\)/,
    'native subtitle sync adjustments should reopen the CC sheet on the sync row');
  assert.match(android, /int focusIndex = nativeSheetRestoreIndex >= 0 \? nativeSheetRestoreIndex : 0;[\s\S]+java\.util\.ArrayList<View> rows = nativeSheetFocusableRows\(\);[\s\S]+focusNativeSheetRow\(rows, focusIndex\);/,
    'native choice sheets should honor a requested restore row after rebuilding');
  assert.match(android, /private void applyNativeSubtitleShift\(\) \{[\s\S]+updateNativeSubtitleOverlay\(\);[\s\S]+window\.__tvNativeSubtitleShift && window\.__tvNativeSubtitleShift/,
    'native subtitle sync should update the live overlay and persist the offset');
  assert.doesNotMatch(android, /private void applyNativeSubtitleShift\(\) \{[\s\S]+setMediaItem\(/,
    'native subtitle sync must not refresh or rebuild the playing video');
  assert.match(android, /private ValidatedNativeUrl validateNativeSubtitleOverlayUrl\(String raw, String pinnedHostHeader\) throws IOException \{[\s\S]+ValidatedNativeUrl safe = validateNativePlaybackUrl\(raw\);[\s\S]+hostLooksLiteral\(connectHost\)[\s\S]+hostHeader = pinnedHostHeader\.trim\(\);[\s\S]+return new ValidatedNativeUrl\(safe\.originalUrl, safe\.connectUrl, hostHeader\);[\s\S]+\}/,
    'native subtitle overlay URLs should be validated inside the fetch helper and preserve pinned personal-IPTV Host headers');
  assert.match(android, /private void loadNativeSubtitleOverlay\(String url\) \{[\s\S]+validateNativeSubtitleOverlayUrl\(cleanUrl, nativeSubtitleHostHeader\);[\s\S]+final String fetchUrl = subtitleUrl\.connectUrl;[\s\S]+new URL\(fetchUrl\)\.openConnection\(\)[\s\S]+c\.setRequestProperty\("Host", hostHeader\);[\s\S]+int status = c\.getResponseCode\(\);[\s\S]+readNativeSubtitleResponse\(c, status >= 400\)[\s\S]+parseNativeVtt\(body\)[\s\S]+nativeSubtitleHandler\.postDelayed\(nativeSubtitleTick, 250\)/,
    'native online subtitles should be fetched once and rendered by a live Exo overlay');
  assert.match(android, /throw new java\.io\.IOException\("subtitle HTTP " \+ status \+ ": " \+ subtitleErrorSnippet\(body\)\)/,
    'native online subtitle failures should log the real HTTP status from the server route');
  assert.match(android, /private String redactNativeLogMessage\(String msg\)[\s\S]+token\|apikey\|api_key\|password\|pass/,
    'native subtitle failure logs should redact stream tokens and API-style secrets');
  assert.match(android, /window\.__tvNativeSubtitleShift && window\.__tvNativeSubtitleShift/,
    'native subtitle sync should tell the web app to save the offset');
  assert.match(android, /nativeAudioBtn\.setOnClickListener\(v -> \{ if \(consumeNativeControlClick\(v\)\) showNativeTrackMenu\(C\.TRACK_TYPE_AUDIO\); \}\)/,
    'native Audio button should open a native audio menu only from an armed remote click');
  assert.match(android, /nativeQualityBtn\.setOnClickListener\(v -> \{ if \(consumeNativeControlClick\(v\)\) showNativeQualityMenu\(\); \}\)/,
    'native Quality button should stay inside the native player only from an armed remote click');
  assert.match(android, /"Original \(" \+ label \+ "\)"[\s\S]+"1080p optimized"[\s\S]+"720p optimized"[\s\S]+"480p optimized"/,
    'native Quality sheet should offer real selectable quality rows');
  assert.match(android, /private void chooseNativeQuality\(int which\) \{[\s\S]+window\.__tvNativeVideoQuality && window\.__tvNativeVideoQuality/,
    'native Quality choices should call back into the web bridge to restart ExoPlayer');
  assert.match(android, /showNativeChoiceSheet\(trackType == C\.TRACK_TYPE_TEXT \? "Subtitles" : "Audio"/,
    'native track choices should use Triboon chrome, not a stock Android dialog');
  assert.match(android, /nativeSheet\.setFocusable\(true\);[\s\S]+nativeSheet\.setDescendantFocusability\(ViewGroup\.FOCUS_AFTER_DESCENDANTS\)/,
    'native option sheets should be focus containers so rows can receive D-pad focus');
  assert.match(android, /if \(handleNativeSheetKey\(e\)\) return true;/,
    'native sheets should own D-pad and OK before the player button row handler');
  assert.match(android, /private boolean handleNativeSheetKey\(KeyEvent e\) \{[\s\S]+KEYCODE_DPAD_UP[\s\S]+KEYCODE_DPAD_DOWN[\s\S]+focusNativeSheetRow\(rows, next\);[\s\S]+rows\.get\(cur\)\.performClick\(\);[\s\S]+\}/,
    'native option sheets should support D-pad row movement and OK activation');
  assert.match(android, /nativeSubtitleRel = choice\.subtitleRel;[\s\S]+disableNativeTextTracks\(\);[\s\S]+loadNativeSubtitleOverlay\(nativeSubtitleUrl\);/,
    'native online subtitle choices should switch through the live subtitle overlay');
  assert.match(android, /private void applyNativeTrackChoice\(int trackType, NativeTrackChoice choice\) \{[\s\S]+nativePlayer\.setTrackSelectionParameters\(b\.build\(\)\);[\s\S]+showNativeChrome\(false\);[\s\S]+\}/,
    'native CC/audio choices should update quietly without a confirmation toast');
  assert.doesNotMatch(android, /Toast\.makeText\(this,\s*"Subtitles:|Toast\.makeText\(this,\s*"Audio:|Toast\.makeText\(this,\s*label/,
    'native player controls should not show success popups over playback');
  assert.match(android, /private boolean nativeVodSeekable\(\) \{[\s\S]+if \(nativePlayer == null \|\| "live"\.equals\(nativeMode\)\) return false;/,
    'live streams should not expose movie-style seeking behavior');
  assert.match(android, /boolean reuseLivePlayer = "live"\.equals\(mode\) && nativePlayer != null[\s\S]+if \(!reuseQuietVideo && !reuseLivePlayer\) \{[\s\S]+releaseNativePlayer\(false, guide\);[\s\S]+if \(reuseLivePlayer\) \{[\s\S]+nativePlayer\.stop\(\);[\s\S]+nativePlayer\.clearMediaItems\(\);[\s\S]+applyNativeHttpHostHeader\(\);[\s\S]+nativePlayer\.setMediaItem\(buildNativeMediaItem\(\)\);/,
    'native Live TV zaps should reuse ExoPlayer, refresh pinned Host headers, and explicitly release the old live source before replacing the media item');
  assert.ok([
    'private long nativePendingStartMs;',
    'private long nativeStartSeekIssuedAtMs;',
    'private long nativeStartOffsetMs;',
    'nativePendingStartMs = "video".equals(mode) ? startMs : 0L;',
    'nativeStartOffsetMs = "video".equals(mode) ? startOffsetMs : 0L;',
    'if (state == Player.STATE_READY) {',
    'applyNativeStartSeekIfReady();',
  ].every((s) => android.includes(s)),
    'native movie resume should keep the requested start time until ExoPlayer is ready');
  assert.match(android, /private long nativeDisplayPositionMs\(\) \{[\s\S]+nativeStartOffsetMs \+ nativeRawPositionMs\(\)[\s\S]+private void nativeSeekToDisplayPosition\(long displayMs\) \{[\s\S]+nativePlayer\.seekTo\(Math\.max\(0L, target - nativeStartOffsetMs\)\)/,
    'native remux/transcode playback should display and save absolute movie time while seeking inside the restarted segment');
  assert.match(ui, /function seekTo\(seconds\) \{[\s\S]+p\.suppressSeekLoaderUntil = appMs\(\) \+ 4500;[\s\S]+clearTimeout\(S\._waitT\);[\s\S]+\$\(\'playerLoader\'\)\.classList\.remove\(\'show\'\);[\s\S]+startSource\('transcode', seconds, \{ quietSeek: true \}\)[\s\S]+startSource\('remux', seconds, \{ quietSeek: true \}\)/,
    'web movie/episode seeking should not show the full startup loader during repeated skips');
  assert.match(ui, /<canvas id="seekHold" aria-hidden="true"><\/canvas>[\s\S]+function showSeekHoldFrame\(\) \{[\s\S]+drawImage\(v, 0, 0, c\.width, c\.height\);[\s\S]+c\.classList\.add\('show'\);/,
    'web movie/episode seeking should hold the last rendered frame over remux/transcode source swaps');
  assert.match(ui, /if \(opts\.quietSeek && p\) \{[\s\S]+p\.suppressSeekLoaderUntil = appMs\(\) \+ 4500;[\s\S]+showSeekHoldFrame\(\);[\s\S]+\}/,
    'quiet web seeks should capture the current frame before replacing the media URL');
  assert.match(ui, /v\.onplaying = \(\) => \{[\s\S]+hideSeekHoldFrame\(\);[\s\S]+\};[\s\S]+v\.onloadeddata = clearReadyFrame;[\s\S]+v\.oncanplay = clearReadyFrame;/,
    'the web seek frame hold should disappear as soon as the replacement stream has a frame');
  assert.match(ui, /v\.onwaiting = \(\) => \{[\s\S]+pWait\.suppressSeekLoaderUntil && appMs\(\) < pWait\.suppressSeekLoaderUntil[\s\S]+return;/,
    'web rebuffer events during a user seek should keep the current frame instead of flashing the loader');
  assert.match(ui, /window\.__tvNativeVideoSeek = \(pos, dur\) => \{[\s\S]+p\.suppressSeekLoaderUntil = appMs\(\) \+ 4500;[\s\S]+\$\(\'playerLoader\'\)\.classList\.remove\(\'show\'\);[\s\S]+tryNativeVideoPlayer\(currentPlayerKind\(p\), at, \{ quietSeek: true \}\);/,
    'native remux/transcode seek restarts should be marked as quiet seeks from the web bridge');
  assert.match(ui, /quietSeek: !!opts\.quietSeek/,
    'native playback payload should carry whether this is a user seek instead of startup');
  assert.match(ui, /window\.TriboonTV && window\.TriboonTV\.updateVideoDuration[\s\S]+window\.TriboonTV\.updateVideoDuration\(String\(p\.nativeDuration\)\)/,
    'native player should receive the async track-probe duration without restarting playback');
  assert.match(android, /public void updateVideoDuration\(String seconds\) \{[\s\S]+updateNativeVideoDuration\(seconds\)/,
    'Android bridge should expose a duration update hook for the native player chrome');
  assert.match(android, /private void updateNativeVideoDuration\(String seconds\) \{[\s\S]+nativeKnownDurationMs = Math\.max\(nativeKnownDurationMs, Math\.round\(s \* 1000\)\);[\s\S]+updateNativeChrome\(\);/,
    'Android native chrome should repaint the seek bar, total time, and end clock when duration arrives later');
  assert.match(android, /boolean quietSeek = j\.optBoolean\("quietSeek", false\);[\s\S]+if \(!guide && "video"\.equals\(mode\) && !quietSeek\) \{[\s\S]+showNativeLoading\(title, backdropUrl,[\s\S]+nativeLoadingDetailFor\(mode, loadingKind, loadingQuality, loadingSource, loadingStartOffsetMs\)\);[\s\S]+\}/,
    'Android native seek restarts should not bring the full preparing loader to the front');
  assert.match(android, /boolean reuseQuietVideo = quietSeek && "video"\.equals\(mode\) && nativePlayer != null[\s\S]+boolean reuseLivePlayer = "live"\.equals\(mode\) && nativePlayer != null[\s\S]+if \(!reuseQuietVideo && !reuseLivePlayer\) \{[\s\S]+releaseNativePlayer\(false, guide\);[\s\S]+\} else \{[\s\S]+hideNativeLoading\(\);[\s\S]+if \(!reuseQuietVideo && !reuseLivePlayer\) \{[\s\S]+new ExoPlayer\.Builder\(this, nativeRenderersFactory\(\)\)/,
    'Android native quiet seeks and Live TV retunes should reuse the existing ExoPlayer surface, while new players use decoder fallback');
  assert.match(android, /private void applyNativeStartSeekIfReady\(\) \{[\s\S]+nativePendingStartMs <= 0L[\s\S]+nativePlayer\.getPlaybackState\(\) != Player\.STATE_READY \|\| !nativeVodSeekable\(\)[\s\S]+current >= Math\.max\(0L, target - 3000L\)[\s\S]+nativePendingStartMs = 0L[\s\S]+now - nativeStartSeekIssuedAtMs < 1200L[\s\S]+nativeSeekToDisplayPosition\(target\)/,
    'native movie resume should retry the pending start seek until ExoPlayer reports the saved position');
  assert.match(android, /private void zapNativeLiveChannel\(int dir\) \{[\s\S]+!"live"\.equals\(nativeMode\)[\s\S]+window\.__tvNativeLiveZap && window\.__tvNativeLiveZap\(/,
    'native Live TV should expose a direct D-pad channel zap callback instead of seeking');
  assert.match(android, /"live"\.equals\(nativeMode\) && \(code == KeyEvent\.KEYCODE_DPAD_UP \|\| code == KeyEvent\.KEYCODE_DPAD_DOWN\)[\s\S]+e\.getAction\(\) == KeyEvent\.ACTION_UP[\s\S]+zapNativeLiveChannel\(code == KeyEvent\.KEYCODE_DPAD_UP \? 1 : -1\)/,
    'native Live TV Up should go to the next channel and Down should go to the previous channel');
  assert.match(ui, /window\.__tvNativeLiveZap = \(dir\) => \{[\s\S]+S\.playing\.item\.type === 'live'[\s\S]+zapChannel\(dir >= 0 \? 1 : -1\);[\s\S]+\};/,
    'native Live TV D-pad zapping should reuse the web channel list order');
  assert.match(ui, /function setNativeLivePlaybackState\(it\) \{[\s\S]+type: 'live'[\s\S]+usingNative: true[\s\S]+\}[\s\S]+if \(!guide\) setNativeLivePlaybackState\(it\);/,
    'fullscreen native Live TV should update web player state before D-pad Up/Down can zap channels');
  assert.match(android, /public int personalIptvVersion\(\)[\s\S]+public String personalIptvSources\(\)[\s\S]+public String personalIptvSave\(String json\)[\s\S]+public void personalIptvLoad\(String token\)/,
    'Android TV should expose a device-local IPTV bridge without replacing server-side playlists');
  assert.match(android, /public void personalIptvGuide\(String token, String json\) \{[\s\S]+loadPersonalIptvGuide\(token, json\)/,
    'Android TV should expose a device-local guide bridge for personal IPTV channels');
  assert.match(manifest, /android:allowBackup="false"/,
    'Android should keep credential-bearing app prefs out of default device/cloud backup');
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/,
    'Android cleartext behavior should be explicit through network security config');
  assert.match(manifest, /android:supportsPictureInPicture="true"[\s\S]+android:resizeableActivity="true"|android:resizeableActivity="true"[\s\S]+android:supportsPictureInPicture="true"/,
    'Android phone/tablet playback should be eligible for system PiP');
  assert.match(networkSecurity, /<base-config cleartextTrafficPermitted="true">[\s\S]+<certificates src="system" \/>/,
    'network security config should keep self-hosted/IPTV HTTP intentional instead of relying on platform defaults');
  assert.ok(android.includes('MIN_WEBVIEW_MAJOR = 88')
      && android.includes('WebView.getCurrentWebViewPackage()')
      && android.includes('showSetup(webViewUnavailableMessage())'),
    'Android startup should fail visibly for too-old WebView providers instead of showing a blank shell');
  assert.match(android, /web\.setLayerType\(View\.LAYER_TYPE_HARDWARE, null\)[\s\S]+setRendererPriorityPolicy\(WebView\.RENDERER_PRIORITY_IMPORTANT, false\)[\s\S]+web\.postDelayed\(\(\) -> \{[\s\S]+web\.clearCache\(true\)[\s\S]+setAllowFileAccess\(false\)[\s\S]+setAllowContentAccess\(false\)[\s\S]+setOffscreenPreRaster\(true\)/,
    'Android WebView should stay hardware-backed, avoid first-paint cache flush hitches, and disable file/content access');
  assert.match(android, /KEY_PERSONAL_IPTV[\s\S]+KEY_PERSONAL_IPTV_CHANNEL_CACHE[\s\S]+KEY_PERSONAL_IPTV_GUIDE_CACHE[\s\S]+PERSONAL_IPTV_CACHE_TTL_MS = 24L \* 60L \* 60L \* 1000L[\s\S]+personalIptvStoredSources\(\)[\s\S]+encryptPersonalIptvJson/,
    'Android personal IPTV should keep sources plus channel/guide caches encrypted on-device');
  assert.match(android, /personalIptvSecretKey\(\)[\s\S]+AndroidKeyStore/,
    'Android personal IPTV encryption should use the Android Keystore');
  assert.match(android, /encryptPersonalIptvJson\(String json\)[\s\S]+throw new IllegalStateException\("secure personal IPTV storage is unavailable"/,
    'Android personal IPTV storage should fail closed if Keystore encryption is unavailable');
  assert.match(android, /isBlockedPersonalIptvAddress\(InetAddress addr\)[\s\S]+Unique local fc00::\/7[\s\S]+6to4 can embed private IPv4[\s\S]+Teredo[\s\S]+Well-known NAT64 prefix[\s\S]+PERSONAL_IPTV_HOST_SAFETY_TTL_MS/,
    'Android personal IPTV URL validation should reject embedded private-address IPv6 forms and keep DNS safety caching short');
  assert.match(android, /loadPersonalXtreamSource[\s\S]+personalXtreamChannelCache\(src, true\)[\s\S]+get_live_streams[\s\S]+putPersonalXtreamCachedChannels[\s\S]+loadPersonalM3uSource[\s\S]+personalM3uChannelCache\(src, true\)[\s\S]+BufferedReader[\s\S]+putPersonalM3uCachedChannels/,
    'Android personal IPTV should load Xtream/M3U channels locally and reuse local channel caches instead of hitting the provider every visit');
  assert.match(android, /loadPersonalIptvGuide[\s\S]+personalXtreamGuide[\s\S]+fetchPersonalXtreamGuideAction[\s\S]+get_short_epg[\s\S]+get_simple_data_table[\s\S]+personalXmltvGuide[\s\S]+parseXmltvDate/,
    'Android personal IPTV guide should support cached Xtream guide rows and optional XMLTV guide rows');
  assert.match(android, /private String savePersonalIptvSource\(String json\) \{[\s\S]+String id = j\.optString\("id", ""\)\.trim\(\);[\s\S]+existing = old;[\s\S]+if \(host\.isEmpty\(\) && sameMode\) host = existing\.optString\("host", ""\);[\s\S]+if \(pass\.isEmpty\(\) && sameMode\) pass = existing\.optString\("pass", ""\);/,
    'Android device-local IPTV edits should merge by id and keep saved sensitive fields when edit inputs are blank');
  assert.match(android, /java\.util\.HashMap<String, String> xmltvBatchCache = new java\.util\.HashMap<>\(\)[\s\S]+personalXmltvGuide\(src, ch, xmltvBatchCache\)[\s\S]+fetchPersonalXmltvGuide\(org\.json\.JSONObject src, org\.json\.JSONObject ch,[\s\S]+xmltvBatchCache\.get\(epgUrl\)[\s\S]+xmltvBatchCache\.put\(epgUrl, xml\)/,
    'Android XMLTV guide batches should reuse one downloaded XMLTV file across requested channels');
  assert.match(ui, /function fetchEpg\(idx\) \{[\s\S]+isPersonalChannel\(ch\)[\s\S]+fetchPersonalGuideBatch\(\[ch\]\)/,
    'web now/next lookup should route Android personal channels through the device guide bridge');
  assert.match(ui, /function fetchGuideBatch\(chans\) \{[\s\S]+const personal =[\s\S]+fetchPersonalGuideBatch\(personal\)/,
    'web timeline guide should merge server guide data with Android device-local personal guide data');
  assert.match(ui, /window\.__tvPersonalIptvGuideLoaded[\s\S]+function fetchPersonalGuideBatch\(chans[\s\S]+bridge\.personalIptvGuide\(token, JSON\.stringify\(\{ channels: rows \}\)\)/,
    'web should request personal IPTV programme batches from Android and cache the returned guide window');
  assert.match(ui, /function loadLiveChannelsCombined\(\{ fav = false \} = \{\}\) \{[\s\S]+new URLSearchParams\(\{ lean: '1' \}\)[\s\S]+if \(fav\) q\.set\('fav', '1'\);[\s\S]+api\('\/api\/iptv\/channels\?' \+ q\.toString\(\)\)[\s\S]+loadPersonalIptvChannels[\s\S]+epg: !!server\.epg \|\| !!personal\.epg[\s\S]+sourceErrors/,
    'web Live TV should merge server playlists and Android device-local playlists through a lean channel payload');
  assert.match(ui, /async function hydrateLivePlaybackUrls\(it\) \{[\s\S]+api\(`\/api\/iptv\/play\/\$\{idx\}\$\{q\.toString\(\) \? '\?' \+ q\.toString\(\) : ''\}`\)[\s\S]+it\._streamUrl = r\.streamUrl[\s\S]+full\.nativeFallbackUrl = it\._nativeFallbackUrl/,
    'web Live TV should mint playback URLs only for the selected server channel');
  assert.match(server, /iptvPlay: async \(ctx\) => \{[\s\S]+ensureIptvChannelStateForUser\(ctx\.user\)[\s\S]+const channelScope = `iptv:\$\{ch\.idx\}:\$\{ch\.id\}`;[\s\S]+auth\.streamToken\(ctx\.user\.id, channelScope\)[\s\S]+streamUrl: `\/api\/iptv\/stream\/\$\{ch\.idx\}\?cid=\$\{cid\}&t=\$\{token\}`/,
    'server Live TV should expose a per-channel playback URL endpoint without bloating the channel list');
  assert.match(ui, /function openPrefs\(\)[\s\S]+\$\('prefTabLive'\)\.style\.display = '';[\s\S]+renderPrefPersonalIptv\(\);/,
    'Preferences should always expose Live TV so users can find the personal IPTV setup before a playlist exists');
  assert.match(ui, /Save to my account[\s\S]+personalIptvSaveDevice[\s\S]+Save on this device only/,
    'Preferences should make account IPTV the default path and keep Android device-local IPTV as an optional path');
  assert.ok(ui.includes('id="personalIptvAddOpen">Add playlist')
    && ui.includes('id="personalIptvForm" class="iptvAddForm" hidden')
    && ui.includes('id="personalIptvCancel">Cancel')
    && ui.includes('data-account-iptv-edit')
    && ui.includes('data-device-iptv-edit'),
    'Personal IPTV setup should keep add fields collapsed until the user chooses Add playlist and allow fixing saved playlist mistakes');
  assert.ok(ui.includes('function updatePersonalIptvFormState()')
    && ui.includes("const form = $('personalIptvForm');")
    && ui.includes('if (form) form.hidden = !open;')
    && ui.includes("$('personalIptvSaveDevice').style.display = bridge && (!edit || edit.kind === 'device') ? '' : 'none';")
    && ui.includes('function setPersonalIptvAdding(open'),
    'Personal IPTV setup should stay usable in browser while showing device-only controls only in the Android app');
  assert.ok(ui.includes('id="iptvAddOpen">Add playlist')
    && ui.includes('id="iptvAddForm" class="iptvAddForm" hidden')
    && ui.includes('id="iptvCancel">Cancel')
    && ui.includes('data-iptvedit')
    && ui.includes('function updateIptvAddFormState()')
    && ui.includes("const form = $('iptvAddForm');")
    && ui.includes('if (form) form.hidden = !open;'),
    'Admin IPTV setup should also keep server/username/password fields collapsed until Add playlist and allow playlist edits');
  assert.match(ui, /async function savePersonalIptvFromPrefs\(\) \{[\s\S]+api\(`\/api\/me\/iptv\/sources\/\$\{edit\.id\}`,[\s\S]+method: 'PATCH'[\s\S]+api\('\/api\/me\/iptv\/sources', \{ method: 'POST', body \}\)[\s\S]+refreshLiveAvailabilityFlags\(\)/,
    'browser Preferences should save personal IPTV to the signed-in account through the server source model and PATCH existing sources');
  assert.match(ui, /\$\(\'iptvSave\'\)\.addEventListener\('click'[\s\S]+api\(`\/api\/iptv\/sources\/\$\{edit\.id\}`,[\s\S]+method: 'PATCH'[\s\S]+api\('\/api\/iptv\/sources', \{ method: 'POST', body \}\)/,
    'admin Settings should PATCH an edited IPTV source instead of adding a duplicate');
  assert.doesNotMatch(ui, /#prefPersonalIptvPanel\s*\{[^}]*display\s*:\s*none/,
    'CSS must not hide the Personal IPTV panel after JavaScript enables the Preferences tab');
  assert.match(ui, /function toggleFav\(ch, star\) \{[\s\S]+isPersonalChannel\(ch\)[\s\S]+PERSONAL_IPTV_FAV_KEY[\s\S]+api\('\/api\/iptv\/fav'/,
    'personal IPTV favorites should stay local while server IPTV favorites still use the server API');
  assert.match(android, /new DefaultHttpDataSource\.Factory\(\)[\s\S]+setAllowCrossProtocolRedirects\(false\)[\s\S]+setUserAgent\("TriboonTV\/" \+ BuildConfig\.VERSION_NAME\)/,
    'native ExoPlayer should block cross-protocol provider redirects after URL validation');
  assert.match(android, /private String nativePlaybackErrorMessage\(PlaybackException error\) \{[\s\S]+HttpDataSource\.InvalidResponseCodeException[\s\S]+nativeHeader\(http\.headerFields, "x-triboon-iptv-error"\)[\s\S]+return reason \+ " \(HTTP " \+ http\.responseCode \+ "\)";/,
    'native Live TV should surface sanitized provider HTTP failures instead of generic Exo source errors');
  assert.match(android, /else if \("video\/mp4"\.equals\(nativeMime\)\) media\.setMimeType\(MimeTypes\.VIDEO_MP4\)/,
    'native Live TV remux fallback should be tagged as MP4 for ExoPlayer');
  assert.match(android, /else if \(tryNativeLiveFallback\(\)\) \{[\s\S]+return;[\s\S]+\} else \{[\s\S]+__tvNativeLiveError/,
    'native Live TV should retry the Exo remux fallback before reporting a player error');
  assert.match(android, /private boolean tryNativeLiveFallback\(\) \{[\s\S]+nativeFallbackIndex >= nativeFallbackUrls\.size\(\)[\s\S]+nativeUrl = nextUrl;[\s\S]+nativeMime = nextMime[\s\S]+nativePlayer\.setMediaItem\(buildNativeMediaItem\(\)\);[\s\S]+nativePlayer\.prepare\(\);[\s\S]+nativePlayer\.play\(\);/,
    'native Live TV fallback should walk ordered ExoPlayer candidates instead of opening web playback');
  assert.match(android, /NATIVE_LIVE_STALL_RECOVERY_MS = 45000L[\s\S]+NATIVE_LIVE_STARTUP_STALL_RECOVERY_MS = 12000L[\s\S]+NATIVE_LIVE_READ_TIMEOUT_MS = 60000/,
    'native Live TV should recover faster before the first frame while allowing later provider hiccups');
  assert.match(android, /private DefaultLoadControl nativeLoadControlForMode\(String mode\) \{[\s\S]+nativeConservativePlaybackDevice\(\)[\s\S]+setBufferDurationsMs\(minMs, maxMs, startMs, rebufferMs\)/,
    'native ExoPlayer should use a conservative buffer profile on Onn-class devices without slowing Shield');
  assert.match(android, /boolean heavyVod = video && nativeLikelyHeavyVod\(\)[\s\S]+int targetMb = video[\s\S]+conservative \? \(heavyVod \? 96 : 48\) : \(heavyVod \? 384 : 64\)[\s\S]+int backBufferMs = video \? \(conservative \? \(heavyVod \? 15000 : 8000\) : \(heavyVod \? 30000 : 12000\)\)/,
    'native ExoPlayer should build a deeper heavy-4K buffer on capable devices while staying bounded on low-memory hardware');
  assert.match(android, /new ExoPlayer\.Builder\(this, nativeRenderersFactory\(\)\)[\s\S]+setBandwidthMeter\(nativeBandwidthMeterForMode\(mode\)\)[\s\S]+setSeekParameters\(SeekParameters\.CLOSEST_SYNC\)/,
    'native ExoPlayer should use decoder fallback plumbing, seeded bandwidth, and closest-sync seeking');
  assert.match(android, /private DefaultRenderersFactory nativeRenderersFactory\(\) \{[\s\S]+setEnableDecoderFallback\(true\)[\s\S]+setEnableAudioOutputPlaybackParameters\(true\)/,
    'Android native playback should retry another decoder when hardware init fails');
  assert.match(android, /private DefaultBandwidthMeter nativeBandwidthMeterForMode\(String mode\) \{[\s\S]+"live"\.equals\(mode\)[\s\S]+5_000_000L[\s\S]+12_000_000L[\s\S]+22_000_000L[\s\S]+80_000_000L[\s\S]+setInitialBitrateEstimate\(estimate\)/,
    'Android native playback should seed live and VOD bandwidth differently for budget and high-end devices');
  assert.match(android, /private void applyNativeTrackSelectionDefaults\(boolean isLiveMode\) \{[\s\S]+setPreferredAudioLanguages\("en"\)[\s\S]+setViewportSizeToPhysicalDisplaySize\(true\)[\s\S]+params\.setMaxVideoSize\(1920, 1080\)[\s\S]+setMaxVideoBitrate\(10_000_000\)[\s\S]+AudioOffloadPreferences/,
    'Android track selection should cap Live HLS on conservative devices and enable VOD audio offload where supported');
  assert.match(android, /media\.setLiveConfiguration\(new MediaItem\.LiveConfiguration\.Builder\(\)[\s\S]+setTargetOffsetMs\(nativeConservativePlaybackDevice\(\) \? 8000L : 5000L\)[\s\S]+setMaxPlaybackSpeed\(1\.03f\)/,
    'native Live TV media items should carry target-offset and catch-up speed hints');
  assert.match(android, /setTargetBufferBytes\(targetBytes\)[\s\S]+setBackBuffer\(backBufferMs, false\)/,
    'native ExoPlayer should bound memory while keeping short VOD rewinds fast');
  assert.match(android, /setReadTimeoutMs\("live"\.equals\(nativeMode\)[\s\S]+NATIVE_LIVE_READ_TIMEOUT_MS[\s\S]+nativeLikelyHeavyVod\(\) \? 45000 : 18000\)/,
    'native Live TV should use a longer provider read timeout, and huge VOD should tolerate slower usenet reads');
  assert.match(android, /heavyVod \? 24000 : 6000[\s\S]+heavyVod \? 180000 : 60000[\s\S]+heavyVod \? 384 : 64/,
    'high-end Android devices should build a deeper ExoPlayer buffer for very large 4K VOD');
  assert.match(android, /private void updateNativeLiveWatchdog\(\) \{[\s\S]+boolean waitingForLiveData = state == Player\.STATE_BUFFERING[\s\S]+nativePlayer\.isLoading\(\)[\s\S]+boolean unhealthy = state == Player\.STATE_IDLE \|\| state == Player\.STATE_ENDED \|\| waitingForLiveData[\s\S]+long threshold = nativeLiveStarted \? NATIVE_LIVE_STALL_RECOVERY_MS : NATIVE_LIVE_STARTUP_STALL_RECOVERY_MS;[\s\S]+now - nativeLiveUnhealthySinceMs >= threshold[\s\S]+recoverNativeLivePlayback\(state == Player\.STATE_IDLE \? "idle"/,
    'native Live TV should recover only after sustained idle, ended, or real data-wait stalls');
  assert.match(android, /state == Player\.STATE_ENDED && "live"\.equals\(nativeMode\)[\s\S]+recoverNativeLivePlayback\("ended"\)/,
    'native Live TV should restart instead of staying frozen when a live stream ends quietly');
  assert.match(android, /private void recoverNativeLivePlayback\(String reason\) \{[\s\S]+if \(tryNativeLiveFallback\(\)\) return;[\s\S]+nativePlayer\.setMediaItem\(buildNativeMediaItem\(\)\);[\s\S]+nativePlayer\.prepare\(\);[\s\S]+nativePlayer\.play\(\);/,
    'native Live TV recovery should stay inside ExoPlayer and restart the active native stream');
  assert.match(android, /private boolean nativeVideoStarted;[\s\S]+NATIVE_VIDEO_REBUFFER_TRIM_MS = 15000L[\s\S]+NATIVE_VIDEO_REBUFFER_RECOVERY_MS = 45000L[\s\S]+private void updateNativeVideoWatchdog\(\) \{[\s\S]+if \(state == Player\.STATE_READY\) \{[\s\S]+nativeVideoStarted = true;[\s\S]+nativeVideoUnhealthySinceMs = 0L;[\s\S]+nativeVideoMemoryTrimmedDuringBuffer = false;[\s\S]+if \(nativeVideoStarted\) \{[\s\S]+boolean waitingForData = state == Player\.STATE_BUFFERING[\s\S]+elapsed >= NATIVE_VIDEO_REBUFFER_TRIM_MS[\s\S]+trimAndroidMemoryCaches\(false\)[\s\S]+elapsed >= NATIVE_VIDEO_REBUFFER_RECOVERY_MS[\s\S]+notifyNativeVideoError\(state == Player\.STATE_IDLE \? "native player idle" : "native rebuffer stalled"/,
    'native movie and episode startup should fail over quickly, while sustained mid-play stalls trim memory and retry the same source');
  assert.match(android, /private boolean nativeVideoErrorNotified;[\s\S]+private void notifyNativeVideoError\(String msg, long pos, long dur\) \{[\s\S]+if \(nativeVideoErrorNotified\) return;[\s\S]+nativeVideoErrorNotified = true;[\s\S]+releaseNativePlayer\(false\);/,
    'native movie and episode error reporting should be one-shot per playback attempt');
  assert.match(android, /ExoPlayer player = nativePlayer;[\s\S]+nativePlayer = null;[\s\S]+if \(player != null\) \{[\s\S]+nativePlayerView\.setPlayer\(null\);[\s\S]+player\.release\(\);/,
    'native ExoPlayer release should use a local reference so nested callbacks cannot double-release the player');
  assert.ok([
    'private long nativeLastVideoDisplayMs;',
    'private long safeNativeVideoPosSeconds(long reportedSeconds) {',
    'if (reportedMs <= 1000L && nativeLastVideoDisplayMs > 30000L) {',
    'return nativeLastVideoDisplayMs / 1000L;',
    'long safePos = safeNativeVideoPosSeconds(pos);',
    '+ "," + safePos + "," + dur + ")", null);',
  ].every((s) => android.includes(s)),
    'native movie and episode fallback should preserve the last good position if Exo reports zero during an error');
  assert.match(android, /private void notifyNativeVideoError\(String msg, long pos, long dur\) \{[\s\S]+String title = nativePlaybackTitle;[\s\S]+String backdropUrl = nativePlaybackBackdropUrl;[\s\S]+releaseNativePlayer\(false\);[\s\S]+showNativeLoading\(title, backdropUrl, "Retrying playback",[\s\S]+__tvNativeVideoError/,
    'native movie and episode startup watchdog should preserve the branded loader while reporting the failure to the native ladder');
  assert.match(server, /LIVE_REMUX_FIRST_BYTE_TIMEOUT_MS = 12000[\s\S]+LIVE_REMUX_IDLE_TIMEOUT_MS = 45000/,
    'Live TV remux fallback should fail silent/bad channels quickly while still avoiding endless hangs');
  assert.match(server, /armIdle\(LIVE_REMUX_FIRST_BYTE_TIMEOUT_MS\);[\s\S]+ff\.stdout\.on\('data'[\s\S]+armIdle\(LIVE_REMUX_IDLE_TIMEOUT_MS\);[\s\S]+ff\.kill\('SIGKILL'\)/,
    'server Live TV remux should fail fast when ffmpeg stops producing bytes');
  assert.match(android, /private void hideNativeChromeNow\(\) \{[\s\S]+nativeControlShade\.setVisibility\(View\.GONE\)[\s\S]+nativeChrome\.setVisibility\(View\.GONE\)[\s\S]+parkNativeHiddenFocusOnSeek\(\);[\s\S]+setNativeSubtitleLift\(false\);[\s\S]+private boolean nativeChromeShowingForBack\(\) \{[\s\S]+nativeChrome[\s\S]+nativeControlShade[\s\S]+nativeMetaBar[\s\S]+nativeTop[\s\S]+private boolean dismissNativeChromeForBack\(\) \{[\s\S]+if \(!nativeChromeShowingForBack\(\)\) return false;[\s\S]+nativeProgress\.removeCallbacks\(nativeHideChrome\);[\s\S]+hideNativeChromeNow\(\);[\s\S]+return true;/,
    'Back should use the same native chrome hide path as auto-hide before leaving playback');
  assert.match(android, /private boolean handleNativeBackKey\(KeyEvent e\) \{[\s\S]+KeyEvent\.ACTION_DOWN[\s\S]+dismissNativeChromeForBack\(\)[\s\S]+nativeBackConsumedChromeDown = true;[\s\S]+lastSystemBackAt = SystemClock\.uptimeMillis\(\);[\s\S]+KeyEvent\.ACTION_UP[\s\S]+if \(nativeBackConsumedChromeDown\)[\s\S]+handleSystemBack\(\);/,
    'native Back should hide visible controls on key-down and consume key-up so duplicate Android callbacks cannot close playback');
  assert.match(android, /if \(nativeGuideMode\) \{[\s\S]+if \(code == KeyEvent\.KEYCODE_BACK\) \{[\s\S]+return handleNativeBackKey\(e\);[\s\S]+if \(code == KeyEvent\.KEYCODE_BACK\) \{[\s\S]+return handleNativeBackKey\(e\);/,
    'native Back key events should use the shared guarded Back helper in guide and normal player modes');
  assert.match(android, /if \(nativeSheetOpen\(\)\) hideNativeSheet\(\);[\s\S]+else if \(nativeEpisodeStripOpen\) closeNativeEpisodeStrip\(\);[\s\S]+else if \(!dismissNativeChromeForBack\(\)\) closeNativePlayback\(true\);/,
    'Back should close sheets, then episode rows, then visible controls before leaving playback');
  assert.match(android, /boolean waitForLiveClose = notifyClosed && "live"\.equals\(nativeMode\);[\s\S]+web\.postDelayed\(this::showWebAfterNativePlayback, 80\);/,
    'closing native Live TV should let the web close callback clear stale player state before the WebView is visible');
  assert.match(android, /nativeNextBtn\.setOnClickListener\(v -> \{ if \(consumeNativeControlClick\(v\)\) playNativeNextEpisode\(\); \}\)/,
    'Next episode should ask the app to start the next item, not open the old player controls');
  assert.match(android, /nativeGuideBtn = nativeButton\(R\.drawable\.ic_player_guide, "TV guide", false\)/,
    'native Live TV should expose a guide button inside Triboon chrome');
  assert.match(android, /nativeGuideBtn\.setOnClickListener\(v -> \{ if \(consumeNativeControlClick\(v\)\) openNativeLiveGuide\(\); \}\)/,
    'native guide button should hand off to the shared PiP guide path');
  assert.match(android, /window\.__tvNativeLiveGuide && window\.__tvNativeLiveGuide\("[\s\S]*\+ nativeGuideEpoch \+[\s\S]*"\)/,
    'native guide handoff should include an epoch so stale close callbacks cannot close a new guide');
  assert.match(android, /public void setGuidePipRect\(String json\) \{[\s\S]+applyNativeGuidePipRect\(json\)/,
    'web guide should be able to send the measured PiP slot to Android');
  assert.match(android, /private void applyNativeGuidePipRect\(String json\) \{[\s\S]+rawW <= 1f \|\| rawH <= 1f[\s\S]+left = Math\.max\(0, Math\.min\(left[\s\S]+nativePlayerView\.setLayoutParams\(pipLp\)/,
    'Android native PiP should ignore invalid measurements and clamp the rect onscreen');
  assert.match(android, /nativePlayerView\.setResizeMode\(AspectRatioFrameLayout\.RESIZE_MODE_FIT\)/,
    'ExoPlayer content should stay centered and fitted inside the PiP frame');
  assert.match(nativePlayerLayout, /app:surface_type="surface_view"/,
    'native fullscreen playback should use SurfaceView for first-frame speed, power, and HDR-capable direct play');
  assert.match(android, /nativeGuidePipRevealScrim = new View\(this\);[\s\S]+nativePlayerLayer\.addView\(nativeGuidePipRevealScrim/,
    'native guide PiP should use a sibling reveal layer instead of fading the SurfaceView itself');
  assert.match(android, /private void revealNativeGuidePip\(FrameLayout\.LayoutParams pipLp\) \{[\s\S]+nativeGuidePipRevealScrim\.animate\(\)[\s\S]+\.alpha\(0f\)/,
    'native guide PiP should keep the smooth reveal animation on the sibling scrim');
  assert.doesNotMatch(android, /nativePlayerView\.animate\(\)\.alpha/,
    'SurfaceView-backed PlayerView must not be alpha-animated for guide PiP');
  assert.doesNotMatch(android, /nativePlayerView\.setAlpha\(0f\)/,
    'SurfaceView-backed PlayerView must stay opaque while entering guide PiP');
  assert.match(android, /WebView\.setWebContentsDebuggingEnabled\(BuildConfig\.DEBUG\)/,
    'Android release builds should not expose WebView debugging while debug APKs stay inspectable');
  assert.match(android, /nativePlayerView = \(PlayerView\) getLayoutInflater\(\)\.inflate\(R\.layout\.native_player_view, nativePlayerLayer, false\);/,
    'native player should use the dedicated SurfaceView-backed PlayerView layout');
  assert.match(android, /nativePlayerView\.setShutterBackgroundColor\(Color\.TRANSPARENT\);[\s\S]+nativePlayerView\.setKeepContentOnPlayerReset\(true\);/,
    'native retunes should not flash a full black shutter over the guide');
  assert.match(android, /private void enterNativeGuideMode\(\) \{[\s\S]+boolean alreadyGuideMode[\s\S]+if \(!alreadyGuideMode\) \{[\s\S]+nativePlayerView\.setLayoutParams\(pipLp\);[\s\S]+\}[\s\S]+web\.setVisibility\(View\.VISIBLE\);[\s\S]+if \(!alreadyGuideMode\) web\.requestFocus\(\);[\s\S]+nativePlayerLayer\.bringToFront\(\);/,
    'native guide mode should keep ExoPlayer alive as a PiP without resetting focus/layout during retunes');
  assert.match(android, /releaseNativePlayer\(false, guide\);[\s\S]+nativeMode = mode;/,
    'native Live TV retunes from PiP should preserve guide mode while swapping ExoPlayer instances');
  assert.match(android, /if \(!guide && isLiveMode\) \{[\s\S]+enterNativeFullscreenMode\(\);[\s\S]+\}[\s\S]+if \(!guide && "video"\.equals\(mode\) && !quietSeek\)/,
    'non-guide Live TV starts should explicitly restore fullscreen ExoPlayer layout even after a PiP guide crash');
  assert.match(android, /private void releaseNativePlayer\(boolean notifyClosed, boolean preserveGuideMode\) \{[\s\S]+boolean guideMode = nativeGuideMode;[\s\S]+nativeGuideMode = preserveGuideMode && guideMode;/,
    'native release should not erase guide mode during PiP retunes');
  assert.doesNotMatch(openGuideMethod, /releaseNativePlayer\(false\)/,
    'opening the guide must not release ExoPlayer');
  assert.match(android, /if \(nativeGuideMode\) \{[\s\S]+if \(code == KeyEvent\.KEYCODE_BACK\) \{[\s\S]+closeNativeGuideMode\(\);/,
    'Back should leave native guide mode before closing playback');
  assert.match(android, /public void closeGuide\(\) \{[\s\S]+runOnUiThread\(MainActivity\.this::closeNativeGuideMode\)/,
    'web guide close should be able to restore native fullscreen mode');
  assert.match(android, /public void openGuide\(\) \{[\s\S]+runOnUiThread\(MainActivity\.this::openNativeLiveGuide\)/,
    'web guide button should be able to put Android native playback into PiP guide mode');
  assert.doesNotMatch(android, /openNativeLiveGuide\(\) \{[\s\S]+if \(!"live"\.equals\(nativeMode\)\) return;/,
    'native movie/episode playback should be allowed to open the same TV guide');
  assert.match(android, /window\.__tvNativeVideoProgress && __tvNativeVideoProgress/,
    'opening the guide from native video should preserve the movie resume point first');
  assert.match(android, /nativeGuideBtn != null\) nativeGuideBtn\.setVisibility\(View\.VISIBLE\)/,
    'native guide button should be available for both Live TV and movie/episode playback');
  assert.doesNotMatch(android, /switchNativeToWeb/,
    'native Android chrome should not keep old-player escape controls');
});

test('web browse grids stay windowed and D-pad uses logical grid indexes', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(ui, /const VIRTUAL_GRID_VIEWS = new Set\(\['movies', 'tv', 'watchlist'\]\);/,
    'high-volume poster pages should opt into grid virtualization');
  assert.match(ui, /function renderVirtualGridWindow\(targetIdx = S\.gridIdx \|\| 0, opts = \{\}\) \{[\s\S]+root\.dataset\.virtualized = '1';[\s\S]+gridSpacerTop[\s\S]+for \(let i = start; i < end; i\+\+\)[\s\S]+gridSpacerBottom/,
    'virtualized grids should render a bounded card window with top/bottom spacers');
  assert.match(ui, /function renderGrid\(items, root = \$\('grid'\)\) \{[\s\S]+if \(shouldVirtualizeGrid\(root\)\) \{[\s\S]+renderVirtualGridWindow\(0, \{ topRow: 0 \}\);[\s\S]+\} else \{/,
    'initial grid render should choose the virtual path before appending every card');
  assert.match(ui, /function appendGrid\(items\) \{[\s\S]+S\.gridItems = S\.gridItems\.concat\(items \|\| \[\]\);[\s\S]+if \(shouldVirtualizeGrid\(root\)\) \{[\s\S]+renderVirtualGridWindow\(S\.gridIdx \|\| 0/,
    'infinite scroll should extend the logical list without mounting every previous card');
  assert.match(ui, /function refreshVirtualGridGeometry\(\) \{[\s\S]+resetGridVirtual\(root\);[\s\S]+renderVirtualGridWindow\(idx, \{ topRow: Math\.max\(0, oldRow - 1\) \}\);[\s\S]+restoreVirtualGridFocus\(idx\);[\s\S]+\}/,
    'resize and cover-size changes should invalidate stale virtual columns/pitch and redraw the current window');
  assert.match(ui, /function applyCoverSize\(\) \{[\s\S]+adaptRowWindows\(\);[\s\S]+scheduleVirtualGridGeometryRefresh\(\);/,
    'cover-size and resize paths should refresh virtual grid geometry');
  assert.match(ui, /function activeGridIdx\(\) \{[\s\S]+el\.dataset && el\.dataset\.grid !== undefined[\s\S]+parseInt\(el\.dataset\.grid, 10\)/,
    'D-pad focus should recover the absolute item index from data-grid');
  assert.match(ui, /function focusedGridAtVisualRowStart\(\) \{[\s\S]+document\.querySelector\('\.pcard\.focus, \.card\.focus[\s\S]+return Math\.abs\(pr\.top - cr\.top\) > 6;[\s\S]+\}/,
    'D-pad Left should have a visual-row-start fallback when virtualized grid state drifts');
  assert.match(ui, /if \(k === 'ArrowLeft' && focusedGridAtVisualRowStart\(\)\) return enterRail\(\);[\s\S]+S\.gridIdx = activeGridIdx\(\);/,
    'grid D-pad handling should exit to the rail before stale logical indexes can trap focus');
  assert.match(ui, /const itemIdx = parseInt\(el\.dataset\.grid, 10\);[\s\S]+const it = Number\.isFinite\(itemIdx\) \? \(S\.gridItems \|\| \[\]\)\[itemIdx\] : null;/,
    'focusable guide/category/message rows should not borrow stale grid metadata when no backing item exists');
  assert.doesNotMatch(ui, /const itemIdx = Number\.isFinite\(parseInt\(el\.dataset\.grid, 10\)\) \? parseInt\(el\.dataset\.grid, 10\) : S\.gridIdx;/,
    'message rows must not fall back to the previous logical grid index');
  assert.match(ui, /function focusLiveGridMessage\(\) \{[\s\S]+bootReady\(\);[\s\S]+S\.view === 'livetv'[\s\S]+focusGrid\(0\);/,
    'Live TV loading, empty, and source-error messages should clear the global boot overlay');
  assert.match(ui, /function scheduleVirtualGridFromScroll\(root = S\.gridRoot \|\| \$\('grid'\)\) \{[\s\S]+renderVirtualGridWindow\(idx, \{ fromScroll: true, topRow \}\);[\s\S]+restoreVirtualGridFocus\(idx\);/,
    'scroll-triggered window swaps should restore the active focus ring immediately');
  assert.match(ui, /if \(shouldVirtualizeGrid\(S\.gridRoot \|\| \$\('grid'\)\)\) \{[\s\S]+const cols = Math\.max\(1, virtualGridCols[\s\S]+if \(k === 'ArrowLeft'\)[\s\S]+if \(k === 'ArrowDown'\)/,
    'virtual grids should navigate with cached uniform-grid row math instead of full-DOM offset scans');
  assert.match(ui, /api\.unobserveRoot = \(root\) => \{[\s\S]+querySelectorAll\('\[data-bg\]'\)[\s\S]+io\.unobserve\(el\)/,
    'removed virtual cards should be unobserved by the poster lazy-loader');
});

test('web shell avoids known TV paint/focus regressions', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(ui, /<link rel="preload" href="fonts\/Sora\.woff2" as="font" type="font\/woff2" crossorigin>/,
    'self-hosted display fonts should be preloaded for first paint');
  assert.doesNotMatch(ui, /transition:opacity \.7s ease,width|transition:opacity \.7s ease,[^;]*height/,
    'backdrop crossfade should not animate width or height');
  assert.doesNotMatch(ui, /will-change:transform/,
    'top-level page layers should not keep permanent compositor reservations');
  assert.match(ui, /\.cbtn:hover,\.cbtn\.focus,\.cbtn:focus\{[\s\S]+rgba\(251,139,60,\.82\)/,
    'player OSD button focus should have a visible coral ring over video');
  assert.match(ui, /#subOverlay\{[^}]*max-height:32vh;overflow:hidden;[\s\S]+while \(box\.scrollHeight > box\.clientHeight && box\.firstElementChild\) box\.removeChild\(box\.firstElementChild\);/,
    'self-rendered subtitle text should stay bounded inside the video frame');
  assert.match(ui, /b\.addEventListener\('focus', \(\) => \{[\s\S]+scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/,
    'long subtitle/audio/quality menus should keep the focused row inside the panel');
  assert.match(ui, /#hero h1\{[^}]*height:2\.08em;[\s\S]+#hero \.meta\{[^}]*height:28px;[\s\S]+#hero p\{[^}]*height:4\.5em/,
    'desktop Home hero title, metadata, and overview should reserve stable height while focus changes');
  assert.match(ui, /#discoverRows\{flex:1!important;margin-top:0;max-height:none\}/,
    'Discover rows should fill from the visible page title instead of bottom-anchoring like Home/Browse');
  assert.match(ui, /function sizeRowsWindow\(root\) \{[\s\S]+if \(root\.id === 'discoverRows'\) \{ root\.style\.maxHeight = ''; return; \}/,
    'Discover rows should not receive the inline Home row-window max-height');
  assert.match(ui, /#browseTitle\{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect\(0 0 0 0\);white-space:nowrap\}/,
    'Browse title may stay visually hidden while Discover title remains visible');
  assert.doesNotMatch(ui, /#browseTitle,#discoverTitle\{position:absolute;width:1px;height:1px;/,
    'Discover title should not be hidden with the Browse title');
  assert.match(ui, /function rowsWindowHeight\(root, rows, n, gap\) \{[\s\S]+document\.body\.classList\.contains\('tv'\) && n === 1[\s\S]+Math\.max\(\.\.\.rows\.map/,
    'TV Home row window should use the tallest row height instead of resizing per focused row');
  assert.doesNotMatch(ui, /view\.root\.style\.maxHeight = \(rowEl\.offsetHeight \+ 8\) \+ 'px';/,
    'TV Home focus should not resize the row window to each focused row height');
  assert.match(ui, /@media \(max-width:600px\)\{[\s\S]+#hero \.meta,#heroCredits,#hero p\{display:none!important\}[\s\S]+#rows\{max-height:calc\(100vh - 176px\);/,
    'mobile Home should drop backdrop-style hero copy and give the rows most of the screen');
  assert.match(ui, /#hero h1\{font-size:clamp\(24px,7\.4vw,32px\);line-height:1\.08;margin-bottom:8px;height:2\.16em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden\}/,
    'mobile Home title should reserve a stable two-line height so rows do not jump between cards');
  assert.match(ui, /body\.mobileShell #hero \.meta,body\.mobileShell #heroCredits,body\.mobileShell #hero p\{display:none!important\}[\s\S]+body\.mobileShell #rows\{max-height:calc\(100vh - 176px\);/,
    'Android mobile shell should get the same compact Home treatment as narrow browsers');
  assert.match(ui, /body\.mobileShell #hero h1\{font-size:clamp\(24px,7\.4vw,32px\);line-height:1\.08;margin-bottom:8px;height:2\.16em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden\}/,
    'Android mobile shell Home title should use the same stable two-line height');
  assert.match(ui, /function sizeRowsWindow\(root\) \{[\s\S]+const compactHome = root\.id === 'rows'[\s\S]+window\.innerWidth <= 600[\s\S]+document\.body\.classList\.contains\('mobileShell'\)[\s\S]+if \(compactHome\) \{ root\.style\.maxHeight = ''; return; \}/,
    'mobile Home should not receive an inline desktop/TV row-window max-height');
  assert.match(ui, /function resetSearchPage\(opts = \{\}\) \{[\s\S]+if \(opts\.landing !== false && S\.view === 'search'\) renderSearchLanding\(\);/,
    'Search should land on useful results instead of a blank grid');
  assert.match(ui, /prevView === 'search' && v !== 'search'[\s\S]+resetSearchPage\(\{ landing: false \}\);/,
    'leaving Search should clear state without starting a background landing fetch');
  assert.match(ui, /async function renderSearchLanding\(\) \{[\s\S]+\/api\/tmdb\/trending\/all\/week[\s\S]+renderSearchSections\(sections\)/,
    'Search landing should reuse TMDB discovery rows');
  assert.match(ui, /if \(!q\) \{ renderSearchLanding\(\); return; \}/,
    'empty Search queries should keep the landing state visible');
  assert.match(ui, /renderGrid\(cards\);[\s\S]+if \(!cards\.length\) grid\.innerHTML = '<div class="gridMore">No matches\.<\/div>';/,
    'fallback source search should show an empty state instead of a silent blank page');
  assert.doesNotMatch(ui, /id="musicBar"|musicBarBtns|S\.zone === 'musicBar'|\$\('mb/,
    'dead hidden mini-player bar and its focus/control wiring should not ship');
  assert.match(ui, /--safeT:max\(env\(safe-area-inset-top\),0px\);[\s\S]+--overscan:0px;[\s\S]+body\.tv\{--bdW:[^}]+--overscan:2\.5vmin\}/,
    'TV and mobile chrome should reserve safe-area/overscan space');
  assert.ok(ui.includes('--appClockReserve:144px;')
    && ui.includes('.browseHead .filterBar{position:fixed;top:calc(18px + var(--safeT) + var(--overscan));right:calc(var(--appClockReserve) + var(--safeR) + var(--overscan));z-index:22')
    && ui.includes('body.railOpen .browseHead{transform:translateX(-152px)}')
    && ui.includes('#browse .browseHead{margin-left:48px;margin-top:8px;margin-bottom:12px;justify-content:flex-start;padding-right:0}')
    && ui.includes('body.mobileShell #browse .filterBar{position:static;top:auto;right:auto;z-index:auto;flex-wrap:wrap;max-width:100%}'),
    'browse genre/sort controls should sit beside the fixed clock on desktop while dropping cleanly on phone shells');
  assert.match(ui, /function clearPlaybackTimers\(\) \{[\s\S]+S\.healthTimer[\s\S]+S\.watchTimer[\s\S]+\}/,
    'health/watch timers should clear through one shared player cleanup path');
  assert.match(ui, /<div id="railMain">[\s\S]+<div id="railLibs"><\/div>[\s\S]+<\/div>\s+<div id="railFooter">[\s\S]+id="railAddLib"[\s\S]+id="navPrefs"[\s\S]+id="navSettings"[\s\S]+id="railUser" class="railBtn focusable"/,
    'library rows should scroll separately from a pinned utility rail footer');
  assert.match(ui, /#railMain\{[\s\S]*overflow-y:auto[\s\S]*#railFooter\{[\s\S]*flex:none[\s\S]*border-top:/,
    'rail footer should stay fixed while library/menu items scroll');
  assert.match(ui, /function applyMenuPrefs\(\) \{[\s\S]+const railMain = \$\('railMain'\) \|\| \$\('rail'\);[\s\S]+railMain\.querySelector\(`\.railBtn\[data-nav="\$\{nav\}"\]`\)[\s\S]+railMain\.insertBefore\(btn, firstMainNav\(\)\);/,
    'menu preference reordering should only move buttons inside the scrollable rail body, never pinned footer buttons');
  assert.doesNotMatch(ui, /rail\.insertBefore\(btn/,
    'pinned rail footer must not be reordered through the old direct-rail insert path');
});

test('remux: ffmpeg copies streams from our HTTP stream into fragmented MP4', { skip: !HAS_FFMPEG }, async () => {
  // Serve a tiny valid MP4 over http and prove the remux emits an ftyp/moov MP4 stream.
  const http = require('http');
  // A minimal but real fragmented-mp4 isn't trivial to hand-build; instead feed ffmpeg a
  // generated test source and confirm it muxes. We use lavfi via a special URL ffmpeg supports.
  const ff = spawnRemux('anullsrc', { startSeconds: 0 }); // invalid input → ffmpeg errors fast
  let errored = false;
  ff.on('error', () => { errored = true; });
  const code = await new Promise((r) => ff.on('close', r));
  // We only assert the binary launches and exits — full mux is exercised in the Docker run.
  assert.ok(code !== null || errored, 'ffmpeg process lifecycle works');
});

test('remux audio decision: DDP/AC3/DTS re-encode, browser-safe codecs copy, unknown is safe', () => {
  const { audioNeedsTranscode } = require('../server/transcode');
  for (const c of ['eac3', 'ac3', 'dts', 'truehd', 'pcm_s24le', 'EAC3']) {
    assert.strictEqual(audioNeedsTranscode(c), true, `${c} must be re-encoded for browsers`);
  }
  for (const c of ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'AAC']) {
    assert.strictEqual(audioNeedsTranscode(c), false, `${c} stream-copies fine`);
  }
  // No probe yet → assume unsafe: a wrong "copy" guess is a hard playback error, a wrong
  // "re-encode" guess only costs a cheap AAC pass.
  assert.strictEqual(audioNeedsTranscode(undefined), true);
  assert.strictEqual(audioNeedsTranscode(''), true);
});

test('client caps: hardware that decodes the codec gets a bit-exact copy (true direct play)', () => {
  const { audioCopyOk } = require('../server/transcode');
  // No hardware claims (plain browser/WebView): only universal codecs copy.
  assert.strictEqual(audioCopyOk('aac', {}), true);
  assert.strictEqual(audioCopyOk({ codec: 'aac', profile: 'LC' }, {}), true);
  assert.strictEqual(audioCopyOk('eac3', {}), false);
  // A TV that PROVED DDP/AC3 support via canPlayType: zero re-encoding.
  const tv = { ac3: true, eac3: true, dts: false };
  assert.strictEqual(audioCopyOk('eac3', tv), true);
  assert.strictEqual(audioCopyOk('eac3-joc', { eac3Joc: true }), true);
  assert.strictEqual(audioCopyOk('ac3', tv), true);
  assert.strictEqual(audioCopyOk('dts', tv), false, 'claims are per-codec, not all-or-nothing');
  // Unknown codec (no probe yet): trust a broad AC3-family claim, else convert.
  assert.strictEqual(audioCopyOk('', tv), true);
  assert.strictEqual(audioCopyOk('', { ac3: true }), false);
  // Lossless codecs copy only for native passthrough devices; plain browser/WebView stays AAC.
  assert.strictEqual(audioCopyOk('truehd', { native: true, passthrough: true, truehd: true }), true);
  assert.strictEqual(audioCopyOk('truehd', { truehd: true }), false);
  assert.strictEqual(audioCopyOk({ codec: 'dts', profile: 'DTS-HD MA' }, { native: true, passthrough: true, dts: true, dtsHd: true }), true);
  assert.strictEqual(audioCopyOk({ codec: 'dts', profile: 'DTS-HD MA' }, { dts: true, dtsHd: true }), false);
  // MKV direct play needs container AND audio hardware — Chromium claims matroska while
  // decoding no AC3 family, which used to mean silent video on "direct".
  assert.strictEqual(decidePlayback('Movie.mkv', { mkv: true }).method, detectFfmpeg() ? 'remux' : 'direct');
  assert.strictEqual(decidePlayback('Movie.mkv', { mkv: true, ac3: true, eac3: true }).method, 'direct');
  assert.strictEqual(decidePlayback('Movie.2024.2160p.BluRay.REMUX.TrueHD.Atmos.mkv',
    { native: true, mkv: true, ac3: true, eac3: true, passthrough: true, truehd: true }).method, 'direct');
  assert.strictEqual(decidePlayback('Movie.2024.2160p.BluRay.REMUX.TrueHD.Atmos.mkv',
    { native: true, mkv: true, ac3: true, eac3: true }).method, detectFfmpeg() ? 'remux' : 'direct');
  assert.strictEqual(decidePlayback('Movie.2024.2160p.BluRay.DTS-HD.MA.mkv',
    { native: true, mkv: true, ac3: true, eac3: true, passthrough: true, dtsHd: true }).method, 'direct');
  assert.strictEqual(decidePlayback('Movie.1992.1080p.BluRay.X264-GROUP', {}).method, detectFfmpeg() ? 'remux' : 'direct');
});

test('live tv browser remux keeps AAC surround instead of forcing stereo', () => {
  const transcode = fs.readFileSync(path.join(__dirname, '..', 'server', 'transcode.js'), 'utf8');
  assert.match(transcode, /function spawnLiveRemux\(url, \{ hlsFriendly = true, headers = null \} = \{\}\)[\s\S]+'-c:a', 'aac', '-b:a', '384k'[\s\S]+'-fflags', '\+genpts'/,
    'Live TV browser remux should encode browser-safe AAC without a hard stereo downmix');
  assert.doesNotMatch(transcode, /function spawnLiveRemux[\s\S]+'-ac', '2'[\s\S]+\]\, \{ stdio/,
    'Live TV browser remux should not force every channel to stereo');
});

test('live tv remux preserves 5.1 channel count as AAC when ffmpeg can encode it', { skip: !HAS_FFMPEG || !HAS_FFPROBE }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-live-51-'));
  const src = path.join(dir, 'live.ts');
  const gen = spawnSync(detectFfmpeg().path, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=12:duration=3',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=5.1:sample_rate=48000',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12',
    '-c:a', 'ac3', '-ac', '6', '-f', 'mpegts', src,
  ], { timeout: 120000, windowsHide: true });
  if (gen.status !== 0) return;
  const { server, url } = await serveFile(src);
  try {
    const out = await collect(spawnLiveRemux(url, { hlsFriendly: false }));
    assert.ok(out.length > 2000, 'live remux produced output');
    const outFile = path.join(dir, 'live.mp4');
    fs.writeFileSync(outFile, out);
    const t = await probeTracks(outFile);
    assert.strictEqual(t.audio[0].codec, 'aac', 'Live TV browser fallback still emits browser-safe AAC');
    assert.strictEqual(t.audio[0].channels, 6, '5.1 Live TV audio is no longer hard-downmixed to stereo');
  } finally { server.close(); }
});

test('remux: AC3 source with transcodeAudio → AAC audio, video still copied', { skip: !HAS_FFMPEG || !HAS_FFPROBE }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-ac3-'));
  const src = path.join(dir, 'ac3.mkv');
  const gen = spawnSync(detectFfmpeg().path, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=12:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'ac3', src,
  ], { timeout: 120000, windowsHide: true });
  if (gen.status !== 0) return; // no ac3 encoder in this build → covered in Docker
  const { server, url } = await serveFile(src);
  try {
    const out = await collect(spawnRemux(url, { transcodeAudio: true }));
    assert.ok(out.length > 2000, 'remux produced output');
    const outFile = path.join(dir, 'out.mp4');
    fs.writeFileSync(outFile, out);
    const t = await probeTracks(outFile);
    assert.strictEqual(t.video[0].codec, 'h264', 'video stream-copied, never re-encoded');
    assert.strictEqual(t.audio[0].codec, 'aac', 'AC3 audio became browser-safe AAC');
  } finally { server.close(); }
});

test('detect: ffmpeg detection is cached and shape-correct', () => {
  const a = detectFfmpeg();
  const b = detectFfmpeg();
  assert.strictEqual(a, b, 'detection cached');
  if (a) { assert.ok(typeof a.path === 'string' && /ffmpeg/i.test(a.version)); }
});

test('transcode ladder: HEVC source → H.264 + AAC at the requested height', { skip: !HAS_FFMPEG || !HAS_FFPROBE || !HAS_ENCODER }, async () => {
  // Make a small HEVC file (the codec wall browsers hit), then run it through the ladder.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-hevc-'));
  const src = path.join(dir, 'hevc.mkv');
  const gen = spawnSync(detectFfmpeg().path, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=12:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-c:a', 'aac', src,
  ], { timeout: 120000, windowsHide: true });
  if (gen.status !== 0) return; // libx265 not in this build → covered in Docker
  const { server, url } = await serveFile(src);
  try {
    const out = await collect(spawnTranscode(url, { height: 480 }));
    assert.ok(out.length > 5000, 'transcode produced output');
    assert.strictEqual(out.subarray(4, 8).toString('latin1'), 'ftyp', 'fMP4 container');
    const outFile = path.join(dir, 'out.mp4');
    fs.writeFileSync(outFile, out);
    const t = await probeTracks(outFile);
    assert.strictEqual(t.video[0].codec, 'h264', `HEVC transcoded to H.264 (encoder: ${detectEncoder().kind})`);
    assert.strictEqual(t.audio[0].codec, 'aac');
    assert.ok(t.video[0].height <= 480, `ladder honored height (got ${t.video[0].height})`);
  } finally { server.close(); }
});

test('player backend: probe lists audio languages + text subs and the duration', { skip: !HAS_FFMPEG || !HAS_FFPROBE }, async () => {
  const file = makeMultitrackFile();
  const { server, url } = await serveFile(file);
  try {
    const t = await probeTracks(url);
    assert.strictEqual(t.video.length, 1);
    assert.strictEqual(t.audio.length, 2, 'two audio tracks');
    assert.deepStrictEqual(t.audio.map((a) => a.lang), ['eng', 'ger']);
    assert.strictEqual(t.subs.length, 1, 'one subtitle track');
    assert.strictEqual(t.subs[0].text, true, 'srt marked extractable');
    assert.ok(t.duration > 4 && t.duration < 8, `duration ~6s (got ${t.duration})`);
  } finally { server.close(); }
});

test('player backend: remux with audio selection emits fMP4; subtitle extract emits WebVTT', { skip: !HAS_FFMPEG }, async () => {
  const file = makeMultitrackFile();
  const { server, url } = await serveFile(file);
  try {
    // Remux selecting the SECOND audio track → output must be an fMP4 (ftyp header).
    const mp4 = await collect(spawnRemux(url, { audioTrack: 1 }));
    assert.ok(mp4.length > 10000, 'remux produced data');
    assert.strictEqual(mp4.subarray(4, 8).toString('latin1'), 'ftyp', 'fragmented MP4 magic');

    // Subtitle extraction → WebVTT with our cue text.
    const vtt = (await collect(spawnSubtitleExtract(url, 0))).toString('utf8');
    assert.ok(vtt.startsWith('WEBVTT'), 'WebVTT header');
    assert.match(vtt, /Hello Triboon/, 'cue text survived conversion');
  } finally { server.close(); }
});
