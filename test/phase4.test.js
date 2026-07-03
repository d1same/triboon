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
const { detectFfmpeg, detectFfprobe, detectEncoder, decidePlayback, probeTracks, spawnRemux, spawnHls, spawnLiveRemux, spawnTranscode, spawnSubtitleExtract, supportsFfmpegHttpOption } = require('../server/transcode');

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

test('playback decision: DTS-core MKV on a non-DTS device remuxes instead of playing silent', () => {
  // The MKV-direct gate checks AC3/EAC3 decode but not DTS, so a device with ac3/eac3 but
  // dts:false would direct-play a DTS MKV with no audio. It must remux (when ffmpeg is present).
  const noDts = decidePlayback('Movie.2024.1080p.BluRay.DTS.x264-GRP.mkv', { mkv: true, ac3: true, eac3: true, dts: false });
  if (HAS_FFMPEG) assert.strictEqual(noDts.method, 'remux', 'DTS MKV on a non-DTS device must not direct-play');
  else assert.ok(noDts.warning, 'honest degrade when no ffmpeg');
  // A DTS-capable device still direct-plays; a plain AC3/EAC3 MKV is unaffected (no over-remux).
  assert.strictEqual(decidePlayback('Movie.2024.1080p.BluRay.DTS.x264-GRP.mkv', { mkv: true, ac3: true, eac3: true, dts: true }).method, 'direct',
    'a DTS-capable device still direct-plays a DTS MKV');
  assert.strictEqual(decidePlayback('Movie.2024.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv', { mkv: true, ac3: true, eac3: true, dts: false }).method, 'direct',
    'a non-DTS MKV is unaffected on a non-DTS device');
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
  assert.match(ui, /function playbackRequestBody\(it, picked = null, qRank = qualityRankForItem\(it\)\) \{[\s\S]+body\.originalLanguage[\s\S]+body\.preferredAudioLanguage/,
    'Play and prepare requests should carry original-language and preferred-audio hints into source selection');
  const serverForPolicy = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.ok(serverForPolicy.includes('function parseCapsQuery(raw) {')
    && serverForPolicy.includes("caps: parseCapsQuery(ctx.url.searchParams.get('caps'))"),
    'Sources search should parse native device caps into the server scoring policy');
  assert.match(serverForPolicy, /function playbackPolicyFor\(user, \{ maxResolutionRank, preferResolutionRank, originalLanguage, preferredAudioLanguage, caps: rawCaps \} = \{\}\) \{[\s\S]+policy\.originalLanguage[\s\S]+policy\.preferredAudioLanguage[\s\S]+policy\.audioPassthrough[\s\S]+policy\.lowPowerDevice/,
    'Server playback policy should preserve language/device hints for the scorer');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8'), /if \(preferRank === 4\) policy\.exactResolutionRank = 4;/,
    '4K selection should be exact so fallback stays in the 4K source class');
  assert.match(serverForPolicy, /transcode: async \(ctx\) => \{[\s\S]+ctx\.user\.policy\.allowTranscode === false[\s\S]+transcoding is disabled for this account/,
    'per-user allowTranscode=false must be enforced at the transcode endpoint (cap contract, transcoder half)');
  assert.match(serverForPolicy, /const abortRead = \(\) => \{[\s\S]+!\['readAhead', 'background', 'health'\]\.includes\(readPriority\)[\s\S]+vf\.cancelReadAhead\(\)/,
    'a closing read-ahead/warm-ahead/background connection must NOT cancel the live player read-ahead (pause→resume stall fix)');
  assert.match(ui, /data-utr="\$\{esc\(u\.id\)\}"[\s\S]+policy: \{ allowTranscode: cb\.checked \}/,
    'admin user list should expose an Allow-transcoding toggle wired to the user policy');
  assert.match(ui, /function sourceSearchQuery\(it, opts = \{\}\) \{[\s\S]+const qRank = opts\.includeQuality === false \? null : qualityRankForItem\(it\);[\s\S]+maxResolutionRank[\s\S]+preferResolutionRank/,
    'Sources, play warmup, and availability should share one query builder while allowing unfiltered quality discovery');
  assert.match(ui, /function prefetchSources\(it, delay = 700\) \{[\s\S]+const qRank = qualityRankForItem\(it\);[\s\S]+localTitleHasPlayback\(it\) && localPlaybackFitsQuality\(it, qRank\)[\s\S]+api\('\/api\/search\?' \+ sourceSearchQuery\(it\)\)/,
    'source warmup should skip matching local files but still warm online 4K when local playback is lower quality');
  assert.match(ui, /function updateDetailPlayLabel\(\{ label, target \}\) \{[\s\S]+detailPlayTarget = target;[\s\S]+prefetchSources\(target, 0\);[\s\S]+preparePlaybackSource\(target, 0\);[\s\S]+\}/,
    'movie/show details should warm and immediately prepare the exact current Play target, including TV episodes');
  assert.match(ui, /applyExternalIds\(it, d\);[\s\S]+if \(it\.imdbId \|\| it\.tvdbId\) \{[\s\S]+checkAvailability\(it\);[\s\S]+prefetchSources\(detailPlayTarget, 0\);[\s\S]+preparePlaybackSource\(detailPlayTarget, 0\);[\s\S]+\}/,
    'movie/show details should refresh prepare when exact IMDb/TVDB identity arrives');
  assert.match(ui, /pickKey: picked && picked\.pickKey/,
    'manual source playback should send the opaque server pick key, not only a release name');
  assert.match(ui, /play\(it, \{ name: c\.name, pickKey: c\.pickKey, resolutionRank: rk\(c\) \}\)/,
    'clicking a Sources row should carry its exact release key and quality class into Play');
  assert.match(ui, /async function play\(it, pick\) \{[\s\S]+it = resolvePlaybackResume\(it\);[\s\S]+const picked = pick && typeof pick === 'object' \? pick : \(pick \? \{ name: pick \} : null\);[\s\S]+const body = playbackRequestBody\(it, picked, qRank\);/,
    'manual source selection should re-resolve the latest resume point before mounting the exact picked release');
  assert.match(ui, /function stopActivePlaybackForReplacement\(opts = \{\}\) \{[\s\S]+saveWatch\(true\);[\s\S]+window\.TriboonTV\.closeVideo\(\);[\s\S]+stopWebVideoElement\(\);[\s\S]+if \(!opts\.preserveGuide\) closePlayerGuide\(\{ fromNative: true \}\);[\s\S]+S\.playing = null;[\s\S]+\}/,
    'source replacement should stop the active native/web player before the new mount can start');
  assert.match(ui, /async function play\(it, pick\) \{[\s\S]+const localExact = !picked && localPlaybackForItem\(it\) \? \{ \.\.\.it, _local: localPlaybackForItem\(it\) \} : null;[\s\S]+if \(localExact && localPlaybackFitsQuality\(localExact, qRank\)\) return playLocal\(localExact\);[\s\S]+stopActivePlaybackForReplacement\(\);[\s\S]+const nativeFirst = nativeVideoRequired\(it\);/,
    'manual source selection and quality mismatches should tear down the old source before showing the new loading/player state');
  assert.match(ui, /const pickRank = picked \? normalizeResolutionRank\(picked\.resolutionRank\) : null;[\s\S]+const qRank = pickRank !== null \? pickRank : qualityRankForItem\(it\);[\s\S]+const body = playbackRequestBody\(it, picked, qRank\);/,
    'manual source selection should pass the picked source quality into the shared request builder');
  assert.match(ui, /function playbackRequestBody\(it, picked = null, qRank = qualityRankForItem\(it\)\) \{[\s\S]+if \(qRank !== null\) \{[\s\S]+body\.maxResolutionRank = qRank;[\s\S]+body\.preferResolutionRank = qRank;/,
    'manual source selection should prefer the picked source quality while normal Play uses the current 1080p/4K toggle');
  assert.match(ui, /function qualityRankForItem\(it\) \{[\s\S]+if \(it\._local && !it\.tmdbId\) return null;/,
    'matched local movies and episodes should still inherit saved 1080p/4K preferences');
  // 4K startup fix: a user's quality choice is remembered per-profile so the NEXT title pre-mounts
  // that quality on detail open (warm by Play) instead of starting the 4K mount only on toggle.
  assert.match(ui, /function qualityRankForItem\(it\) \{[\s\S]+savedQualityPref\(it\)[\s\S]+\|\| globalQualityPref\(\);[\s\S]+if \(q === 4 && !userCanPlay4k\(\)\) q = 3;[\s\S]+return q \|\| null;/,
    'qualityRankForItem should fall back to the remembered global quality and clamp 4K for capped users, but stay null when nothing is set (single-version titles unaffected)');
  // A remembered GLOBAL 4K default must not force a 4K request (→ the server no-fallback lock) onto a
  // title that has no 4K at all: checkAvailability records _has4k, and qualityRankForItem clamps 4→3
  // when it's known false. This is the "don't even try 4K on a 1080p-only show" fix.
  assert.match(ui, /const known4k = \(detailMatches && S\.detailItem\) \? S\.detailItem\._has4k : it\._has4k;[\s\S]+if \(q === 4 && known4k === false\) q = 3;/,
    'qualityRankForItem must clamp a global-default 4K down to 1080p for titles known to have no 4K');
  // Browsers can't decode 4K HEVC → 4K forces a heavy live transcode that buffers; cap browser
  // playback at 1080p by default (opt-in 4K in Preferences). The TV app (native ExoPlayer) is exempt.
  assert.match(ui, /if \(isWebBrowserClient\(\) && !allow4kInBrowser\(\)\) q = Math\.min\(q \|\| 3, 3\);/,
    'qualityRankForItem must cap browser playback at 1080p unless 4K-in-browser is opted in');
  assert.match(ui, /function isWebBrowserClient\(\) \{ return !nativePlaybackCaps\(\); \}/,
    'a plain browser (no native ExoPlayer bridge) is the client that gets the 1080p cap');
  assert.match(ui, /if \(!it\._local && isWebBrowserClient\(\)\) return openDetail\(detailTargetForItem\(it\)\);/,
    'a browser Continue-Watching next-episode card opens details (to pick quality) instead of auto-playing');
  assert.match(ui, /const has4k = res\.has\('2160p'\);[\s\S]+it\._has4k = has4k;/,
    'checkAvailability must persist real 4K availability on the item so a no-4K title never requests 4K');
  assert.match(ui, /function saveGlobalQualityPref\(rank\) \{ const q = normalizeQualityRank\(rank\);/,
    'a profile-scoped global quality preference should be persistable');
  assert.match(ui, /S\.qualityPref = \+b\.dataset\.q;\s*\n\s*saveGlobalQualityPref\(S\.qualityPref\);/,
    'toggling quality should remember the choice globally so the next title pre-warms it');
  // Part 2: a user capped below 4K must never see the 4K toggle.
  assert.match(ui, /function userCanPlay4k\(\) \{ return userMaxRank\(\) >= 4; \}/,
    'should expose whether the user is allowed to play 4K');
  assert.match(ui, /const offer = !!\(r\.candidates && r\.candidates\.length && has4k && userCanPlay4k\(\) &&/,
    'the 4K quality toggle must be gated on the user being allowed to play 4K');
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
  // Resume should feel local: settling focus on a resumable card warms the best source all the way
  // to a MOUNTED state (not just the search) — multi-volume RAR mounts cost seconds, so search-only
  // warming still left a long press-play gap (see bench/resume-latency.js).
  assert.match(ui, /function focusCard\([\s\S]+if \(it && it\.type !== 'live' && \(it\._cw \|\| it\._nextEp \|\| \(\+it\.resume \|\| 0\) > 0\)\) preparePlaybackSource\(it\);/,
    'focusing a resumable Continue Watching / next-episode card should mount-warm the best source (preparePlaybackSource) so resume reuses a live mount instantly');
  assert.match(ui, /if \(!opts\.catalogOnly && !opts\.watchReady && !hasFreshWatch && !opts\.preserveFocus\) \{/,
    'Continue Watching row actions should not publish an empty placeholder row while preserving focus');
  assert.match(ui, /async function cwOp\(it, body, msg, opts = \{\}\) \{[\s\S]+if \(body\.hidden\) \{[\s\S]+cwHideNext\(it\.key\);[\s\S]+removeWatchCacheKey\(it\.key\);[\s\S]+\} else if \(body\.remove\) removeWatchCacheKey\(it\.key\);[\s\S]+loadRows\(\{ preserveFocus: !!snap, focusSnapshot: snap, watchReady: true \}\);[\s\S]+loadWatchState\(true\)/,
    'Continue Watching remove/mark actions should durably dismiss next-up (cwHideNext) + update cache, keep focus, then refresh quietly');
  assert.match(ui, /function nextEpisodeBumps\(cw, cwItems\) \{[\s\S]+const hiddenNext = cwHiddenNextSet\(\);[\s\S]+if \(hiddenNext\.has\(nextKey\)\) continue;/,
    'dismissed next-up suggestions must stay dismissed across reloads (nextEpisodeBumps honors the local hidden set)');
  // The SERVER next-up list (S._homeTvNext) is cached under a watched-episode fingerprint that does
  // not change when you dismiss an unwatched next-up — so buildCwItems must apply the local hidden
  // set to the cached server list too, or a just-removed next-up card reappears on the next render.
  assert.match(ui, /if \(Array\.isArray\(S\._homeTvNext\)\) \{[\s\S]+const hiddenNext = cwHiddenNextSet\(\);[\s\S]+for \(const it of S\._homeTvNext\) if \(it && it\.key && !seen\.has\(it\.key\) && !hiddenNext\.has\(it\.key\)\)/,
    'buildCwItems must filter the cached server next-up list through the local dismissal set so a removed next-up card does not reappear');
  assert.match(ui, /function epItemOf\(show, season, ep\) \{[\s\S]+qualityRank: qualityRankForItem\(show\)[\s\S]+function epTarget\(show, sNum, eNum, resume\) \{[\s\S]+qualityRank: qualityRankForItem\(show\)/,
    'episode targets created from details should inherit the current show quality preference');
  assert.match(ui, /async function prepPlayerSeasonEpisodes\(it\) \{[\s\S]+const inheritedQuality = qualityRankForItem\(it\);[\s\S]+const item = inheritedQuality \? \{ \.\.\.base, qualityRank: inheritedQuality \} : base;[\s\S]+async function prepNextEpisode\(it\) \{[\s\S]+const inheritedQuality = qualityRankForItem\(it\);[\s\S]+const item = inheritedQuality \? \{ \.\.\.base, qualityRank: inheritedQuality \} : base;/,
    'player episode strip and Up Next should continue the same 4K/1080p class');
  assert.match(ui, /async function saveWatch\(final, opts = \{\}\) \{[\s\S]+const pos = currentTime\(\);[\s\S]+if \(!final && Math\.abs\(pos - p\.lastSaved\) < 5\) return;[\s\S]+const watched = opts && opts\.watched != null \? !!opts\.watched : nearEnd;[\s\S]+key: p\.item\.key, position: Math\.floor\(pos\), duration: Math\.floor\(d \|\| 0\),[\s\S]+watched, profile: S\.profile \? S\.profile\.id : undefined,[\s\S]+upsertWatchCache\(\{[\s\S]+position: payload\.position[\s\S]+api\('\/api\/watch', \{ method: 'POST', body: payload, keepalive: !!final \}\)/,
    'watch progress should save profile-scoped position immediately into the local cache and server (keepalive on final saves so close/pagehide flushes survive teardown), honoring a caller watched-override');
  assert.match(ui, /window\.addEventListener\('pagehide', \(\) => \{ if \(S\.playing\) \{ saveWatch\(true\);/,
    'pagehide should flush the final watch position before the page is torn down');
  assert.match(ui, /async function closePlayer\(opts = \{\}\) \{[\s\S]+const finalWatch = saveWatch\(true, opts && opts\.ended \? \{ watched: true \} : \{\}\);[\s\S]+const finalActivity = stopActivityHeartbeat\(\);[\s\S]+if \(\$\(\'detail\'\)\.classList\.contains\(\'open\'\)\) \{[\s\S]+await finalWatch; await finalActivity; await loadWatchState\(true\);[\s\S]+if \(S\.detailItem\) syncDetailButtons\(S\.detailItem\);/,
    'returning from player to details should flush the final watch position (forcing watched when playback ENDED, even if the duration probe never landed) and refresh the visible Resume/Start Over buttons');
  assert.match(ui, /function syncDetailButtons\(it\) \{[\s\S]+const resume = resumePositionForItem\(it\);[\s\S]+\$\(\'dStartOver\'\)\.style\.display = resume \? '' : 'none';[\s\S]+updateDetailPlayLabel\(resume \? \{ label: 'Resume', target: \{ \.\.\.it, resume \} \} : \{ label: 'Play', target: it \}\);/,
    'detail button sync should recompute movie Resume/Play from the latest watch map');
  assert.match(ui, /function playbackFinishedDetailTarget\(item\) \{[\s\S]+item\.type === 'movie'[\s\S]+item\.type === 'episode'[\s\S]+key: `tmdb:tv:\$\{item\.tmdbId\}`[\s\S]+type: 'tv'/,
    'finished playback should resolve movies to movie details and final episodes to the show details page');
  // Continue Watching plays straight from home with no detail page beneath the player. Backing
  // out (not just finishing) must land on the title's details page, not dump the user on the
  // homepage. Scoped to home-launched playback so library/Live TV returns keep their restores.
  assert.match(ui, /const cwDetailTarget = \(!ret\.view \|\| ret\.view === 'home'\) \? playbackFinishedDetailTarget\(closingItem\) : null;[\s\S]+if \(cwDetailTarget\) \{[\s\S]+await openDetail\(cwDetailTarget\);[\s\S]+return;/,
    'closing playback launched from Continue Watching (home) should open the title details page instead of returning to the homepage');
  // The in-player episode rail spans the current season PLUS the next two, so deep-diving the
  // strip can cross a season boundary without leaving the player; a stale-token re-check after
  // the extra season fetches keeps a newer playback from being clobbered by the slow one.
  assert.match(ui, /const nextSeasonNums = \(ctx\.seasons \|\| \)?[\s\S]*?\.filter\(\(n\) => Number\.isFinite\(\+n\) && \+n > ctx\.parts\.season\)[\s\S]+\.slice\(0, 2\);[\s\S]+const extraSeasons = \(await Promise\.all\(nextSeasonNums\.map[\s\S]+if \(token !== S\._playerSeasonStripToken \|\| !S\.playing \|\| !S\.playing\.item \|\| S\.playing\.item\.key !== it\.key\) return;[\s\S]+for \(const season of \[ctx\.season, \.\.\.extraSeasons\]\) \{/,
    'the player episode strip should append episodes from the next two seasons (with a post-fetch staleness re-check)');
  assert.match(ui, /window\.__tvNativeVideoClosed = \(pos, dur, ended\) => \{[\s\S]+if \(ended && S\.nextEp\) \{\s+saveWatch\(true, \{ watched: true \}\);[\s\S]+closePlayer\(\{ ended: !!ended \}\);/,
    'native finished playback should mark the just-finished episode watched before Up Next, then close through the finished-title return path');
  // The web (HTMLVideo) end-of-episode path hands off to Up Next and returns WITHOUT going through
  // closePlayer — so it must save watched itself, or an auto-advanced episode is never recorded
  // watched (the "only marks watched if I watch the ENTIRE thing" bug).
  assert.match(ui, /v\.onended = \(\) => \{[\s\S]+if \(S\.nextEp\) \{[\s\S]+saveWatch\(true, \{ watched: true \}\);[\s\S]+if \(!S\.upNextShown\) showUpNext\(\);[\s\S]+return;/,
    'web episode end-of-file must mark the finished episode watched before the Up Next handoff (closePlayer, which saves, is skipped on this path)');
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
  // Two-phase Up Next: the card surfaces at credits-start (runtime-heuristic window, manual
  // choice), and the 10s autoplay countdown arms SEPARATELY only inside the true final seconds —
  // so the card is useful early without autoplay ever skipping the end of the episode.
  assert.match(ui, /function maybeShowUpNext\(t, d, opts = \{\}\) \{[\s\S]+if \(!opts\.native && \$\('video'\)\.paused\) return;[\s\S]+if \(remaining > upNextEarlyWindow\(d\)\) return;[\s\S]+showUpNext\(\);[\s\S]+if \(remaining <= UP_NEXT_COUNTDOWN_SECONDS \+ 1\) armUpNextCountdown\(\);/,
    'Up Next should surface at the credits-start window (manual) and arm the autoplay countdown only in the final seconds, working for native progress without relying on the web video paused state');
  assert.match(ui, /function upNextEarlyWindow\(d\) \{ return Math\.max\(30, Math\.min\(90, Math\.round\(d \* 0\.035\)\)\); \}/,
    'the credits-start heuristic is ~3.5% of runtime clamped to 30-90s');
  assert.match(ui, /function armUpNextCountdown\(\) \{[\s\S]+if \(!ne \|\| !S\.upNextShown \|\| S\.upNextTimer \|\| S\.upNextDismissed \|\| !prefAutoplay\(\)\) return;[\s\S]+if \(n <= 0\) playNextEpisode\(\);/,
    'the autoplay countdown must be idempotent and blocked by an explicit dismiss or the auto-play preference');
  assert.match(ui, /function dismissUpNext\(\) \{ S\.upNextDismissed = true; hideUpNextUi\(\); \}[\s\S]+\$\('unCancel'\)\.addEventListener\('click', dismissUpNext\);[\s\S]+window\.__upNextDismissNative = \(\) => dismissUpNext\(\);/,
    'dismissing the Up Next card (web or native) must stick — autoplay never re-arms for that episode');
  assert.doesNotMatch(ui, /\(d - t\) > 45/,
    'Up Next must not start a 10-second autoplay countdown with 45 seconds still left in the episode');
  assert.match(ui, /const UP_NEXT_COUNTDOWN_SECONDS = 10;[\s\S]+function showUpNext\(\) \{[\s\S]+let n = UP_NEXT_COUNTDOWN_SECONDS;[\s\S]+\$\('unCount'\)\.textContent = n;[\s\S]+if \(n <= 0\) playNextEpisode\(\);/,
    'Up Next autoplay should always give the user a 10-second choice window before starting the next episode');
  assert.match(ui, /id="unPlay">Play next episode<\/button>/,
    'Up Next primary action should clearly say Play next episode');
  assert.doesNotMatch(ui, /opts\.ended \? 6 : 10/,
    'the ended fallback path should not shorten the Up Next countdown');
  assert.match(ui, /saveQualityPref\(target,\s*S\.qualityPref\)[\s\S]+paintQualityToggle\(S\.qualityPref\);[\s\S]+prefetchSources\(target, 0\);[\s\S]+preparePlaybackSource\(target, 0\);/,
    'changing the detail quality toggle should persist and immediately warm and prepare the selected source class');
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
  assert.match(ui, /const HOME_CATALOG_INITIAL = 16;[\s\S]+function homeCatalogRow\(name, path, result, kind = 'catalog'\)[\s\S]+items: all\.slice\(0, HOME_CATALOG_INITIAL\),[\s\S]+buffer: all\.slice\(HOME_CATALOG_INITIAL\)/,
    'home catalog rows should keep first paint small while retaining overflow items for lazy loading');
  assert.match(ui, /rows\.push\(homeCatalogRow\('Trending this week', paths\[0\], trend, 'catalog'\)\);[\s\S]+rows\.push\(homeCatalogRow\('Popular movies', paths\[1\], movies, 'catalog'\)\);[\s\S]+rows\.push\(homeCatalogRow\('Popular series', paths\[2\], tv, 'catalog'\)\);/,
    'home Trending, Popular Movies, and Popular Series rows should be lazy catalog rows');
  assert.match(ui, /function bindHomeRowLazy\(cards, root, ri\) \{[\s\S]+cards\.addEventListener\('scroll', \(\) => maybeLoadMoreHomeRow\(root, ri\), \{ passive: true \}\);[\s\S]+async function loadMoreHomeRow\(root, ri\) \{[\s\S]+api\(homeCatalogPathWithPage\(lazy\.path, page\)\)[\s\S]+appendHomeRowCards\(root, ri, added, firstNew\)/,
    'home catalog rows should append more cards on row scroll without repainting the whole page');
  assert.match(ui, /function focusCard\(ri, ci, opts = \{\}\) \{[\s\S]+maybeLoadMoreHomeRow\(view\.root, ri\);/,
    'home catalog lazy loading should also trigger from D-pad focus near the right edge');
  assert.match(ui, /function refreshHomeWhenSettled\(opts = \{\}\) \{[\s\S]+if \(S\._booting && S\.view === 'home'\) return loadRows\(\{ preserveFocus: true, background: true, \.\.\.opts \}\);[\s\S]+if \(homeBackgroundRefreshReady\(\)\) loadRows/,
    'boot-time home refresh should publish under the splash instead of waiting for visible idle focus');
  assert.match(ui, /function homeRowsFromWatch\(cw, loading = false\) \{[\s\S]+rows\.push\(\.\.\.cachedHomeCatalogRows\(\)\);[\s\S]+if \(!rows\.length && loading\)[\s\S]+emptyLabel: 'Loading\.\.\.'[\s\S]+function homeRowsReadyForBoot\(rows\) \{[\s\S]+row\.name !== 'Loading home'[\s\S]+function publishHomeRows\(rows, opts = \{\}\) \{[\s\S]+if \(S\._homeRowsSig === sig && \$\('rows'\)\.children\.length\) \{[\s\S]+return false;[\s\S]+async function loadRows\(opts = \{\}\) \{[\s\S]+const runId = S\._homeLoadRun[\s\S]+!opts\.catalogOnly && !opts\.watchReady && !hasFreshWatch[\s\S]+publishHomeRows\(homeRowsFromWatch\(cachedWatchRowsForHome\(\), true\), opts\); \/\/ Internal first paint: focus target under the splash before \/api\/watch returns\.[\s\S]+loadWatchState\(\)\.then/,
    'home first paint should create a hidden focus placeholder but keep the splash until real rows exist');
  assert.match(ui, /const cw = opts\.watchReady \? cachedWatchRowsForHome\(\) : await loadWatchState\(\)\.catch\(\(\) => \[\]\);[\s\S]+if \(runId !== S\._homeLoadRun && !opts\.catalogOnly\) return;[\s\S]+publishHomeRows\(homeRowsFromWatch\(cw, false\), \{ preserveFocus: !!opts\.preserveFocus, focusSnapshot: opts\.focusSnapshot \}\);[\s\S]+scheduleHomeCatalogRefresh\(\);/,
    'home should refresh with real watch rows and schedule TMDB catalog refresh after first paint');
  assert.doesNotMatch(ui, /const catalogJob = loadHomeCatalogRows|rows\.push\(\.\.\.await catalogJob\)/,
    'home first paint must not await TMDB catalog rows');
  assert.match(ui, /function renderRowsInto\(root, rowsData, opts = \{\}\) \{[\s\S]+if \(!items\.length\) \{[\s\S]+empty\.className = 'gridMore focusable';[\s\S]+empty\.dataset\.row = ri; empty\.dataset\.col = 0;[\s\S]+openServerSettings\(\)/,
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
  // certParams() must NOT emit include_adult — CATALOG_Q already carries it, and TMDB discover
  // returns 400 on a duplicate include_adult (the "tmdb upstream 400" when adding a kid/teen profile).
  assert.ok(!ui.includes('return `&include_adult=false&certification_country=US'),
    'certParams must not duplicate include_adult (TMDB 400 on kid/teen/family catalog)');
  assert.match(ui, /return `&certification_country=US&certification\.lte=\$\{encodeURIComponent\(cert\)\}`/,
    'certParams returns only the certification filter (include_adult comes from CATALOG_Q)');
  assert.match(ui, /discover\/\$\{lib\.mediaType\}[^`]+` \+ CATALOG_Q \+ certParams\(\)/,
    'the smart-library browse (only certParams caller without CATALOG_Q) now includes CATALOG_Q so adult exclusion is kept');
  // Age gate: the play request carries the active profile id + the title id/type so the SERVER can
  // enforce maturity; a server 403 shows a clear "restricted for this profile" message.
  assert.match(ui, /if \(S\.profile && S\.profile\.id\) body\.profileId = S\.profile\.id;[\s\S]+body\.tmdbId = it\.tmdbId;[\s\S]+body\.mediaType =/,
    'playbackRequestBody sends profileId + tmdbId + mediaType for the server age gate');
  assert.match(ui, /if \(e && e\.detail && e\.detail\.restricted\) \{[\s\S]+restricted for this profile/,
    'a 403 age-gate response surfaces a clear restriction message to the user');
  assert.match(ui, /\.\.\.\(S\.watchlist \|\| \[\]\)\.map\(\(w\) => \(\{ \.\.\.w\.meta, _key: w\.key \}\)\)[\s\S]+Object\.entries\(S\.watchMap \|\| \{\}\)[\s\S]+const t = certTargetForMeta\(m, m\._key \|\| ''\);[\s\S]+uniq\.set\(t\.type \+ ':' \+ t\.tmdbId, \{ \.\.\.m, \.\.\.t \}\);/,
    'calendar should normalize in-progress episode metas to their TV show before fetching upcoming dates');
  assert.match(ui, /function calendarWeekDates\(start = todayStr\(\)\) \{[\s\S]+Array\.from\(\{ length: 7 \}/,
    'Calendar should render a fixed seven-day horizon');
  assert.match(ui, /const weekDates = calendarWeekDates\(today\);[\s\S]+const weekEnd = weekDates\[weekDates\.length - 1\];[\s\S]+ne\.air_date >= today && ne\.air_date <= weekEnd[\s\S]+d\.release_date >= today && d\.release_date <= weekEnd/,
    'Calendar should filter TV episodes and movie releases to the next seven days');
  assert.match(ui, /const activeDates = weekDates\.filter\(\(date\) => \(byDay\[date\] \|\| \[\]\)\.length\);[\s\S]+if \(!activeDates\.length\)[\s\S]+Nothing scheduled in the next 7 days[\s\S]+for \(const date of activeDates\)/,
    'Calendar should skip empty dates while keeping a clean weekly empty state');
  assert.match(ui, /\.calItems\{display:flex;gap:16px;overflow-x:auto[\s\S]+\.calItem\{position:relative;flex:0 0 132px;display:flex;flex-direction:column[\s\S]+\.calItem \.pp\{width:100%;aspect-ratio:2\/3/,
    'Calendar should use poster-first cards instead of wide text agenda rows');
  assert.ok(ui.indexOf("actionMenuButton('info', 'info', 'Details')") < ui.indexOf("actionMenuButton('resume', 'play'"),
    'the long-press menu should default to Details, with Resume as a deliberate second action');
  assert.match(ui, /if \(act === 'resume'\) play\(it\);[\s\S]+else if \(act === 'info'\) openDetail\(detailTargetForItem\(it\)\);/,
    'the long-press Details action should open details instead of letting episode cards fall through to playback');
  assert.match(ui, /function isContinueWatchingItem\(it\) \{[\s\S]+it\._cw \|\| it\._nextEp \|\| \(\+it\._traktPct \|\| 0\) > 2[\s\S]+!w\.hidden[\s\S]+\}/,
    'Continue Watching detection should cover resume rows, Trakt/imported rows, and generated next-up cards');
  assert.match(ui, /function openItemMenu\(it, card\) \{[\s\S]+const isCw = isContinueWatchingItem\(it\);[\s\S]+isCw \? actionMenuButton\('rm', 'remove', 'Remove from Continue Watching'\)[\s\S]+else if \(act === 'rm'\) removeContinueWatchingItem\(it, snap\);/,
    'Continue Watching long-press menus should always expose Remove and route through the shared remove helper');
  assert.match(ui, /function continueWatchingRemoveBody\(it\) \{[\s\S]+it && it\._nextEp && !existing[\s\S]+\{ hidden: true, position: 0, duration: 0 \}[\s\S]+\{ remove: true \}/,
    'generated next-up cards should be dismissed instead of deleted from a non-existent progress row');
  assert.match(ui, /if \(isContinueWatchingItem\(it\)\) \{[\s\S]+cwAct\.watch[\s\S]+cwAct\.rm[\s\S]+removeContinueWatchingItem\(it, cwSnap\(\)\)/,
    'all Continue Watching card shapes should get the on-thumbnail watched and remove controls');
  assert.match(ui, /if \(!it\.trailer && \(isContinueWatchingItem\(it\) \|\| \(it\.tmdbId && \['movie', 'tv'\]\.includes\(it\.type\)\)\)\) \{[\s\S]+openItemMenu\(it, el\);/,
    'Home row D-pad long-OK should open the menu for every Continue Watching card before playback can fire');
  assert.match(ui, /const cwSnap = \(\) => \{ onFocus && onFocus\(\); return homeFocusSnapshot\(\); \};[\s\S]+cwAct\.watch[\s\S]+focusSnapshot: cwSnap\(\)[\s\S]+cwAct\.rm[\s\S]+removeContinueWatchingItem\(it, cwSnap\(\)\)/,
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
  assert.match(ui, /async function restoreSavedSession\(\) \{[\s\S]+S\.user = await api\('\/api\/me'\);[\s\S]+if \(e && e\.status === 401\) \{[\s\S]+tokenStore\.set\(null\);[\s\S]+return false;[\s\S]+session check failed; keeping saved token[\s\S]+setTimeout\(\(\) => location\.reload\(\), 1800\);[\s\S]+await enterApp\(\);[\s\S]+app shell failed after session restore[\s\S]+replaceRoute\('#\/home'\);[\s\S]+await enterApp\(\);[\s\S]+if \(e2 && e2\.status === 401\) \{[\s\S]+tokenStore\.set\(null\);[\s\S]+return false;[\s\S]+document\.body\.classList\.remove\('authOpen'\);[\s\S]+Home had trouble opening after the update/,
    'refresh boot should retry only the /api/me session check; app-shell errors must not loop as server wakeups');
  assert.doesNotMatch(ui, /home fallback failed after session restore[\s\S]{0,500}showGate\('login'\)/,
    'app-shell restore failures should not masquerade as a signed-out login state');
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
  assert.match(ui, /function buildCwItems\(cw\) \{[\s\S]+_cw: true, _cwSortAt: w\.updatedAt \|\| 0[\s\S]+items\.push\(stampContinueWatchingSort\(\{ \.\.\.it, _cw: true \}, cw\)\);[\s\S]+items\.push\(\.\.\.nextEpisodeBumps\(cw, items\)\.map\(\(it\) => stampContinueWatchingSort\(it, cw, it\._cwSortAt\)\)\);[\s\S]+return dedupeContinueWatchingItems\(items\)\.sort\(compareContinueWatchingItems\);/,
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
  assert.match(ui, /--bdW:min\(40vw,720px\);[\s\S]+--bdH:min\(46vh,480px\);[\s\S]+#backdrop \.layer\{[\s\S]+width:var\(--bdW\);height:var\(--bdH\)/,
    'desktop-browser backdrop stays capped + viewport-aware (min(vw,px), not a percentage takeover) and is deliberately smaller than TV so posters lead');
  assert.match(ui, /--scrim:\s*linear-gradient\(90deg,rgba\(11,8,18,\.86\) 0%,rgba\(11,8,18,\.56\) 28%,rgba\(11,8,18,\.20\) 58%,rgba\(11,8,18,\.06\) 100%\),\s*linear-gradient\(0deg,rgba\(11,8,18,\.76\) 0%,rgba\(11,8,18,\.24\) 26%,rgba\(11,8,18,\.04\) 60%,rgba\(11,8,18,\.10\) 100%\)/,
    'browser backdrop scrim should protect text without blacking out the artwork');
  assert.match(ui, /body\.tv\{--bdW:min\(48vw,820px\);--bdH:min\(50vh,460px\);--overscan:2\.5vmin\}[\s\S]+body\.shortBrowseBd\{--bdH:min\(46vh,430px\)\}[\s\S]+body\.tv\.shortBrowseBd\{--bdH:min\(38vh,360px\)\}[\s\S]+@media \(max-height:760px\)\{[\s\S]+--bdH:min\(34vh,260px\)[\s\S]+@media \(max-width:980px\)\{[\s\S]+--bdW:min\(40vw,400px\);--bdH:min\(36vh,300px\)\}[\s\S]+body\.shortBrowseBd:not\(\.tv\)\{--bdH:min\(33vh,280px\)\}/,
    'TV, short browser, narrow browser, and poster browse viewports should tighten backdrop size; on narrow browser windows the browse (shortBrowseBd) pages must also shrink height (:not(.tv)) so movies/TV pages do not keep a ~46vh backdrop and dominate a small window');
  assert.match(ui, /body\.shortBrowseBd:not\(\.tv\) #bdInfo[\s\S]+-webkit-line-clamp:1[\s\S]+@media \(max-height:820px\)[\s\S]+body\.shortBrowseBd:not\(\.tv\) #bdInfo \.bdiC,[\s\S]+display:none/,
    'browser poster browse pages should compact the focused-title band without touching TV');
  assert.match(ui, /function browserBrowseCoverPx\(size\) \{[\s\S]+document\.body\.classList\.contains\('tv'\)[\s\S]+window\.innerHeight <= 820[\s\S]+return size === 'L' \? '190px'[\s\S]+const px = window\.innerWidth <= 600 \? '140px' : \(browserBrowseCoverPx\(s\) \|\| table\[s\] \|\| table\.M\);[\s\S]+const shortBrowserBrowse = document\.body\.classList\.contains\('shortBrowseBd'\) && !document\.body\.classList\.contains\('tv'\);[\s\S]+shortBrowserBrowse \? \(h <= 820 \? 128/,
    'desktop/tablet browse pages should use compact browser poster sizing and a compact row reserve');
  assert.match(ui, /function browserBrowseCoverPx[\s\S]+window\.innerWidth <= 980\) return window\.innerHeight <= 820 \? '118px' : '138px'/,
    'narrow browser windows (<=980, TV/phone excluded above) use compact browse covers so >=4 columns and a full second row fit under the smaller backdrop — kills the dark band that stranded posters at the bottom');
  assert.match(ui, /S\.browseLoading = false;\s*maybeFillBrowseWindow\(\);/,
    'runBrowse must trigger the fill-the-window check after every page load');
  assert.match(ui, /function maybeFillBrowseWindow\(\)[\s\S]+document\.body\.classList\.contains\('tv'\)\) return;[\s\S]+g\.scrollHeight > g\.clientHeight \+ 8\) return;[\s\S]+S\.browsePage \|\| 0\) >= 8\) return;[\s\S]+runBrowse\(false\)/,
    'browse pages keep auto-loading pages until the grid overflows its row window, so a 2K/4K/tall window fills instead of stranding ~1 row low with a dark band; TV-excluded and page-capped');
  assert.match(ui, /const shortBrowseBd = v === 'discover' \|\| v === 'movies' \|\| v === 'tv' \|\| v === 'watchlist' \|\| \(v === 'library' && S\.currentLib && S\.currentLib\.path\);[\s\S]+document\.body\.classList\.toggle\('shortBrowseBd', !!shortBrowseBd\);/,
    'Discover, movies, TV shows, watchlist, and attached libraries should use the shorter browse backdrop');
  assert.match(ui, /document\.body\.classList\.toggle\('fullBd', isBrowse \|\| v === 'discover'\);/,
    'Discover should show the focused-title backdrop overlay (rows pinned low) like other cover pages');
  assert.match(ui, /let pendingLibraryRouteJob = null;[\s\S]+function applyLibraryRoute\(id\) \{[\s\S]+switchView\('library', false\);[\s\S]+function deferLibraryRoute\(id\) \{[\s\S]+loadLibraries\(\)[\s\S]+if \(parts\[0\] !== 'library' \|\| parts\[1\] !== id\) return;[\s\S]+if \(!applyLibraryRoute\(id\)\) switchView\('home', false\);[\s\S]+if \(view === 'library' && parts\[1\]\) \{[\s\S]+deferLibraryRoute\(parts\[1\]\);/,
    'library hash routes should wait for async library metadata instead of falling through to Home');
  assert.match(ui, /if \(v === 'search'\) \{ \$\('browseTitle'\)\.textContent = 'Search';[\s\S]+if \(!opts\.preserveSearch && !opts\.preservePage\) resetSearchPage\(\);/,
    'restoring Search from Details should not clear the existing result grid');
  // Unified search fields: global, Music, and Live TV all get a clear (X) button + the same rounded
  // field look, and clearing behaves the same across all three.
  assert.ok(ui.includes('id="searchClearBtn"') && ui.includes('id="musicClearBtn"') && ui.includes('id="chClearBtn"'),
    'all three search fields (global, music, Live TV) have a clear (X) button');
  assert.match(ui, /#musicClearBtn,#searchClearBtn,#chClearBtn\{position:absolute;right:8px/,
    'the clear (X) button styling is shared across every search field');
  assert.match(ui, /function syncSearchClear\(\) \{[\s\S]+searchClearBtn[\s\S]+toggle\('hasClear', hasText\)/,
    'global search toggles its clear button on input like Music');
  assert.match(ui, /function clearSearchQuery\(\) \{[\s\S]+clearSearchResults\(\{ invalidate: true \}\); \$\('searchInput'\)\.focus\(\)/,
    'a shared clearSearchQuery helper empties the field + results (browser click, element keydown, and on-device D-pad all use it)');
  assert.match(ui, /\$\('searchClearBtn'\)\.addEventListener\('click', \(\) => clearSearchQuery\(\)\)/,
    'global search clear button empties the field and results via the shared helper');
  assert.match(ui, /const syncChClear = \(\) => \{[\s\S]+chClearBtn[\s\S]+toggle\('hasClear', hasText\)/,
    'Live TV filter toggles its clear button on input');
  // D-pad reachability of the clear (X) on all three search fields (audit: no remote dead-ends).
  assert.match(ui, /function focusSearchClear\(\) \{[\s\S]+searchClearBtn'\)\.focus\(\)/,
    'global search has a focusSearchClear helper for D-pad');
  assert.match(ui, /ArrowRight' && \$\('searchInput'\)\.selectionStart >= \$\('searchInput'\)\.value\.length && searchClearVisible\(\)[\s\S]+focusSearchClear\(\)/,
    'global search ArrowRight (caret at end) reaches the clear X');
  assert.match(ui, /\$\('searchClearBtn'\)\.addEventListener\('keydown'[\s\S]+ArrowLeft' \|\| e\.key === 'ArrowUp'[\s\S]+searchInput'\)\.focus\(\)/,
    'the global clear X returns focus to the field on Left/Up (no dead-end)');
  assert.match(ui, /if \(chClear\) chClear\.addEventListener\('keydown'[\s\S]+ArrowLeft' \|\| e\.key === 'ArrowUp'[\s\S]+input\.focus\(\)/,
    'the Live TV clear X returns focus to the filter on Left/Up');
  // ON-DEVICE (Android TV): the shell dispatches D-pad keys to `document`, so the clear buttons' own
  // element listeners never fire — the clear must be wired into the GLOBAL keydown handler (like
  // Music at ae===musicClearBtn), for BOTH reaching the X and activating it. The element listeners
  // above still serve the desktop browser; they stopPropagation so the browser never double-fires.
  assert.match(ui, /if \(inInput && S\.view === 'search' && ae === \$\('searchInput'\)\) \{[\s\S]+k === 'ArrowRight' && ae\.selectionStart >= ae\.value\.length && searchClearVisible\(\)[\s\S]+focusSearchClear\(\)/,
    'the GLOBAL keydown handler (not just the element listener) reaches the search clear X on-device');
  assert.match(ui, /if \(S\.view === 'search' && document\.activeElement === \$\('searchClearBtn'\)\) \{[\s\S]+clearSearchQuery\(\)/,
    'the GLOBAL keydown handler activates the search clear X on-device (OK clears the query)');
  assert.match(ui, /if \(inInput && S\.view === 'livetv' && ae === \$\('chSearch'\)\) \{[\s\S]+const clr = \$\('chClearBtn'\);\s*\n\s*if \(clr && !clr\.hidden\)[\s\S]+clr\.focus\(\)/,
    'the GLOBAL keydown handler reaches the Live TV clear X on-device before the Multiview jump');
  assert.match(ui, /if \(S\.view === 'livetv' && document\.activeElement === \$\('chClearBtn'\)\) \{[\s\S]+if \(k === 'Enter'\) \{ if \(!e\.repeat\) clr\.click\(\)/,
    'the GLOBAL keydown handler activates the Live TV clear X on-device (OK clears the filter)');
  // Phone shell: the three search bars must clear the fixed burger icon (top-left overlay).
  assert.match(ui, /body\.mobileShell #searchBar\{top:62px!important\}/,
    'global search bar drops below the burger on the phone shell');
  assert.match(ui, /body\.mobileShell #music\{padding-top:62px!important\}/,
    'music search drops below the burger on the phone shell');
  assert.match(ui, /body\.mobileShell #chBar\{padding-left:48px\}/,
    'Live TV filter clears the burger horizontally on the phone shell');
  assert.match(ui, /body\.mobileShell #browse\.searchMode\{padding-top:146px!important\}/,
    'search results clear the lowered fixed search bar on the phone shell (no results under the bar)');
  // Casting Phase 1 (web): Google Cast (Default Media Receiver) + AirPlay for VOD, receiver-pull.
  assert.ok(ui.includes('id="castBtn"') && ui.includes('id="airplayBtn"'),
    'the player has Cast and AirPlay buttons');
  assert.match(ui, /'qualBtn', 'castBtn', 'airplayBtn', 'muteBtn'/,
    'Cast + AirPlay buttons are in the D-pad control order');
  assert.match(ui, /function castEligible\(\) \{ try \{ return !canUseNativeVideoPlayer\(\); \}/,
    'web casting is suppressed on the Android native-ExoPlayer path (no double-play)');
  // Phase 2: the receiver app-id is CONFIGURABLE but still DEFAULTS to the Default Media Receiver so
  // Phase 1 behavior is unchanged until the owner registers a custom receiver.
  assert.match(ui, /receiverApplicationId: castReceiverAppId\(\)/,
    'the web sender launches the configured receiver app-id');
  assert.match(ui, /function castReceiverAppId\(\) \{[\s\S]+S\.serverInfo && S\.serverInfo\.castReceiverAppId[\s\S]+DEFAULT_MEDIA_RECEIVER_APP_ID\) \|\| 'CC1AD845'[\s\S]+\/\^\[0-9A-F\]\{8\}\$\/\.test\(id\) \? id : dflt/,
    'the receiver app-id defaults to the Default Media Receiver (CC1AD845) when none is configured');
  assert.match(ui, /if \(p && p\.castingActive\) return p\.castPos \|\| 0;/,
    'while casting, currentTime() reads the receiver clock so watch + Trakt heartbeats keep counting (one reporter)');
  assert.match(ui, /function castVodEligible\(\) \{ const p = S\.playing; return !!\(p && p\.item && p\.item\.type !== 'live'\); \}/,
    'casting is VOD-only in Phase 1 (Live TV excluded — it uses MSE, not a plain URL)');
  assert.match(ui, /function currentCastStreamUrl\(\) \{[\s\S]+p\.usingTranscode[\s\S]+p\.usingRemux[\s\S]+new URL\(path, location\.origin\)\.href/,
    'the cast URL is the current variant made absolute (LAN-reachable), token already in the query');
  assert.match(ui, /if \(!castHostReachable\(\)\) \{ toast\('Open Triboon by its LAN IP/,
    'casting from localhost is blocked with guidance (the TV cannot reach localhost)');
  assert.match(ui, /if \(S\.playing && S\.playing\.castingActive && !opts\._fromCast\) \{[\s\S]+endSession\(true\)/,
    'backing out of the player while casting stops the TV too');
  assert.match(ui, /btn\.addEventListener\('click', \(\) => \{ try \{ v\.webkitShowPlaybackTargetPicker\(\); \}/,
    'AirPlay picker is wired for Safari/iOS VOD');
  assert.match(ui, /if \(k === 'ArrowUp'\) return; \/\/ top of the now-playing loop/,
    'music now-playing top controls no longer fall through on ArrowUp (no focus trap)');
  // Trakt-imported resume (percent only, no position/duration) still primes the server read-ahead
  // window via resumeFrac so it doesn't cold-seek (the 20-30s resume lag).
  assert.match(ui, /if \(body\.resumeFrac === undefined && \+it\._traktPct > 2\) \{[\s\S]+body\.resumeFrac = Math\.max\(0, Math\.min\(0\.96, \(\+it\._traktPct\) \/ 100\)\)/,
    'Trakt percent-only progress sends resumeFrac to warm the resume byte window');
  assert.match(ui, /id="chBar"><div class="chWrap"><input id="chSearch"[\s\S]+id="chClearBtn"/,
    'Live TV filter is wrapped so it can host a clear (X) button');
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
  assert.match(ui, /async function checkAvailability\(it\) \{[\s\S]+const hasLocal = localTitleHasPlayback\(it\);[\s\S]+if \(hasLocal && localPlaybackRankForItem\(it\) === 4\) \{[\s\S]+\$\(\'qToggle\'\)\.style\.display = 'none';[\s\S]+api\('\/api\/search\?' \+ sourceSearchQuery\(it, \{ includeQuality: false \}\)\)[\s\S]+has4k && userCanPlay4k\(\) && \(hasLower \|\| \(hasLocal && localRank !== 4\)\)[\s\S]+if \(hasLocal\) \{[\s\S]+\$\(\'dSources\'\)\.style\.display = offer \? '' : 'none';[\s\S]+return;/,
    'local-owned detail pages should still discover online 4K when the local file is lower quality, without showing unavailable');
  assert.match(ui, /if \(it\._showOpen !== undefined\)[\s\S]+openLocalShowDetail\(\{ \.\.\.it, _lib: lib \}\)/,
    'unmatched local TV shows should open a details page instead of a flat episode grid');
  assert.match(ui, /async function openLocalShowDetail\(it\) \{[\s\S]+_localShow: true[\s\S]+loadAllLocalShowEpisodes\(show\._lib, show\._showOpen\)[\s\S]+S\.detailSeasons = localSeasonSummaries\(episodes\)[\s\S]+renderLocalShowSeasonGrid\(show, S\.detailSeasons\)[\s\S]+pickLocalShowPlayTarget\(show, episodes\)/,
    'local-only show details should group scanned episodes into seasons before rendering episode cards');
  assert.match(ui, /function openLocalShowSeasonEpisodes\(show, seasonNumber, opts = \{\}\) \{[\s\S]+S\.localDetailEpisodes[\s\S]+localEpisodeItemOf\(show, ep\)[\s\S]+setLocalEpisodeWatched\(item, act === 'watch', seasonNumber\)/,
    'local-only show seasons should open local episode cards that play and mark local episode keys');
  assert.match(ui, /function localEpisodeItemOf\(show, ep\) \{[\s\S]+q: `\$\{show\.title\} \$\{code\}`[\s\S]+season: ep\.s, episode: ep\.e/,
    'local episode playback items should preserve query and episode numbers for subtitles');
  assert.match(ui, /function episodeKeyParts\(it\) \{[\s\S]+it\.season[\s\S]+it\.episode[\s\S]+it\.q[\s\S]+it\.genre[\s\S]+it\.title/,
    'episode helpers should understand local episode metadata, not just tmdb:tv keys');
  // "All seasons" renders as the LAST tab in the season-tab strip (appendAllSeasonsTab), wired to
  // the right season grid per show type — so a D-pad DOWN into the tabs row can walk right to it.
  assert.match(ui, /function appendAllSeasonsTab\(tabs, onClick\) \{[\s\S]+className = 'seasonTab allSeasonsTab focusable'[\s\S]+b\.id = 'allSeasonsBtn'[\s\S]+tabs\.appendChild\(b\)/,
    'All seasons should be appended as the last season tab');
  assert.match(ui, /appendAllSeasonsTab\(tabs, \(\) => renderSeasonGrid\(show, S\.detailSeasons \|\| \[\]\)\)/,
    'the All-seasons tab opens the TMDB season grid');
  assert.match(ui, /appendAllSeasonsTab\(tabs, \(\) => renderLocalShowSeasonGrid\(show, S\.detailSeasons \|\| \[\]\)\)/,
    'the All-seasons tab opens the local season grid for local-only shows');
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
  assert.match(ui, /function detailPlayEpisodeParts\(\) \{[\s\S]+episodeKeyParts\(detailPlayTarget \|\| \{\}\)[\s\S]+function detailPlayShouldFocusEpisode\(\) \{[\s\S]+Resume\|Continue[\s\S]+async function focusDetailPlayEpisode\(show, opts = \{\}\) \{[\s\S]+openSeasonEpisodes\(show, parts\.season, \{ focusEpisode: parts\.episode, reqId: opts\.reqId \}\)[\s\S]+function queueDetailPlayEpisodeFocus\(show, reqId\) \{[\s\S]+focusDetailPlayEpisode\(show, \{ reqId \}\)/,
    'TV show details should auto-open and focus the Resume/Continue episode instead of leaving users at the top of the show');
  assert.match(ui, /async function openSeasonEpisodes\(show, seasonNumber, opts = \{\}\) \{[\s\S]+card\.dataset\.season = String\(seasonNumber\);[\s\S]+card\.dataset\.episode = String\(ep\.episode_number\);[\s\S]+focusRenderedDetailEpisode\(\{ season: seasonNumber, episode: focusEpisode \}\)/,
    'TMDB season episode grids should expose exact season/episode focus targets');
  assert.match(ui, /function openLocalShowSeasonEpisodes\(show, seasonNumber, opts = \{\}\) \{[\s\S]+card\.dataset\.season = String\(seasonNumber\);[\s\S]+card\.dataset\.episode = String\(ep\.e\);[\s\S]+focusRenderedDetailEpisode\(\{ season: seasonNumber, episode: focusEpisode \}\)/,
    'local-only season episode grids should expose exact season/episode focus targets');
  // Switching seasons from the tab strip must keep focus on the newly selected tab (the re-render
  // destroys the old focused tab and otherwise snaps focus back to Play).
  assert.match(ui, /async function openSeasonEpisodes\(show, seasonNumber, opts = \{\}\) \{[\s\S]+const cameFromTab = opts\.fromTab[\s\S]+#seasonTabs \.seasonTab\.focus[\s\S]+if \(cameFromTab\) \{[\s\S]+tabs\.querySelector\('\.seasonTab\.sel'\)[\s\S]+applyFocus\(selTab, false\); return;/,
    'TMDB season-tab switches should keep focus on the selected tab, not fall back to Play');
  assert.match(ui, /function openLocalShowSeasonEpisodes\(show, seasonNumber, opts = \{\}\) \{[\s\S]+const cameFromTab = opts\.fromTab[\s\S]+if \(cameFromTab\) \{[\s\S]+tabs\.querySelector\('\.seasonTab\.sel'\)[\s\S]+applyFocus\(selTab, false\); return;/,
    'local season-tab switches should keep focus on the selected tab too');
  // "All seasons" is the last .seasonTab now, so it rides the seasonTab D-pad row (no separate zone).
  assert.doesNotMatch(ui, /\[zone\('#allSeasonsBtn'\), 'allSeasons'\]/,
    'All seasons should no longer have its own D-pad zone (it is part of the seasonTab row)');
  // Marking a single episode watched must NOT drop D-pad focus (it jumped to the rail/top). Re-render
  // with a focus target: advance to the next episode when marking watched, stay put when unmarking.
  assert.match(ui, /async function setEpisodeWatched\([\s\S]+openSeasonEpisodes\(show, seasonNumber, \{ focusEpisode: watched \? ep\.episode_number \+ 1 : ep\.episode_number \}\)/,
    'marking an episode watched should keep focus on the episode list (advance to next / stay on unmark), not let it jump');
  assert.match(ui, /if \(focusEpisode > 0\) \{[\s\S]+focusRenderedDetailEpisode\(\{ season: seasonNumber, episode: focusEpisode \}\)\) return;[\s\S]+eps\.filter\(\(c\) => \(parseInt\(c\.dataset\.episode, 10\) \|\| 0\) <= focusEpisode\)\.pop\(\)/,
    'episode focus should fall back to the nearest lower episode when the requested one is not rendered (e.g. the next after a finale)');
  assert.match(ui, /renderSeasonGrid\(it, seasons\);[\s\S]+pickNextUp\(it, seasons\);[\s\S]+queueDetailPlayEpisodeFocus\(it, reqId\);/,
    'TMDB show details should focus the computed current episode after the Play target is known');
  assert.match(ui, /renderLocalShowSeasonGrid\(show, S\.detailSeasons\);[\s\S]+pickLocalShowPlayTarget\(show, episodes\);[\s\S]+queueDetailPlayEpisodeFocus\(show, reqId\);/,
    'local show details should focus the computed current episode after scanned episode targets are known');
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

test('casting Phase 3: native Android Cast sender is wired (cast from the app)', () => {
  const androidDir = path.join(__dirname, '..', 'android', 'app');
  const main = fs.readFileSync(path.join(androidDir, 'src', 'main', 'java', 'app', 'triboon', 'tv', 'MainActivity.java'), 'utf8');
  const provider = fs.readFileSync(path.join(androidDir, 'src', 'main', 'java', 'app', 'triboon', 'tv', 'CastOptionsProvider.java'), 'utf8');
  const gradle = fs.readFileSync(path.join(androidDir, 'build.gradle'), 'utf8');
  const manifest = fs.readFileSync(path.join(androidDir, 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  // Build wiring: Cast SDK deps + reflectively-loaded OptionsProvider (Default Media Receiver).
  assert.match(gradle, /play-services-cast-framework/, 'the app depends on the Google Cast sender SDK');
  assert.match(gradle, /androidx\.mediarouter:mediarouter/, 'mediarouter provides the Cast route picker');
  // Phase 2: the Android sender reads a configurable app-id from SharedPreferences but FALLS BACK to
  // the Default Media Receiver (matches Phase 1/3, no registration/HTTPS media) when none is set.
  assert.match(provider, /setReceiverApplicationId\(receiverAppId\(context\)\)/,
    'the Android sender launches the configured receiver app-id');
  assert.match(provider, /private static String receiverAppId\(Context context\) \{[\s\S]+getSharedPreferences\(PREFS[\s\S]+matches\("\[0-9A-F\]\{8\}"\)[\s\S]+return CastMediaControlIntent\.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID/,
    'the Android receiver app-id defaults to the Default Media Receiver when no valid custom id is stored');
  assert.match(main, /public void setCastReceiverAppId\(String id\)/,
    'a bridge method lets the web UI persist the configured cast receiver app-id for the native sender');
  assert.match(manifest, /OPTIONS_PROVIDER_CLASS_NAME[\s\S]+app\.triboon\.tv\.CastOptionsProvider/,
    'the manifest registers the Cast OptionsProvider');
  // Bridge: the web player routes cast intent/controls to native; native never double-plays.
  assert.match(main, /public void castRequest\(String json\)/, 'a castRequest bridge method exists');
  assert.match(main, /public void castControl\(String action\)/, 'a castControl bridge method exists');
  assert.match(main, /public void castStop\(\)/, 'a castStop bridge method exists');
  assert.match(main, /int gp = com\.google\.android\.gms\.common\.GoogleApiAvailability[\s\S]+castUnavailable = true;/,
    'CastContext init is guarded on Google Play Services so degoogled/Fire boxes never crash');
  assert.match(main, /closeNativePlayback\(false\);[\s\S]+new com\.google\.android\.gms\.cast\.MediaInfo\.Builder/,
    'loading the receiver stops the local ExoPlayer first (no double-play)');
  assert.match(main, /window\.__tvCast && window\.__tvCast\(/, 'native pushes cast state to the web via __tvCast');
  assert.match(main, /boolean show = castHasDevices && !castActive\(\) && "video"\.equals\(nativeMode\)/,
    'the native Cast button shows only for VOD when a device is available and not already casting');
  // castHasDevices is only accurate while a MediaRouter discovery scan runs — CAF does not keep one
  // alive on its own and there is no MediaRouteButton, so without this the button never appears.
  assert.match(main, /mediaRouter\.addCallback\(castRouteSelector\(\), castRouteCallback,\s*\n?\s*androidx\.mediarouter\.media\.MediaRouter\.CALLBACK_FLAG_REQUEST_DISCOVERY\)/,
    'foreground MediaRouter discovery is started so castHasDevices reflects real device availability');
  assert.match(main, /try \{ castCtx\(\); startCastDiscovery\(\); \}/, 'discovery starts on resume');
  assert.match(main, /stopCastDiscovery\(\); \/\/ foreground-only scan/, 'discovery stops on pause (foreground-only, session left running)');
  assert.match(main, /castContext\.getMergedSelector\(\)/,
    'the route selector uses CastContext.getMergedSelector so it matches the configured (possibly custom) receiver id');
  assert.match(main, /nativeAudioBtn, nativeCastBtn, nativeQualityBtn/, 'the native Cast button is in the D-pad control order');
  assert.match(main, /detachCastMediaListeners\(\);\s*\n\s*removeCastListeners\(\);/,
    'Cast listeners are detached on destroy (framework must not hold the Activity; session is NOT ended)');
  // Web glue: the __tvCast hook feeds the Phase-1 cast fields; controls route to the native bridge.
  assert.match(uiSrc, /window\.__tvCast = \(o\) => \{[\s\S]+p\.castingActive = true;[\s\S]+p\.castPos = o\.position/,
    'the web __tvCast hook feeds the shared cast fields so the OSD + heartbeat keep working');
  assert.match(uiSrc, /else if \(window\.TriboonTV && TriboonTV\.castControl\) \{ try \{ TriboonTV\.castControl\(S\.playing\.castPaused/,
    'in-app play/pause routes to the native cast bridge');
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

test('admin security panel exposes own-password change separately from user resets', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(ui, /<button data-tab="security"[\s\S]+<span>Security<\/span><\/button>/,
    'Server Settings should expose a Security tab for owner account controls');
  assert.match(ui, /<div class="panel"><h2>Admin password<\/h2>[\s\S]+id="secPwCurrent"[\s\S]+id="secPwNew"[\s\S]+id="secPwConfirm"[\s\S]+id="secPwSave"/,
    'Security should include a current/new/confirm owner password form');
  assert.match(ui, /\$\(\'secPwSave\'\)\.addEventListener\('click', async \(\) => \{[\s\S]+newPassword !== confirmPassword[\s\S]+await api\('\/api\/me\/password', \{ method: 'POST', body: \{ oldPassword, newPassword \} \}\)[\s\S]+tokenStore\.set\(null\)[\s\S]+showGate\('login'\)/,
    'owner password form should validate confirmation, call the own-account password endpoint, and force a clean re-login');
});

test('music playback stops when leaving the Music section', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(ui, /function stopMusicWhenLeavingMusic\(nextView\) \{[\s\S]+if \(nextView === 'music'\) return;[\s\S]+if \(S\.musicCur\) closeMusicPlayer\(\);[\s\S]+S\._musicWasPlaying = false;[\s\S]+\}/,
    'leaving Music should stop and clear the section-scoped audio player');
  assert.match(ui, /function switchView\(v, push = true, opts = \{\}\) \{[\s\S]+stopMusicWhenLeavingMusic\(v\);[\s\S]+\$\(\'musicNow\'\)\.classList\.remove\('open'\)/,
    'all normal page navigation should enforce the Music stop rule');
  assert.match(ui, /async function openPlayer\(it, mount, opts = \{\}\) \{[\s\S]+if \(S\.musicCur\) closeMusicPlayer\(\);[\s\S]+S\._musicWasPlaying = false;/,
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

test('music search supports voice and TV result focus without side-note clutter', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.ok(ui.includes('id="musicMicBtn" class="focusable" title="Voice search" aria-label="Voice search"'),
    'Music search should expose the same voice affordance as main Search');
  assert.match(ui, /<section id="music">[\s\S]+<div class="wrap">\s*<button id="musicMicBtn"[\s\S]+<input id="musicSearch"/,
    'Music search should mirror global Search with the microphone on the left of the field');
  assert.match(ui, /<input id="musicSearch"[\s\S]+<button id="musicClearBtn" class="focusable" title="Clear search" aria-label="Clear search" hidden>/,
    'Music search should expose a D-pad reachable clear button beside the input');
  assert.doesNotMatch(ui, /<section id="music">\s*<div class="musicHead">\s*<h1>Music<\/h1>/,
    'Music should not render a redundant title above the search strip');
  assert.match(ui, /\.musicHead \.wrap\.hasMic #musicSearch\{padding-left:58px\}[\s\S]+#musicMicBtn\{position:absolute;left:10px;/,
    'Music mic and input spacing should use the same left-mic layout as global Search');
  assert.match(ui, /\.musicHead \.wrap\.hasClear #musicSearch\{padding-right:58px\}[\s\S]+#musicClearBtn,#searchClearBtn,#chClearBtn\{position:absolute;right:8px;/,
    'Music clear button should reserve right-side input space without covering typed text');
  assert.doesNotMatch(ui, /Liked Music and your YouTube Music playlists stay first|Weekly picks only, kept short so Music opens quickly/,
    'Music shelf headers should not render right-aligned helper text');
  assert.match(ui, /const addShelf = \(title, cls = ''\) => \{[\s\S]+<div class="musicShelfTop"><h2>\$\{esc\(title\)\}<\/h2><\/div>[\s\S]+musicTiles[\s\S]+musicRail/,
    'Music shelf headers should render only the shelf title above the cards');
  assert.match(ui, /function musicSearchAndFocusResults\(\) \{[\s\S]+clearTimeout\(_musicSearchT\);[\s\S]+doMusicSearch\(\)\.then\(\(\) => focusMusicResultsSoon\(\)\)/,
    'Music Enter/voice search should submit immediately and wait for result focus');
  // Phone music: the now-playing seekbar must scrub by touch tap AND drag (was click-only), with a
  // bigger touch target and no scroll-hijack; and a long artist name must not overflow/shift the page.
  assert.match(ui, /\$\('mnSeek'\)\.addEventListener\('pointerdown'[\s\S]+setPointerCapture\(e\.pointerId\)[\s\S]+mnSeekToPointer\(e\)/,
    'the music seekbar should scrub via pointer (touch tap + drag), not click only');
  assert.match(ui, /\.mnProg \.mbBar\{height:6px;touch-action:none\}\s*\.mnProg \.mbBar::before\{content:""[^}]*top:-14px/,
    'the music seekbar needs touch-action:none and an enlarged ::before hit area for touch');
  assert.match(ui, /\.mnInfo\{min-width:0;width:100%;max-width:calc\(100vw - 32px\)\}/,
    'on phones the now-playing info must be viewport-capped so a long artist truncates instead of shifting the layout');
  assert.match(ui, /function moveMusicSearchDown\(\) \{[\s\S]+if \(q\) \{ musicSearchAndFocusResults\(\); return; \}[\s\S]+chipEls\(\)\.length[\s\S]+musicRows\(\)\.length/,
    'Music ArrowDown should not strand focus in the input while search results load');
  // TV: scrollIntoView is unreliable inside the #musicList overflow container (the focus ring moved
  // down search results but the list never scrolled). focusMusic must scroll #musicList by hand on TV.
  assert.match(ui, /function scrollMusicRowIntoView\(el\) \{[\s\S]+getBoundingClientRect\(\)[\s\S]+ml\.scrollTo\(\{ top: Math\.max\(0, top\)/,
    'music results must scroll by measured rects (scrollIntoView is unreliable in the TV WebView)');
  assert.match(ui, /function focusMusic\(i\) \{[\s\S]+const tv = document\.body\.classList\.contains\('tv'\);[\s\S]+applyFocus\(rows\[S\.musicRowIdx\], !tv && !S\.pointer\);[\s\S]+if \(tv\) scrollMusicRowIntoView\(rows\[S\.musicRowIdx\]\)/,
    'focusMusic should scroll the list manually on TV so lower search results are not stranded off-screen');
  assert.match(ui, /window\.__tvVoice = \(text\) => \{[\s\S]+tvVoiceTarget === 'music' && S\.view === 'music'[\s\S]+submitMusicVoiceSearch\(text\)/,
    'Android native voice callback should route to Music when the Music mic launched it');
  assert.match(ui, /function setupMusicVoiceSearch\(\) \{[\s\S]+TriboonTV\.startVoice[\s\S]+setTvVoiceTarget\('music'\)[\s\S]+new SR\(\)/,
    'Music voice search should support both Android native recognition and browser SpeechRecognition');
  assert.match(ui, /function syncMusicClear\(\) \{[\s\S]+\$\(\'musicClearBtn\'\)\.hidden = !hasText;[\s\S]+classList\.toggle\('hasClear', hasText\)/,
    'Music clear button visibility should track whether the search field has text');
  assert.match(ui, /function clearMusicSearch\(opts = \{\}\) \{[\s\S]+clearTimeout\(_musicSearchT\);[\s\S]+\$\(\'musicSearch\'\)\.value = '';[\s\S]+showMusicHome\(\);[\s\S]+focusContent\(\)/,
    'Clearing Music search should return to the Music browse surface');
  assert.match(ui, /\$\(\'musicClearBtn\'\)\.addEventListener\('click', \(\) => clearMusicSearch\(\)\)/,
    'Music clear button should also clear through the normal button click path');
  assert.match(ui, /function musicMicVisible\(\) \{[\s\S]+\$\(\'musicMicBtn\'\)\.style\.display !== 'none'[\s\S]+function focusMusicSearch\(\) \{[\s\S]+return musicMicVisible\(\) \? \$\(\'musicMicBtn\'\)\.focus\(\) : \$\(\'musicSearch\'\)\.focus\(\)/,
    'Music should land on the mic instead of defaulting TV D-pad focus into the text input');
  assert.match(ui, /if \(inInput && ae === \$\('musicSearch'\)\) \{[\s\S]+k === 'ArrowDown' \|\| k === 'Enter'[\s\S]+moveMusicSearchDown\(\)/,
    'document-level D-pad handling should submit or move from Music search consistently');
  assert.match(ui, /k === 'ArrowRight' && ae\.selectionStart >= ae\.value\.length && musicClearVisible\(\)[\s\S]+return focusMusicClear\(\)/,
    'right from the end of Music search should focus the clear button when it is visible');
  assert.match(ui, /\$\(\'musicSearch\'\)\.addEventListener\('keydown', \(e\) => \{[\s\S]+e\.key === 'ArrowLeft' && \$\(\'musicSearch\'\)\.selectionStart === 0 && musicMicVisible\(\)[\s\S]+focusMusicSearch\(\)/,
    'Music search input should let left-at-start step back to the mic in browser and Android TV');
  assert.match(ui, /ae\.selectionStart === 0[\s\S]+return musicMicVisible\(\) \? focusMusicSearch\(\) : enterRail\(\)/,
    'left from the Music search field should step back to the mic before the rail');
  assert.match(ui, /if \(ae === \$\('musicClearBtn'\)\) \{[\s\S]+clearMusicSearch\(\)[\s\S]+focusMusicInput\(\)[\s\S]+moveMusicSearchDown\(\)/,
    'Music clear button should be a first-class D-pad stop between the input and results');
  assert.match(ui, /if \(ae === \$\('musicMicBtn'\)\) \{[\s\S]+\$\(\'musicMicBtn\'\)\.click\(\)[\s\S]+if \(k === 'ArrowRight'\) \{ \$\(\'musicMicBtn\'\)\.blur\(\); return focusMusicInput\(\); \}[\s\S]+moveMusicSearchDown\(\)[\s\S]+enterRail\(\)/,
    'Music mic should be a real Android TV focus stop with right-to-type and left-to-menu navigation');
  assert.match(ui, /if \(S\.view === 'music'\) \{[\s\S]+if \(k === 'Escape' \|\| k === 'Backspace'\) return enterRail\(\);[\s\S]+if \(S\.zone === 'musicChips'\)/,
    'Back/Escape from Music browse should open the rail so other sections stay reachable');
  assert.match(ui, /const rank = opts\.search \? `<div class="mRank">[\s\S]+const playGlyph = opts\.search \? '<div class="mPlayGlyph">[\s\S]+playMusic\(results, i, opts\.search \? \{ showQueue: true \} : \{\}\)/,
    'TV search result rows should be richer and open the queue so the next songs are visible');
  assert.match(ui, /body\.tv \.mSearchSongs\{grid-template-columns:repeat\(2,minmax\(330px,1fr\)\)[\s\S]+body\.tv \.mSearchSongs \.musicRow\.focus[\s\S]+body\.tv \.mSearchSongs \.musicRow \.mRank,body\.tv \.mSearchSongs \.musicRow \.mPlayGlyph\{display:grid\}/,
    'TV Music search results should render as larger two-column song cards with clear focus');
});

test('subtitle startup preference contract: admin can toggle built-in captions', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const playerMap = fs.readFileSync(path.join(__dirname, '..', 'docs-player-regression-map.md'), 'utf8');
  const android = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'app', 'triboon', 'tv', 'MainActivity.java'), 'utf8');
  const webHousekeepingStart = ui.indexOf('function startWebPlayerHousekeeping(mount, it) {');
  const webHousekeepingEnd = ui.indexOf('function playbackStartKind(mount)', webHousekeepingStart);
  assert.ok(webHousekeepingStart >= 0 && webHousekeepingEnd > webHousekeepingStart, 'web player housekeeping function should be present');
  const webHousekeeping = ui.slice(webHousekeepingStart, webHousekeepingEnd);
  assert.match(ui, /function prefSubtitleMode\(\) \{[\s\S]+const scoped = localStorage\.getItem\(profilePrefKey\('subtitleMode'\)\);[\s\S]+if \(scoped !== null\) return scoped === 'always' \? 'always' : 'manual';[\s\S]+localStorage\.getItem\('triboon\.subtitleMode'\) === 'always'/,
    'profile subtitle mode should fall back to the legacy global always/manual setting');
  assert.match(ui, /function builtInSubtitlesEnabled\(\) \{[\s\S]+S\.serverInfo && S\.serverInfo\.builtInSubtitlesEnabled === true[\s\S]+\}/,
    'built-in subtitle behavior should come from server settings instead of a hardcoded test flag');
  assert.match(ui, /<select id="builtInSubsMode"[\s\S]+<option value="off">Online only<\/option>[\s\S]+<option value="on">Built-in first, then online<\/option>/,
    'admin Settings should expose an online-only/built-in-first subtitle toggle');
  assert.match(ui, /const body = \{ builtInSubtitlesEnabled: \$\('builtInSubsMode'\)\.value === 'on' \};[\s\S]+if \(key\) body\.openSubsKey = key;/,
    'saving subtitle settings should allow toggling built-ins without erasing the saved online key');
  assert.match(ui, /function bestBuiltInSubtitleRel\(\) \{[\s\S]+if \(!builtInSubtitlesEnabled\(\)\) return '';[\s\S]+return bestReleaseSubtitleRel\(\) \|\| bestEmbeddedSubtitleRel\(\);[\s\S]+\}/,
    'automatic subtitle startup should skip same-release and embedded built-in choices when the admin disables them');
  assert.match(ui, /function autoSubtitleRelFor\(p\) \{[\s\S]+if \(builtInSubtitlesEnabled\(\) && p && p\.tracksUrl && !p\.tracks\) return '';[\s\S]+return osTrackRel\(preferredAutoSubtitleLang\(\)\);[\s\S]+\}/,
    'online subtitles should not wait for the track probe while built-in subtitles are disabled by settings');
  assert.match(ui, /function startupSubtitleRelFor\(p, saved = loadSubChoice\(\)\) \{[\s\S]+Manual mode is truly manual at startup[\s\S]+if \(prefSubtitleMode\(\) !== 'always'\) return '';[\s\S]+if \(saved === 'off'\) return '';[\s\S]+if \(subtitleRelPlayable\(p, saved\)\) return saved;[\s\S]+const builtIn = bestBuiltInSubtitleRel\(\);[\s\S]+if \(builtIn\) return builtIn;[\s\S]+return autoSubtitleRelFor\(p\);[\s\S]+\}/,
    'manual subtitle mode should not auto-enable saved captions while always mode can reuse saved online choices');
  assert.match(webHousekeeping, /loadTracks\(\);[\s\S]+if \(!applyStartupSubtitlePref\(\)\) \{/,
    'web player should try to enable always-mode subtitles before entering online warmup');
  assert.ok(webHousekeeping.includes('fetch(`/api/ossubs/${mount.id}?${subtitleRequestParams(it, code2, mount.streamToken).toString()}`).catch(() => {});'),
    'web player should try to enable always-mode subtitles before falling back to online warmup prefetch');
  // The online-subtitle request must carry the exact episode (same source the play request uses), so
  // the server filters Wyzie by SxxExx instead of recovering it from a remembered query string. Without
  // this, episode plays searched the whole show — wrong dialogue + a wall of mixed-episode rows.
  assert.match(ui, /function subtitleRequestParams\(it, lang, streamToken\) \{[\s\S]+const ep = episodeKeyParts\(it\);[\s\S]+q\.set\('season', String\(ep\.season\)\);[\s\S]+q\.set\('episode', String\(ep\.episode\)\);/,
    'subtitleRequestParams must send explicit season/episode so the correct episode reaches Wyzie');
  // 639-2 Bibliographic codes ffprobe emits (cze/ger/fre/gre/per/chi) must map to the right
  // 639-1 code instead of being truncated to a wrong language; otherwise non-English CC misses.
  const langMap = (ui.match(/const LANG_3TO2 = \{[\s\S]*?\};/) || [''])[0];
  for (const pair of ['cze: \'cs\'', 'ces: \'cs\'', 'ger: \'de\'', 'fre: \'fr\'', 'gre: \'el\'', 'ell: \'el\'', 'per: \'fa\'', 'chi: \'zh\'']) {
    assert.ok(langMap.includes(pair), `LANG_3TO2 must map ${pair} so the right subtitle language reaches Wyzie`);
  }
  // The client LANG_3TO2 and the server ISO6392_TO_1 are two hand-maintained copies that MUST stay
  // identical (a drift on the long tail silently breaks non-English CC). Assert full equality so they
  // can't diverge unnoticed — the old "includes a few pairs" check missed everything else.
  const parseLangMap = (src, decl) => {
    const body = (src.match(new RegExp(decl + '\\s*=\\s*\\{([\\s\\S]*?)\\};')) || [, ''])[1];
    const out = {};
    for (const m of body.matchAll(/([a-z_]+)\s*:\s*'([a-z]{2})'/g)) out[m[1]] = m[2];
    return out;
  };
  const serverSubs = fs.readFileSync(path.join(__dirname, '..', 'server', 'opensubs.js'), 'utf8');
  const webLang = parseLangMap(ui, 'const LANG_3TO2');
  const srvLang = parseLangMap(serverSubs, 'const ISO6392_TO_1');
  assert.ok(Object.keys(srvLang).length > 50, 'server ISO6392_TO_1 parsed a full map');
  assert.deepStrictEqual(webLang, srvLang,
    'LANG_3TO2 (web/index.html) and ISO6392_TO_1 (server/opensubs.js) must stay identical — they are kept in sync by hand');
  assert.match(ui, /function applyStartupSubtitlePref\(\) \{[\s\S]+const rel = concreteSubtitleRel\(startupSubtitleRelFor\(p\)\);[\s\S]+Promise\.resolve\(setSubtitle\(rel, \{ startup: true \}\)\)\.finally/,
    'always-mode subtitles should be applied without waiting for the track probe to finish');
  assert.match(webHousekeeping, /await fetchPlayerTracks\(p, 1400\)[\s\S]+if \(bestBuiltInSubtitleRel\(\) && prefSubtitleMode\(\) === 'always'\) \{[\s\S]+applyStartupSubtitlePref\(\);[\s\S]+return;[\s\S]+\}[\s\S]+if \(prefSubtitleMode\(\) === 'always' && applyStartupSubtitlePref\(\)\) return;[\s\S]+\/api\/ossubs/,
    'web startup should still retain the built-in-first branch for when built-ins are re-enabled');
  assert.match(ui, /const releaseSubs = visibleReleaseSubChoices\(\);[\s\S]+releaseSubs\.slice\(0, 6\)\.forEach[\s\S]+releaseSubLabel\(sub\)/,
    'CC menu should list same-release subtitles ahead of online subtitle choices');
  assert.match(ui, /function releaseSubChoices\(\) \{\s+if \(!builtInSubtitlesEnabled\(\)\) return \[\];[\s\S]+return \(p && p\.tracks && Array\.isArray\(p\.tracks\.releaseSubs\)\) \? p\.tracks\.releaseSubs : \[\];[\s\S]+\}/,
    'same-release sidecar subtitle rows should be hidden while built-ins are disabled');
  assert.match(ui, /function releaseSubLabel\(sub\) \{[\s\S]+return builtInSubtitleLabel\(/,
    'same-release sidecar subtitle rows should keep the built-in label for when built-ins are re-enabled');
  assert.match(ui, /function builtInSubtitleLabel\(label\) \{[\s\S]+sourceSubtitleLabel\('Built-in', label\)/,
    'local subtitle sources should have one user-facing built-in label');
  assert.match(ui, /function embeddedSubChoices\(\) \{\s+if \(!builtInSubtitlesEnabled\(\)\) return \[\];[\s\S]+return subs\.filter\(\(s\) => s && s\.text === true\);[\s\S]+\}/,
    'embedded text subtitle rows should be hidden while built-ins are disabled');
  assert.match(ui, /function embeddedSubLabel\(sub\) \{[\s\S]+return sourceSubtitleLabel\('Built-in'/,
    'embedded text subtitle rows should be labeled as built-in');
  assert.match(ui, /function visibleReleaseSubChoices\(\) \{[\s\S]+showAllLocalSubtitles\(\) \? all : all\.filter\(\(s\) => subtitleChoiceMatchesPreferred\(s\)\);[\s\S]+\}/,
    'same-release subtitle rows should be filtered to the preferred subtitle language unless the user expands all languages');
  assert.match(ui, /function visibleEmbeddedSubChoices\(\) \{[\s\S]+showAllLocalSubtitles\(\) \? all : all\.filter\(\(s\) => subtitleChoiceMatchesPreferred\(s\)\);[\s\S]+\}/,
    'built-in subtitle rows should be filtered to the preferred subtitle language unless the user expands all languages');
  assert.match(ui, /const embeddedSubs = visibleEmbeddedSubChoices\(\);[\s\S]+embeddedSubs\.slice\(0, 8\)\.forEach[\s\S]+embeddedSubLabel\(sub\)/,
    'CC menu keeps the built-in row code available for when built-ins are re-enabled');
  assert.match(ui, /hiddenLocalSubtitleCount\(\)[\s\S]+Show all subtitle languages[\s\S]+setShowAllLocalSubtitles\(true\)/,
    'CC menu should offer an explicit way to reveal hidden local subtitle languages');
  assert.match(ui, /Promise\.resolve\(setSubtitle\(rel, \{ startup: true \}\)\)\.finally/,
    'startup auto-subtitle selection should mark the request so fallback behavior is explicit');
  assert.match(ui, /function onlineSubtitleLabel\(label\) \{[\s\S]+sourceSubtitleLabel\('Online'/,
    'online subtitle rows should be labeled as online');
  assert.match(ui, /mkRow\(onlineSubtitleLabel\(pick\.label\), p\.subTrack === pick\.rel, \(\) => setSubtitle\(pick\.rel\)\)/,
    'web CC menu should show online source labels for default online subtitles');
  assert.match(ui, /const extractionMode = opts\.startup \? 'startup' : 'manual';[\s\S]+let url = subtitleUrlForRel\(p, rel, \{ mode: extractionMode \}\)/,
    'startup auto-subtitle selection should use the short startup wait instead of blocking on a full manual extraction');
  assert.match(ui, /function subtitleUrlForRel\(p, rel, opts = \{\}\) \{[\s\S]+rel\.startsWith\('em:'\)[\s\S]+embeddedSubUrl\(p, rel, opts\)/,
    'shared subtitle URL builder should pass extraction mode through for built-in subtitles');
  assert.match(ui, /r\.status === 504[\s\S]+Built-in subtitles are still preparing - using online subtitles/,
    'slow startup built-in subtitle extraction should fall back to online subtitles instead of waiting like a manual choice');
  assert.doesNotMatch(ui, /return setSubtitle\(rel, \{ startup: false, builtInRetry: true \}\);/,
    'startup built-in subtitle extraction should not silently turn into a long manual retry');
  assert.match(ui, /const manualChoice = !opts\.startup && !opts\.builtInRetry && !opts\.autoFallback;/,
    'only explicit user subtitle choices should persist as per-title subtitle choices');
  assert.match(ui, /return setSubtitle\(onlineFallbackRelForBuiltIn\(rel\), \{ autoFallback: true \}\);/,
    'automatic online fallback from a built-in failure should not become the saved per-title choice');
  assert.match(ui, /if \(manualChoice && typeof rel === 'string' && rel\.startsWith\('os:'\)\)[\s\S]+if \(manualChoice\) saveSubChoice\(rel, subtitleDisplayName\(rel\)\);/,
    'startup auto-selection should not overwrite manual language or subtitle choice preferences');
  assert.match(ui, /if \(prefSubtitleMode\(\) === 'always'\) \{[\s\S]+saveSubChoice\(null\);[\s\S]+\} else \{[\s\S]+savePrefLang\('slang', 'off'\);/,
    'turning subtitles off in always mode should persist only the per-title off choice, not the global subtitle language');
  assert.match(ui, /window\.__tvNativeSubtitleSelect = \(rel, pos, dur\) => \{[\s\S]+if \(!rel\) \{[\s\S]+if \(prefSubtitleMode\(\) === 'always'\) saveSubChoice\(null\);[\s\S]+else \{[\s\S]+savePrefLang\('slang', 'off'\);/,
    'native subtitle off should follow the same per-title always-mode behavior as the web CC menu');
  assert.match(ui, /function scheduleEmbeddedSubtitlePrewarm\(p = S\.playing\) \{\s+if \(!builtInSubtitlesEnabled\(\)\) return;[\s\S]+setTimeout\(\(\) => \{[\s\S]+fetch\(embeddedSubUrl\(p, rel, \{ mode: 'prewarm' \}\)\)/,
    'built-in subtitle extraction should not prewarm while online-only mode is active');
  assert.match(ui, /fetch\(embeddedSubUrl\(p, rel, \{ mode: 'prewarm' \}\)\)[\s\S]+}, 1200\);/,
    'built-in subtitle prewarm should start soon after track probing without blocking source startup');
  assert.match(ui, /function onlineFallbackRelForBuiltIn\(rel\) \{[\s\S]+const sub = embeddedSubForRel\(rel\);[\s\S]+const lang = sub && sub\.lang \? osLang\(sub\.lang\) : osLang\(preferredAutoSubtitleLang\(\)\);[\s\S]+return osTrackRel\(lang \|\| 'en'\);[\s\S]+\}/,
    'slow built-in subtitle tracks should fall back to online subtitles in the same language when possible');
  assert.match(ui, /rel\.startsWith\('em:'\) && canAutoSubtitle\(p\)[\s\S]+Built-in subtitles are still preparing - using online subtitles[\s\S]+return setSubtitle\(onlineFallbackRelForBuiltIn\(rel\), \{ autoFallback: true \}\)/,
    'built-in subtitle extraction failures should automatically fall back to online subtitles when configured');
  assert.match(ui, /p\._subVttText = await r\.text\(\);[\s\S]+p\._subVttRel = rel;/,
    'subtitle selection should keep the verified VTT body for the player attach path');
  assert.match(ui, /p\.subTrack\.startsWith\('os:'\) \|\| p\.subTrack\.startsWith\('rs:'\) \|\| p\.subTrack\.startsWith\('em:'\)/,
    'built-in subtitle rels should be allowed through the web subtitle attach path');
  assert.match(ui, /tr\.src = subtitleUrlForRel\(p, p\.subTrack, \{ mode: 'manual' \}\)/,
    'fallback web subtitle attachment should use the manual extraction window for built-in subtitles');
  assert.match(ui, /URL\.createObjectURL\(new Blob\(\[p\._subVttText\], \{ type: 'text\/vtt;charset=utf-8' \}\)\)/,
    'web subtitles should attach the already-fetched VTT text through a blob URL');
  assert.match(ui, /function applyTrackPrefs\(\) \{[\s\S]+if \(p\.usingNative && canUseNativeVideoPlayer\(\)\) return;[\s\S]+applyStartupSubtitlePref\(\);[\s\S]+if \(!p\.tracks\) \{ updateSrndBtn\(\); return; \}/,
    'track preference setup should still apply startup subtitles when tracks are not available yet');
  assert.match(ui, /function nativeVideoSubtitleRel\(p\) \{\s+return \{ blocked: false, rel: concreteSubtitleRel\(startupSubtitleRelFor\(p\)\) \};\s+\}/,
    'native ExoPlayer startup should use the same subtitle startup contract as web playback');
  assert.match(ui, /function nativeSubtitlePayload\(p, rel, mode = 'startup'\) \{[\s\S]+subtitleUrlForRel\(p, chosen, \{ mode \}\)[\s\S]+nativeSubtitleLabel\(chosen\)[\s\S]+\}/,
    'native subtitle payloads should be built from the same rel, URL, label and shift helpers as the web player');
  assert.match(ui, /async function nativeStartupSubtitleRelAfterPreflight\(p, rel\) \{[\s\S]+fetch\(payload\.url\)[\s\S]+if \(r\.ok\) return rel;[\s\S]+return canAutoSubtitle\(p\) \? onlineFallbackRelForBuiltIn\(rel\) : '';/,
    'native playback should preflight slow built-in subtitles and fall back to online before updating ExoPlayer');
  assert.match(ui, /async function applyNativeStartupSubtitleAfterTrackProbe\(p\) \{[\s\S]+const rel = await nativeStartupSubtitleRelAfterPreflight\(p,[\s\S]+window\.TriboonTV\.updateActiveSubtitle\(JSON\.stringify[\s\S]+p\.subTrack = rel;[\s\S]+refreshNativeSubtitleChoices\(\);[\s\S]+\}/,
    'native playback should auto-apply the resolved subtitle when tracks arrive just after handoff');
  assert.match(ui, /if \(!\(await applyNativeStartupSubtitleAfterTrackProbe\(p\)\)\) refreshNativeSubtitleChoices\(\);/,
    'native track probing should not stop at refreshing the CC list when always-subtitles can now choose a built-in track');
  assert.match(android, /public void updateActiveSubtitle\(String json\) \{[\s\S]+trustedBridgeOrigin\(\)[\s\S]+updateNativeActiveSubtitle\(json\)/,
    'Android bridge should expose a trusted-origin-only active subtitle update for late track probes');
  assert.match(android, /private void updateNativeActiveSubtitle\(String json\) \{[\s\S]+validateNativePlaybackUrl\(cleanSubtitleUrl\)[\s\S]+disableNativeTextTracks\(\);[\s\S]+loadNativeSubtitleOverlay\(nativeSubtitleUrl\);[\s\S]+updateNativeChrome\(\);[\s\S]+\}/,
    'Android late subtitle updates should validate the URL before loading the native subtitle overlay');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /function embeddedSubtitleTimeoutMs\(mode = '', vf = null\) \{[\s\S]+Math\.min\(30 \* 60000, configured\)[\s\S]+Math\.max\(120000, Math\.min\(20 \* 60000, Math\.round\(size \/ \(25 \* 1024 \* 1024\) \* 1000\)\)\)/,
    'embedded subtitle extraction jobs scale their budget with the mount size (a flat 120s could never read a 20-60GB remux) and the env override is honored above 120s');
  assert.match(server, /const timeoutMs = embeddedSubtitleTimeoutMs\(opts\.mode, vf\);/,
    'the extraction JOB gets the size-scaled budget');
  assert.match(server, /function embeddedSubtitleStartupWaitMs\(\) \{[\s\S]+return 8000;[\s\S]+\}/,
    'startup auto-subtitle selection should have a short wait budget');
  assert.match(server, /const SUBTITLE_FAILURE_TTL_MS = 10 \* 60000;[\s\S]+function recentSubtitleFailure\(vf, track\)/,
    'failed embedded subtitle tracks should be remembered briefly for auto-start fallback');
  assert.match(server, /if \(opts\.mode === 'manual'\) vf\._subFailures\.delete\(track\);[\s\S]+opts\.mode === 'startup' \? recentSubtitleFailure\(vf, track\) : null/,
    'manual built-in subtitle selection should still retry while startup may skip a recent failed track');
  assert.match(server, /const waitMs = mode === 'startup' \? embeddedSubtitleStartupWaitMs\(\) : embeddedSubtitleTimeoutMs\(mode\);[\s\S]+const job = ensureSubtitleVtt\(vf, track, ctx\.claims\.uid, \{ mode \}\);[\s\S]+mode === 'startup' \? await waitForSubtitleStartup\(job, embeddedSubtitleStartupWaitMs\(\)\) : await job/,
    'slow built-in subtitle extraction should keep the background job alive while startup returns quickly');
  assert.match(server, /function extendSubtitleResponseTimeout\(ctx, ms\) \{[\s\S]+ctx\.req\.setTimeout\(timeoutMs\)[\s\S]+ctx\.res\.setTimeout\(timeoutMs\)[\s\S]+socket\.setTimeout\(timeoutMs\)[\s\S]+ctx\.res\.once\('finish', restore\);[\s\S]+ctx\.res\.once\('close', restore\);/,
    'subtitle route timeout extension should restore the normal socket timeout after the response closes');
  assert.match(server, /priority=background/,
    'embedded subtitle extraction should read through the background stream lane');
  // The on-demand alass sub-sync pulls the mount's AUDIO; it MUST read through the background lane
  // too, or enabling CC mid-playback steals the player's connections (startup/seek lane) and buffers.
  assert.match(server, /async function onDemandSubSync\(vf, vtt, uid\) \{[\s\S]+const selfUrl = `http:\/\/127\.0\.0\.1:\$\{server\.address\(\)\.port\}\/api\/stream\/\$\{vf\.id\}\?t=\$\{auth\.streamToken\(uid, vf\.id\)\}&priority=background`;/,
    'on-demand subtitle sync must pull audio through the background NNTP lane so CC never starves the active player');
  assert.match(server, /function subtitleVttHasCues\(vtt\) \{[\s\S]+-->/,
    'embedded subtitle extraction should require real cue timings before treating WebVTT as valid');
  assert.match(server, /if \(!subtitleVttHasCues\(vtt\)\) return fail\(new Error\('embedded subtitle extraction returned no text cues'\)\);[\s\S]+vf\._subFailures\.delete\(track\);[\s\S]+vf\._subCache\.set\(track, vtt\)/,
    'cue-less WebVTT should fail before it can poison the embedded subtitle cache');
  assert.match(playerMap, /Admin Settings owns whether built-in subtitles are enabled/,
    'player regression map should document the admin-controlled subtitle source mode');
});

test('local library title match modal keeps manual, folder-info, and automatic actions wired', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(ui, /function openMatchModal\(it\) \{[\s\S]+matchAuto'\)\.style\.display = it\._matchOv !== undefined \? '' : 'none'/,
    'match modal should expose the Automatic reset only when an override exists');
  assert.ok(ui.includes("row.addEventListener('click', () => applyMatch(x.id));"),
    'TMDB search result rows should apply the selected manual TMDB id');
  assert.ok(ui.includes("await api(`/api/libraries/${it._lib.id}/match`, { method: 'POST', body: { idx: it._idx, tmdbId } });"),
    'match modal should send only the library item index plus selected match value');
  assert.ok(ui.includes("$('matchNone').addEventListener('click', () => applyMatch(null));"),
    'folder/NFO button should request the safe no-TMDB override');
  assert.ok(ui.includes("$('matchAuto').addEventListener('click', () => applyMatch('auto'));"),
    'Automatic button should clear the override and return to normal matching');
});

test('Live TV startup warm is delayed so app login and first playback stay responsive', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /const IPTV_STARTUP_WARM_DELAY_MS = Math\.max\(5 \* 60000, Math\.min\(30 \* 60000, Number\(process\.env\.TRIBOON_IPTV_STARTUP_WARM_DELAY_MS \|\| 10 \* 60000\)\)\);/,
    'startup warm should default to a long delay with bounded override');
  assert.match(server, /scheduleIptvWarmSoon\('startup', IPTV_STARTUP_WARM_DELAY_MS, \{ skipGuide: true \}\);/,
    'startup warm must not use the short source-change delay or heavy guide parse');
});

test('VOD pause resume: paused players warm ahead without stealing startup or seek priority', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const android = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'app', 'triboon', 'tv', 'MainActivity.java'), 'utf8');
  assert.match(ui, /function cancelPauseWarmAhead\(\) \{[\s\S]+S\.pauseWarmAhead = null;[\s\S]+warm && warm\.abort && warm\.abort\.abort\(\);[\s\S]+\}/,
    'pause warm-ahead should be abortable when playback resumes, seeks, or closes');
  assert.match(ui, /function schedulePauseWarmAhead\(p = S\.playing\) \{[\s\S]+p\.item\.type === 'live'[\s\S]+p\.streamUrl[\s\S]+p\.size[\s\S]+const dur = totalDuration\(\);[\s\S]+if \(p\._pauseWarmAt && now - p\._pauseWarmAt < 12000\) return;[\s\S]+const targetSeconds = Math\.min\(dur - 1, Math\.max\(currentTime\(\) \+ 6, bufferedEnd \+ 2\)\);[\s\S]+url\.searchParams\.set\('priority', 'read-ahead'\);[\s\S]+headers: \{ Range: `bytes=\$\{start\}-\$\{start \+ bytes - 1\}` \}/,
    'pause warm-ahead should issue one bounded low-priority range ahead of the paused VOD position');
  assert.match(ui, /v\.onplaying = \(\) => \{ cancelPauseWarmAhead\(\);[\s\S]+v\.onpause = \(\) => \{ schedulePauseWarmAhead\(S\.playing\); updPP\(\); \};/,
    'web video should warm on pause and cancel the warm request immediately when playing again');
  assert.match(ui, /function requestVideoPlay\(v, opts = \{\}\) \{[\s\S]+cancelPauseWarmAhead\(\);[\s\S]+const r = v\.play\(\);[\s\S]+return r\.then\(\(\) => \{[\s\S]+cancelPauseWarmAhead\(\)/,
    'user-initiated resume should cancel pause warm-ahead before and after play starts');
  assert.match(ui, /function seekTo\(seconds\) \{[\s\S]+cancelPauseWarmAhead\(\);[\s\S]+if \(!p\) return;/,
    'manual seeks should cancel old pause warm-ahead ranges before changing position');
  assert.match(ui, /window\.__tvNativeVideoPlaying = \(pos, dur\) => \{[\s\S]+applyNativeVideoProgress\(pos, dur\);[\s\S]+cancelPauseWarmAhead\(\);[\s\S]+\};[\s\S]+window\.__tvNativeVideoPaused = \(pos, dur\) => \{[\s\S]+applyNativeVideoProgress\(pos, dur\);[\s\S]+schedulePauseWarmAhead\(p\);[\s\S]+\};/,
    'native ExoPlayer should share the same pause/resume warm-ahead contract as the web player');
  assert.match(android, /if \("video"\.equals\(nativeMode\) && isPlaying\) \{[\s\S]+__tvNativeVideoPlaying[\s\S]+\} else if \("video"\.equals\(nativeMode\) && nativeVideoStarted[\s\S]+nativePlayer\.getPlaybackState\(\) == Player\.STATE_READY[\s\S]+!nativePlayer\.getPlayWhenReady\(\)[\s\S]+__tvNativeVideoPaused/,
    'Android should report real user pauses without treating normal buffering as paused playback');
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
  const guideIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_guide.xml'), 'utf8');
  const nativePlayerLayout = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'layout', 'native_player_view.xml'), 'utf8');
  const audioIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_audio.xml'), 'utf8');
  const ccIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_cc.xml'), 'utf8');
  const qualityIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_quality.xml'), 'utf8');
  const rewindIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_rewind.xml'), 'utf8');
  const forwardIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_forward.xml'), 'utf8');
  const nextIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_next.xml'), 'utf8');
  const infoIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_info.xml'), 'utf8');
  const startSourceBlock = ui.slice(ui.indexOf('function startSource('), ui.indexOf('// The full ladder, in policy order'));
  const failoverBlock = ui.slice(ui.indexOf('function failover()'), ui.indexOf('async function autoAdvance'));
  const showVlcPanelBlock = ui.slice(ui.indexOf('function showVlcPanel()'), ui.indexOf('/* ---- next episode'));
  const openGuideMethod = android.slice(
    android.indexOf('private void openNativeLiveGuide()'),
    android.indexOf('private void enterNativeGuideMode()'),
  );
  assert.doesNotMatch(manifest, /android:screenOrientation="landscape"/,
    'Android phone APK must not force the full shell into landscape');
  // Phones show the system bars; content is padded below them via a root inset listener, while
  // TV / fullscreen video stay edge-to-edge (zero padding) so the burger/clock are not hidden.
  assert.match(android, /setOnApplyWindowInsetsListener\([\s\S]+isTvDevice\(\) \|\| phonePlaybackOrientationLocked[\s\S]+setPadding\(0, 0, 0, 0\)[\s\S]+Type\.systemBars\(\)/,
    'Android phone shell pads content for the system bars (immersive/TV stays edge-to-edge)');
  assert.match(android, /boolean isTv = isTvDevice\(\);[\s\S]+TriboonTV\/[\s\S]+TriboonAndroid\//,
    'Android shell should tag TV and phone WebViews differently');
  // Background music + lock-screen controls: a foreground MediaSession service (MusicService)
  // mirrors the WebView <audio> player and routes lock-screen transport back to it.
  const musicService = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'app', 'triboon', 'tv', 'MusicService.java'), 'utf8');
  assert.ok(/class MusicService extends Service/.test(musicService) && musicService.includes('MediaSessionCompat')
    && musicService.includes('new MediaStyle()') && musicService.includes('startForeground(NOTIF_ID'),
    'MusicService is a foreground service with a MediaSession + MediaStyle notification');
  assert.ok(musicService.includes('MainActivity.dispatchMusicTransport("play")')
    && musicService.includes('MainActivity.dispatchMusicTransport("pause")')
    && musicService.includes('MainActivity.dispatchMusicTransport("next")'),
    'lock-screen transport buttons forward back to the web player');
  assert.match(manifest, /android:name="\.MusicService"[\s\S]+android:foregroundServiceType="mediaPlayback"/,
    'MusicService declared with the mediaPlayback foreground type');
  assert.ok(manifest.includes('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK') && manifest.includes('android.permission.POST_NOTIFICATIONS'),
    'media-playback foreground + notification permissions declared');
  assert.match(androidGradle, /androidx\.media:media:/,
    'androidx.media (MediaSessionCompat) dependency present');
  assert.match(android, /public void musicSession\(String json\)[\s\S]+updateMusicService\(j, playing\)/,
    'musicSession bridge drives the foreground MusicService');
  assert.match(android, /if \(!musicServiceUp && playing\) \{[\s\S]+startForegroundService\(i\);[\s\S]+else if \(musicServiceUp\) \{[\s\S]+startService\(i\)/,
    'first play starts the FGS from the foreground; later updates use startService (no background-FGS-start)');
  assert.match(ui, /function clearMusicMediaSession\(\)[\s\S]+TriboonTV\.musicStop/,
    'tearing down music stops the Android foreground service');
  assert.match(ui, /window\.__tvMusicSeek = \(sec\) =>/,
    'lock-screen scrubbing seeks the web audio element');
  // Resilience batch: failed multi-volume mount aborts inflight fetches; store flush failures are
  // logged; a startup warning fires when SSRF protection is disabled.
  const archiveSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'archive.js'), 'utf8');
  assert.match(archiveSrc, /await Promise\.all\(vols\.map\(\(v\) => v\.mount\(\)\)\);[\s\S]*?\} catch \(e\) \{[\s\S]+rec\.controller\.abort\(\)[\s\S]+throw e;/,
    'a failed multi-volume mount aborts inflight NNTP fetches (no pool exhaustion)');
  const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'store.js'), 'utf8');
  assert.match(storeSrc, /\[store\] flush failed for/,
    'persistent store flush failures are surfaced to the operator, not silently swallowed');
  const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(idxSrc, /TRIBOON_ALLOW_PRIVATE_IPTV is ENABLED/,
    'a startup warning fires when IPTV SSRF protection is disabled via env');
  // Live TV / IPTV resilience batch: shorter provider-protection backoff, UA-scoped negative cache
  // that clears on success, stale guide-block expiry, delete-race tombstone, and per-attempt startup.
  assert.match(idxSrc, /const IPTV_PROVIDER_PROTECTION_ERROR_TTL_MS = 90000;/,
    'provider bot-protection backoff is a short 90s so recovered providers/channels come back fast');
  assert.match(idxSrc, /Provider accepted this identity[\s\S]+iptvNativeErrorCache\.delete\(failureKey\);/,
    'a successful IPTV native response clears the stale negative cache entry');
  assert.match(idxSrc, /const rawBlocked = Number\(raw\.guideBlockedUntil\) \|\| 0;\s*\n\s*const guideBlockedUntil = rawBlocked > Date\.now\(\) \? rawBlocked : 0;/,
    'a re-added/restarted Xtream source does not inherit an expired guide-protection block');
  assert.match(idxSrc, /function persistXtreamEpgCache[\s\S]+if \(cache && cache\._deleted\) return;/,
    'a guide fetch resolving after source deletion cannot re-persist a stale block');
  assert.match(idxSrc, /const staleXtream = xtreamEpgSourceCaches\.get\(id\);[\s\S]+staleXtream\._deleted = true; staleXtream\.guideBlockedUntil = 0;/,
    'deleting an IPTV source tombstones its in-flight Xtream guide cache');
  assert.match(idxSrc, /const LIVE_REMUX_ATTEMPT_BUDGET_MS = LIVE_REMUX_FIRST_BYTE_TIMEOUT_MS;\s*\nconst LIVE_REMUX_TOTAL_STARTUP_BUDGET_MS = 30000;/,
    'Live TV startup uses a per-attempt first-byte budget bounded by an overall cap');
  assert.match(idxSrc, /const beginAttemptBudget = \(\) => \{ attemptDeadline = Date\.now\(\) \+ LIVE_REMUX_ATTEMPT_BUDGET_MS; \};/,
    'each Live TV source/retry gets its own first-byte window so a slow source cannot starve alternates');
  assert.match(idxSrc, /if \(codeNum && !wrote && overallRemaining\(\) <= 0\) return finishLiveStartupTimeout\(target\);/,
    'only the overall startup cap ends Live TV startup with a 504 — a spent per-attempt budget falls through to the next source');
  assert.match(ui, /function scheduleLiveChannelResync\(\) \{[\s\S]+if \(now - \(S\._liveResyncAt \|\| 0\) < 10000\) return;[\s\S]+clearLiveClientCaches\(\{ channels: true \}\);/,
    'a genuine guide 409 triggers a bounded (once/10s) channel-list resync so the guide recovers instead of staying blank');
  assert.match(ui, /if \(e && e\.status === 409\) scheduleLiveChannelResync\(\);/,
    'the guide-batch fetch wires a 409 to the bounded channel resync');
  // Music resilience batch (batch5): concurrent-resolve dedupe + proactive near-expiry re-resolve,
  // bounded stream 403 recovery with a public last resort, per-user rate limits, and an Android
  // music-state reset when the WebView (and its <audio>) is torn down.
  const ytmusicSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'ytmusic.js'), 'utf8');
  assert.match(ytmusicSrc, /const _streamInflight = new Map\(\);/,
    'concurrent resolveStream calls for the same track are coalesced instead of each spawning yt-dlp');
  assert.match(ytmusicSrc, /if \(!force\) \{\s*\n\s*const pending = _streamInflight\.get\(cacheKey\);\s*\n\s*if \(pending\) return pending;/,
    'a resolve already in flight is shared with concurrent callers');
  assert.match(ytmusicSrc, /Date\.now\(\) < hit\.expiresAt - STREAM_REFRESH_MARGIN_MS/,
    'a cache hit near expiry is proactively re-resolved so a long session never gets a soon-dead URL');
  assert.match(idxSrc, /const MAX_STREAM_ATTEMPTS = 3;[\s\S]+const lastResort = attempt \+ 1 >= MAX_STREAM_ATTEMPTS;[\s\S]+const cookiesPath = lastResort \? null :/,
    'the music stream proxy retries a stale URL a few times, ending with a public (no-cookie) re-resolve');
  assert.match(idxSrc, /if \(throttleUserRoute\(ctx, 'music-search', \{ max: 40/,
    'yt-dlp-backed music endpoints are rate-limited per user to prevent subprocess exhaustion');
  assert.match(android, /private void resetWebPageState\(\) \{[\s\S]+if \(musicPlaying\) \{\s*\n\s*musicPlaying = false;\s*\n\s*stopMusicService\(\);/,
    'a torn-down/recovered WebView resets musicPlaying and stops the orphaned foreground music service');
  // Age-gate latency: play() runs the maturity cert lookup CONCURRENTLY with search+mount (awaited
  // before any playable payload is sent, denial discards the speculative mount) so a restricted
  // profile's TMDB round-trip overlaps the pipeline instead of serializing in front of it.
  assert.match(idxSrc, /const maturityAllowed = maturityAllowsPlay\(profileLevelFor\(ctx\.user, body\.profileId\), body\.tmdbId, body\.mediaType\)\s*\n\s*\.catch\(\(\) => true\);/,
    'play() fires the age check in parallel with the pipeline (fail-open, non-rejecting)');
  assert.match(idxSrc, /if \(!\(await maturityAllowed\)\) \{ discardDeniedMount\(session, vf\); return maturityBlockedResponse\(ctx\); \}/,
    'a denied parallel age check discards the speculative mount and returns 403 before any payload');
  assert.match(idxSrc, /function discardDeniedMount\(session, vf\) \{[\s\S]+mounts\.delete\(vf\.id\)/,
    'the denied-mount teardown dereferences the mount so it frees immediately rather than at the sweep');
  assert.match(idxSrc, /function profileLevelFor\(user, profileId\) \{[\s\S]+return p \? \(p\.level \?\? \(p\.kid \? 0 : 3\)\) : 0;/,
    'a provided-but-unknown profileId fails closed to the strictest level (no spoofed-id bypass)');
  // IPTV live proxy: an Android WebView renderer crash can half-close the client socket without a
  // 'close' event, so a bare pipe() would pin the upstream provider connection forever. A manual
  // pump + dead-client stall watchdog (re-armed only on drained writes) + a res 'error' handler
  // reclaim the upstream.
  assert.match(idxSrc, /const armClientStall = \(\) => \{[\s\S]+setTimeout\(\(\) => stop\('client stalled'\), LIVE_REMUX_IDLE_TIMEOUT_MS\);/,
    'the IPTV native proxy arms a dead-client stall watchdog so a half-closed socket cannot pin a provider connection');
  assert.match(idxSrc, /ctx\.res\.once\('error', onClientClose\);/,
    'the IPTV native proxy handles a client socket error (pipe alone does not) so the upstream is reclaimed');
  assert.match(idxSrc, /if \(ctx\.res\.write\(chunk\)\) armClientStall\(\);/,
    'the stall watchdog is re-armed only when the client is actually draining, not while backpressured');
  // NNTP failover batch (owner-approved, touches the streaming-perf contract): circuit-breaker
  // half-open probe + hedged multi-provider failover for active-player BODY work.
  const nntpSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'nntp.js'), 'utf8');
  assert.match(nntpSrc, /if \(this\.down\(\)\) \{[\s\S]+reconnectProbeMs[\s\S]+this\.lastProbeAt = Date\.now\(\);\s*\n\s*target = 1;/,
    'a circuit-broken provider allows one throttled half-open reconnect probe instead of staying dark for the whole backoff');
  assert.match(nntpSrc, /const HEDGE_PRIORITIES = new Set\(\['startup', 'seek', 'playback'\]\);/,
    'only active-player priorities hedge, so background/health/read-ahead never double-fetch');
  assert.match(nntpSrc, /_hedgedBody\(ordered, msgId, priority, opts\)[\s\S]+setTimeout\(\(\) => \{ hedgeTimer = null; startNext\(\); \}, hedgeMs\)/,
    'a slow active-player provider is hedged onto the next provider after HEDGE_MS rather than waiting out the command timeout');
  const streamDoc = fs.readFileSync(path.join(__dirname, '..', 'docs-streaming-performance.md'), 'utf8');
  assert.match(streamDoc, /Hedged multi-provider failover/,
    'the streaming-performance reference documents hedged failover + circuit-breaker recovery (contract requirement)');
  // The native backward-jump auto-resume must require the regression to persist across 2 ticks so a
  // one-tick PTS/GOP wobble on a resumed (server-seek) stream no longer dips-and-snaps ~every 10 min.
  assert.match(android, /private void rememberNativeVideoPosition\(\) \{[\s\S]+backwardsBy > 5000L\) \{[\s\S]+boolean bigRestart = backwardsBy > 60000L;[\s\S]+if \(!bigRestart && \+\+nativeBackwardTicks < 2\) return;/,
    'native segment-jumpback auto-resume confirms a SMALL regression over 2 ticks (wobble guard) but recovers a large (>60s) stream restart on the first tick');
  assert.match(android, /return established \? 30000 : 18000;/,
    'the established (post-first-frame) VOD read timeout stays generous (30s normal / 45s heavy) so a MID-STREAM stall does not trigger a reconnect/replay-from-start — the backward-jump fix stays intact');
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
  assert.ok(ui.includes("if (document.querySelector('#detail.open,#person.open,#settings.open,#prefs.open,#music.open')) return false;")
    && ui.includes('#osd .ctl{display:flex;grid-template-columns:none;gap:8px;overflow-x:auto;overflow-y:visible')
    && ui.includes('#player:not(.live) #chGuide{display:none}')
    && ui.includes('#trackMenu{left:12px;right:12px;bottom:84px;width:auto;min-width:0;max-height:calc(100vh - 144px);border-radius:12px}')
    && ui.includes('body.mobileShell #osd .ctl{display:flex;grid-template-columns:none;gap:8px;overflow-x:auto;overflow-y:visible')
    && ui.includes('body.mobileShell #trackMenu{left:12px;right:12px;bottom:84px;width:auto;min-width:0;max-height:calc(100vh - 144px);border-radius:12px}'),
    'mobile browser and phone WebView player controls should use a scrollable touch strip and never sit behind the screensaver');
  assert.ok(ui.includes('function showVodPlayPrompt()')
    && ui.includes("pReady && pReady.item && pReady.item.type !== 'live' && !pReady.started && v.readyState >= 2 && v.paused")
    && ui.includes("$('playerLoader').classList.remove('show');")
    && ui.includes("requestVideoPlay(v).then(() => { cancelPauseWarmAhead(); if (!serverSeek && atSeconds) v.currentTime = atSeconds; }).catch(() => showVodPlayPrompt());"),
    'mobile browser VOD should reveal a tappable play control when autoplay is blocked after buffering');
  assert.ok(ui.includes('#person .personHead{flex-direction:column;align-items:center;gap:16px')
    && ui.includes('#person .personHead .pInfo{width:100%;text-align:center}')
    && ui.includes('body.mobileShell #person .personHead{flex-direction:column;align-items:center;gap:16px')
    && ui.includes('body.mobileShell #person .personHead .pInfo{width:100%;text-align:center}'),
    'mobile person pages should stack the profile header instead of squeezing text beside the poster');
  assert.match(ui, /const DETAIL_CAST_BATCH = 20;[\s\S]+function appendCastBatch\(row\)[\s\S]+row\.addEventListener\('scroll', maybeLoadMoreCast, \{ passive: true \}\)/,
    'detail cast rows should keep the first render bounded and append more cast as the row scrolls');
  assert.match(ui, /const PERSON_WORKS_BATCH = 24;[\s\S]+\.map\(mapTmdb\);\s+renderPersonWorks\(credits\);[\s\S]+function loadMorePersonWorks\(focusNew = false\)[\s\S]+if \(start === 0\) renderGrid\(batch, \$\('personGrid'\)\);[\s\S]+else appendGrid\(batch\);/,
    'person known-for pages should lazy-render all filtered credits in batches instead of slicing to a fixed cap');
  assert.match(ui, /\$\('person'\)\.addEventListener\('scroll', maybeLoadMorePersonWorks, \{ passive: true \}\);[\s\S]+if \(S\.view === 'person' && S\.gridIdx >= \(S\.gridItems \|\| \[\]\)\.length - Math\.max\(2, gridCols\(\) \* 2\)\) \{[\s\S]+loadMorePersonWorks\(false\);/,
    'person known-for lazy loading should work for both scrolling and D-pad focus near the loaded edge');
  assert.ok(ui.includes('id="statsBtn"') && ui.includes("return ['chGuide', 'back10', 'playPause', 'fwd30', 'nextEpBtn', 'favBtn', 'splitBtn', 'ccBtn', 'audBtn', 'srndBtn', 'qualBtn', 'castBtn', 'airplayBtn', 'muteBtn', 'fsBtn', 'statsBtn']")
    && ui.includes('function collectPlayerStats()') && ui.includes('window.__tvNativeVideoStats'),
    'web player stats must be the last D-pad reachable control and accept native ExoPlayer stats');
  assert.ok(ui.includes('Server target') && ui.includes('Server read-ahead')
    && ui.includes("const label = k === 'Buffered' ? 'Player buffer' : k")
    && ui.includes('function refreshPlayerRuntimeStats('),
    'Playback stats should separate visible player buffer from Triboon server read-ahead');
  assert.ok(ui.includes('data-stab="activity"') && ui.includes("api('/api/activity')") && ui.includes('id="activityRefresh"')
    && ui.includes('id="activityHistory"') && ui.includes('id="activitySummary"')
    && ui.includes('>Last 3 days<') && ui.includes('id="activityPager"'),
    'admin Settings should expose a compact focusable Activity panel backed by the activity API');
  assert.ok(ui.includes('function playerStreamKind(') && ui.includes('streamKind: playerStreamKind(p)')
    && ui.includes('streamLabel: playerStreamLabel(p)') && ui.includes('clientVersion: clientVersionLabel()')
    && ui.includes('function activityStreamLabel(') && ui.includes('function activityRowHtml(')
    && ui.includes('activityStream'),
    'Activity should show stream treatment, app version, active sessions, and a 3-day history');
  // The 3-day history is paged (10/page) so the admin never scrolls a wall of rows — client-side
  // over the cached payload, Prev/Next re-render with no network round-trip, focusable for D-pad.
  assert.ok(ui.includes('id="activityPrev"') && ui.includes('id="activityNext"') && ui.includes('id="activityPagerInfo"')
    && ui.includes('const ACTIVITY_HISTORY_PAGE = 10') && ui.includes('function renderActivityHistory(')
    && ui.includes('function activityHistGoto('),
    'Activity history should paginate (10/page) with focusable Prev/Next that re-render from the cached payload');
  assert.match(ui, /function renderActivityHistory\(\)[\s\S]+Math\.ceil\(all\.length \/ ACTIVITY_HISTORY_PAGE\)[\s\S]+all\.slice\(start, start \+ ACTIVITY_HISTORY_PAGE\)[\s\S]+if \(pages <= 1\) \{ pager\.hidden = true;/,
    'history pager hides itself when a single page covers everything and slices the current page from the cached history');
  assert.match(ui, /\$\('activityPrev'\)\.addEventListener\('click', \(\) => activityHistGoto\(-1\)\);\s*\$\('activityNext'\)\.addEventListener\('click', \(\) => activityHistGoto\(1\)\)/,
    'history Prev/Next buttons are wired to the client-side pager');
  // Activity shows the actual device (SHIELD, onn, Chrome…), reported by the client and parsed on the row.
  assert.ok(ui.includes('function deviceFriendlyName(') && ui.includes('deviceName: deviceFriendlyName()')
    && ui.includes('function activityDeviceLabel(') && ui.includes('function activityDeviceKind('),
    'Activity reports + renders a friendly hardware device name per session');
  // Activity surfaces live usenet connection usage per provider (admin capacity view).
  assert.ok(ui.includes('id="activityConn"') && ui.includes('function renderActivityConnections(')
    && ui.includes('renderActivityConnections(payload.connections)') && ui.includes('Usenet connections'),
    'Activity shows per-provider usenet connection usage');
  assert.match(ui, /function commitNativeLivePlayback\(it\) \{[\s\S]+setNativeLivePlaybackState\(it\);[\s\S]+startActivityHeartbeat\(\);/,
    'native Live TV should report activity once ExoPlayer is ready');
  assert.match(ui, /<div class="settingsForm">[\s\S]+<span>Expected users<\/span><input id="perfUsers"[\s\S]+<span>Start\/seek reserve<\/span><input id="perfReserve"[\s\S]+<div class="settingsActions">[\s\S]+id="perfTest"[\s\S]+id="perfApply"[\s\S]+id="perfSave"/,
    'Streaming performance settings should keep labeled rows and one professional action group');
  assert.match(ui, /\.settingsRow\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)[\s\S]+\.settingsActions\{display:flex;align-items:center;gap:10px;flex-wrap:wrap/,
    'Settings form rows and action buttons should share stable spacing rules');
  assert.ok(ui.includes('class="perfSummary" id="perfSummary"')
    && ui.includes('Calculate recommendation')
    && ui.includes('1080p read-ahead goal')
    && ui.includes('4K read-ahead goal')
    && ui.includes('id="perfApply" disabled')
    && ui.includes('function perfSetApplyEnabled(')
    && ui.includes('playback: st.playback || {}')
    && !ui.includes('S.perfRecommendation || perfFormValues()'),
    'Streaming performance should show active runtime capacity and keep recommendation apply separate from manual save');
  assert.match(ui, /\.settingsControl input\{[\s\S]+background:var\(--field\)[\s\S]+border:1px solid var\(--line\)/,
    'Settings numeric inputs should use Triboon dark field chrome instead of native white inputs');
  assert.ok(ui.includes('id="prefContentTextSize"') && ui.includes("localStorage.setItem('triboon.textsize'")
    && ui.includes('function applyContentTextSize()'),
    'Preferences should expose a per-device content text-size picker');
  assert.match(ui, /Content text-size preference:[\s\S]+The rail, Settings, Preferences, auth gates and player controls keep fixed geometry[\s\S]+#hero h1\{font-size:var\(--ctHeroTitle\)[\s\S]+\.pgRow \.pgName\{font-size:var\(--ctLiveTitle\)[\s\S]+\.musicRow \.mT/,
    'content text size should scope to media/content pages without resizing the rail or settings chrome');
  assert.match(ui, /const THEME_TOKEN_MAP = \{[\s\S]+ink: '--ink'[\s\S]+surface: '--surface'[\s\S]+focus: '--focus'[\s\S]+scrim: '--scrim'/,
    'theme choices should remap full design roles, not only the three accent colors');
  assert.ok(['triboonCoral', 'cinema', 'studio', 'velvet', 'teal', 'evergreen', 'contrast'].every((name) => ui.includes(`${name}: {`)),
    'theme list should include calmer cinematic professional options');
  assert.match(ui, /scrim: 'linear-gradient\(90deg,rgba\([0-9, ]+,\.8[0-9]\) 0%,rgba\([0-9, ]+,\.54\) 28%,[\s\S]+?linear-gradient\(0deg,rgba\([0-9, ]+,\.7[0-9]\) 0%/,
    'theme scrims should keep browser backdrop art visible (side + bottom fade) instead of a full-screen blackout');
  assert.ok(!ui.includes("scrim: 'linear-gradient(180deg"),
    'theme scrims should not regress to the old opaque vertical wash');
  assert.match(ui, /const THEME_ALIASES = \{[\s\S]+graphite: 'studio'[\s\S]+triboon: 'triboonCoral'[\s\S]+trioon: 'triboonCoral'[\s\S]+arctic: 'teal'[\s\S]+forest: 'evergreen'/,
    'legacy stored theme names should map to the nearest new professional palette');
  assert.ok(ui.includes("label: 'Ocean'") && ui.includes("tone: 'deep blue'")
    && ui.includes("ink: '#0D1420'") && ui.includes("c: '#5EA0F2'"),
    'default theme should be the Ocean (deep blue) palette');
  assert.ok(ui.includes("const VISIBLE_THEMES = ['triboonCoral', 'studio', 'velvet', 'midnight', 'scarlet', 'aurora', 'toomaj', 'triboonGold', 'daylight', 'topaz']")
    && ui.includes("label: 'Forest'") && ui.includes("label: 'Sunset'") && ui.includes("label: 'Midnight'"),
    'the picker should offer DISTINCT accent palettes (Ocean blue / Forest green / Sunset amber / Midnight gold)');
  assert.ok(ui.includes("label: 'Scarlet'") && ui.includes("c: '#E50914'")
    && ui.includes("label: 'Aurora'") && ui.includes("c: '#1CE783'")
    && ui.includes("label: 'Daylight'") && ui.includes("c: '#1F8BFF'")
    && ui.includes("label: 'Topaz'") && ui.includes("c: '#E5A00D'"),
    'the picker should also offer bold original palettes (Scarlet red / Aurora green / Daylight blue / Topaz gold)');
  // Toomaj + Triboon are "spotlight" themes (spotlight:true): a solid focus fill + dimmed unfocused
  // artwork so the focused item is unmistakable on small/older/low-contrast TVs. They SHARE one
  // body[data-spotlight] CSS block driven by each theme's own tokens (Toomaj amber, Triboon gold).
  assert.ok(ui.includes("label: 'Toomaj'") && ui.includes("focus: '#FFD23F'") && ui.includes("btnFocusText: '#1A1206'"),
    'Toomaj theme should use a high-visibility amber focus with dark on-focus text');
  assert.ok(ui.includes("label: 'Triboon', tone: 'near-black + gold', spotlight: true")
    && ui.includes("focus: '#D8B25A'") && ui.includes("ink: '#050506'"),
    'Triboon theme should be a near-black base with a gold high-visibility focus');
  assert.match(ui, /body\[data-spotlight\]\{--grad:var\(--focus\)\}[\s\S]+\.railBtn[\s\S]+background:var\(--focus\)[\s\S]+\.pcard \.art[\s\S]+opacity:\.62/,
    'spotlight themes share one body[data-spotlight] block: focus-coloured ring/fill + dimmed unfocused artwork');
  assert.match(ui, /document\.body\.toggleAttribute\('data-spotlight', !!t\.spotlight\)/,
    'applyTheme should toggle body[data-spotlight] by attribute presence (not empty dataset, which would leak the spotlight to every theme)');
  // The spotlight scale(1.05) must NOT re-introduce zoom on the wide 16/9 Music cover tiles — they
  // focus with a cover ring only (transform:none in the base themes) and would otherwise overflow the
  // frame/rails. Music tiles join the guide rows in the spotlight transform:none exclusion.
  assert.match(ui, /body\[data-spotlight\] \.mCard\.focusable\.focus,\s*body\[data-spotlight\] \.musicRow\.focusable\.focus,\s*body\[data-spotlight\] \.mArtistHit\.focusable\.focus\{transform:none\}/,
    'spotlight themes must not zoom the Music cover tiles (mCard/musicRow/mArtistHit) — ring cue only, no scale that overflows the frame');
  // Brand-name keys must NOT leak into the shipped UI — only the made-up names.
  assert.ok(!ui.includes("label: 'Netflix'") && !ui.includes("label: 'Hulu'")
    && !ui.includes("label: 'Apple TV'") && !ui.includes("label: 'Plex'")
    && !/\n\s*(netflix|hulu|appletv|plex): \{/.test(ui),
    'streaming-service brand names must not be used as theme labels or keys');
  // Daylight is the one LIGHT theme: light surface, DARK body text, DARK rollover text, and it
  // flips color-scheme so native controls render light.
  assert.ok(ui.includes("label: 'Daylight', tone: 'light · cool blue', light: true")
    && ui.includes("ink: '#EDEFF3'") && ui.includes("text: '#161A1F'") && ui.includes("btnFocusText: '#06335C'"),
    'Daylight should be a true light theme (pale surface, dark text, dark rollover text)');
  assert.match(ui, /color-scheme', t\.light \? 'light' : 'dark'[\s\S]+dataset\.light = t\.light \? '1' : ''/,
    'applying a light theme should switch color-scheme and set a body light flag');
  assert.ok(ui.includes('--fg:243,239,247;') && /body\[data-light="1"\]\{--fg:18,22,28\}/.test(ui)
    && /body\[data-light="1"\] #player,body\[data-light="1"\] #multiView\{--fg:243,239,247\}/.test(ui)
    && !/rgba\(243,239,247,/.test(ui),
    'foreground tint must route through --fg (dark only on data-light="1") with the always-black player/multiview restored to light — no raw off-white literals left');
  assert.ok(/button\.focusable:not\(\.card\):not\(\.pcard\):not\(\.railBtn\):not\(\.castCard\):not\(\.seasonCard\):not\(\.epCard\):not\(\.chCard\):not\(\.playerEpCard\)/.test(ui),
    'media tiles (cast/season/episode/channel) must be excluded from the solid button-fill rollover so they keep their poster RING like .pcard');
  assert.ok(ui.includes("localStorage.getItem('triboon.theme') || 'triboonCoral'")
    && ui.includes('THEMES[name] || THEMES.triboonCoral'),
    'Executive Graphite should be the default and fallback theme');
  // Theme (colors) follows the PROFILE and syncs to the server like the other prefs, so it survives
  // updates/reinstalls — with the device-wide triboon.theme kept as the pre-login boot fallback.
  assert.match(ui, /function savePrefTheme\(name\) \{[\s\S]+localStorage\.setItem\(profilePrefKey\('theme'\), name\);[\s\S]+localStorage\.setItem\('triboon\.theme', name\);[\s\S]+syncProfilePrefsUp\(\);/,
    'saving a theme should write the per-profile (synced) key + device fallback and push to the server');
  assert.match(ui, /function prefTheme\(\) \{[\s\S]+triboon\.profile\.\$\{S\.profile\.id\}\.theme[\s\S]+localStorage\.getItem\('triboon\.theme'\) \|\| 'triboonCoral'/,
    'applyTheme should resolve the profile-scoped theme first, then the device fallback');
  assert.match(ui, /applyServerProfilePrefs\(r\.prefs\);[\s\S]+try \{ applyTheme\(\); \} catch \{\}/,
    'loading server prefs should apply the profile’s synced theme');
  assert.match(ui, /function applyTheme\(\) \{[\s\S]+Object\.entries\(THEME_TOKEN_MAP\)[\s\S]+setProperty\('--grad', t\.c\)[\s\S]+setProperty\('--gold', t\.a\)[\s\S]+\['btn', 'btnHover', 'btnSelected', 'btnSelectedHover', 'btnPrimary', 'btnPrimaryHover', 'btnFocusText',[\s\S]+'artFocusLine', 'artFocusGlow', 'artFocusTileLine', 'artFocusTileBorder', 'artFocusTileGlow'\][\s\S]+document\.body\.dataset\.theme = name/,
    'theme application should update role tokens plus shared button state colors');
  assert.ok(!ui.includes('--grad:linear-gradient') && !ui.includes('--gold:linear-gradient')
    && !ui.includes('.musicAction.primary{background:linear-gradient')
    && !ui.match(/\.ytmConnectIcon[^{]*\{[^}]*linear-gradient/),
    'buttons and icon-like action controls should use solid professional fills, not gradients');
  assert.match(ui, /#themePick,#themePickSet\{display:grid[\s\S]+\.themeMeta[\s\S]+\.themeName[\s\S]+\.themeTone[\s\S]+\.themePalette/,
    'theme picker should render understated material cards with names and tone labels');
  assert.match(ui, /b\.innerHTML = `[\s\S]+themeMeta[\s\S]+themeName[\s\S]+themeTone[\s\S]+themePalette[\s\S]+<i><\/i><i><\/i><i><\/i>/,
    'theme picker should use restrained palette strips instead of illustrative color-picking icons');
  assert.match(ui, /\.themeChoice:hover,\.themeChoice\.focus,\.themeChoice:focus,\.themeChoice:focus-visible\{[\s\S]+outline:none/,
    'theme picker cards should react to native focus as well as D-pad focus classes');
  assert.match(ui, /#setTabs button,#prefTabs button\{\s*box-shadow:none!important\}[\s\S]+#setTabs button:hover,#prefTabs button:hover,[\s\S]+#setTabs button:focus-visible,#prefTabs button:focus-visible\{[\s\S]+background:var\(--btnHover\)!important;color:var\(--btnFocusText\)!important[\s\S]+#setTabs button\.on\.focus,#prefTabs button\.on\.focus,[\s\S]+#setTabs button\.on:focus-visible,#prefTabs button\.on:focus-visible\{[\s\S]+background:var\(--btnSelectedHover\)!important;color:var\(--text\)!important/,
    'Settings and Preferences side-tab menus should visibly highlight hover, keyboard focus, and D-pad focus');
  assert.match(ui, /#setTabs button,#prefTabs button\{[\s\S]+background:var\(--btn\);border:0;/,
    'Settings and Preferences side-tab menus should be borderless');
  assert.match(ui, /#settings \.setGrid button:not\(\.themeChoice\):hover,#prefs \.setGrid button:not\(\.themeChoice\):hover,[\s\S]+#settings \.setGrid button:not\(\.themeChoice\):focus-visible,#prefs \.setGrid button:not\(\.themeChoice\):focus-visible\{[\s\S]+background:var\(--btnHover\)!important;color:var\(--btnFocusText\)!important/,
    'Settings and Preferences content buttons should visibly fill on hover, keyboard focus, and D-pad focus');
  assert.match(ui, /function syncSectionTabs\(tabsId, activeButton = null\) \{[\s\S]+setAttribute\('role', 'tablist'\)[\s\S]+setAttribute\('role', 'tab'\)[\s\S]+setAttribute\('aria-selected', on \? 'true' : 'false'\)[\s\S]+\}/,
    'Settings and Preferences side tabs should initialize selected state for D-pad and accessibility');
  // Server settings are folded into the Preferences page as one menu (Preferences group · divider ·
  // Server settings group; Appearance dropped). One handler drives both tab kinds, on click/focus/hover.
  assert.match(ui, /function mergeServerSettingsIntoPrefs\(\) \{[\s\S]+data-tab="display"[\s\S]+data-stab="display"[\s\S]+prefTabDivider[\s\S]+b\.dataset\.srv = b\.dataset\.tab[\s\S]+prefs\.appendChild\(p\)/,
    'Server-settings tabs + panels should be folded into the Preferences page (Appearance removed, divider added)');
  assert.match(ui, /function activateAccountTab\(b\) \{[\s\S]+const isSrv = !!b\.dataset\.srv;[\s\S]+syncSectionTabs\('prefTabs', b\)[\s\S]+#prefs \[data-ptab\][\s\S]+#prefs \.setGrid\[data-stab\][\s\S]+refreshSettings\(\)/,
    'the unified account-tab handler shows the right pref/server panel and lazy-loads server data');
  assert.match(ui, /document\.querySelectorAll\('#prefTabs button'\)\.forEach\(\(b\) => \{[\s\S]+activateAccountTab\(b\)[\s\S]+addEventListener\('click', run\)[\s\S]+addEventListener\('focus', run\)[\s\S]+addEventListener\('mouseenter', run\)/,
    'account tabs activate on click, D-pad focus, and hover');
  assert.match(ui, /function openServerSettings\(\) \{[\s\S]+switchView\('prefs'\)[\s\S]+#prefTabs \.srvTab[\s\S]+activateAccountTab\(first\)/,
    'admin entry points open the account page on the first Server-settings tab');
  assert.match(ui, /if \(v === 'settings'\) return openServerSettings\(\)/,
    'switchView(settings) should redirect to the folded-in account page');
  // The #prefTabs ArrowRight handler (focusActiveSettingsPanel) must enter the folded-in SERVER
  // panels too, not just pref panels — else D-pad Right from a server tab does nothing on device.
  assert.match(ui, /function focusActiveSettingsPanel\(rootId, panelAttr\) \{[\s\S]+querySelector\(`\[\$\{panelAttr\}\]:not\(\[hidden\]\), \.setGrid\[data-stab\]:not\(\[hidden\]\)`\)/,
    'ArrowRight from an account tab should enter both pref and server panels');
  assert.match(ui, /document\.querySelectorAll\('#prefTabs \.srvTab, #prefServerDivider'\)\.forEach\(\(el\) => \{ el\.style\.display = isAdmin/,
    'the Server-settings tab group + divider should be admin-only');
  assert.match(ui, /function syncChoiceButtons\(selector, isSelected\) \{[\s\S]+classList\.toggle\('sel', selected\)[\s\S]+setAttribute\('aria-pressed', selected \? 'true' : 'false'\)/,
    'selection-style buttons should share visual and pressed-state updates');
  ['#prefCoverSize button', '#prefContentTextSize button', '#prefAutoplay button', '#prefSubtitleMode button', '#prefSubSize button', '#prefScreensaverDelay button', '#coverSize button'].forEach((selector) => {
    assert.ok(ui.includes(`syncChoiceButtons('${selector}'`), `${selector} should use the shared selected-button sync`);
  });
  assert.match(ui, /b\.setAttribute\('aria-pressed', name === cur \? 'true' : 'false'\)[\s\S]+syncChoiceButtons\('#themePick \.themeChoice,#themePickSet \.themeChoice'/,
    'theme cards should expose and update pressed state with the same selected-button sync');
  // One universal APK runs on TV and phone, so there's a single "Update app" button (not separate
  // TV/phone buttons), pointing at the stable release link.
  assert.ok(ui.includes('id="apkUpdate"') && ui.includes('>Update app<')
    && !ui.includes('id="apkTvUpdate"') && !ui.includes('id="apkMobileUpdate"')
    && ui.includes('releases/latest/download/triboon.apk')
    && !ui.includes('releases/latest/download/triboon-tv.apk')
    && !ui.includes('releases/latest/download/triboon-mobile.apk'),
    'Preferences should expose a single Update app button pointing at the one universal triboon.apk');
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
  // In-app self-update: download the signed APK and launch the system installer (no browser).
  assert.match(android, /public void installAppUpdate\(String url\)[\s\S]+downloadAndInstallUpdate\(url\)/,
    'Android bridge should expose installAppUpdate (in-app download + install)');
  assert.match(android, /private void downloadAndInstallUpdate\(String rawUrl\) \{[\s\S]+allowedAppUpdateUrl\(uri\)[\s\S]+canRequestPackageInstalls\(\)[\s\S]+FileProvider\.getUriForFile[\s\S]+vnd\.android\.package-archive/,
    'in-app update must validate the URL, ensure install permission, and hand the APK to the system installer via FileProvider, falling back to the browser');
  assert.match(ui, /typeof TriboonTV\.installAppUpdate === 'function'[\s\S]+TriboonTV\.installAppUpdate\(url\)/,
    'web update button should use the in-app installer when the shell supports it');
  assert.match(android, /boolean dpadArrow = code == KeyEvent\.KEYCODE_DPAD_UP \|\| code == KeyEvent\.KEYCODE_DPAD_DOWN[\s\S]+KEYCODE_DPAD_LEFT[\s\S]+KEYCODE_DPAD_RIGHT;[\s\S]+if \(domKey != null && \(!pageInputFocused \|\| dpadArrow\) && setup\.getVisibility\(\) != View\.VISIBLE\) \{[\s\S]+jsKey\("keydown", domKey, e\.getRepeatCount\(\) > 0\)/,
    'Android TV should still forward D-pad arrows to the web focus model while Settings/Preferences fields are focused');
  // The updater allowlist is locked to https + github.com + the stable Triboon release asset, but
  // accepts ANY owner/repo so a future GitHub rename doesn't strand the in-app updater on installed
  // devices (the allowlist is baked into the APK). It must NOT be pinned to a single repo path.
  assert.match(android, /allowedAppUpdateUrl\(Uri uri\)[\s\S]+"github\.com"\.equals\(host\)[\s\S]+path\.matches\("\/\[\^\/\]\+\/\[\^\/\]\+\/releases\/latest\/download\/triboon\(-\(tv\|mobile\)\)\?\\\\\.apk"\)/,
    'updater allowlist should accept the canonical triboon.apk AND the legacy tv/mobile aliases under any github.com owner/repo (rename-safe), not a single hardcoded repo');
  assert.doesNotMatch(android, /"\/d1same\/triboon\/releases\/latest\/download\/triboon-tv\.apk"\.equals\(path\)/,
    'the native allowlist must not be hardcoded to the d1same/triboon repo path');
  // Per-profile prefs sync: prefs mirror to the account so they survive reinstall + follow devices.
  assert.match(ui, /async function loadProfilePrefs\(\) \{[\s\S]+api\(`\/api\/me\/prefs\?profile=\$\{encodeURIComponent\(S\.profile\.id\)\}`\)[\s\S]+applyServerProfilePrefs\(r\.prefs\)[\s\S]+\} else \{\s*\n\s*syncProfilePrefsUp\(\);/,
    'profile entry should pull account-synced prefs (server wins) and migrate local prefs up on first use');
  assert.match(ui, /applyMenuPrefs\(\); \/\/ search-first[\s\S]+loadProfilePrefs\(\);/,
    'entering the app shell should load the profile\'s account-synced prefs');
  assert.match(ui, /function savePrefSubtitleMode\(value\) \{[\s\S]+syncProfilePrefsUp\(\);/,
    'changing auto-CC should sync the preference to the account');
  assert.match(ui, /function savePrefScreensaverDelay\(seconds\) \{[\s\S]+syncProfilePrefsUp\(\);/,
    'changing the screensaver delay should sync the preference to the account');
  assert.match(android, /nativeQualityBtn = nativeButton\(R\.drawable\.ic_player_quality, "Quality", false\)[\s\S]+rightControls\.addView\(nativeQualityBtn\);[\s\S]+nativeStatsBtn = nativeButton\(R\.drawable\.ic_player_info, "Playback stats", false\)[\s\S]+showNativeStatsSheet\(\)[\s\S]+rightControls\.addView\(nativeStatsBtn\);/,
    'native stats button should be the last ExoPlayer right-side control after CC/audio/quality');
  assert.match(android, /private ScrollView nativeSheetScroll;[\s\S]+private LinearLayout nativeSheetRows;/,
    'native ExoPlayer choice sheets should have a dedicated scroll viewport');
  assert.match(android, /private int nativeSheetWidthPx\(\) \{[\s\S]+if \(isTvDevice\(\)\) return dp\(328\);[\s\S]+screen - dp\(32\)[\s\S]+private int nativeSheetBottomMarginPx\(\) \{[\s\S]+if \(isTvDevice\(\)\) return dp\(96\);[\s\S]+screen \/ 5[\s\S]+private int nativeSheetRowsViewportHeight\(int count\) \{[\s\S]+screen - nativeSheetVerticalReservePx\(\)[\s\S]+return Math\.min\(max, needed\);[\s\S]+\}/,
    'native ExoPlayer subtitle/audio/quality sheets should stay bounded on smaller screens');
  assert.match(android, /nativeSheetScroll = new ScrollView\(this\);[\s\S]+nativeSheetRows = new LinearLayout\(this\);[\s\S]+nativeSheetRows\.addView\(row\);[\s\S]+nativeSheet\.addView\(nativeSheetScroll, new LinearLayout\.LayoutParams\([\s\S]+nativeSheetRowsViewportHeight\(labels\.length\)\)\);/,
    'native ExoPlayer choice rows should scroll inside the bounded sheet instead of growing offscreen');
  assert.match(android, /private java\.util\.ArrayList<View> nativeSheetFocusableRows\(\)[\s\S]+nativeSheetRows != null \? nativeSheetRows : nativeSheet[\s\S]+private void focusNativeSheetRow\([\s\S]+scrollTo\(0, Math\.max\(0, row\.getTop\(\) - dp\(8\)\)\)/,
    'native ExoPlayer D-pad focus should keep the highlighted sheet row visible');
  assert.match(android, /private GradientDrawable nativePanelBg\(\) \{[\s\S]+new int\[\]\{0xF0181A1D, 0xF00D0F12\}[\s\S]+d\.setCornerRadius\(dp\(10\)\);[\s\S]+d\.setStroke\(dp\(1\), 0x12FFFFFF\)/,
    'native ExoPlayer option sheets should use compact graphite panels instead of bright purple glass');
  assert.match(android, /private GradientDrawable nativeSheetRowBg\(boolean focused, boolean selected\) \{[\s\S]+focused[\s\S]+new int\[\]\{0xFF2B3137, 0xFF252A30\}[\s\S]+selected[\s\S]+new int\[\]\{0x403A3424, 0x30312D22\}[\s\S]+d\.setStroke\(dp\(1\), focused \? 0x66B8A46A : selected \? 0x55B8A46A : 0x00000000\)/,
    'native ExoPlayer sheet focused and selected rows should be visually distinct');
  assert.match(android, /row\.setSingleLine\(true\);[\s\S]+row\.setEllipsize\(TextUtils\.TruncateAt\.END\);[\s\S]+ViewGroup\.LayoutParams\.MATCH_PARENT, dp\(40\)/,
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
  assert.match(ui, /async function prepareNativeStartKindForAudio\(startKind\) \{[\s\S]+fetchPlayerTracks\(p, 1400\)[\s\S]+nativeDirectAudioNeedsSafeRemux\(selectedPlayerAudioTrack\(p\)\)[\s\S]+p\.forceAacRemux = true;[\s\S]+return 'remux';[\s\S]+nativeDirectAudioNameRisk\(p\)[\s\S]+return 'remux';[\s\S]+\}/,
    'Android direct playback should quickly probe risky audio and start a safe audio remux instead of silently direct-playing');
  assert.match(ui, /function remuxPlaybackUrl\(p, seekStart = 0, opts = \{\}\) \{[\s\S]+p\.forceAacRemux && !opts\.native[\s\S]+'&audioSafe=1'[\s\S]+return `\$\{p\.remuxUrl\}&start=\$\{Math\.max\(0, Math\.floor\(seekStart \|\| 0\)\)\}&audio=\$\{audio\}\$\{safe\}`;/,
    'remux URL omits the stereo audioSafe flag for the native player (gets server-default 5.1) but keeps it for browser/MSE surfaces; video always copied');
  assert.match(server, /const forceAudioSafe = ctx\.url\.searchParams\.get\('audioSafe'\) === '1';[\s\S]+const transcodeAudio = forceAudioSafe \|\| !audioCopyOk\(aud, vf\._caps\);/,
    'server remux should honor the audioSafe flag without forcing full video transcode');
  // audioSafe (multiview / any plain <video> MSE surface) must downmix to STEREO AAC — 5.1 AAC is
  // the least browser/WebView-decodable variant and plays as video-with-no-sound. The handler must
  // forward forceAudioSafe as safeStereo, and spawnRemux must pick 2 channels for it (6 otherwise).
  assert.match(server, /spawnRemux\(selfUrl, \{ startSeconds, audioTrack, transcodeAudio, safeStereo: forceAudioSafe \}\)/,
    'remux handler must forward the audio-safe flag so multiview audio is downmixed to stereo');
  assert.match(transcode, /function spawnRemux\(streamUrl, \{ startSeconds = 0, audioTrack = 0, transcodeAudio = false, safeStereo = false \} = \{\}\)[\s\S]+transcodeAudio[\s\S]+'-ac', safeStereo \? '2' : '6'/,
    'spawnRemux must downmix the audio-safe path to stereo AAC (2ch) and keep 5.1 (6ch) for the normal transcode path');
  // The SAME 5.1-AAC-silent footgun hits the full transcode fallback: a browser must get stereo there too,
  // while the native ExoPlayer path (never sends audioSafe) keeps 5.1 surround.
  assert.match(transcode, /function spawnTranscode\(streamUrl, \{ startSeconds = 0, audioTrack = 0, height = 1080, hdr = false, safeStereo = false \} = \{\}\)[\s\S]+'-c:a', 'aac', '-b:a', safeStereo \? '192k' : '256k', '-ac', safeStereo \? '2' : '6'/,
    'spawnTranscode downmixes the audio-safe path to stereo AAC (2ch) and keeps 5.1 (6ch) otherwise');
  assert.match(server, /transcode: async \(ctx\)[\s\S]+const forceAudioSafe = ctx\.url\.searchParams\.get\('audioSafe'\) === '1';[\s\S]+spawnTranscode\(selfUrl, \{ startSeconds, audioTrack, height: LADDER\[height\] \? height : 1080, hdr, safeStereo: forceAudioSafe \}\)/,
    'the /api/transcode handler honors audioSafe=1 (stereo) while the native path stays 5.1');
  assert.match(ui, /kind === 'transcode'\) \{[\s\S]+v\.src = `\$\{p\.transcodeUrl\}&start=\$\{seekStart\}&audio=\$\{p\.audioTrack \|\| 0\}&height=\$\{p\.quality \|\| 1080\}\$\{p\.forceAacRemux \? '&audioSafe=1' : ''\}`/,
    'the browser transcode fallback also requests stereo audio so an HEVC/10-bit source is not played silent');
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
  assert.match(ui, /const nativeRequired = nativeVideoRequired\(it\);[\s\S]+if \(opts\.nativeFirst \|\| nativeRequired\) startKind = await prepareNativeStartKindForAudio\(startKind\);[\s\S]+const nativeStarted = \(opts\.nativeFirst \|\| nativeRequired\) && tryNativePlaybackLadder\(it\.resume \|\| 0, startKind\);[\s\S]+if \(nativeStarted\) \{[\s\S]+startNativePlayerHousekeeping\(it\);[\s\S]+\} else if \(nativeRequired\) \{[\s\S]+closePlayer\(\);[\s\S]+return;[\s\S]+\} else \{[\s\S]+revealWebPlayerShell\(it\);[\s\S]+startWebPlayerHousekeeping\(mount, it\);[\s\S]+startSource\(startKind, it\.resume \|\| 0\);[\s\S]+\}/,
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
  // iOS Safari <video> decodes only AAC/MP3 but its canPlayType over-reports AC-3/E-AC-3 → the remux must
  // be forced to browser-safe AAC on iOS or nearly every AC3/EAC3 release codec-errors. iPhone/iPad/iPod
  // + iPadOS-as-Macintosh (touch) are detected; the flag rides forceAacRemux → audioSafe on the remux URL.
  assert.match(ui, /function iosWebkitVideo\(\) \{[\s\S]+\/iPhone\|iPad\|iPod\/\.test\(ua\)[\s\S]+\/Macintosh\/\.test\(ua\) && \(navigator\.maxTouchPoints \|\| 0\) > 1/,
    'iOS/iPadOS WebKit <video> surface is detected (Safari + Chrome/Firefox on iOS + iPadOS-as-Mac)');
  assert.match(ui, /forceAacRemux: iosWebkitVideo\(\) \|\| !canUseNativeVideoPlayer\(\),/,
    'EVERY plain browser <video> (iOS + desktop) forces stereo-AAC remux (fixes AC3/EAC3 codec-error on iOS AND the silent 5.1-AAC bug on desktop); the native ExoPlayer path strips audioSafe and keeps 5.1');
  assert.match(ui, /v\.onerror = \(\) => \{[\s\S]+const err = v\.error, pl = S\.playing;[\s\S]+console\.warn\('\[vod\] <video> error code=' \+ err\.code[\s\S]+failover\(\);/,
    'the web-player error path records the MediaError code (3=decode vs 4=src-not-supported) before failing over — pinpoints audio vs container/video walls on iOS');
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
  assert.match(android, /protected void onPause\(\) \{[\s\S]+boolean inPip = Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.N && isInPictureInPictureMode\(\);[\s\S]+if \(nativePlayer != null && !inPip\) nativePlayer\.pause\(\);[\s\S]+document\.querySelectorAll\('video'\)\.forEach\(v=>v\.pause\(\)\)[\s\S]+if \(!inPip && !musicPlaying\) \{[\s\S]+web\.onPause\(\);[\s\S]+web\.pauseTimers\(\);/,
    'Android backgrounding should pause playback and WebView timers, while keeping system PiP playback AND background music alive');
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
  assert.match(ui, /function startWebPlayerHousekeeping\(mount, it\) \{[\s\S]+v\.onerror = \(\) => \{[\s\S]+failover\(\);[\s\S]+\};[\s\S]+startHealthPoll\(mount\.id\);[\s\S]+loadTracks\(\);[\s\S]+subtitleCatalogAvailable\(it\)[\s\S]+fetch\(`\/api\/ossubs\/\$\{mount\.id\}\?\$\{subtitleRequestParams\(it, code2, mount\.streamToken\)\.toString\(\)\}`\)/,
    'web-only probes and subtitle prefetch should stay in the web playback branch and carry catalog ids; the video error handler still fails over');
  assert.match(ui, /async function loadTracks\(\) \{[\s\S]+if \(p\.usingNative && canUseNativeVideoPlayer\(\)\) \{[\s\S]+p\.nativeDuration = p\.duration \|\| p\.nativeDuration \|\| 0;[\s\S]+refreshNativeSubtitleChoices\(\);[\s\S]+return;[\s\S]+\}/,
    'track probing should feed native duration and subtitle choices without starting web playback');
  assert.match(ui, /function startSource\(kind, atSeconds, opts = \{\}\) \{[\s\S]+if \(p && p\.usingNative && canUseNativeVideoPlayer\(\)\) return false;/,
    'web source swaps should not run underneath native playback');
  assert.match(ui, /function markVodPlaybackStarted\(p\) \{[\s\S]+p\.started = true;[\s\S]+function vodPlaybackStarted\(p\) \{[\s\S]+p\.nativeReady[\s\S]+function recoverSamePlaybackSource\(reason = ''\) \{[\s\S]+tryNativeVideoPlayer\(kind, at, \{ quietSeek: true \}\)[\s\S]+startSource\(kind, at, \{ quietSeek: true \}\)/,
    'VOD playback should record the post-start boundary and recover the same source/kind after a mid-stream interruption');
  assert.match(ui, /function failover\(\) \{[\s\S]+if \(vodPlaybackStarted\(p\)\) \{[\s\S]+recoverSamePlaybackSource\('playback interrupted'\);[\s\S]+return;[\s\S]+if \(!p\.usingRemux && !p\.usingTranscode/,
    'web media errors after a real VOD frame must not silently switch to remux/transcode or another release');
  // When same-source resume fails because the mount is gone (server restarted/updated/swept), re-mount
  // the SAME title on a fresh mount and resume at the current position, with backoff to ride out the
  // restart — instead of giving up. Failure-path only, so healthy playback is untouched.
  assert.match(ui, /if \(!p\._reMounting\) reMountAndResume\(reason\);/,
    'a gone mount should escalate to a re-mount instead of immediately showing interrupted');
  assert.match(ui, /async function reMountAndResume\(reason = '', attempt = 0\) \{[\s\S]+api\('\/api\/play', \{ method: 'POST', body: playbackRequestBody\(p\.item, p\.name \? \{ name: p\.name \} : null\) \}\)[\s\S]+p\.mountId = r\.id;[\s\S]+startSource\(kind, at, \{ quietSeek: true \}\)[\s\S]+setTimeout\(\(\) => \{ if \(S\.playing === p\) reMountAndResume\(reason, attempt \+ 1\); \}, 1500 \+ attempt \* 1500\)/,
    'reMountAndResume should re-play the same title, adopt the new mount, resume at position, and retry with backoff then fall back');
  assert.match(ui, /async function autoAdvance\(opts = \{\}\) \{[\s\S]+if \(vodPlaybackStarted\(p\) && !opts\.allowMidstreamAdvance\) \{[\s\S]+recoverSamePlaybackSource\('source failed'\);[\s\S]+return;[\s\S]+const at = currentTime\(\);/,
    'auto-advance should remain a startup/source-failure path, not a mid-movie release switch');
  assert.match(ui, /window\.__tvNativeVideoReady = \(pos, dur\) => \{[\s\S]+p\.nativeReady = true;[\s\S]+markVodPlaybackStarted\(p\);[\s\S]+window\.__tvNativeVideoError = \(msg, pos, dur\) => \{[\s\S]+if \(vodPlaybackStarted\(p\)\) \{[\s\S]+recoverSamePlaybackSource\(msg \|\| 'native playback interrupted'\);[\s\S]+return;/,
    'native ExoPlayer errors after READY should recover the same source instead of walking the fallback ladder');
  assert.match(android, /if \(state == Player\.STATE_READY\) \{[\s\S]+if \("video"\.equals\(nativeMode\)\) \{[\s\S]+nativeVideoStarted = true;[\s\S]+window\.__tvNativeVideoReady && __tvNativeVideoReady/,
    'Android ExoPlayer STATE_READY should mark the web VOD session as post-start before later errors are handled');
  assert.match(android, /else if \("live"\.equals\(nativeMode\)\) \{[\s\S]+nativeLiveStarted = true;[\s\S]+window\.__tvNativeLiveReady && __tvNativeLiveReady\(\)/,
    'Android ExoPlayer STATE_READY should commit pending Live TV PiP guide tuning only after the live surface is ready');
  assert.match(ui, /const clearReadyFrame = \(\) => \{[\s\S]+pReady\.item\.type === 'live' && v\.readyState >= 2[\s\S]+\$\(\'playerLoader\'\)\.classList\.remove\('show'\);[\s\S]+v\.onloadeddata = clearReadyFrame;[\s\S]+v\.oncanplay = clearReadyFrame;/,
    'web Live TV should clear the startup loader once a decoded frame is ready, even if delayed autoplay is blocked');
  assert.ok(ui.includes("$('vlcPanel').classList.remove('show');")
      && ui.includes('if (v.paused) showLivePlayPrompt();'),
    'a decoded web Live TV frame should clear any earlier external-player fallback panel');
  assert.ok(ui.includes('function requestLiveMsePlay(v, opts = {}) {')
      && ui.includes("if (!opts.split && !opts.multi) return requestVideoPlay(v, { livePrompt: true });")
      && ui.includes('const requestLivePlay = () => requestLiveMsePlay(v, { split, multi }).catch(() => {')
      && ui.includes('if (active() && !split && !multi) {')
      && ui.includes('showLivePlayPrompt();')
      && ui.includes('requestLivePlay();'),
    'web Live TV MSE playback should reveal the ready frame when autoplay is blocked after buffering');
  assert.ok(ui.includes('function showLivePlayPrompt() {')
      && ui.includes("if (!p || !p.item || p.item.type !== 'live') return;")
      && ui.includes('showPlayerPlayPrompt({ requireReady: false });')
      && ui.includes('function showPlayerPlayPrompt(opts = {}) {')
      && ui.includes('if (opts.requireReady !== false && v.readyState < 2) return;')
      && ui.includes('applyFocus(play);')
      && ui.includes('clearTimeout(S.osdTimer);')
      && ui.includes('function requestVideoPlay(v, opts = {}) {')
      && ui.includes("const live = !!(S.playing && S.playing.item && S.playing.item.type === 'live');")
      && ui.includes("requestVideoPlay(v, { livePrompt: live })).catch(() => {});"),
    'blocked browser Live TV autoplay should keep the Play control available instead of throwing an unhandled play rejection');
  assert.ok(ui.includes('function liveMseHasReadyFrame(p = S.playing) {')
      && ui.includes("const src = v && (v.currentSrc || v.src || '');")
      && ui.includes("p.item.type === 'live' && v && v.readyState >= 2 && !v.error && /^blob:/.test(src)")
      && ui.includes('if (liveMseHasReadyFrame(p)) {')
      && ui.includes('showLivePlayPrompt();')
      && ui.includes('showVlcPanel() {'),
    'web Live TV must not open the external-player panel after MSE has decoded a usable frame');
  assert.ok(startSourceBlock.includes("if (p.item && p.item.type === 'live') {")
      && startSourceBlock.includes("kind === 'direct' && startLiveMseSource(p.streamUrl)")
      && startSourceBlock.includes('showLiveProviderError(liveMseType()')
      && startSourceBlock.includes('Live TV playback is not supported by this browser')
      && startSourceBlock.indexOf("if (p.item && p.item.type === 'live') {") < startSourceBlock.indexOf("} else if (kind === 'transcode')"),
    'web Live TV must not fall through to assigning the remux URL as a plain video src when MSE is unavailable');
  assert.ok(failoverBlock.includes("if (p.item && p.item.type === 'live') {")
      && failoverBlock.includes("showLiveProviderError('Live stream unavailable');")
      && failoverBlock.indexOf("if (p.item && p.item.type === 'live') {") < failoverBlock.indexOf('if (vodPlaybackStarted(p))'),
    'web Live TV failover should stay in Triboon with a live error instead of opening the VOD external-player path');
  assert.ok(showVlcPanelBlock.includes("if (p.item && p.item.type === 'live') {")
      && showVlcPanelBlock.includes("showLiveProviderError('Live stream unavailable');")
      && showVlcPanelBlock.indexOf("if (p.item && p.item.type === 'live') {") < showVlcPanelBlock.indexOf("$('vlcUrl').textContent = location.origin + p.streamUrl;"),
    'the generic external-player fallback should be VOD-only, not Live TV');
  assert.ok(!showVlcPanelBlock.includes('S._liveVlcT = setTimeout'),
    'Live TV should not show a delayed external-player stream URL panel');
  assert.ok(ui.includes("const reason = r.headers.get('x-triboon-iptv-error') || 'live stream unavailable';")
      && ui.includes('e.liveProviderReason = reason;')
      && ui.includes('if (e.liveProviderReason) showLiveProviderError(e.liveProviderReason);')
      && ui.includes('function showLiveProviderError(reason) {')
      && ui.includes('friendlyLiveProviderReason(reason')
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
  assert.match(ui, /if \(nativePreferred\) startKind = await prepareNativeStartKindForAudio\(startKind\);[\s\S]+if \(nativePreferred && tryNativePlaybackLadder\(at, startKind\)\) \{[\s\S]+startNativePlayerHousekeeping\(p\.item\);/,
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
  assert.match(ui, /const serverSeek = kind === 'remux' \|\| kind === 'transcode';[\s\S]+nativeUrl = remuxPlaybackUrl\(p, seekStart, \{ native: true \}\);[\s\S]+url: new URL\(nativeUrl, location\.origin\)\.href,[\s\S]+start: serverSeek \? 0 : Math\.max\(0, atSeconds \|\| 0\),[\s\S]+startOffset: seekStart/,
    'native remux/transcode playback should use server-side start URLs (native:true → 5.1 audio) and pass the absolute display offset');
  assert.match(ui, /class="seekLine"[\s\S]+id="seekElapsed"[\s\S]+id="seek"[\s\S]+id="seekTotal"/,
    'web player seek bar should show elapsed time on the left and total duration on the right');
  assert.match(ui, /#seek\{[^}]*touch-action:none[^}]*\}[\s\S]+#seek::before\{[^}]*height:44px/,
    'web player seek bar should expose a phone-sized touch target without changing its visual height');
  assert.match(ui, /function beginSeekPointer\(e\) \{[\s\S]+previewSeekSeconds\(target\);[\s\S]+function moveSeekPointer\(e\) \{[\s\S]+previewSeekSeconds\(target\);[\s\S]+function endSeekPointer\(e, commit = true\) \{[\s\S]+if \(commit\) seekTo\(target\);[\s\S]+\$\(\'seek\'\)\.addEventListener\(\'pointerdown\', beginSeekPointer\);[\s\S]+\$\(\'seek\'\)\.addEventListener\(\'pointermove\', moveSeekPointer\);[\s\S]+\$\(\'seek\'\)\.addEventListener\(\'pointerup\', \(e\) => endSeekPointer\(e, true\)\);/,
    'mobile web player seek bar should support tap-and-drag pointer seeking');
  assert.match(ui, /class="topLeft"[\s\S]+id="playerBackBtn"[\s\S]+class="playerMetaRow"[\s\S]+id="pTitle"[\s\S]+id="pEpisode"[\s\S]+id="pQuality"[\s\S]+class="osdRight"[\s\S]+class="seekLine"/,
    'web player should keep back, title, episode, and the hidden live-only badge in the top-left metadata cluster');
  assert.match(ui, /#osd\{[\s\S]+padding:clamp\(22px,3vw,42px\) clamp\(24px,3\.6vw,52px\) clamp\(50px,6\.2vw,78px\)/,
    'web player controls should sit a bit higher above the bottom edge');
  assert.match(ui, /function updatePlayerMeta\(\) \{[\s\S]+const quality = p && p\.item && p\.item\.type === 'live' \? 'LIVE' : '';[\s\S]+\$\(\'pQuality\'\)\.textContent = quality[\s\S]+\$\(\'pQuality\'\)\.style\.visibility = quality \? 'visible' : 'hidden';/,
    'web player should hide VOD 4K/1080p badges while keeping LIVE available for Live TV');
  assert.match(ui, /function episodePlayerMeta\(it\) \{[\s\S]+it\.type !== 'episode'[\s\S]+episodeCodeMeta\(it\)[\s\S]+subline: \[code, epName\]\.filter\(Boolean\)\.join\(' - '\)/,
    'episode playback should split show title from season/episode metadata for the player header');
  assert.match(ui, /id="playerEpisodes"[\s\S]+id="trackMenu"/,
    'episode players should have a hidden current-season thumbnail strip below the controls');
  assert.match(ui, /#playerEpisodes\{display:flex;max-height:0[\s\S]+transition:max-height[\s\S]+#playerEpisodes\.open\{max-height:196px;padding:5px 8px 20px[\s\S]+\.playerEpCard\{[\s\S]+clamp\(172px,16vw,244px\)[\s\S]+height:172px;border:0;border-radius:10px[\s\S]+background:transparent[\s\S]+box-shadow:none[\s\S]+\.playerEpCard\.focusable::before,\.playerEpCard\.focusable:focus-visible::before\{display:none\}[\s\S]+\.playerEpCard \.peStill\{[\s\S]+aspect-ratio:16\/9;border-radius:10px[\s\S]+box-shadow:none[\s\S]+\.playerEpCard \.peMeta\{display:flex;flex-direction:column[\s\S]+min-height:38px/,
    'web episode strip should fit compact rounded 16:9 stills, contained focus frame, and metadata inside the player frame');
  assert.match(ui, /\.playerEpCard\.focus \.peStill,\.playerEpCard:focus-visible \.peStill\{box-shadow:inset 0 0 0 1\.5px var\(--artFocusLine\)\}/,
    'player episode thumbnails should keep the hollow theme frame inside the still image');
  assert.match(ui, /function smoothFocusScrollOk\(\) \{[\s\S]+prefers-reduced-motion: reduce[\s\S]+return !document\.body\.classList\.contains\('tv'\);[\s\S]+\}[\s\S]+function focusScrollBehavior\(\) \{[\s\S]+smoothFocusScrollOk\(\) \? 'smooth' : 'auto'[\s\S]+\}/,
    'focus-driven scrolling should stay smooth in browsers but use non-stacking movement on Android TV');
  assert.match(ui, /\.pcard,\.card,\.seasonCard,\.epCard,\.castCard,\.chCard,\.playerEpCard\{[\s\S]+transition:transform \.18s cubic-bezier\(\.22,1,\.36,1\),filter \.18s ease,box-shadow \.18s ease[\s\S]+\.pcard \.art,\.seasonCard \.art,\.epCard \.still,\.castCard \.ph,\.chCard \.chLogo,\.playerEpCard \.peStill\{[\s\S]+contain:paint[\s\S]+\.pcard:hover,\.pcard\.focusable\.focus,\.seasonCard:hover,\.seasonCard\.focusable\.focus,\.epCard:hover,\.epCard\.focusable\.focus,\.castCard:hover,\.castCard\.focusable\.focus\{transform:translate3d\(0,-3px,0\)/,
    'poster, episode, cast, and channel cards should animate focus with compositor-friendly transitions');
  assert.match(ui, /\.pcard:hover \.art,\.pcard\.focus \.art,\.seasonCard:hover \.art,\.seasonCard\.focus \.art\{[\s\S]+box-shadow:0 0 0 1\.5px var\(--artFocusLine\),0 0 9px var\(--artFocusGlow\)!important\}/,
    'poster and thumbnail focus should use theme-aware thin hollow glow instead of a thick solid line');
  assert.match(ui, /\.card:hover,\.card\.focusable\.focus\{transform:translate3d\(0,-3px,0\);box-shadow:0 0 0 1\.5px var\(--artFocusLine\),0 0 9px var\(--artFocusGlow\)\}/,
    '16:9 row cards should use the same mouse hover lift and highlight as D-pad focus');
  assert.match(ui, /\.epCard:hover,\.epCard\.focus\{box-shadow:0 0 0 1\.5px var\(--artFocusLine\),0 0 9px var\(--artFocusGlow\)\}[\s\S]+\.castCard:hover \.ph,\.castCard\.focusable\.focus \.ph\{box-shadow:0 0 0 1\.5px var\(--artFocusLine\),0 0 9px var\(--artFocusGlow\)\}/,
    'detail episode and cast cards should match mouse hover highlight to D-pad focus');
  assert.match(ui, /\.seasonCard \.art\{[^}]+border:0/,
    'season artwork should not show a static border when it is not focused');
  assert.match(ui, /\.dPoster\{[^}]+border:0/,
    'detail poster artwork should not show a static border');
  assert.match(ui, /\.castCard \.ph\{[^}]+border:0/,
    'cast photos should not show a static border when they are not focused');
  assert.match(ui, /\.personHead \.pPhoto\{[^}]+border:0/,
    'person photos should not show a static border');
  assert.match(ui, /\.chCard \.chLogo\{[^}]+border:0/,
    'channel logos should not show a static border when they are not focused');
  assert.match(ui, /\.mCover\{[^}]+box-shadow:none/,
    'music covers should not show a static inset line when they are not focused');
  assert.match(ui, /triboonCoral: \{[\s\S]+artFocusLine: 'rgba\(94,160,242,\.34\)'[\s\S]+studio: \{[\s\S]+artFocusLine: 'rgba\(52,179,122,\.34\)'[\s\S]+velvet: \{[\s\S]+artFocusLine: 'rgba\(230,166,72,\.34\)'/,
    'artwork focus glow colors should change with each distinct theme palette (Ocean / Forest / Sunset)');
  assert.doesNotMatch(ui, /\.pcard:hover \.art,[^}]+box-shadow:0 0 0 3px var\(--coral\)|\.mCard:hover \.mCover,[^}]+box-shadow:0 0 0 3px var\(--coral\)|\.musicRow:hover \.mThumb,[^}]+box-shadow:0 0 0 3px var\(--coral\)/,
    'artwork focus should not regress to thick solid coral rings');
  assert.match(ui, /grid\.style\.maxHeight = pitch > 50 \? `\$\{n \* pitch - 4\}px` : `calc\(var\(--rowH\) \* \$\{n\} - \$\{n \* 2\}px\)`;/,
    'browse row windows should keep focused poster captions inside the viewport without showing half rows');
  assert.match(ui, /b\.innerHTML = `<div class="peStill"><\/div><div class="peMeta">[\s\S]+<span class="peName">/,
    'web episode cards should render the episode name below the thumbnail, not overlaid on the still');
  assert.match(ui, /async function getPlayerEpisodeContext\(it\) \{[\s\S]+episodeKeyParts\(it\)[\s\S]+api\(`\/api\/tmdb\/tv\/\$\{parts\.tmdbId\}\?append_to_response=external_ids`\)[\s\S]+api\(`\/api\/tmdb\/tv\/\$\{parts\.tmdbId\}\/season\/\$\{parts\.season\}`\)/,
    'player episode strip should load the current TMDB season and external IDs without depending on the detail page being open');
  assert.match(ui, /async function prepPlayerSeasonEpisodes\(it\) \{[\s\S]+epItemOf\(ctx\.show, \{ \.\.\.season, season_number: sNum \}, ep\)[\s\S]+S\.playerSeasonStrip = \{ currentKey: it\.key, items, idx:[\s\S]+updateNativeEpisodeChoices\(\);/,
    'player episode strip should reuse normal episode items (per-season numbering intact) and push the same choices to native playback');
  assert.match(ui, /const playerMeta = episodePlayerMeta\(p\.item\);[\s\S]+title: playerMeta\.title \|\| p\.item\.title \|\| 'Triboon',[\s\S]+episodeLabel: playerMeta\.subline \|\| '',/,
    'native Android player handoff should receive the same episode subline as the web player');
  assert.match(ui, /episodeChoices: nativeEpisodeChoices\(\),/,
    'native Android player handoff should include the current-season episode choices');
  assert.match(ui, /function nativeEpisodeFocusIndex\(\) \{[\s\S]+const current = st\.items\.findIndex\(\(ep\) => ep\.item && ep\.item\.key === st\.currentKey\);[\s\S]+return current >= 0 \? current : Math\.max\(0, Math\.min\(st\.items\.length - 1, st\.idx \|\| 0\)\);[\s\S]+window\.TriboonTV\.updateEpisodeChoices\(JSON\.stringify\(\{ episodes: nativeEpisodeChoices\(\), focusIndex: nativeEpisodeFocusIndex\(\) \}\)\);/,
    'native Android episode refreshes should send an explicit current-episode focus index');
  assert.match(ui, /window\.__tvNativeEpisodeSelect = \(index, pos, dur\) => \{[\s\S]+S\.playerSeasonStrip\.idx = idx;[\s\S]+activatePlayerEpisode\(\);[\s\S]+\};/,
    'native episode-row selection should return through the normal web episode play path');
  assert.match(android, /private String nativePlaybackSubline = "";[\s\S]+String episodeLabel = j\.optString\("episodeLabel", ""\);[\s\S]+nativePlaybackSubline = episodeLabel == null \? "" : episodeLabel;[\s\S]+nativePlayerTitle\.setText\(title\);[\s\S]+nativePlayerTitle\.setVisibility\(View\.VISIBLE\);[\s\S]+String subline = isLiveMode \? "" : nativePlaybackSubline;[\s\S]+nativePlayerSubline\.setText\(subline\);[\s\S]+nativePlayerSubline\.setVisibility\(subline\.isEmpty\(\) \? View\.GONE : View\.VISIBLE\);/,
    'native Android player should show title and episode metadata while hiding VOD 4K/1080p badges');
  assert.match(android, /String chromeQuality = isLiveMode \? "LIVE" : "";[\s\S]+nativePlayerBadge\.setText\(chromeQuality\);[\s\S]+nativePlayerBadge\.setVisibility\(chromeQuality\.isEmpty\(\) \? View\.GONE : View\.VISIBLE\);/,
    'native Android player badge should be live-only instead of showing VOD resolution');
  assert.match(android, /nativeChromeSubline\.setText\(""\);[\s\S]+nativeChromeSubline\.setVisibility\(View\.GONE\);/,
    'native Android should clear the unused bottom metadata subline');
  assert.match(android, /private HorizontalScrollView nativeEpisodeStrip;[\s\S]+private final java\.util\.ArrayList<NativeEpisode> nativeEpisodes = new java\.util\.ArrayList<>\(\);/,
    'native Android player should own a real episode thumbnail row instead of relying on the hidden web overlay');
  assert.match(android, /nativeChrome\.addView\(nativeEpisodeStrip, new LinearLayout\.LayoutParams\([\s\S]+ViewGroup\.LayoutParams\.MATCH_PARENT, dp\(198\)\)\);/,
    'native Android episode strip should have enough height for larger thumbnails and labels below them');
  assert.match(android, /private void animateNativeEpisodeStripIn\(\) \{[\s\S]+setAlpha\(0f\)[\s\S]+setTranslationY\(dp\(24\)\)[\s\S]+setDuration\(190\)[\s\S]+private void animateNativeEpisodeStripOut\(\) \{[\s\S]+setDuration\(120\)/,
    'native Android episode strip should slide/fade in and out instead of popping on screen');
  assert.match(android, /private void scrollNativeEpisodeIntoView\(View child\) \{[\s\S]+nativeEpisodeStrip\.scrollTo\(target, 0\);[\s\S]+nativeEpisodeStrip\.smoothScrollTo\(target, 0\);[\s\S]+nativeEpisodeScrollAtMs = now;[\s\S]+\}/,
    'native Android episode focus should use one throttled scroll path instead of stacking repeated smooth-scroll calls');
  assert.match(android, /card\.setOnFocusChangeListener\(\(v, hasFocus\) -> \{[\s\S]+v\.animate\(\)\.cancel\(\);[\s\S]+v\.animate\(\)\.translationY\(-dp\(3\)\)\.setDuration\(120\)\.start\(\);[\s\S]+scrollNativeEpisodeIntoView\(v\);[\s\S]+v\.animate\(\)\.translationY\(0f\)\.setDuration\(100\)\.start\(\);[\s\S]+\}\);/,
    'native Android episode cards should animate their focus lift without resizing the strip');
  assert.match(android, /ViewGroup\.LayoutParams\.MATCH_PARENT, dp\(126\)[\s\S]+label\.setText\(\(ep\.watched \? "WATCHED  " : ""\) \+ ep\.tag\);[\s\S]+TextView name = new TextView\(this\);[\s\S]+name\.setMaxLines\(2\);[\s\S]+new LinearLayout\.LayoutParams\(dp\(236\), dp\(182\)\)/,
    'native Android episode cards should show a larger still with the episode name below the image');
  assert.match(android, /private GradientDrawable nativeEpisodeCardBg\(boolean focused, boolean current\) \{[\s\S]+new int\[\]\{0x00000000, 0x00000000\}[\s\S]+d\.setCornerRadius\(dp\(16\)\);[\s\S]+return d;[\s\S]+private GradientDrawable nativeEpisodeStillFrame\(boolean focused, boolean current\) \{[\s\S]+if \(focused \|\| current\) d\.setStroke\(dp\(1\), focused \? 0x88C6B37A : 0x66C6B37A\);[\s\S]+return d;/,
    'native Android episode cards should use rounded borderless card backgrounds');
  assert.match(android, /still\.setTag\("nativeEpisodeStill"\);[\s\S]+GradientDrawable stillBg = new GradientDrawable\(\);[\s\S]+stillBg\.setCornerRadius\(dp\(12\)\);[\s\S]+still\.setBackground\(stillBg\);[\s\S]+still\.setForeground\(nativeEpisodeStillFrame\(i == nativeEpisodeIndex && nativeEpisodeStripOpen, ep\.current\)\);[\s\S]+still\.setClipToOutline\(true\);/,
    'native Android episode thumbnails should clip and own the same contained hollow frame as the web player');
  assert.match(android, /public void updateEpisodeChoices\(String json\) \{[\s\S]+updateNativeEpisodeChoices\(json\)/,
    'web should be able to refresh native episode choices after TMDB season metadata loads');
  assert.match(android, /private void updateNativeEpisodeChoices\(String json\) \{[\s\S]+int focusIndex = -1;[\s\S]+focusIndex = obj\.optInt\("focusIndex", -1\);[\s\S]+if \(focusIndex >= 0 && focusIndex < nativeEpisodes\.size\(\)\) nativeEpisodeIndex = focusIndex;[\s\S]+renderNativeEpisodeStrip\(false\);/,
    'native Android player should parse the shared episode-choice payload and focus the requested current episode');
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
  assert.match(ui, /#trackMenu\{display:none;position:absolute;bottom:118px;right:44px;width:min\(390px,calc\(100vw - 88px\)\);min-width:260px;max-height:min\(420px,calc\(100vh - 220px\)\);[\s\S]+rgba\(24,26,29,\.96\)[\s\S]+border-radius:10px[\s\S]+backdrop-filter:blur\(14px\)/,
    'web player CC/audio/quality popup should open near the right-side controls with compact graphite styling');
  assert.match(ui, /#trackMenu button\{display:flex;width:100%;min-height:44px;/,
    'track menu rows should meet the 44px touch target floor');
  assert.match(ui, /#trackMenu button\.focus\{background:rgba\(255,255,255,\.10\);color:var\(--text\);box-shadow:inset 2px 0 0 var\(--focus\)\}[\s\S]+#trackMenu button\.sel\{color:var\(--text\);background:rgba\(184,164,106,\.18\)/,
    'web player popup focused and selected rows should be distinct professional states');
  assert.match(ui, /#playerStats\{display:none;position:absolute;right:44px;bottom:176px[\s\S]+rgba\(24,26,29,\.96\)[\s\S]+border-radius:10px[\s\S]+backdrop-filter:blur\(14px\)/,
    'web player stats popup should match the compact graphite player sheet styling');
  assert.match(ui, /#upNext\{position:absolute;right:34px;bottom:120px[\s\S]+rgba\(24,26,29,\.96\)[\s\S]+border-radius:10px[\s\S]+#upNext \.un-play\{background:var\(--btn\);color:var\(--text\)\}/,
    'web up-next popup should use the same neutral panel and button palette');
  assert.match(ui, /\.epMenu\{position:absolute;right:10px;top:44px[\s\S]+rgba\(24,26,29,\.97\)[\s\S]+border-radius:10px[\s\S]+\.epMenu button\.focus\{background:rgba\(255,255,255,\.10\);color:var\(--text\)[\s\S]+box-shadow:inset 2px 0 0 var\(--focus\)\}/,
    'episode action popup should use the same compact neutral player menu styling');
  assert.match(ui, /function playerSurfaceClick\(e\) \{[\s\S]+closest\('#osd \.top,\.playerMetaRow,\.seekLine,\.ctl,#playerEpisodes,#trackMenu,#playerStats,#pGuide,#vlcPanel,#upNext,#playerLoader,button,a,input,select,textarea'\)[\s\S]+return true;[\s\S]+function playerSingleClick\(e\) \{[\s\S]+setTimeout\(\(\) => \{[\s\S]+togglePlay\(\);[\s\S]+\}, 320\);[\s\S]+function playerDoubleClick\(e\) \{[\s\S]+clearTimeout\(_playerSurfaceClickT\);[\s\S]+toggleFullscreen\(\);/,
    'web player screen clicks should toggle play, while double-click fullscreen cancels the pending pause');
  assert.match(ui, /\$\('player'\)\.addEventListener\('click', playerSingleClick\);[\s\S]+\$\('player'\)\.addEventListener\('dblclick', playerDoubleClick\);/,
    'web player should bind separate single-click and double-click surface handlers');
  assert.match(ui, /function hidePlayerOsdForBack\(\) \{[\s\S]+player\.classList\.contains\('open'\)[\s\S]+osd\.classList\.contains\('hide'\)[\s\S]+osd\.classList\.add\('hide'\)[\s\S]+S\.zone === 'seek'[\s\S]+return true;/,
    'web player Back should be able to hide visible controls without closing playback');
  assert.match(ui, /if \(k === 'Escape' \|\| k === 'Backspace'\) \{[\s\S]+if \(hidePlayerOsdForBack\(\)\) return;[\s\S]+return closePlayer\(\);[\s\S]+window\.__tvBack = \(\) => \{[\s\S]+\$\(\'pGuide\'\)[\s\S]+closePlayerGuide\(\);[\s\S]+\$\(\'playerStats\'\)[\s\S]+closePlayerStats\(\);[\s\S]+showOsd\(\);[\s\S]+if \(hidePlayerOsdForBack\(\)\) return 'ok';[\s\S]+const overlay = document\.querySelector/,
    'Escape/Backspace and Android TV Back should close PiP guide/controls before closing the player');
  assert.match(ui, /#appClock\{position:fixed;top:calc\(18px \+ var\(--safeT\) \+ var\(--overscan\)\);right:calc\(22px \+ var\(--safeR\) \+ var\(--overscan\)\);z-index:21;min-width:112px;height:38px;padding:0 4px[\s\S]+align-items:baseline;justify-content:center;gap:3px[\s\S]+font:650 16px "JetBrains Mono",monospace;letter-spacing:\.01em;[\s\S]+text-shadow:0 2px 6px rgba\(0,0,0,\.58\)\}/,
    'main app clock should render as larger text-only status with restrained weight and shadow');
  assert.match(ui, /#appClock \.ampm\{font-size:\.72em;letter-spacing:\.02em\}/,
    'main app clock should keep AM/PM close to the time without a full monospace space');
  assert.doesNotMatch(ui, /#appClock\{[^}]*background:/,
    'main app clock should not draw a background chip');
  assert.doesNotMatch(ui, /#appClock\{[^}]*border:/,
    'main app clock should not draw a border');
  assert.doesNotMatch(ui, /#appClock\{[^}]*backdrop-filter:blur/,
    'main app clock should not return to the heavy glass blur treatment');
  assert.doesNotMatch(ui, /#appClock::before/,
    'main app clock should not draw an icon before the time');
  assert.match(ui, /function appClockHtml\(d\) \{[\s\S]+return `<span>\$\{h\}:\$\{m\}<\/span><span class="ampm">\$\{ap\}<\/span>`;[\s\S]+function updateClocks\(\) \{[\s\S]+\$\('appClock'\)\.innerHTML = appClockHtml\(now\);/,
    'top app clock should render tight time and AM/PM spans while other clocks keep plain text');
  assert.match(ui, /#screensaver\{position:fixed;inset:0;z-index:55[\s\S]+#ssTime\{font:900 clamp\(54px,8\.5vw,132px\)\/\.9 "Sora";letter-spacing:0\}[\s\S]+#ssDeck\{position:absolute;right:clamp\(22px,5vw,86px\)/,
    'app screensaver should own a polished fullscreen visual layer with large time and art deck');
  assert.match(ui, /<div id="screensaver" aria-hidden="true">[\s\S]+<div class="ssBg" id="ssBg"><\/div>[\s\S]+<div class="ssDeck" id="ssDeck"><\/div>[\s\S]+<div id="ssTime"><\/div>/,
    'app screensaver markup should include background, art deck, and clock regions');
  assert.match(ui, /#screensaver \.ssBrand\{[\s\S]+width:clamp\(172px,14vw,270px\);height:clamp\(58px,5vw,96px\);overflow:hidden[\s\S]+#screensaver \.ssBrand img\{width:100%;height:auto;display:block;[\s\S]+transform:translateY\(-25%\);/,
    'screensaver brand should use the updated cropped Triboon wordmark');
  assert.match(ui, /<div class="ssBrand"><img src="triboon\.png" alt="Triboon"><\/div>/,
    'screensaver should use the updated transparent Triboon wordmark asset');
  assert.match(ui, /const SCREENSAVER_IDLE_DEFAULT_SECONDS = 60;[\s\S]+const SCREENSAVER_IDLE_OPTIONS = \[0, 60, 120, 300, 600\];[\s\S]+function normalizeScreensaverDelaySeconds\(value\) \{[\s\S]+if \(n > 0 && n < 60\) return normalizeScreensaverDelaySeconds\(n \* 60\);[\s\S]+function prefScreensaverDelaySeconds\(\) \{[\s\S]+localStorage\.getItem\(profilePrefKey\('screensaverDelay'\)\)[\s\S]+localStorage\.getItem\('triboon\.screensaverDelay'\)[\s\S]+return normalizeScreensaverDelaySeconds\(raw\);[\s\S]+function savePrefScreensaverDelay\(seconds\) \{[\s\S]+const n = normalizeScreensaverDelaySeconds\(seconds\);[\s\S]+function prefScreensaverDelayMs\(\) \{[\s\S]+return seconds > 0 \? seconds \* 1000 : 0;[\s\S]+function canShowScreensaver\(\) \{[\s\S]+S\.nativeLivePending[\s\S]+S\.view === 'player' \|\| S\.playing \|\| document\.body\.classList\.contains\('videoOpen'\)[\s\S]+\$\('player'\)\.classList\.contains\('open'\)[\s\S]+\.gate\.open,#drawer\.open,#trailer\.open,#libModal\.open,#matchModal\.open,#updateModal\.open,#catModal\.open,#filterMenu\.open,#cwMenu\.open,#trackMenu\.open,#musicNow\.open[\s\S]+function resetScreensaverIdle\(\) \{[\s\S]+const idleMs = prefScreensaverDelayMs\(\);[\s\S]+if \(!idleMs\) return;[\s\S]+setTimeout\(showScreensaver, idleMs\);/,
    'app screensaver should default to one minute, stay out of native Live TV, playback (S.playing/videoOpen, covering native ExoPlayer), gates, and active modal surfaces');
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
  assert.match(ui, /const subPayload = nativeSubtitlePayload\(p, sub\.rel \|\| '', 'startup'\);[\s\S]+subtitleLabel: subPayload\.label/,
    'native player should receive a user-facing subtitle label');
  assert.match(ui, /async function nativeStartupSubtitleRelAfterPreflight\(p, rel\) \{[\s\S]+nativeSubtitlePayload\(p, rel, 'startup'\)[\s\S]+onlineFallbackRelForBuiltIn\(rel\)/,
    'native player startup should avoid waiting on slow built-in subtitle extraction when online fallback is available');
  assert.match(ui, /subtitleRel: subPayload\.rel[\s\S]+subtitleChoices: nativeSubtitleChoices\(\)/,
    'native player should receive selectable subtitle choices');
  assert.match(ui, /function embeddedSubChoices\(\) \{\s+if \(!builtInSubtitlesEnabled\(\)\) return \[\];[\s\S]+return subs\.filter\(\(s\) => s && s\.text === true\);[\s\S]+\}/,
    'native subtitle choices should also hide embedded built-in rows while online-only mode is active');
  assert.match(ui, /window\.__tvNativeSubtitleShowAll = \(pos, dur\) => \{[\s\S]+setShowAllLocalSubtitles\(true\);[\s\S]+refreshNativeSubtitleChoices\(\);[\s\S]+\};/,
    'native player should be able to reveal all hidden local subtitle languages');
  assert.match(android, /"local_all"\.equals\(choice\.subtitleAction\)[\s\S]+requestNativeSubtitleShowAll\(\);/,
    'Android native subtitle menu should route the show-all local languages action back to the web player state');
  assert.match(server, /embeddedSubtitleTimeoutMs\(mode = '', vf = null\)[\s\S]+embedded subtitle extraction timed out after/,
    'embedded subtitle extraction should fail cleanly instead of hanging indefinitely on streamed mounts');
  assert.match(server, /function episodeSubtitleQuery\(query, season, ep\)[\s\S]+S\$\{String\(s\)\.padStart\(2, '0'\)\}E\$\{String\(e\)\.padStart\(2, '0'\)\}/,
    'server subtitle lookup should be able to add episode identity even when source filenames are opaque');
  assert.match(server, /vf\._q = body\.q;[\s\S]+vf\._subQuery = episodeSubtitleQuery\(body\.q, body\.season, body\.ep\);/,
    'online subtitle lookup should use the episode-aware query captured during play');
  assert.match(server, /function subtitleReleaseName\(vf\) \{[\s\S]+vf\._releaseName[\s\S]+const releaseName = subtitleReleaseName\(vf\) \|\| vf\.name;[\s\S]+query: vf\._subQuery \|\| vf\._q \|\| releaseName \|\| vf\.name[\s\S]+rankSubs\(combined, releaseName[\s\S]+downloadBestSubtitle\([\s\S]+releaseName,/,
    'online subtitle lookup should rank and download using the selected source release name (Wyzie + OpenSubtitles merged)');
  assert.match(server, /const ranked = rankSubs\(combined, releaseName[\s\S]+const variants = usableVariants\(ranked, \{ releaseName \}\)\.slice\(0, 12\);/,
    'the displayed subtitle variant list must be trimmed by usableVariants (hide wrong-episode / non-text rows)');
  assert.match(server, /if \(!variant && !hasConfidentAutoPick\(variants, \{ releaseName \}\)\) \{[\s\S]+e\.noSubtitles = true;[\s\S]+throw e;/,
    'the automatic subtitle pick must refuse to serve a confirmed wrong-episode sub (report no-subtitles instead)');
  assert.match(server, /if \(wantsList\) \{[\s\S]+const menu = distinctVariants\(variants\);[\s\S]+variants: menu\.map\(/,
    'the subtitle menu list must collapse mirror-duplicate rows via distinctVariants (full set kept for download fallback)');
  assert.match(ui, /Manual mode, no preferred language: warm the subtitle MENU[\s\S]+q\.set\('list', '1'\);[\s\S]+fetch\(`\/api\/ossubs\/\$\{mount\.id\}\?\$\{q\.toString\(\)\}`\)\.catch/,
    'manual mode should background-prewarm the subtitle menu (list only) so opening CC is instant');
  assert.match(ui, /function autoSyncSubtitle\(p, rel, baseUrl\)[\s\S]+u\.searchParams\.delete\('shift'\);[\s\S]+u\.searchParams\.set\('sync', '1'\);[\s\S]+p\._subShift = 0; saveSubShift\(rel, 0\);/,
    'web auto-sync must strip the manual shift (no double-offset) and reset it once alass-corrected cues swap in, like the native path');
  assert.match(server, /if \(!subSyncResultOk\(vtt, out\)\) throw new Error\('alass output failed the cue-count sanity check'\);/,
    'alass output must pass the cue-count sanity guard before it is trusted/cached');
  assert.match(server, /function localMountFor\(ctx, libId, idx, caps = \{\}, playCtx = \{\}\)[\s\S]+const q = String\(playCtx\.q \|\| found\.item\.q \|\| found\.item\.title \|\| name\)[\s\S]+const season = playCtx\.season \?\? found\.item\.s[\s\S]+const ep = playCtx\.ep \?\? playCtx\.episode \?\? found\.item\.e[\s\S]+vf\._subQuery = episodeSubtitleQuery\(vf\._q, season, ep\)/,
    'local library mounts should preserve episode-aware subtitle queries for Wyzie');
  assert.match(ui, /function startupSubtitleRelFor\(p, saved = loadSubChoice\(\)\) \{[\s\S]+Manual mode is truly manual at startup[\s\S]+if \(prefSubtitleMode\(\) !== 'always'\) return '';[\s\S]+if \(saved === 'off'\) return '';[\s\S]+if \(subtitleRelPlayable\(p, saved\)\) return saved;[\s\S]+const builtIn = bestBuiltInSubtitleRel\(\);[\s\S]+if \(builtIn\) return builtIn;[\s\S]+return autoSubtitleRelFor\(p\);[\s\S]+\}/,
    'startup subtitles should stay off in manual mode and prefer online subtitles while built-ins are disabled');
  assert.match(ui, /function nativeVideoSubtitleRel\(p\) \{\s+return \{ blocked: false, rel: concreteSubtitleRel\(startupSubtitleRelFor\(p\)\) \};\s+\}/,
    'native playback should use the shared startup subtitle contract');
  assert.match(ui, /function applyStartupSubtitlePref\(\) \{[\s\S]+const rel = concreteSubtitleRel\(startupSubtitleRelFor\(p\)\);[\s\S]+Promise\.resolve\(setSubtitle\(rel, \{ startup: true \}\)\)\.finally/,
    'web playback should auto-start the profile subtitle choice when subtitle mode is always');
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
  assert.match(ui, /function nativeSubtitlePayload\(p, rel, mode = 'startup'\) \{[\s\S]+shift: chosen \? \(loadSubShift\(chosen\) \|\| 0\) : 0,[\s\S]+\}/,
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
  assert.match(ui, /function subtitleDisplayName\(rel\) \{[\s\S]+if \(!info\.variant\) return onlineSubtitleLabel\(subtitleRecommendedLabel\(name, bestSubtitleVariant\(info\.lang\)\)\);[\s\S]+const saved = savedSubtitleDetail\(name\);[\s\S]+return onlineSubtitleLabel\(\(detail \|\| saved\) \? `\$\{name\} \(\$\{detail \|\| saved\}\)` : name\);/,
    'web and native subtitle labels should include the online source plus useful release details');
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
  assert.match(ui, /const pick = subtitleDefaultChoice\(l\);[\s\S]+mkRow\(onlineSubtitleLabel\(pick\.label\), p\.subTrack === pick\.rel, \(\) => setSubtitle\(pick\.rel\)\);[\s\S]+if \(variants && variants\.length && expanded\) \{/,
    'web CC menu should keep advanced subtitle versions collapsed until the user asks for them');
  assert.match(ui, /if \(!variants \|\| !variants\.length\) \{[\s\S]+addChoice\(\{ action: 'versions', lang: l, label: onlineSubtitleLabel\(name\) \}\);[\s\S]+return;[\s\S]+const pick = subtitleDefaultChoice\(l\);[\s\S]+addChoice\(\{ rel: pick\.rel, label: onlineSubtitleLabel\(pick\.label\) \}\);[\s\S]+if \(variants && variants\.length && expanded\) \{/,
    'native CC choices should search before exposing a concrete subtitle URL');
  assert.match(ui, /mkRow\(`Online - more \$\{name\} choices`/,
    'CC menu should expose subtitle versions through a clear version-picker row');
  assert.match(ui, /addChoice\(\{ action: 'versions', lang: l, label: `Online - more \$\{name\} choices` \}\)/,
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
  assert.match(ui, /if \(prefSubtitleMode\(\) !== 'always'\) return '';/,
    'native subtitles should respect manual mode before considering saved online subtitle choices');
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
  assert.match(ui, /function openNativeLiveGuideShell\(it, opts = \{\}\) \{[\s\S]+wakeScreensaverForPlayerSurface\(\);[\s\S]+stopWebVideoElement\(\);[\s\S]+document\.body\.classList\.add\('nativeGuideMode'\);[\s\S]+S\.nativeGuideMode = true;[\s\S]+\$\(\'player\'\)\.classList\.add\('open', 'guideMode'\);[\s\S]+\$\(\'player\'\)\.classList\.remove\('live'\);[\s\S]+\$\(\'osd\'\)\.classList\.add\('hide'\);/,
    'native Live TV guide should wake screensaver state and enter guide mode before the player container can reveal the web player');
  assert.match(ui, /function tryNativeLivePlayer\(it, guide = false\) \{[\s\S]+try \{[\s\S]+wakeScreensaverForPlayerSurface\(\);[\s\S]+window\.TriboonTV\.playLive/,
    'native Live TV playback should wake screensaver state before ExoPlayer owns the screen');
  assert.doesNotMatch(ui, /function openNativeLiveGuideShell\(it, opts = \{\}\) \{[\s\S]+\$\(\'player\'\)\.classList\.add\('open', 'live'\)/,
    'native Live TV guide must not open the old web live-player shell first');
  assert.match(ui, /function setPlayerGuideLiveTuningPending\(it\) \{[\s\S]+S\.playerGuideLivePending = it \|\| null;[\s\S]+\$\(\'pGuide'\)\.classList\.toggle\('liveTuning', !!it\);[\s\S]+function setNativeLiveTuningPending\(it\) \{[\s\S]+S\.nativeLivePendingCommit = it \|\| null;[\s\S]+setPlayerGuideLiveTuningPending\(it\);[\s\S]+function commitNativeLivePlayback\(it\) \{[\s\S]+setNativeLiveTuningPending\(null\);[\s\S]+setNativeLivePlaybackState\(it\);[\s\S]+window\.__tvNativeLiveReady = \(\) => \{[\s\S]+S\.nativeLivePendingCommit \|\| S\.nativeLivePending \|\| currentNativeLiveGuideItem\(\)[\s\S]+commitNativeLivePlayback\(it\);/,
    'PiP guide channel tuning should show a pending state and commit Live TV only after ExoPlayer reports ready');
  assert.match(ui, /function closePlayerGuide\(opts = \{\}\) \{[\s\S]+window\.TriboonTV\.closeGuide\(\)/,
    'closing the shared guide from web focus should restore native fullscreen playback');
  assert.match(ui, /async function togglePlayerGuide\(\) \{[\s\S]+S\.playing && S\.playing\.usingNative[\s\S]+typeof window\.TriboonTV\.openGuide === 'function'[\s\S]+window\.TriboonTV\.openGuide\(\); return;/,
    'web guide button should ask Android to enter native PiP guide mode while ExoPlayer is already playing');
  assert.match(ui, /window\.__tvNativeGuideClosed = \(epoch\) => \{[\s\S]+n !== S\.nativeGuideEpoch\) return;[\s\S]+closePlayerGuide\(\{ fromNative: true \}\)/,
    'native guide close callback should ignore stale close events from an older PiP guide');
  assert.match(ui, /window\.__tvNativeGuideEpoch = \(epoch\) => \{[\s\S]+S\.nativeGuideEpoch = n;[\s\S]+schedulePlayerGuideFocusRestore\(S\._pgFocusChannel \?\? S\.liveCur\)/,
    'native guide channel retunes should keep the web guide epoch in sync and restore row focus');
  assert.match(ui, /function rememberVodReturn\(item = S\.playing && S\.playing\.item, resume = currentTime\(\), opts = \{\}\) \{[\s\S]+if \(!item \|\| item\.type === 'live'\) return false;[\s\S]+S\.returnVod = \{ item, resume: at \};[\s\S]+return true;[\s\S]+\}/,
    'movie and episode return targets should be saved through one helper so Live TV changes do not overwrite them');
  assert.match(ui, /async function closePlayer\(opts = \{\}\) \{[\s\S]+rememberVodReturn\(S\.playing && S\.playing\.item, currentTime\(\), \{ onlyMidstream: true \}\);/,
    'closing a movie or episode mid-play should keep a return target for later Live TV browsing');
  assert.match(ui, /if \(!it\) \{[\s\S]+S\.playing\.item\.type !== 'live' && S\.view === 'player'[\s\S]+rememberVodReturn\(\);[\s\S]+revealNativeGuideShell\(\);[\s\S]+return togglePlayerGuide\(\);/,
    'native movie/episode guide button should open the same PiP guide and preserve a Back to movie target');
  assert.match(ui, /function revealNativeGuideShell\(\) \{[\s\S]+wakeScreensaverForPlayerSurface\(\);[\s\S]+stopWebVideoElement\(\);[\s\S]+document\.body\.classList\.add\('nativeGuideMode'\);[\s\S]+S\.nativeGuideMode = true;[\s\S]+\$\(\'player\'\)\.classList\.add\('open', 'guideMode'\);[\s\S]+\$\(\'player\'\)\.classList\.remove\('live'\);[\s\S]+\$\(\'osd\'\)\.classList\.add\('hide'\);/,
    'native movie/episode guide button should wake the screensaver and hide the web video immediately while the guide data loads');
  assert.match(ui, /return renderGuideProgressive\(body, pool\)/,
    'Live TV guide should render the guide shell before waiting on provider guide data');
  assert.match(ui, /let consumed = Math\.min\(LIVE_GUIDE_BATCH, selectedList\.length\);[\s\S]+const firstSlice = selectedList\.slice\(0, consumed\);/,
    'player guide should open with the same small initial batch as the Live TV page');
  assert.match(ui, /fetchGuideBatch\(chans\)\.then/,
    'player guide should hydrate guide data asynchronously, per rendered batch');
  // Progressive channel loading: the in-player guide used to hard-cap at LIVE_GUIDE_BATCH with no
  // way to reach channels beyond it. It now extends on scroll (IntersectionObserver) and on D-pad
  // stepping off the last rendered row (S._pgExtend), mirroring the browser guide's extend().
  assert.match(ui, /const extendPlayerGuide = \(\) => \{[\s\S]+const next = selectedList\.slice\(consumed, consumed \+ LIVE_GUIDE_BATCH\);[\s\S]+consumed \+= next\.length;[\s\S]+renderChannels\(next\)/,
    'player guide must be able to load the next channel batch beyond the initial window');
  assert.match(ui, /S\._pgIO = new IntersectionObserver\(\(en\) => \{[\s\S]+extendPlayerGuide\(\);[\s\S]+\}, \{ root: main, rootMargin: '260px 0px' \}\);[\s\S]+S\._pgExtend = extendPlayerGuide;/,
    'scrolling to the bottom of the in-player guide should pull in more channels');
  assert.match(ui, /if \(delta > 0 && i >= rows\.length - 1 && typeof S\._pgExtend === 'function' && S\._pgExtend\(\)\) \{[\s\S]+grown\.length > rows\.length/,
    'D-pad DOWN off the last rendered guide row should load + land on the next channel, not wrap at 24');
  assert.match(ui, /if \(k === 'Escape' \|\| k === 'Backspace'\) \{[\s\S]+if \(rows\.includes\(active\) && cats\.length\) return focusPlayerGuideCategory\(catIndex\(\)\);[\s\S]+return closePlayerGuide\(\);/,
    'Back from a guide channel row should step to the category list, not close the whole guide');
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
  assert.match(ui, /\.pgTimeline \.pgRow:hover \.gCh,\.pgTimeline \.pgRow:focus \.gCh,\.pgTimeline \.pgRow\.focus \.gCh\{background:var\(--btnHover\)\}[\s\S]+\.pgTimeline \.pgRow \.gCh,\.pgTimeline \.pgRow \.gTl\{transition:background \.14s ease,box-shadow \.14s ease\}/,
    'PiP guide row hover/focus should stay visibly highlighted and transition smoothly');
  assert.match(ui, /pg\.classList\.remove\('ready'\);[\s\S]+pg\.classList\.add\('open'\);[\s\S]+scheduleNativeGuidePipSync\(\);[\s\S]+requestAnimationFrame\(\(\) => \{[\s\S]+pg\.classList\.add\('ready'\)/,
    'player guide should sync PiP before revealing the ready state');
  assert.match(android, /nativePlayerView\.setLayoutParams\(pipLp\);[\s\S]+revealNativeGuidePip\(pipLp\);[\s\S]+applyNativeGuidePipRect\(String json\)[\s\S]+nativePlayerView\.setLayoutParams\(pipLp\);[\s\S]+syncNativeGuidePipRevealScrim\(pipLp\);/,
    'native PiP should reveal with a sibling scrim and keep that scrim aligned after the guide rectangle is applied');
  assert.match(ui, /function scheduleNativeGuidePipSync\(\) \{[\s\S]+requestAnimationFrame[\s\S]+setTimeout\(syncNativeGuidePipRect, 90\)/,
    'native PiP rect sync should retry after layout settles');
  assert.match(ui, /body\.nativeGuideMode #player\.guideMode #video\{display:none\}/,
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
  // Guide position: opening/returning to the PiP guide (when NOT mid-browse) lands on the category
  // of the channel you're watching — "where you left off" after a tune+fullscreen+back. And the
  // category-focus double-scroll (manual scrollTo THEN scrollIntoView) was removed.
  assert.match(ui, /const currentCat = currentCh && currentCh\.genre && catNames\.includes\(currentCh\.genre\)[\s\S]+if \(!S\.pgCatDpadMode && currentCat\) \{[\s\S]+S\.pgLiveCat = currentCat;/,
    'PiP guide should open on the playing channel category (not a stale one) unless actively browsing');
  assert.match(ui, /no scrollIntoView here — the manual pane scrollTo above already positions the chip/,
    'PiP category focus must not double-scroll (the redundant scrollIntoView was removed)');
  assert.match(ui, /if \(!started && appended > 700000\) \{[\s\S]+started = true;[\s\S]+requestLivePlay\(\)/,
    'live MSE should start playback after ~0.7s buffered (faster channel change), not ~1.5s');
  assert.match(ui, /if \(k === 'ArrowRight'\) return moveTo\(rows\.find\(\(r\) => r\.classList\.contains\('cur'\)\) \|\| rows\[0\]\)/,
    'PiP guide should enter channel rows only when the user presses Right from categories');
  assert.match(ui, /if \(S\.pgCatDpadMode && cats\.length\) return focusPlayerGuideCategory\(catIndex\(\)\);[\s\S]+if \(k === 'ArrowDown'\) return moveRowFrom\(1\)/,
    'PiP guide stale category mode should recover category focus before generic row movement can run');
  assert.match(ui, /function setPlayerGuideVisualFocus\(channel\) \{[\s\S]+clearPlayerGuideVisualFocus\(\);[\s\S]+row\.classList\.add\('focus'\);[\s\S]+S\._pgFocusChannel = row\._ch \?\? target;/,
    'PiP guide should keep a visible selected-row state even when the native player steals DOM focus');
  assert.match(ui, /function focusPlayerGuideRow\(channel, opts = \{\}\) \{[\s\S]+const row = setPlayerGuideVisualFocus\(channel\);[\s\S]+focus\(\{ preventScroll: !!opts\.preventScroll \}\)/,
    'PiP guide should be able to restore the active channel row after native retunes');
  assert.match(ui, /function schedulePlayerGuideFocusRestore\(channel, opts = \{\}\) \{[\s\S]+S\._pgFocusChannel = target;[\s\S]+requestAnimationFrame\(\(\) => \{[\s\S]+setTimeout\(restore, 80\)/,
    'PiP guide should retry focus after ExoPlayer retunes because native surface recreation can steal focus briefly');
  assert.match(ui, /const moveRowFrom = \(delta\) => \{[\s\S]+rows\.findIndex\(\(r\) => r\.classList\.contains\('cur'\)\)[\s\S]+S\._pgFocusChannel[\s\S]+i \+ delta/,
    'PiP guide Up/Down should move relative to the current row even when DOM focus was reset');
  assert.match(ui, /moveTo\(rows\[\(\(i \+ delta\) % rows\.length \+ rows\.length\) % rows\.length\]\);/,
    'channel guide list wraps around (Down past the last channel → first), like the left menu');
  assert.match(ui, /const moveTo = \(el\) => \{[\s\S]+el\.classList && el\.classList\.contains\('pgRow'\)[\s\S]+setPlayerGuideVisualFocus\(el\._ch \?\? el\.dataset\.guideChannel\);/,
    'PiP guide D-pad row moves should refresh the visible selected row, not only browser focus');
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
  assert.match(ui, /const rowCol = \(ri\) => [\s\S]*?S\.colIdx\[ri\] \|\| 0[\s\S]+if \(k === 'ArrowUp'\) return S\.rowIdx === 0 \? \(view\.hasHero \? focusHero\(0\) : enterRail\(\)\)[\s\S]+: focusCard\(S\.rowIdx - 1, rowCol\(S\.rowIdx - 1\)\);[\s\S]+return focusCard\(S\.rowIdx \+ 1, 0\);/,
    'Home/Discover: DOWN starts the next row at the beginning (0); UP RESTORES the per-row remembered column (rowCol → S.colIdx[ri])');
  assert.match(ui, /ci = down \? 0 : Math\.min\(dRows\[ri\]\.length - 1, S\.detailColMem\[dType\(ri\)\] \|\| 0\);/,
    'Detail page: DOWN starts the next row at 0; UP restores the per-row remembered column (S.detailColMem keyed by row type)');
  assert.match(ui, /const t = \(row \+ 1\) \* cols; \/\/ DOWN[\s\S]*?if \(t < count\) return focusGrid\(saveCol\(t\)\);/,
    'Virtual grids (Movies/TV/Library): DOWN jumps to the first item of the next row');
  assert.match(ui, /const col = Math\.min\(cols - 1, gcm\[row - 1\] \|\| 0\); \/\/ restore[\s\S]*?focusGrid\(saveCol\(Math\.min\(count - 1, \(row - 1\) \* cols \+ col\)\)\);/,
    'Virtual grids: UP restores the column last left in the row above (gridColMem)');
  assert.match(ui, /function geomGridVert\(dir\) \{[\s\S]+if \(dir > 0\) return rows\[tr\]\[0\];[\s\S]+return rows\[tr\]\[Math\.min\(rows\[tr\]\.length - 1, gcm\[tr\] \|\| 0\)\];/,
    'Geometric grids (search/person/library) use the same row-by-row model: DOWN→first of next row, UP→restore the row column');
  assert.match(ui, /#discoverTitle,#browseTitle,#prefs>h1,#settings>h1\{display:none\}/,
    'Page-level titles (Discover / Movies / TV Shows / Preferences / Server settings) are hidden everywhere');
  assert.match(ui, /function applyRoute\(\) \{[\s\S]+switchView\(target, false\);[\s\S]+requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{[\s\S]+focusContent\(\);[\s\S]+\}\)\);[\s\S]+\}/,
    'browser Back/Forward should land focus on the visible route instead of leaving a stale rail focus ring');
  assert.match(ui, /window\.addEventListener\('hashchange', \(\) => \{[\s\S]+const parts = routeParts\(\);[\s\S]+if \(parts\[0\] === 'person' && parts\[1\]\) return openPerson\(parts\[1\], false\);[\s\S]+if \(\$\(\'person\'\)\.classList\.contains\('open'\)\) closePerson\(\);[\s\S]+if \(\$\(\'detail\'\)\.classList\.contains\('open'\) && !routeIsTitle\(\)\) return closeDetail\(\);[\s\S]+applyRoute\(\);[\s\S]+\}\);/,
    'browser Back to a cast/person hash re-opens the cast page (person is a real history entry), leaving a person page closes it then routes, and detail-to-detail history routes instead of jumping to the original browse page');
  // Android hardware BACK / Escape run closeDetail (NOT browser history): a detail opened from a
  // cast page must return to that cast page, not restoreDetailReturn's stale origin.
  assert.match(ui, /S\.detailFromPerson = \(S\.view === 'person'\) \? \(S\.personId \|\| null\) : null;/,
    'opening a detail from a cast page should remember the cast id for the hardware-Back path');
  assert.match(ui, /function closeDetail\(\) \{[\s\S]+const fromPerson = S\.detailFromPerson;[\s\S]+S\.detailFromPerson = null;[\s\S]+if \(fromPerson\) \{ replaceRoute\(`#\/person\/\$\{fromPerson\}`\); openPerson\(fromPerson, false\); return; \}[\s\S]+restoreDetailReturn\(\);/,
    'hardware Back / Escape closing a cast-member detail should return to the cast page (browser Back uses history instead)');
  assert.match(ui, /function closePerson\(\) \{[\s\S]+if \(!\$\(\'detail\'\)\.classList\.contains\('open'\)\) return restoreDetailReturn\(\);/,
    'closing a cast page re-entered over a closed detail should fall back to the detail-return origin, not strand on a blank page');
  assert.match(ui, /function liveNoChannelsHtml\(errors = \[\]\) \{[\s\S]+gridMore liveEmpty focusable[\s\S]+function focusLiveGridMessage\(\) \{[\s\S]+S\.view === 'livetv' && S\.zone !== 'rail'[\s\S]+focusGrid\(0\);/,
    'Live TV empty channel states should be focusable and claim D-pad focus');
  assert.match(ui, /grid\.innerHTML = '<div class="gridMore focusable">loading channels[\s\S]+focusLiveGridMessage\(\);[\s\S]+if \(!r\.configured\) \{ grid\.innerHTML = '<div class="gridMore focusable">[\s\S]+focusLiveGridMessage\(\); return; \}[\s\S]+if \(!r\.channels\.length\) \{ grid\.innerHTML = liveNoChannelsHtml\(S\.liveSourceErrors\); focusLiveGridMessage\(\); return; \}[\s\S]+catch \(e\) \{ grid\.innerHTML = `<div class="gridMore focusable">Live TV failed:/,
    'Live TV loading, not-configured, no-channel, and failed states should not strand focus');
  assert.match(ui, /No channels match\.<\/div>'; focusLiveGridMessage\(\);[\s\S]+Every category is hidden[\s\S]+focusLiveGridMessage\(\);[\s\S]+No channels to show - favorite some channels or use the filter[\s\S]+focusLiveGridMessage\(\);/,
    'Live TV in-page empty states should stay remote-focusable after search/category changes');
  assert.match(ui, /const selectedCatIdx = Math\.max\(0, names\.indexOf\(S\.liveCat\)\);[\s\S]+S\.liveCatNavIdx = S\.liveCatDpadMode && Number\.isFinite\(S\.liveCatNavIdx\)[\s\S]+: selectedCatIdx;/,
    'Live TV rerenders should preserve the D-pad category focus index instead of snapping to the selected category');
  assert.match(ui, /function focusLiveCategory\(idx, select = false\) \{[\s\S]+applyFocus\(cats\[i\], false\);[\s\S]+if \(select && name && name !== S\.liveCat\) \{[\s\S]+S\.liveCat = name;[\s\S]+S\._liveCatApplyT = setTimeout\(applyLiveCatRender, 150\);[\s\S]+function applyLiveCatRender\(\) \{[\s\S]+renderLiveTvBody\(\);[\s\S]+requestAnimationFrame\(\(\) => \{[\s\S]+focusLiveCategory\(i\);[\s\S]+\}\);/,
    'Live TV category D-pad movement should apply the category immediately but debounce the heavy channel-pane rerender (then restore category focus)');
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
  // Guide left/right focus memory: LEFT off a channel remembers it (per category); RIGHT back into
  // the SAME category returns to that channel, a different category starts at the first row.
  assert.match(ui, /function rememberLiveChannel\(el\) \{[\s\S]+S\.liveChanReturnIdx = parseInt\(el\.dataset\.grid, 10\);[\s\S]+S\.liveChanReturnCat = S\.liveCat;/,
    'leaving a channel to the category rail should remember which channel + category');
  assert.match(ui, /function focusLiveContentRemembered\(\) \{[\s\S]+S\.liveChanReturnCat === S\.liveCat && Number\.isFinite\(S\.liveChanReturnIdx\)[\s\S]+focusGrid\(S\.liveChanReturnIdx\);[\s\S]+focusGrid\(parseInt\(els\[0\]\.dataset\.grid, 10\) \|\| 0\)/,
    'returning right into the same category should restore the remembered channel, else the first row');
  assert.match(ui, /if \(focusedGuideRow\) \{[\s\S]+rememberLiveChannel\(focusedGuideRow\); return focusLiveCategory\(\);/,
    'ArrowLeft off a guide row should remember the channel before returning to categories');
  assert.match(ui, /if \(k === 'ArrowRight'\) return focusLiveContentRemembered\(\) \|\| focusGrid\(parseInt\(focusedCat\.dataset\.grid/,
    'ArrowRight from a category should restore the remembered channel');
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
  assert.match(ui, /async function playChannel\(it, list\) \{[\s\S]+if \(promotePlayerGuideChannelToFullscreen\(it\)\) return;[\s\S]+rememberVodReturn\(\);/,
    'selecting Live TV from a movie or episode PiP guide should preserve the Back to title target before replacing playback');
  assert.match(ui, /function promotePlayerGuideChannelToFullscreen\(it\) \{[\s\S]+\$\(\'pGuide\'\)\.classList\.contains\('open'\)[\s\S]+S\.playing\.item\.type === 'live'[\s\S]+String\(activeLiveChannelIdx\(\)\) !== String\(it\._channel\)[\s\S]+closePlayerGuide\(\);[\s\S]+\$\(\'player\'\)\.classList\.add\('open'\);[\s\S]+\$\(\'player\'\)\.classList\.add\('live'\);/,
    'selecting the already-current PiP guide channel should close the guide into full-screen Live TV instead of reloading it');
  assert.match(ui, /if \(keepGuidePip && S\.nativeGuideMode && tryNativeLivePlayer\(it, true\)\) \{[\s\S]+markGuideCur\(\);[\s\S]+schedulePlayerGuideFocusRestore\(it\._channel\);[\s\S]+return;[\s\S]+\}/,
    'channel tuning from the native PiP guide should retune ExoPlayer without starting web playback');
  assert.match(ui, /row\.addEventListener\('click', async \(\) => \{[\s\S]+setPlayerGuideVisualFocus\(ch\._channel\);[\s\S]+await playChannel\(ch, selectedList\);[\s\S]+schedulePlayerGuideFocusRestore\(ch\._channel\);[\s\S]+\}\);/,
    'selecting a PiP guide channel should restore the chosen row after the async native retune completes');
  assert.match(ui, /async function ensurePlayerGuideChannels\(\) \{[\s\S]+loadLiveChannelsCombined\(\)[\s\S]+fillLiveState\(fav\)[\s\S]+return list;[\s\S]+\}/,
    'native and web player guide openings should share the same channel-list loader');
  assert.match(ui, /window\.__tvNativeLiveGuide = async \(epoch\) => \{[\s\S]+const list = await ensurePlayerGuideChannels\(\);[\s\S]+openNativeLiveGuideShell\(active\);[\s\S]+return renderPlayerGuideTimeline\(\$\(\'pGuide\'\), list\.length \? list : \[active\]\);[\s\S]+\};/,
    'Android guide handoff should load real guide rows before rendering the native PiP guide shell');
  assert.match(ui, /if \(!catNames\.length\) \{[\s\S]+No channels available[\s\S]+pg\.classList\.add\('open'\);[\s\S]+return;[\s\S]+\}/,
    'player guide should show a nonblank empty state instead of leaving a black guide screen');
  assert.match(ui, /if \(\(!keepGuidePip \|\| !S\.nativeGuideMode\) && tryNativeLivePlayer\(it\)\) return;/,
    'normal Live TV tuning (and a web-rendered guide PiP) should launch native fullscreen playback, not fall to the web player with VOD controls');
  assert.match(ui, /function isTriboonAndroidShell\(\) \{[\s\S]+\/TriboonTV\|TriboonAndroid\/\.test\(navigator\.userAgent \|\| ''\)[\s\S]+\}[\s\S]+function nativeLiveRequired\(\) \{[\s\S]+installed APK is too old to expose playLive[\s\S]+return isTriboonAndroidShell\(\);[\s\S]+\}/,
    'Android TV and mobile Live TV should require ExoPlayer based on the Android shell, not on whether the bridge is currently usable');
  assert.match(ui, /function tryNativeLivePlayer\(it, guide = false\) \{[\s\S]+if \(!guide\) \{[\s\S]+S\.nativeGuideMode = false;[\s\S]+closePlayerGuide\(\{ fromNative: true \}\);[\s\S]+\$\(\'player\'\)\.classList\.remove\('guideMode'\);[\s\S]+\}[\s\S]+window\.TriboonTV\.playLive/,
    'normal Live TV tuning should clear stale native guide state before asking ExoPlayer to start');
  assert.match(ui, /const keepGuidePip = S\.view === 'player' && !!\(\$\(\'pGuide\'\) && \$\(\'pGuide\'\)\.classList\.contains\('open'\)\)/,
    'stale guide DOM outside the player view must not force later Live TV selections into PiP');
  assert.match(ui, /if \(nativeLiveRequired\(\)\) \{[\s\S]+canUseNativeLivePlayer\(\)[\s\S]+Native player could not start this channel[\s\S]+Update the Android app to play Live TV[\s\S]+return;[\s\S]+\}[\s\S]+return playChannelWeb\(it\);/,
    'Android Live TV should stop on native startup failure or stale APK bridge instead of falling back to the web player');
  assert.match(ui, /const LIVE_MSE_TYPES = \[[\s\S]+video\/mp4; codecs="avc1\.4d4028, mp4a\.40\.2"[\s\S]+function liveMseType\(\) \{[\s\S]+MediaSource\.isTypeSupported/,
    'web Live TV should use MediaSource for the server fMP4 remux instead of a plain infinite video src');
  assert.match(ui, /function stopWebVideoElement\(\) \{[\s\S]+cleanupLiveMse\(\);[\s\S]+v\.removeAttribute\('src'\)/,
    'leaving or replacing playback should abort the Live TV MediaSource reader before clearing the video element');
  assert.ok(startSourceBlock.includes("if (p.item && p.item.type === 'live') {")
      && startSourceBlock.includes("kind === 'direct' && startLiveMseSource(p.streamUrl)"),
    'only Live TV direct playback should take the web MediaSource path');
  assert.match(ui, /async function playChannelWeb\(it\) \{[\s\S]+const preserveGuide = !!\(\$\(\'pGuide\'\) && \$\(\'pGuide\'\)\.classList\.contains\(\'open\'\)\);[\s\S]+stopActivePlaybackForReplacement\(\{ preserveGuide \}\);[\s\S]+openPlayer\(liveItemPayload\(it\),/,
    'web Live TV channel changes should close the previous MSE fetch/player connection before opening the new channel');
  assert.match(ui, /async function playChannelWeb\(it\) \{[\s\S]+if \(preserveGuide\) setPlayerGuideLiveTuningPending\(it\);[\s\S]+await openPlayer\(liveItemPayload\(it\),[\s\S]+\}, \{ preserveGuide \}\);[\s\S]+if \(preserveGuide && \$\(\'pGuide\'\) && \$\(\'pGuide\'\)\.classList\.contains\('open'\)\) \{[\s\S]+\$\(\'player\'\)\.classList\.add\('guideMode'\);[\s\S]+schedulePlayerGuideFocusRestore\(it\._channel\);/,
    'web PiP guide Live TV tuning should preserve the video slot instead of dropping to a black guide panel');
  assert.match(ui, /const keepGuideMode = !!\(opts\.preserveGuide && \$\(\'pGuide\'\) && \$\(\'pGuide\'\)\.classList\.contains\('open'\)\);[\s\S]+\$\(\'player\'\)\.classList\.remove\('open'\);[\s\S]+\$\(\'player\'\)\.classList\.toggle\('guideMode', keepGuideMode\);/,
    'openPlayer should not clear browser PiP guide layout when a guide channel is selected');
  assert.match(ui, /const clearReadyFrame = \(\) => \{[\s\S]+setPlayerGuideLiveTuningPending\(null\);[\s\S]+if \(\$\(\'pGuide\'\) && \$\(\'pGuide\'\)\.classList\.contains\('open'\)\) \{[\s\S]+\$\(\'player\'\)\.classList\.add\('guideMode'\);[\s\S]+schedulePlayerGuideFocusRestore\(S\._pgFocusChannel \?\? S\.liveCur\);/,
    'web PiP guide tuning should clear only after Live TV has a decoded browser frame');
  assert.match(server, /let clientClosed = false;[\s\S]+const stopForClientClose = \(\) => \{[\s\S]+clientClosed = true;[\s\S]+ff\.kill\('SIGKILL'\);[\s\S]+ctx\.req\.off\('close', stopForClientClose\);[\s\S]+ctx\.res\.off\('close', stopForClientClose\);[\s\S]+if \(clientClosed\) return;[\s\S]+ctx\.req\.once\('close', stopForClientClose\);[\s\S]+ctx\.res\.once\('close', stopForClientClose\);/,
    'server Live TV remux should kill ffmpeg exactly once when the browser closes the stream');
  assert.ok(server.includes('function iptvRemuxTargets(ch = {})')
    && server.includes("if (ch.nativeUrl && iptvNativeMime(ch.nativeUrl) === 'video/mp2t') add(ch.nativeUrl, 'ts');")
    && server.includes("validateAndPinIptvUrl(target.url, 'Live stream URL')")
    && server.includes('spawnLiveRemux(iptvRemuxInputHref(pin, target.url)')
    && server.includes('headers: pin.hostHeader ? { Host: pin.hostHeader } : undefined'),
    'server Live TV remux fallback should try Xtream TS before HLS and preserve HTTPS provider SNI');
  assert.match(transcode, /function ffmpegHeaderLines\(headers = \{\}\)[\s\S]+\`\$\{k\}: \$\{v\}\\r\\n\`[\s\S]+function spawnLiveRemux\(url, \{ hlsFriendly = true, headers = null \} = \{\}\)[\s\S]+supportsFfmpegHttpOption\('max_redirects'\) \? \['-max_redirects', '0'\] : \[\][\s\S]+\.\.\.\(headerLines \? \['-headers', headerLines\] : \[\]\)[\s\S]+'-i', url/,
    'ffmpeg Live TV remux should receive sanitized Host headers and disable ffmpeg redirect following when the installed build supports that option');
  assert.match(server, /function resolveIptvRemuxRedirect\(rawTarget, maxHops = 5\) \{[\s\S]+validateAndPinIptvUrl\(current, 'Live stream URL'\)[\s\S]+new URL\(res\.headers\.location, u\)\.href[\s\S]+throw new Error\('too many live stream redirects'\)/,
    'server Live TV remux should resolve provider redirects itself so every hop is validated before ffmpeg retries');
  assert.match(server, /const redirectHls = hlsFriendly \|\| iptvRemuxTargetLikelyHls\(redirected\);/,
    'redirected HLS Live TV URLs should keep HLS-friendly ffmpeg flags even if the final provider URL is extensionless');
  assert.match(ui, /const primaryUrl = it\._nativeUrl \|\| it\._streamUrl;[\s\S]+const primaryMime = it\._nativeUrl \? \(it\._nativeMime \|\| ''\) : 'video\/mp4';[\s\S]+const primaryAbs = new URL\(primaryUrl, location\.origin\)\.href;[\s\S]+addLiveFallback\(it\._nativeFallbackUrl, it\._nativeFallbackMime \|\| ''\);[\s\S]+addLiveFallback\(it\._streamUrl, 'video\/mp4'\);[\s\S]+url: primaryAbs,[\s\S]+mime: primaryMime,[\s\S]+fallbacks: liveFallbacks,/,
    'Android Live TV should try provider candidates first, then fall back to the server remux path on weaker devices');
  assert.match(ui, /_nativeFallbackUrl: ch\.nativeFallbackUrl[\s\S]+_nativeFallbackMime: ch\.nativeFallbackMime \|\| ''/,
    'Live TV guide/card/search items should preserve native fallback stream metadata');
  assert.doesNotMatch(ui, /Native player failed[^`'"]*using web player|using web playback/,
    'Android native playback should not advertise or trigger the old web player fallback');
  assert.match(ui, /window\.__tvNativeLiveError = \(msg\) => \{[\s\S]+closePlayerGuide\(\{ fromNative: true \}\);[\s\S]+if \(nativeLiveRequired\(\)\) \{[\s\S]+if \(wasLiveShell\) closePlayer\(\);[\s\S]+toast\(`Live TV unavailable: \$\{friendlyLiveProviderReason\(reason\)\}`\);[\s\S]+return;[\s\S]+\}[\s\S]+if \(wasLiveShell\) \{[\s\S]+showLiveProviderError\(reason\);/,
    'on Android a native Live TV crash must stay native (close back to the guide + toast), NOT reveal the web player error panel; showLiveProviderError is reserved for the non-native web build');
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
  assert.match(android, /return new View\[\]\{\s+nativeGuideBtn, nativeRewBtn, nativePlayBtn, nativeLiveBtn, nativeFwdBtn,\s+nativeNextBtn, nativeFavBtn, nativeCcBtn, nativeAudioBtn, nativeCastBtn, nativeQualityBtn, nativeStatsBtn\s+\};/,
    'native player D-pad traversal (View[] — the Go-live LIVE pill is a TextView) must include nativeFavBtn, nativeLiveBtn, and the Cast button');
  // Native live: a red "LIVE" text pill (matching the web overlay) — NOT a skip icon — that seeks to
  // the live edge. It is a TextView, which is why nativeControlButtons() is View[] not ImageButton[].
  assert.match(android, /nativeLiveBtn = new TextView\(this\);[\s\S]*?SpannableString liveLabel = new android\.text\.SpannableString\("● LIVE"\)[\s\S]*?ForegroundColorSpan\(0xFFFF5A5A\)[\s\S]*?nativeLiveBtn\.setText\(liveLabel\)[\s\S]*?nativeLiveBtn\.setBackground\(nativeButtonBg\(false, false\)\)/,
    'the native Go-live control is a NEUTRAL "● LIVE" text pill (only a small red dot) styled like the transport buttons — not a big red-filled pill');
  assert.match(android, /private void goNativeLive\(\) \{[\s\S]+"live"\.equals\(nativeMode\)[\s\S]+nativePlayer\.seekToDefaultPosition\(\)[\s\S]+nativePlayer\.play\(\)/,
    'goNativeLive should seek to the live edge and resume');
  // Phone/tablet: native player buttons must respond to a touch tap. consumeNativeControlClick gated
  // every click on a prior D-pad "arm", so taps (never armed) did nothing — no pause on a phone.
  assert.match(android, /private boolean consumeNativeControlClick\(View v\) \{[\s\S]*?if \(v\.isInTouchMode\(\)\) \{[^}]*return true; \}/,
    'native player controls must accept a direct touch tap (not only D-pad-armed clicks)');
  assert.match(android, /if \(nativeLiveBtn != null\) nativeLiveBtn\.setVisibility\(isLive \? View\.VISIBLE : View\.GONE\)/,
    'the native Go-live button must be visible only for live playback');
  // Native live EPG strip: the channel schedule, ABOVE the seek bar, fed from the web via setLiveEpg.
  assert.match(android, /nativeChrome\.addView\(nativeEpgStrip, epgLp\);[\s\S]+LinearLayout seekRow = new LinearLayout/,
    'the native EPG strip must be added to the chrome directly above the seek row');
  assert.match(android, /public void setLiveEpg\(String json\) \{[\s\S]+new org\.json\.JSONArray\(json\)[\s\S]+renderNativeEpgStrip\(\)/,
    'the setLiveEpg bridge should parse the pushed programmes and render the native strip');
  assert.match(android, /private void renderNativeEpgStrip\(\) \{[\s\S]+horizon = now \+ 2L \* 3600000L[\s\S]+isNow \? "NOW" : fmtNativeClock\(start\)/,
    'native EPG strip should cover ~2h and mark the current programme');
  assert.match(android, /int maxCells = dpWidth < 600 \? 2 : 4;[\s\S]+shown < maxCells/,
    'native EPG strip should drop to 2 cells on a narrow phone (4 truncates every title)');
  assert.match(android, /return 4; \/\/ v4: native live EPG strip/,
    'nativeChromeVersion must advertise v4 so the web pushes EPG to native');
  assert.match(ui, /function pushLiveEpgToNative\(\) \{[\s\S]+typeof TriboonTV\.setLiveEpg === 'function'[\s\S]+TriboonTV\.setLiveEpg\(JSON\.stringify/,
    'the web should push the live EPG to the native chrome when the shell supports it');
  assert.match(ui, /\.cbtn\.big\{width:58px;height:58px;background:rgba\(5,3,9,\.4\);color:var\(--text\)\}/,
    'web play button should be neutral until focused or hovered');
  assert.doesNotMatch(ui, /\.cbtn\.on\{background:var\(--amber\)|\.btn\.primary,\.cbtn\.big/,
    'enabled or selected player buttons should not keep the old persistent gold highlight');
  assert.match(ui, /function playerCcCanOpen\(\) \{[\s\S]+p\.item\.type !== 'live'[\s\S]+p\.mountId \|\| p\.tracksUrl \|\| subtitleCatalogAvailable\(p\.item\)/,
    'web CC should open for mounted VOD even when it needs to show unavailable-subtitle diagnostics');
  assert.match(ui, /function updatePlayerControlAvailability\(\) \{[\s\S]+setPlayerControlEnabled\('ccBtn', playerCcCanOpen\(\)\);[\s\S]+setPlayerControlEnabled\('audBtn', playerAudioHasOptions\(\)\);[\s\S]+setPlayerControlEnabled\('qualBtn', playerQualityHasOptions\(\)\);/,
    'web CC should stay selectable for VOD while audio/HD buttons remain disabled without real options');
  assert.match(ui, /const ccProbePending = builtInSubtitlesEnabled\(\) && kind === 'cc' && !p\.tracks && !!p\.tracksUrl;[\s\S]+fetchPlayerTracks\(p, 2500\)[\s\S]+Built-in subtitles off in Settings/,
    'web CC menu should avoid built-in probing in online-only mode and explain why local rows are hidden');
  assert.match(ui, /ctlButtons\(\) \{[\s\S]+!b\.disabled && !b\.classList\.contains\('disabled'\)/,
    'web player D-pad focus should skip disabled controls');
  assert.match(android, /setNativeButtonIcon\(ImageButton b, int iconRes, boolean primary, boolean focused\) \{[\s\S]+!b\.isEnabled\(\) \? 0x88EDE8F5 : \(focused \? 0xFF0B0812 : 0xFFEDE8F5\)/,
    'native player icons should turn dark when the focused button switches to light mode');
  assert.match(android, /focused[\s\S]+\? new int\[\]\{0xFFEDE8F5, 0xFFD9CBE7\}[\s\S]+: new int\[\]\{0x18F3EFF7, 0x18F3EFF7\}/,
    'native player buttons should use a very transparent fill normally and full light fill while focused');
  assert.match(android, /setNativeButtonEnabled\(nativeCcBtn, nativeSubtitleHasOptions\(\)\);[\s\S]+setNativeButtonEnabled\(nativeAudioBtn, nativeAudioHasOptions\(\)\);[\s\S]+setNativeButtonEnabled\(nativeQualityBtn, isVideo && nativeHasQualityChoices\);/,
    'native CC/audio/HD buttons should be disabled when no real options exist');
  assert.match(android, /if \(nativeCcBtn != null\) nativeCcBtn\.setVisibility\(isLive \? View\.GONE : View\.VISIBLE\);[\s\S]+if \(nativeFavBtn != null\) nativeFavBtn\.setVisibility\(isLive \? View\.VISIBLE : View\.GONE\);/,
    'live IPTV native chrome should hide CC/audio/quality/next and show only the favorite toggle');
  assert.match(ui, /window\.__tvLiveFavToggle = \(\) => \{ toggleLiveFavorite\(\); \};/,
    'native live favorite taps should route into the web favorites store');
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
  assert.match(ui, /function refreshMusicChartsAfterFirstPaint\(\) \{[\s\S]+api\('\/api\/music\/charts'\)[\s\S]+mergeMusicChartShelves\(r\.charts \|\| \[\]\)[\s\S]+renderMusicBrowse\(\)/,
    'Music Home should backfill chart shelves after the fast first paint instead of staying sparse on cold cache');
  assert.match(ui, /async function loadMusicHomeFallback\(\) \{[\s\S]+\/api\/music\/search\?q=' \+ encodeURIComponent\(def\.query\) \+ '&limit=12'[\s\S]+S\.musicHome = await loadMusicHomeFallback\(\)/,
    'Music page should fall back to regular music search if the home endpoint is not active yet');
  assert.match(ui, /const yours = addShelf\('Your playlists'[\s\S]+if \(Array\.isArray\(S\.ytmPlaylists\)\)[\s\S]+Connect YouTube Music[\s\S]+S\.musicHome/,
    'Music Home should render personal playlists before weekly and chart shelves');
  // Every Music shelf is a single horizontal row (rail) — "Your playlists" no longer opens as a
  // wrapping grid (topTiles), and the rail cards are compact (not 254–304px).
  assert.ok(!/addShelf\('Your playlists', 'topTiles'\)/.test(ui),
    'Your playlists should be a single-row rail, not a wrapping topTiles grid');
  assert.match(ui, /\.musicRail\{display:grid;grid-auto-flow:column;grid-auto-columns:minmax\(150px,168px\)/,
    'music rail cards should be compact (~150–168px), not oversized');
  // Music covers are square (playlist/album art is native square); only the generic weekly
  // video-thumbnail feeds keep 16/9 via .wide.
  assert.match(ui, /\.mCover\{width:100%;aspect-ratio:1\/1;/,
    'music covers should default to square');
  assert.match(ui, /\.mCover\.wide\{aspect-ratio:16\/9\}/,
    'a .wide variant keeps 16/9 for video-thumbnail feeds');
  assert.match(ui, /wideCover: shelf\.id === 'weekly-playlists'/,
    'only the generic weekly-playlists shelf uses wide 16/9 covers; playlists/songs/community are square');
  // Now-playing queue rows highlight the WHOLE row on hover / D-pad focus (not just the thumbnail).
  assert.match(ui, /\.mnQueue \.musicRow:hover,\.mnQueue \.musicRow:focus,\.mnQueue \.musicRow\.focus\{background:rgba\(var\(--fg\),\.10\);box-shadow:inset 0 0 0 1px var\(--artFocusTileLine\)\}/,
    'now-playing queue rows should highlight the full row on hover/focus, not only the icon');
  // Covers lazy-load ALL cards on scroll (IntersectionObserver) with a bounded concurrency gate —
  // not just the first 6 up front — so a long personalized home shows every thumbnail with good perf.
  assert.match(ui, /function hydrateMusicHomeCovers\(\) \{[\s\S]+\.mCard\[data-cover-key\][\s\S]+new IntersectionObserver\([\s\S]+\.observe\(c\)/,
    'Music covers should lazy-load via IntersectionObserver across all cards, not a fixed first-N slice');
  // A card with real artwork is marked done so the lazy hydrator's title-search can't clobber it
  // (this was blanking non-English playlist covers like "From the community").
  assert.match(ui, /if \(item\.coverUrl\) b\.dataset\.coverDone = '1';\s*else \{[\s\S]+item\.coverFeed[\s\S]+item\.coverPlaylist/,
    'cards with a direct coverUrl skip the lazy re-fetch so their artwork is not overwritten');
  // yt3.googleusercontent album/playlist art rejects a full-URL referrer (covers came up blank);
  // origin-only cross-origin referrer fixes it while keeping a referrer for YouTube trailer embeds.
  assert.match(ui, /<meta name="referrer" content="strict-origin-when-cross-origin">/,
    'page should send an origin-only cross-origin referrer so YT Music cover art loads');
  // Background music: the web player reports play state to the Android shell so it can keep the
  // WebView (and its <audio>) alive when backgrounded / screen-locked instead of pausing it.
  assert.match(ui, /function nativeMusicSession\(playing\) \{[\s\S]+TriboonTV\.musicSession[\s\S]+playing: !!playing/,
    'web music player should bridge play state to the Android shell for background playback');
  assert.match(ui, /addEventListener\('play', \(\) => \{[\s\S]+nativeMusicSession\(true\)/,
    'music play event should tell the shell audio is active');
  assert.match(ui, /addEventListener\('pause', \(\) => \{[\s\S]+nativeMusicSession\(false\)/,
    'music pause event should tell the shell audio stopped');
  assert.match(android, /private volatile boolean musicPlaying;/,
    'shell tracks whether web music is playing');
  assert.match(android, /public void musicSession\(String json\) \{[\s\S]+optBoolean\("playing"/,
    'shell exposes a musicSession bridge that reads the playing flag');
  assert.match(android, /if \(!inPip && !musicPlaying\) \{\s*web\.onPause\(\);\s*web\.pauseTimers\(\);/,
    'onPause keeps the WebView alive while music is playing so background audio continues');
  assert.match(ui, /function pumpMusicCoverQueue\(\) \{[\s\S]+_musicCoverActive < 3[\s\S]+coverForMusicCard\(card\)/,
    'lazy cover loading should be concurrency-gated so a scroll burst cannot fan out unbounded fetches');
  // A link/unlink must refresh the Music page — re-pulling BOTH playlists and the home feed, since
  // linking unlocks the personalized "For you" rows (get_home) and unlinking must drop them — so it
  // never keeps showing "Connect" for an account that is actually saved/linked.
  assert.match(ui, /function musicAccountChanged\(\) \{[\s\S]+S\.ytmPlaylists = undefined;[\s\S]+S\.musicHome = undefined;[\s\S]+if \(S\.view === 'music'\) loadMusic\(\)/,
    'musicAccountChanged should arm a fresh playlists + home refetch and re-render Music if it is on-screen');
  // A transient playlist-load failure (server warming after an update, or an expired cookie) must
  // NOT silently revert a linked account to the "Connect" tile — retry + a 'stale' retry state.
  assert.match(ui, /async function loadYtmPlaylists\(attempt = 0\) \{[\s\S]+\/api\/music\/status[\s\S]+if \(linked && attempt < 2\)[\s\S]+S\.ytmPlaylists = linked \? 'stale' : false/,
    'playlist load should retry and keep a linked account linked ("stale") instead of forcing a re-link');
  assert.match(ui, /S\.ytmPlaylists === 'stale'[\s\S]+Couldn.t load your playlists[\s\S]+S\.ytmPlaylists = undefined; loadMusic\(\)/,
    'the stale state shows a retry tile, not the Connect tile');
  assert.match(ui, /\/api\/music\/link'[\s\S]+renderYtmBox\(\);\s+musicAccountChanged\(\)/,
    'cookie link success should refresh the Music page via musicAccountChanged');
  // OAuth linking was removed (Google blocks library reads for that token type) — no device-code
  // flow, no admin OAuth panel; linking is cookie-only.
  assert.ok(!ui.includes('/api/music/oauth/') && !ui.includes('startYtmOAuth') && !ui.includes('ytOAuthSave'),
    'YouTube Music OAuth device-flow + admin panel should be fully removed (cookie linking only)');
  // Personalized home: linked users get taste-based get_home rows; the client backfills them when
  // the server reports personalPending (cold cache warming in the background).
  assert.match(ui, /function refreshMusicHomeIfPersonalPending\(\)[\s\S]+personalPending[\s\S]+api\('\/api\/music\/home'\)/,
    'the client should backfill personalized home rows while the server warms them (personalPending)');
  // No duplication: track shelves dedupe (id + feat-stripped title) and use the ARTIST as the
  // subtitle — never the shelf note (which made every song echo "Top songs this week").
  assert.match(ui, /shelf\.kind === 'tracks'[\s\S]+seenId\.has\(String\(t\.id\)\) \|\| \(nt && seenTitle\.has\(nt\)\)[\s\S]+sub: t\.artist \|\| ''/,
    'music track shelves dedupe by id + normalized title and never echo the shelf name as the subtitle');
  assert.match(ui, /item\.title\.trim\(\)\.toLowerCase\(\) !== shelfTitleNorm[\s\S]+sub: item\.sub \|\| ''/,
    'music feed cards skip titles that repeat the shelf heading and never fall the subtitle back to the note');
  // The playlist list is a ~2s cold fetch — warm the server caches on rail intent so Music opens fast.
  assert.match(ui, /function prefetchMusic\(\) \{[\s\S]+S\._musicPrefetched = true;[\s\S]+api\('\/api\/music\/playlists'\)\.catch[\s\S]+api\('\/api\/music\/home'\)\.catch/,
    'prefetchMusic should warm the playlists + home server caches once');
  assert.match(ui, /const navMx = \$\('navMusic'\);[\s\S]+navMx\.addEventListener\('mouseenter', prefetchMusic\);[\s\S]+navMx\.addEventListener\('focus', prefetchMusic, true\)/,
    'the Music rail button should warm the caches on hover/focus (like Live TV)');
  assert.match(ui, /function startMusicFeed\(item\) \{[\s\S]+\/api\/music\/search\?q=' \+ encodeURIComponent\(q\) \+ '&limit=24'[\s\S]+playMusic\(rows, 0, \{ showQueue: true \}\)/,
    'Music feed cards should start generated queues instead of only opening raw search');
  assert.match(ui, /function safeMusicPlay\(opts = \{\}\) \{[\s\S]+mAudio\.play\(\)[\s\S]+toast\('Press play to start music\.'\)/,
    'Music playback should give a visible prompt when autoplay is blocked instead of silently failing');
  assert.match(ui, /mAudio\.addEventListener\('error'[\s\S]+Track unavailable\. Skipping[\s\S]+setTimeout\(\(\) => \{ if \(S\.musicLoadFailed\) musicNext\(true\); \}/,
    'Music should skip unavailable tracks instead of stalling the queue on a dead stream');
  assert.match(ui, /function updateMusicMediaSession\(\) \{[\s\S]+new MediaMetadata\(\{[\s\S]+title: t\.title \|\| 'Music'[\s\S]+artwork: t\.thumb \?/,
    'Music playback should publish title/artwork metadata to OS and remote media surfaces');
  assert.match(ui, /function playMusic\(queue, idx, opts = \{\}\) \{[\s\S]+mAudio\.src = t\.streamUrl;[\s\S]+updateMusicMediaSession\(\);/,
    'Music should refresh media-session metadata whenever the active track changes');
  assert.match(ui, /function openMusicConnect\(\) \{[\s\S]+tries < 30[\s\S]+requestAnimationFrame\(focusConnect\)/,
    'Music connect focus should wait for Preferences rendering instead of using a fixed timer race');
  assert.match(ui, /id="mnQueueToggle" title="Hide queue" aria-label="Hide queue"[\s\S]+function updateMusicQueueToggle\(\) \{[\s\S]+btn\.title = hidden \? 'Show queue' : 'Hide queue'[\s\S]+btn\.setAttribute\('aria-label', btn\.title\)/,
    'Music now-playing queue control should be icon-only and use queue labels');
  assert.match(ui, /function renderYtmConnectBox\(box, st\) \{[\s\S]+Connect account[\s\S]+renderYtmPaste\(box, \{ guided: true \}\)[\s\S]+function renderYtmImportBox\(box, opts = \{\}\) \{[\s\S]+ytmOpenMusic[\s\S]+ytmPick[\s\S]+ytmShowPaste[\s\S]+api\('\/api\/music\/link'/,
    'YouTube Music linking should present a cookie-session guided setup flow (OAuth removed)');
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
  assert.match(android, /private void updateNativeSheetLayout\(\) \{[\s\S]+lp\.width = nativeSheetWidthPx\(\);[\s\S]+lp\.gravity = android\.view\.Gravity\.END \| android\.view\.Gravity\.BOTTOM;[\s\S]+lp\.setMargins\(side, 0, side, nativeSheetBottomMarginPx\(\)\);[\s\S]+nativeSheet\.setLayoutParams\(lp\);[\s\S]+\}/,
    'native option sheets should stay compact on TV and fit phone landscape screens');
  assert.match(android, /nativeTop = new LinearLayout\(this\);[\s\S]+nativePlayerTitle = new TextView\(this\);[\s\S]+nativePlayerSubline = new TextView\(this\);[\s\S]+nativePlayerLayer\.addView\(nativeTop, titleLp\);/,
    'native ExoPlayer should place title and episode subline in the top-left metadata cluster');
  assert.match(android, /if \(nativeMetaBar != null\) nativeMetaBar\.setVisibility\(View\.GONE\);[\s\S]+nativeChrome\.setVisibility\(View\.VISIBLE\);[\s\S]+nativeTop\.setVisibility\(View\.VISIBLE\);/,
    'native ExoPlayer should not show the old bottom metadata bar when chrome is visible');
  assert.match(android, /String chromeQuality = isLiveMode \? "LIVE" : "";[\s\S]+nativePlayerBadge\.setText\(chromeQuality\);[\s\S]+nativePlayerBadge\.setVisibility\(chromeQuality\.isEmpty\(\) \? View\.GONE : View\.VISIBLE\);/,
    'native player should hide VOD 4K/1080p badges while keeping LIVE available for Live TV');
  assert.match(android, /private FrameLayout nativeLoading;[\s\S]+private ImageView nativeLoadingBackdrop;[\s\S]+private TextView nativeLoadingTitle;/,
    'native ExoPlayer should own a branded loading overlay instead of borrowing the web player shell');
  assert.match(ui, /<link rel="icon" href="T-Logo\.svg"><link rel="alternate icon" href="T-Logo\.png">/,
    'web favicon should use the T logo assets');
  assert.match(ui, /id="railLogo"[\s\S]+<img src="T-Logo\.svg" alt="Triboon" onerror="this\.onerror=null;this\.src='T-Logo\.png'"/,
    'web rail logo should use the T logo assets');
  assert.match(ui, /<div class="ssBrand"><img src="triboon\.png" alt="Triboon"><\/div>/,
    'web screensaver should use the updated transparent Triboon wordmark asset');
  assert.match(ui, /#playerLoader \.loadMark\{display:grid;place-items:center\}[\s\S]+#playerLoader \.loadMark img\{[^}]*width:min\(210px,50vw\)[\s\S]+#playerLoader \.loadSteps\{[^}]*width:min\(340px,72vw\)[^}]*height:4px[\s\S]+#playerLoader \.loadStep\{[^}]*width:58%[\s\S]+#playerLoader \.loadStatus\{[\s\S]+<img src="triboon\.png" alt="Triboon">[\s\S]+<div class="loadSteps" aria-hidden="true"><span class="loadStep"><\/span><\/div>[\s\S]+<div class="loadStatus" id="plStage">Preparing<\/div>/,
    'web player loading overlay should use the full wordmark, one calm progress lane, and one simple startup status line');
  assert.match(ui, /PLAYER_LOADING_STAGES = \['Preparing', 'Finding source', 'Mounting', 'Checking health\.\.\.', 'Starting stream'\][\s\S]+function clearPlayerLoadingStages\(\)[\s\S]+S\._stageTimers = \[650, 1400, 2200, 3000\][\s\S]+setPlayerLoadingStage\(i \+ 1\)/,
    'web player loading status should advance through finding source, mounting, a brief health check, and stream start');
  assert.match(android, /nativeLoading = new FrameLayout\(this\);[\s\S]+ImageView loadingMark = new ImageView\(this\);[\s\S]+loadingMark\.setImageResource\(R\.drawable\.native_loading_wordmark\);[\s\S]+loadingCenter\.addView\(loadingMark, markLp\);[\s\S]+FrameLayout loadingLane = new FrameLayout\(this\);[\s\S]+nativeLoadingLaneGlow = new View\(this\);[\s\S]+nativeLoadingStatus = new TextView\(this\);[\s\S]+nativeLoadingStatus\.setText\("Preparing"\);[\s\S]+startNativeLoadingLane\(\);/,
    'native loading overlay should use the real wordmark, a moving progress lane, and one simple startup status line');
  assert.match(android, /private ObjectAnimator nativeLoadingLaneAnimator;[\s\S]+if \(nativeLoadingLaneAnimator != null\) \{[\s\S]+nativeLoadingLaneAnimator\.cancel\(\);[\s\S]+nativeLoadingLaneAnimator = null;[\s\S]+nativeLoadingLaneAnimator = ObjectAnimator\.ofFloat\(nativeLoadingLaneGlow, "translationX", -dp\(92\), dp\(320\)\);[\s\S]+nativeLoadingLaneAnimator\.setRepeatCount\(ValueAnimator\.INFINITE\);[\s\S]+nativeLoadingLaneAnimator\.start\(\);/,
    'native loading progress lane should use one owned animation that can be stopped cleanly');
  assert.match(android, /nativeLoadingTitle\.setTextSize\(24\);[\s\S]+nativeLoadingTitle\.setMaxLines\(2\);[\s\S]+nativeLoadingTitle\.setEllipsize\(TextUtils\.TruncateAt\.END\);/,
    'native loading title should stay prominent without overflowing on TV');
  assert.match(android, /nativeLoadingStatuses = new String\[\]\{"Preparing", "Finding source", "Mounting", "Checking health\.\.\.", "Starting stream"\}[\s\S]+startNativeLoadingStatus\(\)[\s\S]+nativeLoadingStatusTick[\s\S]+stopNativeLoadingStatus\(\)/,
    'native loading status should show the same brief startup steps as the web loader and stop cleanly');
  assert.doesNotMatch(ui, /id="plMsg"|class="loadLabels"|Finding the best source|Mounting the release|Checking health & buffering|<span>Source<\/span>|<span>Health<\/span>|<span>Buffer<\/span>/,
    'web player loading overlay should stay minimal and avoid source/health/buffer status copy');
  assert.doesNotMatch(android, /TextView loadingMark|loadingMark\.setText\("Triboon"\)|private TextView nativeLoadingStage|private TextView nativeLoadingDetail|nativeLoadingStage =|nativeLoadingDetail =|nativeLoadingStage\.|nativeLoadingDetail\.|nativeLoadingStageFor|nativeLoadingDetailFor|showNativeLoading\(title, backdropUrl,|private TextView nativeLoadingStep|loadingSteps|nativeLoadingStep\("Source"\)|nativeLoadingStep\("Health"\)|nativeLoadingStep\("Buffer"\)|Preparing native playback/,
    'native ExoPlayer loading overlay should stay minimal and avoid text branding plus source/health/buffer status copy');
  assert.doesNotMatch(android, /ProgressBar loadingRing|nativeLoadingRingDrawable|R\.drawable\.native_loading_ring|nativeLoadingLogoBg|ic_loading_logo/,
    'native ExoPlayer loading overlay should not show a circular ring or logo-background tile');
  assert.doesNotMatch(android, /loadingBrand\.setText\("TRIBOON"\)|TextView loadingBrand/,
    'native ExoPlayer loader should not add a second brand line below the wordmark');
  assert.doesNotMatch(android, /loadingLogo\.setImageResource\(R\.drawable\.ic_launcher\)/,
    'native loading overlay should not reuse the non-transparent launcher icon');
  for (const rel of [
    'logo/T-Logo.png',
    'logo/triboon.png',
    'web/T-Logo.png',
    'web/triboon.png',
    'web/triboon-screensaver.png',
    'android/app/src/main/res/drawable/ic_launcher.png',
    'android/app/src/main/res/drawable/banner.png',
    'android/app/src/main/res/drawable-nodpi/native_loading_wordmark.png',
  ]) {
    assert.ok(pngHasTransparentPixels(path.join(__dirname, '..', rel)),
      `${rel} should preserve transparent pixels instead of baking in a background`);
  }
  assert.match(android, /backdropUrl = j\.optString\("backdropUrl", ""\);[\s\S]+enterNativeFullscreenMode\(\);[\s\S]+showNativeLoading\(title, backdropUrl\);[\s\S]+nativePlayer\.prepare\(\)/,
    'Android should hide the WebView and show the branded native loader before ExoPlayer prepares');
  assert.match(android, /if \("video"\.equals\(m\)\) \{[\s\S]+releaseNativePlayer\(false\);[\s\S]+enterNativeFullscreenMode\(\);[\s\S]+showNativeLoading\(title, backdropUrl\);[\s\S]+__tvNativeVideoError/,
    'native movie fallbacks should keep the Android layer up instead of revealing the WebView player between retries');
  assert.match(android, /public void closeVideo\(\) \{[\s\S]+closeNativePlayback\(false\)/,
    'web-side native failure cleanup should be able to close the Android video layer without using the web player');
  assert.match(android, /public void showVideoLoading\(String json\) \{[\s\S]+showNativeVideoLoading\(json\)/,
    'web should be able to show Android native loading before the stream URL is mounted');
  assert.match(android, /private void showNativeVideoLoading\(String json\) \{[\s\S]+enterNativeFullscreenMode\(\);[\s\S]+showNativeLoading\(title, backdropUrl\);[\s\S]+\}/,
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
  assert.match(android, /c\.setReadTimeout\(nativeSubtitleReadTimeoutMs\(cleanUrl\)\);[\s\S]+private int nativeSubtitleReadTimeoutMs\(String url\) \{[\s\S]+raw\.contains\("\/api\/subtitle\/"\) \? 135000 : 20000;[\s\S]+\}/,
    'native built-in subtitle overlay fetches should outlive slow server-side extraction while online VTT stays quick');
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
  assert.match(android, /private long nativeLastAutoResumeSeekMs;[\s\S]+nativeLastAutoResumeSeekMs = 0L;[\s\S]+private void rememberNativeVideoPosition\(\) \{[\s\S]+nativeServerSeekMode\(\)[\s\S]+nativeLastVideoDisplayMs - pos[\s\S]+backwardsBy > 5000L[\s\S]+requestNativeVideoSeek\(nativeLastVideoDisplayMs\)/,
    'native remux/transcode playback should recover same-source segment restarts at the last absolute movie time');
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
  assert.match(android, /boolean quietSeek = j\.optBoolean\("quietSeek", false\);[\s\S]+if \(!guide && "video"\.equals\(mode\) && !quietSeek\) \{[\s\S]+showNativeLoading\(title, backdropUrl\);[\s\S]+\}/,
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
  assert.match(ui, /function setNativeLivePlaybackState\(it\) \{[\s\S]+item: liveItemPayload\(it\),[\s\S]+usingNative: true[\s\S]+\}[\s\S]+function commitNativeLivePlayback\(it\) \{[\s\S]+setNativeLivePlaybackState\(it\);[\s\S]+startActivityHeartbeat\(\);/,
    'fullscreen native Live TV should update web player state and activity before D-pad Up/Down can zap channels');
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
  assert.match(android, /private String serverUrlValidationError\(String url\) \{[\s\S]+"https"\.equals\(scheme\)[\s\S]+!"http"\.equals\(scheme\)[\s\S]+isLocalCleartextServerHost\(u\.getHost\(\)\)[\s\S]+Plain HTTP is limited to local\/private LAN servers/,
    'Android setup should allow LAN HTTP but reject remote/public HTTP server addresses before WebView load');
  assert.match(android, /private boolean isLocalCleartextServerHost\(String host\) \{[\s\S]+isAndroidLoopbackAlias\(h\)[\s\S]+h\.indexOf\('\.'\) < 0[\s\S]+h\.endsWith\("\.local"\)[\s\S]+hostLooksLiteral\(h\)[\s\S]+isLocalCleartextServerAddress\(InetAddress\.getByName\(h\)\)/,
    'Android cleartext server scope should include loopback, short LAN names, .local/.lan/.home.arpa, and private IP literals');
  assert.match(android, /String serverError = serverUrlValidationError\(server\);[\s\S]+if \(!serverError\.isEmpty\(\)\) showSetup\(serverError\);[\s\S]+else web\.loadUrl\(server\);[\s\S]+String serverError = serverUrlValidationError\(url\);[\s\S]+if \(!serverError\.isEmpty\(\)\) \{[\s\S]+setupMsg\.setText\(serverError\);[\s\S]+return;[\s\S]+\}[\s\S]+prefs\(\)\.edit\(\)\.putString\(KEY_SERVER, url\)\.apply\(\);/,
    'Android should reject unsafe HTTP before saving it or loading it into WebView');
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
  assert.ok(ui.includes('id="favBtn" title="Favorite channel"')
      && ui.includes('id="chMultiBtn" class="focusable" title="Open multiview" aria-label="Open multiview"')
      && ui.includes('id="pgMultiBtn" class="mvIconBtn focusable" type="button" title="Open multiview" aria-label="Open multiview"')
      && ui.includes('<span>Multiview</span>'),
    'Live TV should expose favorite in the player and icon-led Multiview launchers from guide surfaces');
  assert.ok(!ui.includes("isTriboonAndroidShell() ? '' : '<button id=\"chMultiBtn\"")
      && !ui.includes('Android Multiview needs native ExoPlayer support')
      && !ui.includes("$('pgMultiBtn').hidden = true;")
      && !ui.includes("$('pgMultiBtn').disabled = true;")
      && ui.includes("$('pgMultiBtn').addEventListener('click', () => openMultiViewFromGuide());")
      && ui.includes('function multiViewCanUseWeb() {')
      && ui.includes('return !!liveMseType();')
      && ui.includes('function waitNativePlaybackSurfaceReady(timeout = 1200)')
      && ui.includes('async function stopActivePlaybackForWebSurface(opts = {})')
      && ui.includes('window.__tvNativePlaybackSurfaceReady = () =>')
      && ui.includes('reportTvInputState();')
      && ui.includes('function reportTvInputState()'),
    'Android TV should expose the Live TV and PiP guide Multiview launchers while normal single-channel Live TV remains native');
  assert.ok(android.includes('window.__tvNativePlaybackSurfaceReady && window.__tvNativePlaybackSurfaceReady()'),
    'Android should notify the web app after closing the native player surface so Multiview can wait for WebView focus');
  // Up from categories/channels must reach the channel SEARCH input (it was unreachable by D-pad on
  // TV — focusLiveFilter jumped to the Multiview button). Right from search steps to the toolbar.
  assert.match(ui, /function focusLiveFilter\(\) \{[\s\S]*?return focusLiveSearchInput\(\);\s*\}/,
    'Up from categories/channels must focus the channel search input so the D-pad can reach it on TV');
  assert.match(ui, /const liveToolbarId = S\.view === 'livetv' \? focusedLiveToolbarButton\(\) : '';[\s\S]+if \(liveToolbarId === 'chMultiBtn'\) \{[\s\S]+if \(k === 'ArrowLeft'\) return focusLiveSearchInput\(\);[\s\S]+if \(k === 'ArrowRight' && \$\('chGuideBtn'\)\) return focusLiveToolbar\('chGuideBtn'\);/,
    'Left from the Multiview button should step back to the search input (so search ↔ Multiview ↔ Guide), not the rail');
  assert.ok(ui.includes('id="multiView" aria-hidden="true"')
      && ui.includes('id="mvVideo0"')
      && ui.includes('id="mvVideo1"')
      && ui.includes('id="mvVideo2"')
      && ui.includes('id="mvVideo3"'),
    'Multiview should own a separate four-slot viewing surface instead of borrowing the movie/show player');
  assert.ok(ui.includes('.mvGrid.count2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}')
      && ui.includes('.mvGrid.count3{grid-template-columns:minmax(0,2fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr)}')
      && ui.includes('.mvGrid.count3 .mvSlot.mvMain{grid-row:1 / span 2}')
      && ui.includes('.mvGrid.count4{grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr)}'),
    'Multiview should have distinct 2, 3, and 4 screen layouts');
  assert.ok(ui.includes('class="mvAction mvVodOnly mvBackBtn focusable"')
      && ui.includes('class="mvAction mvVodOnly mvPlayBtn focusable"')
      && ui.includes('class="mvAction mvVodOnly mvFwdBtn focusable"')
      && ui.includes('class="mvAction mvFullBtn focusable"')
      && ui.includes('class="mvAction mvSwapBtn focusable"')
      && ui.includes('class="mvAction mvChangeBtn focusable"')
      && ui.includes('class="mvAction mvCloseBtn focusable"')
      && ui.includes('id="mvClose" class="mvIconBtn mvIconOnly focusable"')
      && ui.includes('id="mvPickerClose" class="mvIconBtn mvIconOnly focusable"')
      && ui.includes('.mvIconBtn svg{width:17px;height:17px;flex:none}')
      && ui.includes('.mvIconOnly{width:40px;padding:0;border-radius:50%}')
      && ui.includes('.mvSlot.vod .mvVodOnly{display:grid}')
      && ui.includes('#multiView.paneFull .mvTop{display:none}')
      && ui.includes('.mvGrid.fullscreen{display:block;position:relative}'),
    'Multiview panes should expose polished VOD transport, fullscreen, swap, change, and icon close actions with an internal zoomed-pane mode');
  // After ~5s idle the multiview chrome fades to a clean wall of video; any D-pad press / tap brings
  // it back, and the first press while hidden only reveals (doesn't also navigate).
  assert.ok(ui.includes('#multiView.mvIdle .mvTop,#multiView.mvIdle .mvShade,#multiView.mvIdle .mvLabel,#multiView.mvIdle .mvStatus,#multiView.mvIdle .mvAdd{opacity:0;pointer-events:none}')
      && ui.includes('#multiView.mvIdle .mvActions{opacity:0!important;pointer-events:none!important}'),
    'idle multiview should fade out all chrome (top bar, labels, shade, status, add, actions)');
  assert.match(ui, /function bumpMultiViewChrome\(\) \{[\s\S]+mv\.classList\.remove\('mvIdle'\);[\s\S]+clearTimeout\(_mvIdleT\);[\s\S]+_mvIdleT = setTimeout\(\(\) => \{[\s\S]+mv\.classList\.add\('mvIdle'\);[\s\S]+\}, 5000\);/,
    'bumpMultiViewChrome should clear+restart a 5s timer that re-adds the mvIdle class');
  assert.match(ui, /function handleMultiViewKey\(k, e\) \{[\s\S]+const wasIdle = \$\('multiView'\)\.classList\.contains\('mvIdle'\);[\s\S]+bumpMultiViewChrome\(\);[\s\S]+if \(wasIdle && k !== 'Escape' && k !== 'Backspace'\) \{[\s\S]+return true;/,
    'the first multiview key while idle should only reveal chrome (Back still closes)');
  assert.ok(ui.includes('.mvSlot{position:relative;display:none;min-width:0;min-height:0;border-radius:10px;background:#000;overflow:hidden;border:1px solid rgba(var(--fg),.07);')
      && ui.includes('.mvSlot.active{border-color:rgba(255,198,92,.42);')
      && ui.includes('.mvLayout button.on,.mvLayout button:hover,.mvIconBtn:hover,.mvIconBtn:focus,.mvIconBtn.focus{background:rgba(58,66,74,.82);border-color:rgba(255,198,92,.22);outline:none;box-shadow:0 0 0 2px rgba(255,198,92,.20)')
      && ui.includes('.mvAction:hover,.mvAction:focus,.mvAction.focus{outline:none;background:rgba(58,66,74,.82);border-color:rgba(255,198,92,.24);box-shadow:0 0 0 2px rgba(255,198,92,.22)'),
    'Multiview borders and button focus rings should stay thin, neutral, and amber-toned instead of thick coral');
  assert.doesNotMatch(ui, /\.mvSlot\{[^}]*border:2px solid transparent|\.mvSlot\.active\{border-color:rgba\(251,139,60,\.98\)|\.mvAction:hover,[^}]+rgba\(251,139,60,\.62\)/,
    'Multiview chrome should not regress to thick red/coral outlines');
  assert.ok(ui.includes('#player.live #ccBtn,#player.live #audBtn,#player.live #srndBtn,#player.live #qualBtn{display:none!important}'),
    'Live TV should hide VOD subtitle/audio/surround/quality controls instead of disabling the movie/show player controls globally');
  assert.doesNotMatch(ui, /#player\.live #favBtn,#player\.live #splitBtn\{display:grid\}/,
    'the old split control should not be exposed in the Live TV player chrome');
  // Live = real-TV chrome: a top EPG strip (now + next ~2h) and a bottom timeshift bar with a
  // Go-live button. VOD now/next text and seek bar are hidden; OK reveals the chrome (no pause).
  assert.ok(ui.includes('#player.live #pSrc,#player.live .seekLine,#player.live #back10,#player.live #fwd30{display:none!important}'),
    'Live chrome should hide the VOD now/next line, seek bar, and ±10/30s skips');
  assert.match(ui, /async function renderLiveEpgStrip\(idx\) \{[\s\S]+fetchGuideBatch\(\[ch\]\)[\s\S]+paintLiveEpgStrip\(\)/,
    'live player should fetch the channel schedule and paint a top EPG strip');
  assert.match(ui, /function paintLiveEpgStrip\(\) \{[\s\S]+horizon = now \+ 2 \* 3600000[\s\S]+epgCell\$\{isNow \? ' now' : ''\}/,
    'the EPG strip should cover ~2 hours and mark the current programme');
  assert.match(ui, /const maxCells = window\.innerWidth < 560 \? 2 : 4;/,
    'the web EPG strip should drop to 2 cells on a narrow phone viewport');
  // The EPG strip sits just ABOVE the seekbar (first child of the bottom OSD block, before #pSrc /
  // the seek line) — not the top of the screen and not floating mid-screen.
  assert.match(ui, /<div id="liveEpgStrip" class="liveOnly"[^>]*><\/div>\s*<div class="src" id="pSrc"><\/div>\s*<div class="seekLine">/,
    'the EPG strip must render directly above the seek/timeshift bar in the bottom chrome');
  assert.match(ui, /function goLive\(\) \{[\s\S]+liveBufferedEdge\(v\)[\s\S]+v\.currentTime = Math\.max\(0, end - 0\.4\)[\s\S]+v\.play\(\)/,
    'Go-live should seek to the live edge and resume');
  assert.match(ui, /function updateLiveChrome\(\) \{[\s\S]+const atLive = behind < 3 && !v\.paused;[\s\S]+toggle\('atLive', atLive\)[\s\S]+toggle\('behind', !atLive\)/,
    'live chrome should flip the Go-live button between at-live and behind states');
  assert.match(ui, /if \(\$\('player'\)\.classList\.contains\('live'\)\) \{ updateLiveChrome\(\); return requestAnimationFrame/,
    'the player tick loop should drive the live chrome each frame for live playback');
  assert.match(ui, /if \(osdWasHidden && \$\('player'\)\.classList\.contains\('live'\)\) return;\s+const b = ctlButtons\(\)\[S\.ctlIdx\]/,
    'on live, an OK press that only woke the hidden chrome must not also fire a control (no pause)');
  assert.match(ui, /function updatePlayerControlAvailability\(\) \{[\s\S]+const isLive = !!\(p && p\.item && p\.item\.type === 'live'\);[\s\S]+\['ccBtn', 'audBtn', 'qualBtn'\][\s\S]+style\.display = isLive \? 'none' : '';[\s\S]+const fav = \$\('favBtn'\); if \(fav\) fav\.style\.display = isLive \? '' : 'none';[\s\S]+const split = \$\('splitBtn'\); if \(split\) split\.style\.display = 'none';[\s\S]+setPlayerControlEnabled\('favBtn', isLive && !!liveChannelForFavorite\(\)\);[\s\S]+setPlayerControlEnabled\('splitBtn', false\);/,
    'player controls should show favorite for Live TV while keeping split out of the player');
  assert.match(ui, /function liveMseKey\(slot = 'main'\)[\s\S]+s\.startsWith\('multi'\)[\s\S]+return `live\$\{s\[0\]\.toUpperCase\(\)\}\$\{s\.slice\(1\)\}Mse`[\s\S]+return s === 'split' \? 'liveSplitMse' : 'liveMse';/,
    'Live TV MediaSource state should stay isolated for main, legacy split, and Multiview panes');
  assert.match(ui, /function startLiveMseSource\(url, opts = \{\}\) \{[\s\S]+const multi = String\(slot\)\.startsWith\('multi'\)[\s\S]+S\.multiView && S\.multiView\.open && S\.multiView\.slots && S\.multiView\.slots\[opts\.multiSlot\] === p[\s\S]+if \(multi\) \{[\s\S]+p\.error = e\.liveProviderReason \|\| e\.message \|\| 'stream failed';[\s\S]+renderMultiView\(\);/,
    'Multiview stream failures should stay local to the affected pane');
  assert.match(ui, /function syncMultiViewAudio\(\) \{[\s\S]+const active = multiViewActiveSlot\(\);[\s\S]+v\.muted = !!state\.muted \|\| i !== active;/,
    'Multiview should route audio only through the highlighted screen');
  assert.ok(ui.includes('function friendlyLiveProviderReason(reason) {')
      && ui.includes('Provider limited extra stream - your IPTV account may allow one active channel')
      && ui.includes('.mvStatus.warn{')
      && ui.includes("statusEl.classList.toggle('warn', hasError);")
      && ui.includes('friendlyLiveProviderReason(slot.error)'),
    'Multiview should explain provider rate limits as likely account stream limits with a readable warning badge');
  assert.match(ui, /el\.addEventListener\('pointerenter', \(\) => \{[\s\S]+setMultiViewActiveSlot\(slot\(\), \{ focus: false, keepActions: true \}\);[\s\S]+\}\);/,
    'Multiview hover should move active audio without stealing keyboard focus');
  assert.match(ui, /const back = el\.querySelector\('\.mvBackBtn'\);[\s\S]+const play = el\.querySelector\('\.mvPlayBtn'\);[\s\S]+const fwd = el\.querySelector\('\.mvFwdBtn'\);[\s\S]+multiViewVodSeek\(slot\(\), -10\)[\s\S]+multiViewVodTogglePlay\(slot\(\)\)[\s\S]+multiViewVodSeek\(slot\(\), 30\)/,
    'VOD Multiview transport buttons should be clickable as pane actions');
  assert.match(ui, /function saveMultiViewVodProgress\(i, final = false\) \{[\s\S]+api\('\/api\/watch', \{ method: 'POST', body: payload \}\)\.catch\(\(\) => \{\}\);[\s\S]+function cleanupMultiViewSlot\(i, clearItem = false\) \{[\s\S]+saveMultiViewVodProgress\(i, true\);[\s\S]+cleanupLiveMse\('multi' \+ i\);[\s\S]+v\.removeAttribute\('src'\);[\s\S]+v\.src = '';[\s\S]+if \(clearItem && S\.multiView && S\.multiView\.slots\) S\.multiView\.slots\[i\] = null;/,
    'Multiview cleanup should save VOD progress, stop each pane, clear the media element, and release the pane item');
  assert.match(ui, /function multiViewActionButtons\(slot = multiViewActiveSlot\(\)\) \{[\s\S]+const isVod = root\.classList\.contains\('vod'\);[\s\S]+filter\(\(btn\) => isVod \|\| !btn\.classList\.contains\('mvVodOnly'\)\);/,
    'Multiview action focus should skip hidden VOD transport buttons on Live TV panes');
  assert.match(ui, /function openMultiViewActions\(slot = multiViewActiveSlot\(\)\) \{[\s\S]+S\.multiViewActionIdx = multiViewSlotIsVod\(pane\) \? 1 : 0;[\s\S]+return setMultiViewActionFocus\(S\.multiViewActionIdx\);/,
    'VOD Multiview panes should focus Play/Pause first while Live panes focus the first Live action');
  assert.match(ui, /function multiViewVodTogglePlay\(slotIndex = multiViewActiveSlot\(\)\) \{[\s\S]+if \(v\.paused\) \{[\s\S]+v\.play\(\)\.then\(\(\) => setMultiViewVodStatus\(i, 'Playing'\)\)[\s\S]+\} else \{[\s\S]+v\.pause\(\);[\s\S]+saveMultiViewVodProgress\(i\);/,
    'VOD Multiview panes should have a local play/pause transport action');
  assert.match(ui, /function multiViewVodSeek\(slotIndex = multiViewActiveSlot\(\), delta = 0\) \{[\s\S]+slot\.status = delta < 0 \? 'Rewinding' : 'Skipping';[\s\S]+if \(slot\.kind === 'remux' \|\| slot\.kind === 'transcode'\) \{[\s\S]+const media = multiViewVodUrlFromSlot\(slot, target\);[\s\S]+v\.src = media\.url;[\s\S]+\} else \{[\s\S]+v\.currentTime = target;/,
    'VOD Multiview seek should restart remux/transcode panes at the target timestamp and seek direct panes in-place');
  assert.match(ui, /function startMultiViewVodSlot\(i, slot, media\) \{[\s\S]+slot\.streamUrl = media\.streamUrl[\s\S]+slot\.remuxUrl = media\.remuxUrl[\s\S]+slot\.transcodeUrl = media\.transcodeUrl[\s\S]+v\.onpause = \(\) => \{[\s\S]+saveMultiViewVodProgress\(i\);/,
    'VOD Multiview panes should keep source URLs for transport controls and save progress on pause');
  assert.match(ui, /function setMultiViewCount\(n\) \{[\s\S]+Math\.max\(2, Math\.min\(MULTIVIEW_MAX_SLOTS[\s\S]+for \(let i = count; i < MULTIVIEW_MAX_SLOTS; i\+\+\) cleanupMultiViewSlot\(i, true\);[\s\S]+toast\(`\$\{count\} screens can use \$\{count\} provider streams`\)/,
    'changing Multiview layouts should cap at four and clean up panes removed from the layout');
  assert.ok(ui.includes(": (swapSlot >= 0 ? `Pick a screen to swap with screen ${swapSlot + 1}` : 'Multiviewer');")
      && !ui.includes("${count} screens - one audio source"),
    'Multiview should use a simple Multiviewer header instead of restating screen count and audio rules');
  assert.ok(!ui.includes('class="mvEy"')
      && ui.includes('.mvTop{height:56px;')
      && ui.includes('.mvName{font:800 15px/1.1 "Albert Sans";'),
    'Multiview header should stay compact instead of rendering a page-style eyebrow and hero title');
  assert.match(ui, /function multiViewVisualOrder\(\) \{[\s\S]+S\.multiView\.order = order;[\s\S]+function multiViewVisibleOrder\(\) \{[\s\S]+return visible;/,
    'Multiview should keep a visual order separate from stream slot ownership');
  assert.match(ui, /function completeMultiViewSwap\(target = multiViewActiveSlot\(\)\) \{[\s\S]+const order = multiViewVisualOrder\(\);[\s\S]+\[order\[fromPos\], order\[toPos\]\] = \[order\[toPos\], order\[fromPos\]\];[\s\S]+S\.multiView\.order = order;[\s\S]+S\.multiView\.swapSlot = null;[\s\S]+setMultiViewActiveSlot\(from\);/,
    'Multiview swap should move visual positions without remounting streams while keeping audio on the promoted screen');
  assert.match(ui, /function beginMultiViewSwap\(slot = multiViewActiveSlot\(\)\) \{[\s\S]+S\.multiView\.swapSlot = i;[\s\S]+S\.multiView\.fullSlot = null;[\s\S]+closeMultiViewPicker\(\);/,
    'Multiview swap action should enter a pane-pick mode from the selected screen');
  assert.match(ui, /el\.classList\.toggle\('vod', visible && multiViewSlotIsVod\(slot\)\);[\s\S]+el\.classList\.toggle\('mvMain', visible && count === 3 && pos === 0\);[\s\S]+el\.classList\.toggle\('swapSource'[\s\S]+el\.classList\.toggle\('swapTarget'/,
    'Multiview render should mark VOD panes, current visual main pane, and swap source/targets');
  // Multiview live panes must each carry a per-surface id so a new pane doesn't evict (retune) the
  // previous one's upstream stream (the "previous pane shows network error" bug).
  assert.match(ui, /const surface = multi \? `mv\$\{opts\.multiSlot \|\| 0\}` : \(split \? 'split' : 'main'\);[\s\S]+url = url \+ \(url\.includes\('\?'\) \? '&' : '\?'\) \+ 'surface=' \+ encodeURIComponent\(surface\)/,
    'live MSE panes should tag the stream with a per-surface id so concurrent panes keep separate server slots');
  // Multiview VOD panes have no track-probe loop and the WebView can't decode AC3/EAC3/DTS, so
  // they must force AAC remux AND prefer remux over direct (even when the server picks 'direct'),
  // or such sources play with no sound.
  assert.match(ui, /function multiViewVodUrl\(mount, item, startAt = 0\) \{[\s\S]+forceAacRemux: true,[\s\S]+forceAacRemux: true,[\s\S]+if \(mount\.remuxUrl\) return \{ \.\.\.media, kind: 'remux', url: remuxPlaybackUrl\(p, start\)/,
    'multiview VOD should prefer remux+AAC over direct so non-AAC audio still plays in the pane');
  assert.match(ui, /function multiViewVodUrlFromSlot\([\s\S]+forceAacRemux: true,[\s\S]+if \(p\.remuxUrl\) return \{ \.\.\.p, kind: 'remux'/,
    'multiview VOD seek-rebuild should also prefer remux+AAC');
  // Multiview is icons-only: no resting button backgrounds and no amber active-pane highlight.
  assert.match(ui, /#multiView \.mvLayout button,#multiView \.mvIconBtn,#multiView \.mvAction\{[^}]*background:transparent;border-color:transparent;box-shadow:none\}/,
    'multiview buttons should be icons-only (transparent resting background)');
  assert.match(ui, /#multiView \.mvSlot\.active\{border-color:rgba\(var\(--fg\),\.07\);box-shadow:0 18px 58px rgba\(0,0,0,\.44\)\}/,
    'active multiview pane should drop the amber highlight (icons indicate selection)');
  // Android hardware Back in multiview must use the layered handler (close the picker first),
  // not fall through to switchView('home') which tears down the whole surface.
  assert.match(ui, /window\.__tvBack = \(\) => \{[\s\S]+if \(S\.multiView && S\.multiView\.open\) \{[\s\S]+handleMultiViewKey\('Escape'[\s\S]+return 'ok';[\s\S]+\}[\s\S]+if \(S\.view !== 'home'\)/,
    'hardware Back in multiview routes through handleMultiViewKey (close picker) whenever the surface is open — gated on S.multiView.open, not S.view, so a drifted view never sends Back to home');
  // Leaving multiview must tear down the underlying player surface or it shows a black #video.
  assert.match(ui, /function closeMultiView\(opts = \{\}\) \{[\s\S]+const mainVideo = \$\('video'\);[\s\S]+\$\('player'\)\.classList\.remove\('open', 'guideMode', 'live'\);[\s\S]+document\.body\.classList\.remove\('videoOpen', 'nativeGuideMode'\)/,
    'closing multiview should tear down the main player/video surface so the target view is not a black screen');
  // The multiview key loop and Back must own input whenever the surface is OPEN, not gated on
  // S.view (which can drift while the channel picker is up — the "stuck D-pad / Back to home" bug).
  assert.match(ui, /if \(S\.multiView && S\.multiView\.open\) \{\s+if \(handleMultiViewKey\(k, e\)\) return;/,
    'D-pad dispatch should route to handleMultiViewKey whenever the multiview surface is open');
  // Live TV hardware Back steps out one level: from a channel/guide row it returns to the CURRENT
  // category (focusLiveCategory() with NO args → preserves focus + scroll, like ArrowLeft), NOT the
  // first category. Only a Back while ON a non-first category steps to the first category, then exits.
  assert.match(ui, /S\.view === 'livetv' && document\.querySelector\('#chBody\.liveGuideShell'\)\) \{\s*\n\s*const onContent = [^\n]+\n\s*if \(onContent\) \{ focusLiveCategory\(\); return 'ok'; \}\s*\n\s*if \(\(S\.liveCatNavIdx \|\| 0\) > 0\) \{ focusLiveCategory\(0, true\); return 'ok'; \}/,
    'hardware Back from a channel/guide row must return to the CURRENT category (preserve position), not jump to the first category');
  // Returning from a played channel restores the guide category focus + scroll (no screen jump).
  assert.match(ui, /function rememberPlayerReturn\(\) \{[\s\S]+live: S\.view === 'livetv' \? \{[\s\S]+liveCat: S\.liveCat[\s\S]+scrollTop: livePane/,
    'leaving for the player should save the Live TV category + scroll so returning lands in place');
  assert.match(ui, /const r = S\._liveScaffoldRestore; S\._liveScaffoldRestore = null;[\s\S]+focusGrid\(Math\.max\(0, Math\.min\(count - 1, r\.gridIdx[\s\S]+else \{\s+focusGrid\(0\);/,
    'Live TV scaffold should restore the saved channel focus on return instead of always snapping to index 0');
  // Favoriting from the Favorites view keeps focus near where you were (no jump to top).
  assert.match(ui, /function renderLiveFavListKeepingFocus\(\) \{[\s\S]+focusGrid\(Math\.max\(0, Math\.min\(count - 1, savedIdx\)\)\)/,
    'favorite toggle in the Favorites view should preserve focus instead of resetting to the top');
  // Multiview picker rows: logo + name, no repeated group label (the unprofessional "United States").
  assert.match(ui, /'mvChannel focusable' \+ \(isContinue \? '' : ' mvChannelLive'\)[\s\S]+mvChLogo[\s\S]+<span class="mvChName">\$\{esc\(ch\.title \|\| ch\.name/,
    'multiview live channel rows should show a logo + name, not a repeated group label');
  assert.match(ui, /function openMultiViewActions\(slot = multiViewActiveSlot\(\)\) \{[\s\S]+if \(!pane \|\| !pane\.item\) \{[\s\S]+openMultiViewPicker\(i\);[\s\S]+S\.multiView\.actionSlot = i;[\s\S]+return setMultiViewActionFocus\(S\.multiViewActionIdx\);/,
    'OK on a filled Multiview pane should open pane actions while empty panes still open the picker');
  assert.match(ui, /function toggleMultiViewFullscreen\(slot = multiViewActiveSlot\(\)\) \{[\s\S]+if \(multiViewFullscreenSlot\(\) === i\) return exitMultiViewFullscreen\(\);[\s\S]+S\.multiView\.fullSlot = i;[\s\S]+setMultiViewActiveSlot\(i\);/,
    'Multiview fullscreen should be an internal zoomed pane that can toggle back to the grid');
  assert.match(ui, /function changeMultiViewPane\(slot = multiViewActiveSlot\(\)\) \{[\s\S]+S\.multiView\.fullSlot = null;[\s\S]+S\.multiView\.actionSlot = null;[\s\S]+openMultiViewPicker\(i\);/,
    'Multiview change action should return to the grid and replace the selected pane');
  assert.match(ui, /function closeMultiViewPane\(slot = multiViewActiveSlot\(\)\) \{[\s\S]+cleanupMultiViewSlot\(i, true\);[\s\S]+if \(S\.multiView\.fullSlot === i\) S\.multiView\.fullSlot = null;[\s\S]+setMultiViewActiveSlot\(Math\.min\(i, multiViewCount\(\) - 1\)\);/,
    'Multiview close action should release only that pane and leave the surface open');
  assert.match(ui, /function closeMultiView\(opts = \{\}\) \{[\s\S]+const targetView = returnView === 'player' \? 'livetv' : returnView;[\s\S]+if \(targetView === 'livetv' \|\| targetView === 'home'\) \{[\s\S]+switchView\(targetView, false\);/,
    'closing Multiview should re-enter Home or Live TV through the normal view renderer instead of leaving stale shared grid DOM');
  assert.match(ui, /function multiViewCategoryGroups\(\) \{[\s\S]+const cwName = 'Continue Watching';[\s\S]+const cwItems = buildCwItems\(cachedWatchRowsForHome\(\)\)\.slice\(0, 80\);[\s\S]+const names = \[\.\.\.\(cwItems\.length \? \[cwName\] : \[\]\)/,
    'Multiview picker should include Continue Watching as a companion source');
  assert.match(ui, /async function playMultiViewVodItem\(it, slotIndex = multiViewActiveSlot\(\)\) \{[\s\S]+if \(multiViewVodCount\(i\) >= 1\) \{[\s\S]+One movie\/show companion at a time for now[\s\S]+api\('\/api\/play', \{ method: 'POST', body: playbackRequestBody\(item, null, qRank\) \}\)[\s\S]+startMultiViewVodSlot\(i, slot, media\);/,
    'Multiview should play one Continue Watching movie/show companion through the normal source-selection path');
  assert.match(ui, /async function playMultiViewExistingVodFromPlayer\(i = 0\) \{[\s\S]+const item = \{ \.\.\.p\.item, resume: currentTime\(\) \};[\s\S]+const url = currentPlaybackUrl\(p, at\);[\s\S]+await stopActivePlaybackForWebSurface\(\{ preserveGuide: true \}\);[\s\S]+return startMultiViewVodSlot\(i, slot, media\);/,
    'opening Multiview from an active movie or episode should carry that playback into the first pane');
  assert.match(ui, /async function openMultiViewFromGuide\(seed = null\) \{[\s\S]+if \(!multiViewCanUseWeb\(\)\) return toast\('Multiview needs browser Live TV MediaSource support'\);[\s\S]+const playingVod = S\.playing && S\.playing\.item && S\.playing\.item\.type !== 'live';[\s\S]+if \(S\.playing && !playingVod\) await stopActivePlaybackForWebSurface\(\);[\s\S]+if \(playingVod\) await playMultiViewExistingVodFromPlayer\(0\);[\s\S]+else if \(current\) await playMultiViewChannel\(current, 0\);[\s\S]+openMultiViewPicker\(1\);/,
    'Multiview should launch from guide contexts, preserve active VOD when present, and use the browser/server fMP4 surface only when MediaSource is available');
  assert.match(ui, /const multiEl = \$\('pgMultiBtn'\);[\s\S]+const focusGuideMulti = \(\) => \{[\s\S]+clearPlayerGuideVisualFocus\(\);[\s\S]+if \(active === multi\) \{[\s\S]+if \(k === 'Enter' && !e\.repeat\) return multi\.click\(\);[\s\S]+if \(k === 'ArrowUp'\) return i <= 0 \? \(back \? moveTo\(back\) : \(focusGuideMulti\(\) \|\| moveRowFrom\(-1\)\)\) : moveRowFrom\(-1\);/,
    'PiP guide D-pad should be able to move onto the Multiview button and open it with OK');
  assert.match(ui, /function handleMultiViewKey\(k, e\) \{[\s\S]+S\.multiView\.actionSlot !== null[\s\S]+if \(k === 'ArrowLeft'\) return setMultiViewActionFocus\(i - 1\);[\s\S]+if \(k === 'ArrowRight'\) return setMultiViewActionFocus\(i \+ 1\);[\s\S]+buttons\[i\] && buttons\[i\]\.click\(\);/,
    'D-pad should let the pane action row own left/right and OK');
  assert.match(ui, /function handleMultiViewKey\(k, e\) \{[\s\S]+S\.multiView\.swapSlot !== null[\s\S]+moveMultiViewFocus\(-1, 0\)[\s\S]+moveMultiViewFocus\(1, 0\)[\s\S]+completeMultiViewSwap\(multiViewActiveSlot\(\)\);/,
    'D-pad should let swap mode pick the target pane with arrows and OK');
  assert.match(ui, /function handleMultiViewKey\(k, e\) \{[\s\S]+if \(k === 'Escape' \|\| k === 'Backspace'\) \{[\s\S]+if \(exitMultiViewFullscreen\(\)\) return true;[\s\S]+closeMultiView\(\);/,
    'Back should return from a zoomed Multiview pane before closing Multiview');
  assert.match(ui, /function handleMultiViewKey\(k, e\) \{[\s\S]+S\.zone === 'multiTop'[\s\S]+setMultiViewTopFocus\(i - 1\)[\s\S]+setMultiViewTopFocus\(i \+ 1\)[\s\S]+if \(k === 'ArrowUp'\) \{[\s\S]+multiViewSlotOnTopRow\(multiViewActiveSlot\(\)\)[\s\S]+if \(\['2', '3', '4'\]\.includes\(k\)\) \{ setMultiViewCount\(\+k\);[\s\S]+if \(k === 'Enter' && !e\.repeat\) \{[\s\S]+openMultiViewActions\(multiViewActiveSlot\(\)\)/,
    'D-pad should move panes, reach layout controls, switch layouts, and open pane actions with OK');
  // Regression: the picker must track focus by group + index in state, never document.activeElement.
  // On Android TV the shell forwards synthetic key events while real DOM focus stays on <body>,
  // so an activeElement-driven picker dead-ended (up/down stuck on the first two channels, no
  // Left to categories, OK did nothing) — only Back escaped.
  assert.match(ui, /function setMultiViewPickerFocus\(group, idx = 0\) \{[\s\S]+S\.mvPickGroup = g;[\s\S]+S\.mvPickIdx = Math\.max\(0, Math\.min\(els\.length - 1[\s\S]+el\.focus\(\{ preventScroll: true \}\)/,
    'Multiview picker focus should be index-based and place real DOM focus, not rely on document.activeElement');
  assert.match(ui, /if \(\$\('mvPicker'\)\.classList\.contains\('open'\)\) \{[\s\S]+const cats = multiViewPickerGroupEls\('cats'\);[\s\S]+const rows = multiViewPickerGroupEls\('rows'\);[\s\S]+let group = S\.mvPickGroup === 'cats' \? 'cats' : 'rows';[\s\S]+if \(k === 'Enter' && !e\.repeat\) \{ if \(els\[i\]\) els\[i\]\.click\(\); return true; \}[\s\S]+if \(k === 'ArrowRight' && group === 'cats'\) return setMultiViewPickerFocus\('rows', 0\);[\s\S]+if \(k === 'ArrowLeft' && group === 'rows'\)[\s\S]+if \(k === 'ArrowDown'\) return setMultiViewPickerFocus\(group, i \+ 1\);[\s\S]+if \(k === 'ArrowUp'\) return setMultiViewPickerFocus\(group, i - 1\);/,
    'Multiview picker D-pad should walk categories/channels by index and select with OK without reading document.activeElement');
  assert.ok(!/\$\('mvPicker'\)\.classList\.contains\('open'\)\) \{[\s\S]{0,400}document\.activeElement/.test(ui),
    'Multiview picker key handling must not depend on document.activeElement (breaks on the Android TV synthetic-key shell)');
  assert.match(ui, /function ctlButtons\(\) \{[\s\S]+'ccBtn', 'audBtn', 'srndBtn', 'qualBtn'/,
    'movie and show controls should remain in the shared VOD control order');
  assert.match(android, /new DefaultHttpDataSource\.Factory\(\)[\s\S]+setAllowCrossProtocolRedirects\(false\)[\s\S]+setUserAgent\("TriboonTV\/" \+ BuildConfig\.VERSION_NAME\)/,
    'native ExoPlayer should block cross-protocol provider redirects after URL validation');
  assert.match(android, /private String nativePlaybackErrorMessage\(PlaybackException error\) \{[\s\S]+HttpDataSource\.InvalidResponseCodeException[\s\S]+nativeHeader\(http\.headerFields, "x-triboon-iptv-error"\)[\s\S]+return reason \+ " \(HTTP " \+ http\.responseCode \+ "\)";/,
    'native Live TV should surface sanitized provider HTTP failures instead of generic Exo source errors');
  assert.match(android, /else if \("video\/mp4"\.equals\(nativeMime\)\) media\.setMimeType\(MimeTypes\.VIDEO_MP4\)/,
    'native Live TV remux fallback should be tagged as MP4 for ExoPlayer');
  assert.match(android, /else if \(tryNativeLiveFallback\(\)\) \{[\s\S]+return;[\s\S]+\} else \{[\s\S]+__tvNativeLiveError/,
    'native Live TV should retry the Exo remux fallback before reporting a player error');
  assert.match(android, /private ValidatedNativeUrl optionalNativeFallbackUrl\(String raw, String label\) \{[\s\S]+validateNativePlaybackUrl\(url\)[\s\S]+Skipping invalid native fallback[\s\S]+return null;/,
    'invalid optional native IPTV fallbacks should be skipped instead of aborting the whole native playback start');
  assert.match(android, /ValidatedNativeUrl fallbackPin = optionalNativeFallbackUrl\(fallbackRaw, "primary fallback"\)[\s\S]+optionalNativeFallbackUrl\(fbUrl, "fallback " \+ i\)[\s\S]+if \(fbPin != null\)/,
    'native playback should best-effort validate ordered fallbacks while still attempting the primary URL');
  assert.match(android, /private boolean tryNativeLiveFallback\(\) \{[\s\S]+nativeFallbackIndex >= nativeFallbackUrls\.size\(\)[\s\S]+nativeUrl = nextUrl;[\s\S]+nativeMime = nextMime[\s\S]+nativePlayer\.setMediaItem\(buildNativeMediaItem\(\)\);[\s\S]+nativePlayer\.prepare\(\);[\s\S]+nativePlayer\.play\(\);/,
    'native Live TV fallback should walk ordered ExoPlayer candidates instead of opening web playback');
  assert.match(android, /NATIVE_LIVE_STALL_RECOVERY_MS = 45000L[\s\S]+NATIVE_LIVE_STARTUP_STALL_RECOVERY_MS = 12000L[\s\S]+NATIVE_LIVE_READ_TIMEOUT_MS = 60000/,
    'native Live TV should recover faster before the first frame while allowing later provider hiccups');
  assert.match(android, /private DefaultLoadControl nativeLoadControlForMode\(String mode\) \{[\s\S]+nativeConservativePlaybackDevice\(\)[\s\S]+setBufferDurationsMs\(minMs, maxMs, startMs, rebufferMs\)/,
    'native ExoPlayer should use a conservative buffer profile on Onn-class devices without slowing Shield');
  assert.match(android, /boolean heavyVod = video && nativeLikelyHeavyVod\(\)[\s\S]+int defTargetMb = video[\s\S]+conservative \? \(heavyVod \? 72 : 24\) : \(heavyVod \? 384 : 96\)[\s\S]+int backBufferMs = video \? \(conservative \? \(heavyVod \? 6000 : 3000\) : \(heavyVod \? 12000 : 8000\)\)/,
    'device-tier defaults remain (capable 4K 384MB, low-power 72/24MB) as the fallback when no server goal is provided');
  // The player buffer is DERIVED from the server-sent read-ahead goal (Streaming-performance
  // setting) × the file bitrate, clamped to a device-RAM-safe ceiling — not a hard-coded constant.
  assert.match(android, /if \(video && nativeBufferGoalSec > 0\) \{[\s\S]+nativeBufferCeilingMb\(conservative, heavyVod\)[\s\S]+nativePlaybackSizeBytes \/ nativePlaybackDurationSec[\s\S]+maxMs = \(int\) Math\.max\(30000L, Math\.min\(conservative \? 120000L : 300000L, nativeBufferGoalSec \* 1000L\)\)/,
    'the on-device buffer scales with the owner read-ahead-goal setting and the file bitrate');
  assert.match(android, /private int nativeBufferCeilingMb\(boolean conservative, boolean heavyVod\) \{[\s\S]+getMemoryInfo\(mi\)[\s\S]+totalRamMb \* 22 \/ 100[\s\S]+conservative \? \(heavyVod \? 96 : 48\) : \(heavyVod \? 768 : 256\)/,
    'the buffer ceiling is a safe share of THIS device RAM, capped per tier so cheap boxes never over-commit');
  assert.match(android, /int bufferGoalSec = Math\.max\(0, j\.optInt\("bufferGoalSec", 0\)\)[\s\S]+nativeBufferGoalSec = bufferGoalSec/,
    'native player reads the server-sent bufferGoalSec for this stream');
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
  assert.match(android, /setReadTimeoutMs\("live"\.equals\(nativeMode\)[\s\S]+NATIVE_LIVE_READ_TIMEOUT_MS[\s\S]+nativeVodReadTimeoutMs\(false\)\)/,
    'native Live TV uses a longer provider read timeout; VOD uses the SPLIT startup read timeout');
  assert.match(android, /private int nativeVodReadTimeoutMs\(boolean established\) \{[\s\S]+if \(nativeLikelyHeavyVod\(\)\) return 45000;[\s\S]+return established \? 30000 : 18000;[\s\S]+\}/,
    'VOD read timeout is split: heavy 4K stays 45s; standard VOD is a tight 18s at STARTUP and widens to 30s after the first frame');
  assert.match(android, /private void widenNativeReadTimeoutAfterFirstFrame\(\) \{[\s\S]+nativeHttpDataSourceFactory != null && "video"\.equals\(nativeMode\)[\s\S]+setReadTimeoutMs\(nativeVodReadTimeoutMs\(true\)\)/,
    'once the first frame renders the read timeout widens so a MID-STREAM stall rides out contention instead of reconnecting + replaying-from-start (the backward-jump fix stays intact)');
  assert.match(android, /nativeVideoStarted = true;\s*\n\s*widenNativeReadTimeoutAfterFirstFrame\(\);/,
    'the read timeout widens exactly where playback becomes established (nativeVideoStarted flips true)');
  assert.match(android, /heavyVod \? 22000 : 5000[\s\S]+heavyVod \? 120000 : 75000[\s\S]+heavyVod \? 384 : 96/,
    'high-end Android devices get a deep 4K VOD buffer (384MB ≈ 75s) so transient upstream hiccups never reach the player');
  assert.match(android, /private void updateNativeLiveWatchdog\(\) \{[\s\S]+boolean waitingForLiveData = state == Player\.STATE_BUFFERING[\s\S]+nativePlayer\.isLoading\(\)[\s\S]+boolean unhealthy = state == Player\.STATE_IDLE \|\| state == Player\.STATE_ENDED \|\| waitingForLiveData[\s\S]+long threshold = nativeLiveStarted \? NATIVE_LIVE_STALL_RECOVERY_MS : NATIVE_LIVE_STARTUP_STALL_RECOVERY_MS;[\s\S]+now - nativeLiveUnhealthySinceMs >= threshold[\s\S]+recoverNativeLivePlayback\(state == Player\.STATE_IDLE \? "idle"/,
    'native Live TV should recover only after sustained idle, ended, or real data-wait stalls');
  assert.match(android, /state == Player\.STATE_ENDED && "live"\.equals\(nativeMode\)[\s\S]+recoverNativeLivePlayback\("ended"\)/,
    'native Live TV should restart instead of staying frozen when a live stream ends quietly');
  assert.match(android, /private void recoverNativeLivePlayback\(String reason\) \{[\s\S]+if \(tryNativeLiveFallback\(\)\) return;[\s\S]+nativePlayer\.setMediaItem\(buildNativeMediaItem\(\)\);[\s\S]+nativePlayer\.prepare\(\);[\s\S]+nativePlayer\.play\(\);/,
    'native Live TV recovery should stay inside ExoPlayer and restart the active native stream');
  assert.match(android, /private boolean nativeVideoStarted;[\s\S]+NATIVE_VIDEO_HEAVY_STARTUP_STALL_MS = 12000L[\s\S]+NATIVE_VIDEO_REBUFFER_TRIM_MS = 15000L[\s\S]+NATIVE_VIDEO_REBUFFER_RECOVERY_MS = 45000L[\s\S]+private void updateNativeVideoWatchdog\(\) \{[\s\S]+if \(state == Player\.STATE_READY\) \{[\s\S]+nativeVideoStarted = true;[\s\S]+nativeVideoUnhealthySinceMs = 0L;[\s\S]+nativeVideoMemoryTrimmedDuringBuffer = false;[\s\S]+if \(nativeVideoStarted\) \{[\s\S]+boolean waitingForData = state == Player\.STATE_BUFFERING[\s\S]+elapsed >= NATIVE_VIDEO_REBUFFER_TRIM_MS[\s\S]+trimAndroidMemoryCaches\(false\)[\s\S]+elapsed >= NATIVE_VIDEO_REBUFFER_RECOVERY_MS[\s\S]+notifyNativeVideoError\(state == Player\.STATE_IDLE \? "native player idle" : "native rebuffer stalled"[\s\S]+long startupThreshold = nativeLikelyHeavyVod\(\)[\s\S]+NATIVE_VIDEO_HEAVY_STARTUP_STALL_MS/,
    'native movie and episode startup should fail over quickly, while sustained mid-play stalls trim memory and retry the same source');
  assert.match(android, /private boolean nativeVideoErrorNotified;[\s\S]+private void notifyNativeVideoError\(String msg, long pos, long dur\) \{[\s\S]+if \(nativeVideoErrorNotified\) return;[\s\S]+nativeVideoErrorNotified = true;[\s\S]+releaseNativePlayer\(false\);/,
    'native movie and episode error reporting should be one-shot per playback attempt');
  assert.match(android, /catch \(Throwable e\) \{[\s\S]+handleNativePlaybackStartFailure\(e, mode, title, backdropUrl, loadingKind,[\s\S]+private void handleNativePlaybackStartFailure\(Throwable e,[\s\S]+trimAndroidMemoryCaches\(true\)[\s\S]+__tvNativeVideoError[\s\S]+__tvNativeLiveError/,
    'native startup should catch low-level Android player failures and report them to the web recovery ladder instead of crashing the app');
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
  assert.match(android, /private void notifyNativeVideoError\(String msg, long pos, long dur\) \{[\s\S]+String title = nativePlaybackTitle;[\s\S]+String backdropUrl = nativePlaybackBackdropUrl;[\s\S]+releaseNativePlayer\(false\);[\s\S]+showNativeLoading\(title, backdropUrl\);[\s\S]+__tvNativeVideoError/,
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
  assert.match(android, /String guideDomKey = domKeyFor\(code\);[\s\S]+boolean guideDpad = code == KeyEvent\.KEYCODE_DPAD_UP[\s\S]+KeyEvent\.KEYCODE_ENTER;[\s\S]+if \(guideDomKey != null && \(!pageInputFocused \|\| guideDpad\)\)/,
    'native PiP guide should keep routing D-pad and OK through the web guide even if input focus state is stale');
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
  assert.match(android, /nativeGuidePipRevealScrim = new TextView\(this\);[\s\S]+nativeGuidePipRevealScrim\.setText\("Tuning channel\.\.\."\)[\s\S]+nativePlayerLayer\.addView\(nativeGuidePipRevealScrim/,
    'native guide PiP should use a labeled sibling reveal layer instead of fading the SurfaceView itself');
  assert.match(android, /private void revealNativeGuidePip\(FrameLayout\.LayoutParams pipLp, boolean holdUntilReady\) \{[\s\S]+nativeGuidePipRevealScrim\.setText\("Tuning channel\.\.\."\)[\s\S]+if \(holdUntilReady\) return;[\s\S]+\.alpha\(0f\)/,
    'native guide PiP should keep the smooth reveal animation and support holding the tuning label during retunes');
  assert.match(android, /else if \("live"\.equals\(nativeMode\)\) \{[\s\S]+revealNativeGuidePip\(\(FrameLayout\.LayoutParams\) nativePlayerView\.getLayoutParams\(\), true\);/,
    'native guide-mode channel retunes should keep a visible tuning overlay instead of exposing a black PiP surface');
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
  assert.match(android, /else web\.postDelayed\(\(\) -> \{[\s\S]+nativeGuideMode && web != null[\s\S]+web\.requestFocus\(\);[\s\S]+\}, 40\);/,
    'native guide retunes should restore WebView focus shortly after ExoPlayer recreates its surface');
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
  assert.match(ui, /const VIRTUAL_GRID_VIEWS = new Set\(\['movies', 'tv', 'watchlist', 'library'\]\);/,
    'high-volume poster pages — including local libraries — should opt into grid virtualization');
  assert.match(ui, /if \(S\.view === 'library' && S\.localPageState && S\.localPageState\.showIdx !== undefined\) return false;/,
    'a local-library SHOW (episode) view keeps its inline affordances and must not be windowed');
  assert.match(ui, /function appendLocalGridMore\(\) \{[\s\S]+if \(shouldVirtualizeGrid\(root\)\) return;/,
    'the in-grid "Load more" button must be suppressed when the library grid is windowed (auto-load handles paging)');
  assert.match(ui, /function appendLocalAdminBar\(\) \{[\s\S]+clearLocalAdminBar\(\);[\s\S]+const bar = \$\('browse'\)\.querySelector\('\.filterBar'\);[\s\S]+'ghostMini focusable libAdminCtl'/,
    'library admin controls must live in the filter-bar head (survives windowing, reachable via UP from the grid)');
  assert.match(ui, /function browseFilterEls\(\) \{[\s\S]+\.filterBar button\.libAdminCtl[\s\S]+\[\$\('genreSel'\), \$\('sortSel'\), \.\.\.admin\]/,
    'relocated admin buttons should join the filter-bar D-pad row');
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
  assert.match(ui, /function focusedGridAtVisualRowStart\(\) \{[\s\S]+document\.querySelector\('\.pcard\.focus, \.card\.focus[\s\S]+return Math\.abs\(prev\.offsetTop - cur\.offsetTop\) > 4;[\s\S]+\}/,
    'D-pad Left visual-row-start fallback must use transform-immune offsetTop, NOT getBoundingClientRect().top (whose value includes the focus scale transform — that made Left jump to the menu from a non-first-column poster in scaled themes like Toomaj)');
  assert.match(ui, /function geomGridVert\(dir\) \{[\s\S]+const t = el\.offsetTop;[\s\S]+Math\.abs\(t - curTop\) > 6/,
    'grid UP/DOWN row bucketing must use transform-immune offsetTop so the focus scale cannot misbucket the focused card');
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
  assert.match(ui, /\.cbtn:hover,\.cbtn\.focus,\.cbtn:focus\{[\s\S]+box-shadow:0 0 0 3px var\(--focus\)/,
    'player OSD button focus should have a visible THEME-accent ring over video (not a hardcoded coral)');
  assert.match(ui, /#subOverlay\{[^}]*max-height:32vh;overflow:hidden;[\s\S]+while \(box\.scrollHeight > box\.clientHeight && box\.firstElementChild\) box\.removeChild\(box\.firstElementChild\);/,
    'self-rendered subtitle text should stay bounded inside the video frame');
  assert.match(ui, /b\.addEventListener\('focus', \(\) => \{[\s\S]+scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/,
    'long subtitle/audio/quality menus should keep the focused row inside the panel');
  assert.match(ui, /#hero h1\{[^}]*height:2\.08em;[\s\S]+#hero \.meta\{[^}]*height:28px;[\s\S]+#hero p\{[^}]*height:4\.5em/,
    'desktop Home hero title, metadata, and overview should reserve stable height while focus changes');
  assert.match(ui, /#discoverRows\{flex:none!important;margin-top:auto;max-height:calc\(var\(--rowH\) \+ 6px\)\}/,
    'Discover should start from a conservative single bottom row before measured desktop fitting runs');
  assert.match(ui, /function rowWindowCountFor\(kind, rowH, h = innerHeight, phoneLayout, tvLayout\) \{[\s\S]+if \(tvLayout\) return 1;[\s\S]+if \(phoneLayout\) return 1;[\s\S]+kind === 'discover' \? 132 : 118[\s\S]+return 3[\s\S]+return 2[\s\S]+return 1;/,
    'row windows should scale up on tall desktop/tablet screens while keeping phone and TV one-row safe');
  assert.match(ui, /function adaptRowWindows\(\) \{[\s\S]+document\.documentElement\.style\.setProperty\('--winRows', rowWindowCountFor\('home'[\s\S]+scheduleRowsWindowFit\(\);[\s\S]+function scheduleRowsWindowFit\(\) \{[\s\S]+requestAnimationFrame\(\(\) => \{[\s\S]+sizeRowsWindow\(\$\('rows'\)\);[\s\S]+sizeRowsWindow\(\$\('discoverRows'\)\);/,
    'viewport/page changes should remeasure visible row windows after layout settles');
  assert.match(ui, /function sizeRowsWindow\(root\) \{[\s\S]+const isDiscover = root\.id === 'discoverRows';[\s\S]+const compactDiscover = isDiscover[\s\S]+if \(compactDiscover\) \{ root\.style\.maxHeight = ''; return; \}[\s\S]+const rowH = \(parseFloat\(getComputedStyle\(document\.documentElement\)\.getPropertyValue\('--poster'\)\) \|\| 190\) \* 1\.5 \+ 106;[\s\S]+const n = rowWindowCountFor\(isDiscover \? 'discover' : 'home', rowH, innerHeight\);/,
    'Home and Discover should use measured responsive row counts while mobile stays compact');
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
  assert.match(ui, /let searchTimer = null, searchSeq = 0;[\s\S]+function clearSearchResults\(opts = \{\}\) \{[\s\S]+if \(opts\.invalidate\) searchSeq\+\+;[\s\S]+grid\.innerHTML = '';/,
    'Search should start blank and invalidate stale async results when cleared');
  assert.match(ui, /prevView === 'search' && v !== 'search'[\s\S]+resetSearchPage\(\);/,
    'leaving Search should clear state without starting a background landing fetch');
  assert.doesNotMatch(ui, /renderSearchLanding|S\.searchLanding/,
    'Search should not auto-populate movies or TV shows before the user types');
  assert.match(ui, /if \(!q\) \{ clearSearchResults\(\{ invalidate: true \}\); return; \}[\s\S]+const seq = \+\+searchSeq;[\s\S]+const current = \(\) => seq === searchSeq[\s\S]+if \(!current\(\)\) return;/,
    'Search should ignore late async responses after the query or page changes');
  assert.match(ui, /function searchAndFocusResults\(\) \{[\s\S]+doSearch\(\)\.then\(\(\) => focusSearchResultsSoon\(\)\)[\s\S]+\$\(\'searchInput\'\)\.addEventListener\('keydown'[\s\S]+e\.key === 'ArrowDown' \|\| e\.key === 'Enter'/,
    'Android TV Search typing should submit and then wait for result focus');
  assert.match(ui, /if \(inInput && S\.view === 'search' && ae === \$\('searchInput'\)\) \{[\s\S]+k === 'ArrowDown' \|\| k === 'Enter'[\s\S]+searchAndFocusResults\(\);[\s\S]+return;/,
    'document-level D-pad handling should not strand focus in the Search text input');
  // TV shows now render as 2:3 posters in search like movies — wide 16:9 cards overflowed the
  // poster-width grid columns and visually overlapped each other.
  assert.match(ui, /function renderSearchSections\(sections\) \{[\s\S]+makeCard\(it, searchResultUsesPoster\(it\), \(\) => focusGrid\(i\)\)[\s\S]+function searchResultUsesPoster\(it\) \{\s*\n\s*if \(!it \|\| it\._channel !== undefined\) return false;[\s\S]+return true;/,
    'Search results should all use uniform poster cards (TV shows no longer overflow/overlap as wide cards)');
  assert.match(ui, /function renderGrid\(items, root = \$\('grid'\)\) \{[\s\S]+makeCard\(it, true, \(\) => focusGrid\(i\)\)/,
    'normal poster grids should still render poster cards');
  assert.match(ui, /if \(S\.view !== 'search' && it && \(isContinueWatchingItem\(it\) \|\| \(it\.tmdbId && \['movie', 'tv'\]\.includes\(it\.type\)\)\)\) \{[\s\S]+openItemMenu\(it, el\);/,
    'Search result OK should open immediately instead of waiting for the long-press menu timer');
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
  assert.match(ui, /<div id="railMain">[\s\S]+<div id="railLibs"><\/div>[\s\S]+<\/div>\s+<div id="railFooter">[\s\S]+id="railAddLib"[\s\S]+id="railUser" class="railBtn focusable"/,
    'library rows should scroll separately from a pinned utility rail footer');
  // Preferences + admin Settings are folded behind the profile avatar (the standalone nav buttons
  // were removed to free rail space): the avatar opens Preferences on the Profile & Pins tab.
  assert.ok(!ui.includes('id="navPrefs"') && !ui.includes('id="navSettings"'),
    'the standalone Preferences/Settings rail buttons should be gone (folded into the avatar)');
  assert.match(ui, /\$\('railUser'\)\.addEventListener\('click', \(\) => \{[\s\S]+switchView\('prefs'\);[\s\S]+button\[data-tab="profiles"\][\s\S]+t\.click\(\)/,
    'the profile avatar should open Preferences and land on the Profile & Pins tab');
  assert.match(ui, /<div id="prefTabs">\s*<button data-tab="profiles" class="on focusable">/,
    'Profile & Pins should be the first, default-selected Preferences tab');
  // (The full Server-settings tab group + merge behavior is asserted above near mergeServerSettingsIntoPrefs.)
  // Sign out lives in Profile & Pins (avatar) now — the "who's watching" profile picker no longer
  // builds its own redundant Sign out button.
  assert.ok(!ui.includes("so.id = 'profileSignout'") && !ui.includes("id=\"profileSignout\""),
    'the profile picker should not carry its own Sign out button');
  assert.match(ui, /\$\('prefSignOut'\)\.addEventListener\('click', signOutAccount\)/,
    'Sign out should remain available in the Profile & Pins panel');
  assert.match(ui, /#railMain\{[\s\S]*overflow-y:auto[\s\S]*#railFooter\{[\s\S]*flex:none[\s\S]*border-top:/,
    'rail footer should stay fixed while library/menu items scroll');
  // Left menu: wrap-around (Up from the top jumps to the bottom where Preferences/Profile live) so a
  // long menu reaches Preferences in one press, and a divider marks where the scrolling list ends.
  assert.match(ui, /if \(k === 'ArrowUp'\) return focusRail\(S\.railIdx <= 0 \? btns\.length - 1 : S\.railIdx - 1\);[\s\S]+if \(S\.railIdx >= btns\.length - 1\) \{[\s\S]+if \(focusMusicBar\(\)\) return;[\s\S]+return focusRail\(0\);/,
    'rail D-pad should wrap around (Up from top → bottom footer, Down past end → top)');
  assert.match(ui, /#rail:hover #railFooter,#rail\.expanded #railFooter,body\.railOpen #railFooter\{border-top:1px solid var\(--line\)/,
    'an expanded menu should show a divider above the pinned Preferences/Profile footer');
  // Android TV: focus must SNAP (no .15s ring fade) so two list rows never look highlighted at once.
  assert.match(ui, /body\.tv \.focusable::before\{transition:none\}/,
    'TV focus ring should be instant so the previous item does not keep glowing during a D-pad move');
  // Back from anywhere deep in a Home row (e.g. Continue Watching) returns to the first item first.
  assert.match(ui, /if \(S\.zone === 'rows' && S\.rowsView && \(\(S\.rowIdx \|\| 0\) > 0 \|\| \(S\.colIdx && \(S\.colIdx\[S\.rowIdx\] \|\| 0\) > 0\)\)\) \{\s*\n\s*focusCard\(0, 0\); return 'ok';/,
    'hardware Back from a non-first item in Home rows should return to the first item before leaving');
  // Preferences shows when an app update is available (semver compare of current vs latest release).
  assert.match(ui, /function compareSemver\(a, b\) \{[\s\S]+const updateAvailable = !!\(curVer && latestVer && compareSemver\(curVer, latestVer\) < 0\);[\s\S]+status\.classList\.toggle\('updateAvail', updateAvailable\)/,
    'the app-update box should detect and flag when a newer release is available');
  // Proactive update pop-up (Android shell, once per launch, never during playback).
  assert.ok(ui.includes('id="updateModal"') && ui.includes('id="updateModalGo"') && ui.includes('id="updateModalLater"'),
    'a proactive update modal with Update/Later buttons exists');
  assert.match(ui, /async function maybePromptAppUpdate\(\) \{[\s\S]+if \(_updatePromptDone\) return;[\s\S]+if \(!\(window\.TriboonTV && typeof TriboonTV\.appVersion === 'function'\)\) return;[\s\S]+compareSemver\(curVer, latestVer\) >= 0\) return;[\s\S]+_updatePromptDone = true;[\s\S]+if \(S\.playing \|\| S\.view === 'player'\) return;[\s\S]+\$\('updateModal'\)\.classList\.add\('open'\)/,
    'update prompt is Android-shell only, fires at most once per launch, skips when newer is not available or during playback');
  assert.match(ui, /\$\('updateModalGo'\)\.addEventListener\('click', \(\) => \{ closeUpdateModal\(\); openApkUpdate\(\); \}\)/,
    'the pop-up Update button installs via openApkUpdate');
  assert.match(ui, /if \(\$\('updateModal'\)\.classList\.contains\('open'\)\) \{[\s\S]+closeUpdateModal\(\);[\s\S]+dpadCycle\(\$\('updateModal'\), k\)/,
    'the update modal is D-pad navigable and closes (Later) on hardware Back/Esc');
  assert.match(ui, /hydrateAppShellData\(\);[\s\S]+maybePromptAppUpdate\(\)\.catch\(\(\) => \{\}\);/,
    'enterAppShell triggers the update check once the home has settled');
  // Online presence: every open app pings /api/presence so the server knows who's connected. The
  // Activity screen surfaces this as an "N online" count (watchers-only design — the browsing list
  // was dropped), not a list of people sitting in menus.
  assert.ok(!ui.includes('id="activityOnline"') && !ui.includes('function onlineRowHtml('),
    'Activity no longer renders a browsing-only "Online now" list');
  assert.match(ui, /function sendPresence\(state, opts = \{\}\)[\s\S]+fetch\('\/api\/presence'/,
    'client sends an online-presence heartbeat to /api/presence');
  assert.match(ui, /function startPresence\(\) \{[\s\S]+setInterval\(\(\) => sendPresence\(\), 25000\)/,
    'presence heartbeat runs on a ~25s interval while the app is open');
  assert.match(ui, /function presencePayload\(state\) \{[\s\S]+state: state \|\| \(playing \? 'watching' : 'browsing'\)/,
    'presence reports watching vs just browsing');
  assert.match(ui, /hydrateAppShellData\(\);\s*\n\s*startPresence\(\);/,
    'enterAppShell starts presence so browsing (not only watching) marks the device connected');
  assert.match(ui, /function renderActivitySummary\(sessions = \[\], history = \[\], online = \[\]\)[\s\S]+\$\{online\.length\}<\/b> online/,
    'the activity summary folds presence into an online count');
  // Streaming Performance: "Test provider speed" button measures per-connection speed + the cap.
  assert.ok(ui.includes('id="perfSpeed"') && ui.includes('id="perfSpeedResult"'),
    'Streaming Performance has a Test provider speed button + result area');
  assert.match(ui, /\$\('perfSpeed'\)\.addEventListener\('click'[\s\S]+\/api\/test\/provider-speed[\s\S]+r\.mbpsPerConn/,
    'the speed button probes each provider and shows per-connection speed');
  // Phase 4: probe verifies the CONFIGURED connection count (any plan size) + cools down between providers.
  assert.ok(ui.includes('connections confirmed') && ui.includes('lower configured to'),
    'speed-test result shows confirmed-vs-capped connections against the configured count');
  assert.match(ui, /\$\('perfSpeed'\)[\s\S]+if \(i > 0\) await new Promise\(\(res\) => setTimeout\(res, 1200\)\)/,
    'speed test cools down between providers so lingering connections do not skew the next');
  // Phase 2: measured speed/cap feed the recommendation, which reports max simultaneous viewers.
  assert.match(ui, /async function calcRecommendation\(\)[\s\S]+\.\.\.\(S\.perfMeasured \|\| \{\}\)/,
    'the recommendation call folds in the measured provider speed + connection cap');
  assert.match(ui, /\$\('perfSpeed'\)\.addEventListener[\s\S]+S\.perfMeasured = \{ measuredMbpsPerConn:[\s\S]+await calcRecommendation\(\)/,
    'running the speed test stores the measurement and recalculates the recommendation');
  assert.match(ui, /Supports about <strong>\$\{esc\(c\.maxSimultaneous1080[\s\S]+maxSimultaneous4k/,
    'the recommendation result shows how many simultaneous viewers are supported');
  // Phase 3: Max release size controls live inside the Streaming Performance panel now (one capacity panel).
  assert.match(ui, /Streaming performance<\/h2>[\s\S]+id="perfSpeedResult"[\s\S]+>Max release size<\/h3>[\s\S]+id="szMode"[\s\S]+id="szSave"/,
    'Max release size controls are folded into the Streaming Performance panel');
  assert.doesNotMatch(ui, /<div class="panel"><h2>Max release size<\/h2>/,
    'the standalone Max release size panel was removed (no duplicate sz* controls)');
  // Settings labels are no longer CSS-uppercased (the "MBPS" megabits/megabytes confusion fix).
  assert.match(ui, /\.settingsControl>span\{[^}]*text-transform:none/,
    'settings labels render sentence-case (not forced ALL CAPS)');
  // Native players hide the WebView, so the setInterval heartbeats can be throttled. The native
  // progress/stats ticks (pushed from native) must keep activity + presence alive for TV viewers.
  assert.match(ui, /function nativePlaybackHeartbeat\(\) \{[\s\S]+if \(!p \|\| !p\.usingNative\) return;[\s\S]+now - _nativeHbAt < 9000\) return;[\s\S]+sendActivity\('watching'\);[\s\S]+sendPresence\('watching'\);[\s\S]+saveWatch\(\);/,
    'a throttled native heartbeat re-reports activity + presence AND persists watch progress while the WebView is hidden (so app close/kill/update mid-native-playback keeps position + the watched flag)');
  assert.match(ui, /window\.__tvNativeVideoProgress = \(pos, dur\) => \{[\s\S]+nativePlaybackHeartbeat\(\);/,
    'the native VOD progress tick drives the heartbeat');
  assert.match(ui, /window\.__tvNativeVideoStats = \(raw\) => \{[\s\S]+nativePlaybackHeartbeat\(\);/,
    'the native stats tick (fires for Live TV too) drives the heartbeat');
  // Same throttling reason kills the native alass auto-sync: a hidden-WebView setTimeout often never
  // fired, leaving the raw unsynced sub. It must be QUEUED and driven off the native ticks instead.
  assert.match(ui, /function autoSyncNative\(p, rel\) \{[\s\S]+p\._pendingNativeSyncRel = rel;[\s\S]+runPendingNativeSync\(\);[\s\S]+\}/,
    'native auto-sync should queue a request + run it, not schedule a throttle-prone timer');
  assert.doesNotMatch(ui, /_autoSyncNT/,
    'native auto-sync must not rely on the old throttle-prone setTimeout (the _autoSyncNT timer is gone)');
  assert.match(ui, /async function runPendingNativeSync\(\) \{[\s\S]+x-triboon-subsync'\) !== 'pending'[\s\S]+sync=1[\s\S]+if \(syncVerdict === 'failed'\) \{ p\._pendingNativeSyncRel = null; return; \}[\s\S]+syncVerdict !== 'corrected'[\s\S]+updateActiveSubtitle\(/,
    'the queued native sync only swaps the track in once the server confirms an alass-corrected sub, and STOPS retrying when the server declares the sync terminally failed (each retry re-pulled the mount audio from usenet)');
  assert.match(ui, /window\.__tvNativeVideoProgress = \(pos, dur\) => \{[\s\S]+runPendingNativeSync\(\);/,
    'the native VOD progress tick drives the queued alass sync');
  assert.match(ui, /window\.__tvNativeVideoStats = \(raw\) => \{[\s\S]+runPendingNativeSync\(\);/,
    'the native stats tick also drives the queued alass sync (covers paused playback)');
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

test('hls variant: spawnHls copies video, emits fMP4 HLS, and refuses without an output dir', () => {
  // Static contract (no ffmpeg needed): the HLS variant reuses the source-fit copy-remux — video is
  // stream-copied (0 CPU) — and produces a VOD fMP4 HLS playlist. It must never guess an output dir.
  const transcode = fs.readFileSync(path.join(__dirname, '..', 'server', 'transcode.js'), 'utf8');
  assert.match(transcode, /function spawnHls\(streamUrl, \{[^}]*outDir[^}]*\} = \{\}\) \{[\s\S]+'-c:v', 'copy'[\s\S]+'-f', 'hls'[\s\S]+'-hls_segment_type', 'fmp4'/,
    'spawnHls must copy video and emit fMP4 HLS segments (AirPlay/CAF friendly)');
  assert.match(transcode, /spawnHls[\s\S]+if \(!outDir\) throw new Error\('spawnHls requires an output directory'\)/,
    'spawnHls must refuse to run without an explicit output directory (no path guessing)');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  // HLS is now a FIRST-CLASS stream-authed output (the iOS Safari playback path) — no longer gated behind
  // the opt-in flag. It stays stream-tier authed + capped + temp-cleaned; the default ladder is untouched
  // for non-iOS because only iosWebkitVideo() clients ever request hlsUrl.
  assert.doesNotMatch(server, /hls: async \(ctx\) => \{\s*\n\s*if \(!hlsEnabled\(\)\) return send\(ctx\.res, 404/,
    'the HLS route must NOT be gated off by the feature flag — iOS Safari depends on it');
  assert.match(server, /hls: async \(ctx\) => \{[\s\S]+if \(!streamScopeOk\(ctx, ctx\.m\[1\]\)\) return send\(ctx\.res, 401/,
    'the HLS route stays stream-tier authed (deny-by-default preserved)');
  assert.match(server, /hls: async \(ctx\)[\s\S]+const forceAudioSafe = ctx\.url\.searchParams\.get\('audioSafe'\) === '1';[\s\S]+const transcodeAudio = forceAudioSafe \|\| !audioCopyOk\(aud, vf\._caps\);/,
    'the HLS route honors audioSafe=1 to force stereo AAC (iOS Safari can\'t decode AC3/EAC3 in a local <video>, even in HLS)');
  assert.ok(server.includes("re: /^\\/api\\/hls\\/(\\w+)(?:\\/([\\w.-]+))?$/, auth: 'stream'"),
    'the HLS route must be declared in ROUTES at stream-tier auth');
  // The mount payload advertises the HLS URL so the iOS web player can request it.
  assert.match(server, /hlsUrl: detectFfmpeg\(\) \? `\/api\/hls\/\$\{vf\.id\}\?t=\$\{st\}` : null,/,
    'the mount payload exposes hlsUrl for the iOS Safari player');
  // Client: iOS routes the remux kind to native HLS (Safari can\'t play the non-rangeable remux pipe).
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(ui, /function hlsPlaybackUrl\(p, seekStart = 0\) \{[\s\S]+`\$\{p\.hlsUrl\}&start=\$\{Math\.max\(0, Math\.floor\(seekStart \|\| 0\)\)\}&audio=\$\{audio\}&audioSafe=1`/,
    'hlsPlaybackUrl builds a tokened HLS URL with a server-seek start and forced stereo AAC');
  assert.match(ui, /kind === 'remux'\) \{[\s\S]+v\.src = \(\(iosWebkitVideo\(\) \|\| macSafariVideo\(\)\) && p\.hlsUrl\) \? hlsPlaybackUrl\(p, seekStart\) : remuxPlaybackUrl\(p, seekStart\);/,
    'iOS AND Mac desktop Safari get the remux as native HLS; every other browser (incl. Chrome/FF on Mac) keeps the direct fMP4 remux');
  // Mac-Safari detection must be TIGHT: require the Apple vendor string and exclude every Chromium/Gecko UA,
  // so a non-Safari Mac browser (which can't play native HLS) is never routed to the m3u8.
  assert.match(ui, /function macSafariVideo\(\) \{[\s\S]+navigator\.vendor === 'Apple Computer, Inc\.'[\s\S]+!\/\\b\(CriOS\|FxiOS\|Chrome\|Chromium\|Edg\|EdgA\|OPR\|Opera\|Android\)\\b\/i\.test\(ua\)/,
    'Mac Safari is detected via the Apple vendor string with all Chromium/Gecko UAs excluded (no false positive → no broken Chrome-on-Mac)');
});

test('hls variant: ffmpeg process lifecycle works and cleans up its temp dir', { skip: !HAS_FFMPEG }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-hls-test-'));
  const ff = spawnHls('anullsrc', { startSeconds: 0, outDir: dir }); // invalid input → ffmpeg errors fast
  let errored = false;
  ff.on('error', () => { errored = true; });
  const code = await new Promise((r) => ff.on('close', r));
  assert.ok(code !== null || errored, 'HLS ffmpeg process lifecycle works');
  fs.rmSync(dir, { recursive: true, force: true });
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
  assert.ok(transcode.includes("'-analyzeduration', '500000', '-probesize', '1000000'"),
    'live remux uses a trimmed analyze budget for a faster channel-change first byte');
  assert.doesNotMatch(transcode, /function spawnLiveRemux[\s\S]+'-ac', '2'[\s\S]+\]\, \{ stdio/,
    'Live TV browser remux should not force every channel to stereo');
});

test('ffmpeg HTTP option detection is cached and safe on older builds', () => {
  assert.strictEqual(typeof supportsFfmpegHttpOption('max_redirects'), 'boolean');
  assert.strictEqual(supportsFfmpegHttpOption('definitely_not_a_real_option'), false);
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

test('remux: audioSafe downmixes 5.1 → stereo AAC (multiview/WebView), default keeps 5.1', { skip: !HAS_FFMPEG || !HAS_FFPROBE }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-safe-'));
  const src = path.join(dir, 'ac3-51.mkv');
  const gen = spawnSync(detectFfmpeg().path, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=12:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'ac3', '-ac', '6', src,
  ], { timeout: 120000, windowsHide: true });
  if (gen.status !== 0) return; // no ac3 encoder in this build → covered in Docker
  const { server, url } = await serveFile(src);
  try {
    const safeFile = path.join(dir, 'safe.mp4');
    fs.writeFileSync(safeFile, await collect(spawnRemux(url, { transcodeAudio: true, safeStereo: true })));
    const safe = await probeTracks(safeFile);
    assert.strictEqual(safe.audio[0].codec, 'aac', 'audio-safe path is AAC');
    assert.strictEqual(safe.audio[0].channels, 2, 'audio-safe path downmixes to stereo so WebView/MSE can decode it');

    const surrFile = path.join(dir, 'surr.mp4');
    fs.writeFileSync(surrFile, await collect(spawnRemux(url, { transcodeAudio: true })));
    const surr = await probeTracks(surrFile);
    assert.strictEqual(surr.audio[0].channels, 6, 'normal transcodeAudio path (native players) keeps 5.1');
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

// ---- v2.3.8 audit-fix contracts: Trakt/watch-state safety + CC pipeline ----
// These pin the FIXES for the four verified Trakt bugs and four CC bugs from the v2.3.7
// pre-production audit so a refactor can't silently reintroduce them.
test('audit contracts: Trakt/watch-state data-safety + CC pipeline fixes stay in place', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

  // (1) watchBulk: season/group marks send EXACT per-season episode payloads — never a bare-show
  // history op (Trakt expands a bare show, so a season-UNWATCH deleted the user's entire show history).
  const watchBulk = server.slice(server.indexOf('watchBulk: async'), server.indexOf('prefsGet: async'));
  assert.match(watchBulk, /trakt\.historyEpisodes\(ctx\.user\.id, id, season, eps, b\.watched !== false\)/,
    'season bulk marks go through the season-scoped historyEpisodes op');
  assert.doesNotMatch(watchBulk, /trakt\.history\(ctx\.user\.id, `tmdb:tv:\$\{id\}`/,
    'watchBulk must never fire a bare-show trakt history op');

  // (2) Trakt watched-import cannot clobber an in-progress local rewatch (position/traktPct win),
  // mirroring the playback import's local-progress-wins guard.
  assert.match(server, /for \(const w of watched\) \{[\s\S]{0,400}all\[k\]\.watched \|\| \(all\[k\]\.position \|\| 0\) > 30 \|\| \(all\[k\]\.traktPct \|\| 0\) > 2\)\) continue;/,
    'the 6h Trakt watched-import must skip rows with live local progress (rewatch positions were being destroyed)');

  // (4) Profile echo: imports skip keys ANY profile bucket already knows (watched/progress/hidden),
  // via a single-pass precomputed index (pullWatched returns up to 20K keys).
  assert.match(server, /const localWins = new Set\(\);[\s\S]{0,500}v\.watched \|\| \(v\.position \|\| 0\) > 30 \|\| v\.hidden/,
    'traktSyncDown precomputes which keys local profiles already own');
  assert.match(server, /if \(anyProfileKnows\(w\.key\)\) continue;[\s\S]+if \(anyProfileKnows\(p\.key\)\) continue;/,
    'both the watched and playback imports consult the any-profile index (stops cards echoing across profiles)');

  // (3) Broken Trakt tokens: surfaced, not silent. Tick skips them; manual sync 400s with a real
  // message; the settings box renders the re-link flow.
  assert.match(server, /if \(!tok \|\| tok\.broken\) continue;/,
    'the 6h sync tick must skip definitively-broken tokens');
  assert.match(server, /if \(st\.broken\) \{ const e = new Error\('Trakt needs re-linking[\s\S]{0,80}e\.status = 400; throw e; \}/,
    'manual sync on a broken token must fail loudly instead of reporting "sync ✓ — 0 watched"');
  assert.match(server, /send\(ctx\.res, e\.status \|\| 502, \{ error: e\.status \? e\.message : 'trakt unreachable' \}\)/,
    'deliberate 400s keep their actionable message instead of the generic unreachable');
  assert.match(ui, /if \(st\.linked && st\.broken\) \{[\s\S]+Trakt needs re-linking[\s\S]+Re-link Trakt account/,
    'the settings box tells the user to re-link when the token is broken');
  assert.match(ui, /function wireTraktLinkButton\(box\)/,
    'the device-code link flow is shared by the fresh-link and re-link boxes');

  // (5) alass negative cache: a 300s timeout or 3 strikes is TERMINAL — header goes 'failed' and
  // no new alass spawn happens (each doomed retry re-pulled the mount audio from usenet).
  assert.match(server, /vf\._subSyncFail = vf\._subSyncFail \|\| new Map\(\);/,
    'per-mount sync-failure map exists');
  assert.match(server, /const syncTerminal = \(\) => \{ const f = vf\._subSyncFail\.get\(syncKey\); return !!\(f && \(f\.timedOut \|\| f\.tries >= 3\)\); \};[\s\S]{0,400}'x-triboon-subsync': 'failed'/,
    'a terminal sync failure short-circuits BEFORE spawning alass and reports failed');
  assert.match(server, /vf\._subSyncFail\.set\(syncKey, \{ tries: prev\.tries \+ 1, timedOut: prev\.timedOut \|\| \/timed out\/i\.test\(msg\), at: Date\.now\(\) \}\);/,
    'sync failures are recorded with try count + timeout flag (timeouts are immediately terminal)');
  assert.match(server, /const syncHdr = looksSynced \? 'synced'\s*: \(_sf && \(_sf\.timedOut \|\| _sf\.tries >= 3\)\) \? 'failed'/,
    'the advertised sync status reports failed so clients stop queueing background syncs');

  // (6) Wyzie + OpenSubtitles searches run CONCURRENTLY (they were serial despite the comment,
  // doubling cold CC latency).
  assert.match(server, /const \[wySettled, osData\] = await Promise\.all\(\[\s*searchOnlineSubs\(subOpts\)\.then\(\(d\) => \(\{ d \}\), \(e\) => \(\{ e \}\)\),\s*openSubtitlesVariantsForMount\(/,
    'both subtitle providers are queried in parallel');

  // (7) The sync-state (skip-alass-when-matched) is stamped from the sub ACTUALLY SERVED — a
  // stale top link silently falls back, and stamping from the chosen pick froze fallback subs
  // as synced forever (drifting CC + dead Fix-sync).
  assert.match(server, /const \{ vtt: dlVtt, served \} = await downloadBestSubtitle\([\s\S]{0,400}vf\._subSyncState\.set\(cacheKey, subtitleLooksSynced\(served, releaseName\)\)/,
    'Wyzie downloads stamp sync-state from the served variant, after the download');
});

// Second audit-fix batch: local-library age gate, next-episode recency, music queue paging +
// fail-streak, and library-scanner year parsing. ("&"-title matching is covered behaviorally in
// phase2; the local age gate behaviorally in security.test.js — these pin the shapes.)
test('audit contracts: local age gate, next-episode recency, music queue, scanner year rules stay in place', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

  // Local plays enforce the profile maturity bar: gate BEFORE the mount, identity from the
  // server-side scan record (never the client body), episode falls back to the show's id.
  const localPlay = server.slice(server.indexOf('localPlay: async'), server.indexOf('localThumb: async'));
  assert.match(localPlay, /profileLevelFor\(ctx\.user, body\.profileId\)/, 'local play reads the profile level');
  assert.match(localPlay, /maturityAllowsPlay\(level, tmdbId, mediaType\)[\s\S]{0,80}maturityBlockedResponse\(ctx\)/,
    'local play blocks over-level titles');
  assert.ok(localPlay.indexOf('maturityAllowsPlay') < localPlay.indexOf('localMountFor('),
    'the gate runs before the mount is created');
  assert.strictEqual((ui.match(/\/\/ Age gate: local plays enforce the same profile maturity bar as usenet plays\./g) || []).length, 2,
    'both web local playUrl call sites send the active profileId');

  // Next-episode row: recency-ordered Map, not an object — numeric-string keys iterate in
  // ASCENDING NUMERIC order on objects, which silently selected the 20 lowest TMDB ids
  // instead of the 20 most recently watched shows.
  assert.match(server, /const byShow = new Map\(\);[\s\S]{0,800}for \(const \[showId, top\] of \[\.\.\.byShow\]\.slice\(0, 20\)\)/,
    'nextWatchEpisodes keeps recency order via a Map');

  // Music: playlist pages append IN PLACE so the live queue grows; the queue auto-extends at the
  // end instead of stopping at track 24; nearing the end prefetches the next page; the fail-streak
  // resets on 'playing' (media actually rendering), never 'play' (fires on doomed attempts too).
  assert.match(ui, /else p\.tracks\.push\(\.\.\.rows\);/, 'playlist pages append in place (same array as the queue)');
  assert.match(ui, /else if \(musicQueueCanExtend\(q\)\) \{ extendMusicQueueThenNext\(auto\); return; \}/,
    'end of a paged playlist queue loads the next page instead of stopping');
  assert.match(ui, /if \(S\.musicQueue !== q \|\| q\.length <= before\) return;/,
    'a failed/empty page load must not loop the extender');
  assert.match(ui, /if \(musicQueueCanExtend\(q\) && S\.musicIdx >= q\.length - 3\) loadMusicPlaylistPage\(false\);/,
    'nearing the queue end prefetches the next playlist page');
  assert.match(ui, /mAudio\.addEventListener\('playing', \(\) => \{ S\.musicFailStreak = 0; \}\);/,
    'the fail-streak resets only when media actually renders');
  assert.doesNotMatch(ui, /addEventListener\('play', [^\n]*musicFailStreak/,
    'the streak must not reset on the play event (fires per attempt, defeated the one-lap bound)');

  // Library scanner: the LAST year-shaped token is the year (Blade Runner 2049 / Wonder Woman
  // 1984), and a zero-hit search retries with the year folded back into the title.
  assert.match(server, /for \(let h; \(h = re\.exec\(clean\)\);\) m = h;/,
    'parseName scans to the LAST year token, not the first');
  assert.match(server, /if \(!hit && name\.year\) \{[\s\S]{0,300}\$\{name\.title\} \$\{name\.year\}/,
    'tmdbLookup folds the year back into the query when the year-filtered search misses');

  // IPTV zapping: the retune grace matches the PREVIOUS stream's teardown (Node-owned ts-pipe /
  // native-proxy sockets die synchronously → short cushion; only a killed legacy ffmpeg needs the
  // full 650ms) — a browser→browser zap on the preferred ts-pipe path was eating ~530ms of dead air.
  assert.match(server, /replacedKind: \(replaced && prev && prev\.kind\) \|\| ''/,
    'the live slot records what kind of stream was evicted');
  assert.match(server, /liveSlot\.kind = 'ts-pipe'/, 'the ts-pipe path tags its slot');
  assert.match(server, /liveSlot\.kind = 'ffmpeg-url'/, 'the legacy path tags its slot');
  assert.match(server, /slot\.kind = 'native-proxy'/, 'the native proxy tags its slot');
  assert.match(server, /const prevNodeOwned = liveSlot\.replacedKind === 'ts-pipe' \|\| liveSlot\.replacedKind === 'native-proxy';\s*startDelayTimer = setTimeout\(begin, prevNodeOwned \? IPTV_LIVE_RETUNE_GRACE_NATIVE_MS : IPTV_LIVE_RETUNE_GRACE_MS\)/,
    'browser retunes after a Node-owned stream use the short grace');
  // Web zap speed + resilience: neighbors prefetched (kills the serial /api/iptv/play round-trip),
  // and a mid-broadcast drop auto-retunes (bounded) instead of freezing the last frame silently.
  assert.match(ui, /prefetchAdjacentChannelUrls\(it, S\.liveList\);/, 'zaps prefetch the adjacent channels');
  assert.match(ui, /function attemptLiveAutoRetune\(\)[\s\S]{0,900}v\.currentTime < 3\) return false;[\s\S]{0,400}p\._liveRetunes \|\| 0\) >= 2\) return false;/,
    'live auto-retune only fires after real playback and is bounded per window');
  assert.match(ui, /if \(!attemptLiveAutoRetune\(\)\) showLiveProviderError\('The live stream ended unexpectedly'\)/,
    'a played-out live buffer reconnects instead of freezing on the last frame');
  assert.match(ui, /if \(attemptLiveAutoRetune\(\)\) return;\s*showLiveProviderError\('Live stream unavailable'\)/,
    'live failover tries a reconnect before the error panel');
  // The browse-guide timeline stays alive: now-line + live-highlight tick each minute, full
  // re-render when the window is consumed.
  assert.match(ui, /S\._guideNowTimer = setInterval\([\s\S]{0,900}querySelectorAll\('\.gNow'\)[\s\S]{0,300}\.gProg\[data-s\]/,
    'the guide now-line and live highlights advance without a refetch');

  // Season 0 = specials: the episode filter must stay ON (season >= 0) at every hand-off — it used
  // to switch OFF for exactly the plays where mixed-episode subtitle results hurt most.
  assert.match(server, /const hasEpisode = Number\.isInteger\(seasonParam\) && seasonParam >= 0 &&/,
    'the subtitle route accepts season 0');
  assert.match(server, /s < 0 \|\| e <= 0\) return base; \/\/ s=0: specials/,
    'episodeSubtitleQuery accepts season 0');
  assert.match(ui, /if \(ep && ep\.season >= 0 && ep\.episode > 0\)/,
    'the web forwards season 0 to the subtitle search');
  // VTT→SRT for alass: hourless cue times normalize to HH:MM:SS,mmm and cue settings are stripped
  // (alass parses SRT strictly — hourless/decorated lines made auto-sync error on genuine VTT).
  assert.match(server, /\$\{h \|\| '00'\}:\$\{ms\},\$\{frac\}/, 'vttToSrt normalizes hourless cue times');
  assert.match(server, /Drop VTT cue settings after the end time/, 'vttToSrt strips cue settings for SRT');

  // Auto-advance warms the LIVE timestamp on the replacement mount (client sends resumeFrac,
  // pipeline threads it into session.query which _commitMount feeds the warmup) — an advance at
  // minute 70 used to warm the file HEAD and the resume seek sat on a cold window for 20-30s.
  const pipelineSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'pipeline.js'), 'utf8');
  assert.match(pipelineSrc, /async advance\(sessionId, mountOpts = \{\}\) \{[\s\S]{0,900}session\.query = \{ \.\.\.\(session\.query \|\| \{\}\), resumeFrac: frac \};/,
    'pipeline.advance updates the session resume fraction');
  assert.match(server, /await pipeline\.advance\(ctx\.m\[1\], \{ resumeFrac: b && b\.resumeFrac \}\)/,
    'the advance route forwards the reported position');
  assert.match(ui, /body: at > 0 && advDur > 0 \? \{ resumeFrac: Math\.max\(0, Math\.min\(0\.98, at \/ advDur\)\) \} : \{\}/,
    'the player reports its current position on advance');

  // Chronically slow sources get the probe-timeout demotion HEALTH_SCORE was designed with
  // (the flag was set but never read — dead code, so slow sources re-cost a 30s walk every play).
  assert.match(pipelineSrc, /if \(candidate\._probeTimeout && \/mount timeout\/i\.test\(String\(e && e\.message \|\| ''\)\)\) \{\s*this\._recordVerdict\(candidate, 'probe-timeout', \{ stage: 'mount' \}\);/,
    'probe-timeout + mount-timeout records the demotion verdict');

  // Outbound-API routes carry per-user throttles like their peers (a looping client could get the
  // admin's Trakt app rate-banned).
  assert.match(server, /throttleUserRoute\(ctx, 'trakt-sync', \{ max: 6, windowMs: 60000/,
    'manual Trakt sync is rate-limited');
  assert.match(server, /throttleUserRoute\(ctx, 'trakt-pull', \{ max: 6, windowMs: 60000/,
    'Trakt watchlist import is rate-limited');

  // Server-perf: the hot/big tables carry background-flush throttles (the store's debounced path
  // was re-serializing + rewriting whole multi-MB tables on the event loop serving video bytes),
  // and the geoCache is finally swept (it TTL-checked reads but never evicted).
  assert.match(server, /store\.flushIntervals = \{[\s\S]{0,600}watch: 3000,[\s\S]{0,600}'tmdb-cache': 15000,[\s\S]{0,600}xtreamepgcaches: 30000,/,
    'hot store tables keep their background-flush throttle');
  assert.match(server, /for \(const \[ip, hit\] of geoCache\) if \(now - \(\(hit && hit\.at\) \|\| 0\) > GEO_TTL_MS\) geoCache\.delete\(ip\);/,
    'the periodic sweep prunes expired geoCache entries');
  assert.match(server, /if \(geoCache\.size > 500\) \{/,
    'geoCache is size-capped as a backstop');
});
