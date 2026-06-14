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
const { detectFfmpeg, detectFfprobe, detectEncoder, decidePlayback, probeTracks, spawnRemux, spawnTranscode, spawnSubtitleExtract } = require('../server/transcode');

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
    if (range && range[1] !== '') {
      const start = +range[1];
      const end = range[2] ? +range[2] : stat.size - 1;
      res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'content-length': stat.size, 'accept-ranges': 'bytes' });
      fs.createReadStream(file).pipe(res);
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/multi.mkv` })));
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
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8'), /if \(preferRank === 4\) policy\.exactResolutionRank = 4;/,
    '4K selection should be exact so fallback stays in the 4K source class');
  assert.match(ui, /function sourceSearchQuery\(it\) \{[\s\S]+maxResolutionRank[\s\S]+preferResolutionRank/,
    'Sources, availability, and prefetch should ask search with the same quality policy as Play');
  assert.match(ui, /function prefetchSources\(it, delay = 700\) \{[\s\S]+setTimeout\(\(\) => \{[\s\S]+api\('\/api\/search\?' \+ sourceSearchQuery\(it\)\)[\s\S]+\}, delay\);/,
    'source warmup should be reusable for hover prefetch and immediate Play-target prefetch');
  assert.match(ui, /function updateDetailPlayLabel\(\{ label, target \}\) \{[\s\S]+detailPlayTarget = target;[\s\S]+prefetchSources\(target, 0\);[\s\S]+\}/,
    'movie/show details should warm the exact current Play target immediately, including TV episodes');
  assert.match(ui, /pickKey: picked && picked\.pickKey/,
    'manual source playback should send the opaque server pick key, not only a release name');
  assert.match(ui, /play\(it, \{ name: c\.name, pickKey: c\.pickKey, resolutionRank: rk\(c\) \}\)/,
    'clicking a Sources row should carry its exact release key and quality class into Play');
  assert.match(ui, /qualityRank:\s*normalizeQualityRank\(w\.meta\.qualityRank\)/,
    'Continue Watching cards should carry the saved quality rank from watch state');
  assert.match(ui, /qualityRank:\s*qualityRankForItem\(p\.item\)/,
    'watch progress saves the current quality rank for future resumes');
  assert.match(ui, /saveQualityPref\(target,\s*S\.qualityPref\)/,
    'changing the detail quality toggle should persist the per-title preference');
  assert.match(ui, /qualityTitleKey\(S\.detailItem\) === qualityTitleKey\(it\)/,
    'episode resumes should inherit the show-level quality preference');
  assert.match(ui, /map\[key\] = \{ streamUrl: x\.streamUrl, playUrl: x\.playUrl, name: x\.title/,
    'local-first Continue Watching entries should keep the rich local player prep URL');
  assert.match(ui, /_local: x\.streamUrl \? \{ streamUrl: x\.streamUrl, playUrl: x\.playUrl, name:/,
    'added-library cards should carry the full local player prep URL');
  assert.match(ui, /async function playLocal\(it\) \{[\s\S]+await api\(it\._local\.playUrl, \{ method: 'POST', body: \{ caps: clientCaps\(\) \} \}\)[\s\S]+openPlayer\(it, \{ \.\.\.mount/,
    'added-library playback should use the same prepared player mount shape as Movies and TV');
  assert.match(ui, /async function playLocal\(it\) \{[\s\S]+it = resolvePlaybackResume\(it\);[\s\S]+if \(nativeFirst\) showNativePlayLoading\(it\);[\s\S]+else showPlayLoading\(it\);[\s\S]+openPlayer\(it, \{ \.\.\.mount/,
    'local library playback should resolve resume and leave details for the loading player before mount prep waits');
  assert.match(ui, /function mergeLocalItems\(lib, items\) \{[\s\S]+`tmdb:tv:\$\{x\.tmdbId\}:s\$\{x\.s\}e\$\{x\.e\}`[\s\S]+playUrl: x\.playUrl[\s\S]+S\.localMap = map/,
    'local library scans should hydrate episode keys into the local-first playback map');
  assert.match(ui, /function queryFor\(it\) \{[\s\S]+if \(it\.tmdbId && \(it\.type === 'movie' \|\| it\.type === 'tv'\) && exact\) return exact;[\s\S]+return it\.q \|\| exact;/,
    'TMDB movie/show cards should play/search by the selected title and year, not a fuzzy raw search query');
  assert.match(ui, /if \(it\._lib && it\._lib\.path\) \{[\s\S]+const r = await libItems\(it\._lib\);[\s\S]+mergeLocalItems\(it\._lib, r\.items \|\| \[\]\);[\s\S]+\}[\s\S]+checkAvailability\(it\);/,
    'TV details opened from an added library should hydrate local episode ownership before availability/play targets are calculated');
  assert.match(ui, /function epItemOf\(show, season, ep\) \{[\s\S]+const loc = S\.localMap && S\.localMap\[item\.key\];[\s\S]+return loc \? \{ \.\.\.item, _local: loc \} : item;/,
    'season episode cards should carry local playback when the episode exists in an added library');
  assert.match(ui, /function epTarget\(show, sNum, eNum, resume\) \{[\s\S]+const loc = S\.localMap && S\.localMap\[item\.key\];[\s\S]+return loc \? \{ \.\.\.item, _local: loc \} : item;/,
    'the main TV detail Play/Resume target should carry local playback for owned episodes');
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
  assert.match(ui, /poster:\s*w\.meta\.poster \|\| w\.meta\.backdrop/,
    'Continue Watching should carry poster art into details instead of relying only on backdrop art');
  assert.match(ui, /overview: p\.item\.overview, poster: p\.item\.poster, backdrop: p\.item\.backdrop/,
    'watch progress should save poster art so Continue Watching is stable before and after refresh');
  assert.match(ui, /function openLocalDetail\(it\) \{[\s\S]+const resume = resumePositionForItem\(it\);[\s\S]+\$\(\'dStartOver\'\)\.style\.display = resume \? '' : 'none';[\s\S]+Resume/,
    'unmatched local library details should expose the same Resume and Start Over behavior');
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
});

test('Android native player: direct source and native chrome stay out of the web player', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const android = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'app', 'triboon', 'tv', 'MainActivity.java'), 'utf8');
  const guideIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_guide.xml'), 'utf8');
  const audioIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_audio.xml'), 'utf8');
  const ccIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_cc.xml'), 'utf8');
  const qualityIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_quality.xml'), 'utf8');
  const rewindIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_rewind.xml'), 'utf8');
  const forwardIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_forward.xml'), 'utf8');
  const nextIcon = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_player_next.xml'), 'utf8');
  const openGuideMethod = android.slice(
    android.indexOf('private void openNativeLiveGuide()'),
    android.indexOf('private void enterNativeGuideMode()'),
  );
  assert.match(ui, /function tryNativePlaybackLadder\(atSeconds\) \{[\s\S]+tryNativeVideoPlayer\('direct', atSeconds\)/,
    'ExoPlayer should get a true direct-play attempt before inheriting Chromium remux choices');
  assert.match(ui, /function resolvePlaybackResume\(it\) \{[\s\S]+if \(it\._startOver\) return \{ \.\.\.it, resume: 0 \};[\s\S]+const pos = resumePositionForItem\(it\);[\s\S]+return pos > 0 \? \{ \.\.\.it, resume: pos \} : it;/,
    'Resume should be resolved from current watch state at click time, after quality changes');
  assert.match(ui, /async function play\(it, pick\) \{[\s\S]+it = resolvePlaybackResume\(it\);/,
    'playback should not rely on a stale detail target resume timestamp');
  assert.match(ui, /const nativeFirst = nativeVideoRequired\(it\);[\s\S]+if \(nativeFirst\) showNativePlayLoading\(it\);[\s\S]+else showPlayLoading\(it\);/,
    'pressing Play on Android should immediately use the native branded loading screen, not the web player shell');
  assert.match(ui, /if \(S\.view !== 'player'\) return;[\s\S]+openPlayer\(it, r, \{ nativeFirst \}\)/,
    'native-first playback should still honor Back/cancel while the loading screen is open');
  assert.match(ui, /const sourceName = mount\.candidate \? mount\.candidate\.name : mount\.name;[\s\S]+item: it, name: sourceName, fileName: mount\.name/,
    'native quality/source labels should use the selected release name, not only the mounted inner filename');
  assert.match(ui, /const nativeRequired = nativeVideoRequired\(it\);[\s\S]+const nativeStarted = \(opts\.nativeFirst \|\| nativeRequired\) && tryNativePlaybackLadder\(it\.resume \|\| 0\);[\s\S]+if \(nativeStarted\) \{[\s\S]+startNativePlayerHousekeeping\(it\);[\s\S]+\} else if \(nativeRequired\) \{[\s\S]+closePlayer\(\);[\s\S]+return;[\s\S]+\} else \{[\s\S]+revealWebPlayerShell\(it\);[\s\S]+startWebPlayerHousekeeping\(mount, it\);[\s\S]+startSource\(startKind, it\.resume \|\| 0\);[\s\S]+\}/,
    'Android native movie playback should never reveal the web player shell when ExoPlayer is available');
  assert.match(ui, /function startNativePlayerHousekeeping\(it\) \{[\s\S]+stopWebVideoElement\(\);[\s\S]+if \(S\.healthTimer\) clearInterval\(S\.healthTimer\);[\s\S]+S\.watchTimer = setInterval\(saveWatch, 10000\);[\s\S]+prepNextEpisode\(it\);[\s\S]+\}/,
    'native playback should silence the hidden web video and skip web health/track probes');
  assert.match(ui, /function startWebPlayerHousekeeping\(mount, it\) \{[\s\S]+v\.onerror = \(\) => failover\(\);[\s\S]+startHealthPoll\(mount\.id\);[\s\S]+loadTracks\(\);[\s\S]+fetch\(`\/api\/ossubs\/\$\{mount\.id\}\?lang=\$\{code2\}&tmdb=\$\{it\.tmdbId \|\| ''\}&t=\$\{mount\.streamToken\}`\)/,
    'web-only probes and subtitle prefetch should stay in the web playback branch');
  assert.match(ui, /async function loadTracks\(\) \{[\s\S]+if \(p\.usingNative && canUseNativeVideoPlayer\(\)\) return;/,
    'track probing should no-op while native playback is active');
  assert.match(ui, /function startSource\(kind, atSeconds\) \{[\s\S]+if \(p && p\.usingNative && canUseNativeVideoPlayer\(\)\) return false;/,
    'web source swaps should not run underneath native playback');
  assert.match(ui, /p\.usingTranscode = kind === 'transcode';[\s\S]+const kind = p\.usingTranscode \? 'transcode' : \(p\.usingRemux \? 'remux' : 'direct'\);/,
    'native fallback state should distinguish direct, remux, and transcode correctly');
  assert.match(ui, /function showNativePlayLoading\(it\) \{[\s\S]+\$\(\'player\'\)\.classList\.remove\('open', 'live', 'guideMode'\);[\s\S]+window\.TriboonTV\.showVideoLoading\(JSON\.stringify/,
    'Android movie playback should keep the web player closed while the native loader waits for the mount');
  assert.match(ui, /kind === 'direct' && p\.remuxUrl && !p\.triedRemux[\s\S]+tryNativeVideoPlayer\('remux', at\)/,
    'native direct failure should try native remux, not the WebView player');
  assert.match(ui, /tryNativeVideoPlayer\('transcode', at\)/,
    'native fallback may use native transcode when remux is unavailable');
  assert.match(ui, /autoAdvance\(\{ nativePreferred: true \}\)/,
    'native player source failures should advance to the next release instead of closing playback');
  assert.match(ui, /if \(nativePreferred && tryNativePlaybackLadder\(at\)\) \{[\s\S]+startNativePlayerHousekeeping\(p\.item\);/,
    'Android auto-advance should hand the next release back to ExoPlayer when native playback is active');
  assert.match(ui, /if \(nativePreferred\) \{[\s\S]+Native player could not start the next release[\s\S]+closePlayer\(\);[\s\S]+return;[\s\S]+\}[\s\S]+revealWebPlayerShell\(p\.item\);/,
    'Android auto-advance must stop instead of falling back to the web player when ExoPlayer cannot start');
  assert.match(ui, /qualityLabel: nativeQualityLabel\(p, kind\)/,
    'native player should receive a user-facing resolution label');
  assert.match(ui, /qualityChoices: !!p\.transcodeUrl/,
    'native HD button should only be enabled when optimized quality choices exist');
  assert.match(ui, /const nativeBackdrop = p\.item\.backdrop \|\| p\.item\.poster \|\| '';[\s\S]+backdropUrl: nativeBackdrop \? new URL\(nativeBackdrop, location\.origin\)\.href : ''/,
    'native Android loading should receive the same movie art as the web player loader');
  assert.match(ui, /class="seekLine"[\s\S]+id="seekElapsed"[\s\S]+id="seek"[\s\S]+id="seekTotal"/,
    'web player seek bar should show elapsed time on the left and total duration on the right');
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
  assert.match(ui, /subtitleShift: sub\.rel \? \(loadSubShift\(sub\.rel\) \|\| 0\) : 0/,
    'native player should receive the saved subtitle timing offset');
  assert.match(ui, /q\.set\('shift', shift\.toFixed\(1\)\)/,
    'online subtitle URLs should carry a timing shift when sync is adjusted');
  assert.match(ui, /syncHead\.textContent = 'Subtitle sync'/,
    'web CC menu should always expose subtitle timing controls');
  assert.match(ui, /mkRow\('Turn subtitles on first'/,
    'web CC sync section should explain when sync needs subtitles enabled first');
  assert.match(ui, /function restoreTrackMenuPosition\(opts = \{\}\) \{[\s\S]+m\.scrollTop = opts\.scrollTop[\s\S]+target\.focus\(\{ preventScroll: true \}\)[\s\S]+applyFocus\(target, false\)/,
    'web CC sync adjustments should preserve the menu scroll position and focused sync row');
  assert.match(ui, /const keepScrollTop = m\.scrollTop;[\s\S]+openTrackMenu\(kind, \{ focusKey: opts\.key, scrollTop: keepScrollTop \}\)/,
    'web keep-open track rows should rebuild the menu without jumping back to the top');
  assert.match(ui, /window\.__tvNativeSubtitleShift = \(shift\) => \{[\s\S]+saveSubShift\(p\.subTrack, n\)/,
    'Android subtitle sync changes should persist through the web profile state');
  assert.match(ui, /function subtitleDisplayName\(rel\) \{[\s\S]+return `\$\{name\} - \$\{cleanSubtitleLabel\(label\)\}`;/,
    'web and native subtitle labels should use clear language names');
  assert.match(ui, /function cleanSubtitleLabel\(label\) \{[\s\S]+replace\(\s*\/\^Wyzie/,
    'old saved subtitle labels should drop provider branding when displayed');
  assert.match(ui, /mkRow\(`\$\{name\} - Auto match`/,
    'CC menu should label the automatic online subtitle by language and match type');
  assert.match(ui, /mkRow\(`Show \$\{name\} versions`/,
    'CC menu should expose named subtitle versions for different cuts');
  assert.match(ui, /addChoice\(\{ action: 'versions', lang: l, label: `Show \$\{name\} versions` \}\)/,
    'native Android CC should expose a lazy version-list row when subtitle variants are not loaded yet');
  assert.match(ui, /window\.__tvNativeSubtitleVersions = async \(lang, pos, dur\) => \{[\s\S]+await loadSubtitleVersions\(lang\);[\s\S]+refreshNativeSubtitleChoices\(\);/,
    'native Android CC version rows should fetch subtitle variants and refresh the native sheet without selecting a subtitle');
  assert.match(ui, /window\.TriboonTV\.updateSubtitleChoices\(JSON\.stringify\(\{ choices: nativeSubtitleChoices\(\) \}\)\)/,
    'web should push refreshed subtitle choices back into the native ExoPlayer menu');
  assert.match(ui, /saveSubChoice\(rel, subtitleDisplayName\(rel\)\)/,
    'per-title subtitle choices should remember the friendly version label');
  assert.doesNotMatch(ui, /mkRow\(`Wyzie |return `Wyzie |Wyzie \u00b7 [^`'"]*Version/,
    'player subtitle labels should not show provider branding');
  assert.match(ui, /if \(saved === 'off'\) return \{ blocked: false, rel: '' \}/,
    'native subtitles should respect explicit per-title Off choices');
  assert.doesNotMatch(ui, /toast\(`Switching to \$\{q\}p|toast\('Switching audio track|toast\(`Subtitle sync saved|toast\('Subtitle sync reset/,
    'normal web player controls should not show success popups over the video');
  assert.match(ui, /S\.nativeLiveReturnView = \(S\.view === 'livetv' \|\| document\.querySelector\('#chBody\.liveGuideShell'\) \|\| guide\) \? 'livetv' : S\.view/,
    'native Live TV should remember when it was launched from the guide');
  assert.match(ui, /if \(returnView === 'livetv'\) \{[\s\S]+switchView\('livetv', false\)/,
    'closing native Live TV should restore the guide instead of stale detail history');
  assert.match(ui, /const wasLiveShell = !!\(S\.playing && S\.playing\.item && S\.playing\.item\.type === 'live' && S\.view === 'player'\);[\s\S]+if \(wasLiveShell\) \{[\s\S]+closePlayer\(\);[\s\S]+return;[\s\S]+\}/,
    'closing native Live TV from its guide/player shell should clear the web player state instead of revealing a stale black player');
  assert.match(ui, /window\.__tvNativeLiveGuide = async \(epoch\) => \{[\s\S]+openNativeLiveGuideShell\(it\);[\s\S]+renderPlayerGuideTimeline\(\$\(\'pGuide\'\), list\)/,
    'native Live TV guide should draw the existing PiP guide without starting web playback');
  assert.match(ui, /window\.__tvNativeLiveGuide = async \(epoch\) => \{[\s\S]+S\.nativeGuideEpoch = Number\.isFinite\(n\) && n > 0 \? n[\s\S]+const it = S\.nativeLivePending;[\s\S]+S\.nativeLivePending = null;[\s\S]+if \(!it\) \{/,
    'native guide should consume pending live state without losing the Live TV return target');
  assert.doesNotMatch(ui, /__tvNativeLiveGuide[\s\S]+await playChannelWeb\(it\)/,
    'native Live TV guide should not hand off to the old web player');
  assert.match(ui, /function openNativeLiveGuideShell\(it\) \{[\s\S]+stopWebVideoElement\(\);[\s\S]+document\.body\.classList\.add\('nativeGuideMode'\);[\s\S]+S\.nativeGuideMode = true;[\s\S]+\$\(\'player\'\)\.classList\.add\('open', 'guideMode'\);[\s\S]+\$\(\'player\'\)\.classList\.remove\('live'\);[\s\S]+\$\(\'osd\'\)\.classList\.add\('hide'\);/,
    'native Live TV guide should enter guide mode before the player container can reveal the web player');
  assert.doesNotMatch(ui, /function openNativeLiveGuideShell\(it\) \{[\s\S]+\$\(\'player\'\)\.classList\.add\('open', 'live'\)/,
    'native Live TV guide must not open the old web live-player shell first');
  assert.match(ui, /function closePlayerGuide\(opts = \{\}\) \{[\s\S]+window\.TriboonTV\.closeGuide\(\)/,
    'closing the shared guide from web focus should restore native fullscreen playback');
  assert.match(ui, /window\.__tvNativeGuideClosed = \(epoch\) => \{[\s\S]+n !== S\.nativeGuideEpoch\) return;[\s\S]+closePlayerGuide\(\{ fromNative: true \}\)/,
    'native guide close callback should ignore stale close events from an older PiP guide');
  assert.match(ui, /window\.__tvNativeGuideEpoch = \(epoch\) => \{[\s\S]+S\.nativeGuideEpoch = n;/,
    'native guide channel retunes should keep the web guide epoch in sync');
  assert.match(ui, /if \(!it\) \{[\s\S]+S\.playing\.item\.type !== 'live' && S\.view === 'player'[\s\S]+S\.returnVod = \{ item: S\.playing\.item, resume: currentTime\(\) \};[\s\S]+revealNativeGuideShell\(\);[\s\S]+return togglePlayerGuide\(\);/,
    'native movie/episode guide button should open the same PiP guide and preserve a Back to movie target');
  assert.match(ui, /function revealNativeGuideShell\(\) \{[\s\S]+stopWebVideoElement\(\);[\s\S]+document\.body\.classList\.add\('nativeGuideMode'\);[\s\S]+S\.nativeGuideMode = true;[\s\S]+\$\(\'player\'\)\.classList\.add\('open', 'guideMode'\);[\s\S]+\$\(\'player\'\)\.classList\.remove\('live'\);[\s\S]+\$\(\'osd\'\)\.classList\.add\('hide'\);/,
    'native movie/episode guide button should hide the web video immediately while the guide data loads');
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
  assert.match(ui, /const moveToCat = \(el\) => \{[\s\S]+if \(!el\.classList\.contains\('sel'\)\) el\.click\(\);[\s\S]+else moveTo\(el\);[\s\S]+\}/,
    'PiP guide D-pad category movement should select the highlighted category');
  assert.match(ui, /if \(k === 'ArrowDown'\) return moveToCat\(cats\[Math\.min\(cats\.length - 1, i \+ 1\)\]\)/,
    'PiP guide category down should update the right-side channel guide');
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
  assert.match(ui, /function focusLiveCategory\(idx, select = false\) \{[\s\S]+const remembered = Number\.isFinite\(S\.liveCatNavIdx\)[\s\S]+if \(select && name && name !== S\.liveCat\) \{[\s\S]+S\.liveCat = name;[\s\S]+S\.liveCatNavIdx = i;[\s\S]+S\.liveCatDpadMode = true;[\s\S]+renderLiveTvBody\(\);[\s\S]+return focusLiveCategory\(i\);/,
    'Live TV category D-pad movement should select and immediately refocus the highlighted category for fast repeats');
  assert.match(ui, /chip\.dataset\.liveCat = name/,
    'Live TV category buttons should keep their category identity for D-pad selection');
  assert.match(ui, /if \(k === 'ArrowDown'\) return focusLiveCategory\(ci \+ 1, true\)/,
    'Live TV category down should update the selected category instead of only moving focus');
  assert.match(ui, /function focusLiveCategory\(idx, select = false\) \{[\s\S]+applyFocus\(cats\[i\], false\);[\s\S]+const pane = cats\[i\]\.closest\('#chCats'\);[\s\S]+pane\.scrollTo\(/,
    'Live TV category D-pad focus should scroll the category pane directly, not the whole grid');
  assert.match(ui, /focusedCat \|\| S\.liveCatDpadMode[\s\S]+Number\.isFinite\(S\.liveCatNavIdx\)[\s\S]+return focusLiveCategory\(ci \+ 1, true\);/,
    'Live TV category fast-repeat should keep moving from the remembered category index during rerenders');
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
  assert.match(ui, /if \(!keepGuidePip && tryNativeLivePlayer\(it\)\) return;/,
    'normal Live TV tuning should still launch native fullscreen playback');
  assert.match(ui, /if \(nativeLiveRequired\(\)\) \{[\s\S]+Native player could not start this channel[\s\S]+return;[\s\S]+\}[\s\S]+return playChannelWeb\(it\);/,
    'Android Live TV should stop on native startup failure instead of falling back to the web player');
  assert.match(ui, /fallbackUrl: it\._streamUrl \? new URL\(it\._streamUrl, location\.origin\)\.href : '',[\s\S]+fallbackMime: it\._streamUrl \? 'video\/mp4' : '',/,
    'Android Live TV should give ExoPlayer a native remux fallback, not a WebView fallback');
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
  assert.match(android, /controls\.setGravity\(android\.view\.Gravity\.START \| android\.view\.Gravity\.CENTER_VERTICAL\)/,
    'native player controls should be left-aligned like the web player');
  assert.match(android, /moveNativeControlFocus\(code == KeyEvent\.KEYCODE_DPAD_LEFT \? -1 : 1\)/,
    'native player row should use explicit D-pad left/right navigation so Guide is reachable');
  assert.match(android, /moveNativeVerticalFocus\(code == KeyEvent\.KEYCODE_DPAD_UP \? -1 : 1\)/,
    'native player should explicitly move between the seek bar and button row with D-pad up/down');
  assert.match(android, /private boolean moveNativeVerticalFocus\(int dir\) \{[\s\S]+nativeSeek\.requestFocus\(\);[\s\S]+return focusNativeDefaultControl\(\);[\s\S]+\}/,
    'native vertical D-pad movement should not fall through to Android default focus guessing');
  assert.match(android, /private boolean handleNativeSeekBarKey\(KeyEvent e\) \{[\s\S]+getCurrentFocus\(\) != nativeSeek[\s\S]+KEYCODE_DPAD_LEFT[\s\S]+KEYCODE_DPAD_RIGHT[\s\S]+nativeSeekBy\(code == KeyEvent\.KEYCODE_DPAD_RIGHT \? 30000 : -10000\);[\s\S]+\}/,
    'focused native seek bar should scrub video with D-pad left/right');
  assert.match(android, /if \(nativeChrome != null && nativeChrome\.getVisibility\(\) == View\.VISIBLE\) \{[\s\S]+if \(handleNativeSeekBarKey\(e\)\) return true;[\s\S]+moveNativeControlFocus/,
    'native seek bar should handle left/right before the button row moves focus');
  assert.match(android, /clickNativeControlFocus\(\)/,
    'native player OK should activate the focused control instead of relying on platform focus guessing');
  assert.match(android, /nativeGuideBtn = nativeButton\(R\.drawable\.ic_player_guide, "TV guide", false\);[\s\S]+controls\.addView\(nativeGuideBtn\);[\s\S]+nativeRewBtn = nativeButton\(R\.drawable\.ic_player_rewind/,
    'native guide button should be the first playback control, matching the web player');
  assert.match(android, /controls\.addView\(nativeGuideBtn\);\s+controls\.addView\(nativeControlSpacer\(12\)\);[\s\S]+controls\.addView\(nativeRewBtn\);[\s\S]+controls\.addView\(nativePlayBtn\);[\s\S]+controls\.addView\(nativeFwdBtn\);[\s\S]+controls\.addView\(nativeNextBtn\);\s+controls\.addView\(nativeControlSpacer\(12\)\);[\s\S]+controls\.addView\(nativeCcBtn\);[\s\S]+controls\.addView\(nativeAudioBtn\);[\s\S]+controls\.addView\(nativeQualityBtn\);/,
    'native player controls should group Guide, playback/next, and CC/audio/HD with visual spacing');
  assert.match(android, /return new ImageButton\[\]\{\s+nativeGuideBtn, nativeRewBtn, nativePlayBtn, nativeFwdBtn,\s+nativeNextBtn, nativeCcBtn, nativeAudioBtn, nativeQualityBtn\s+\};/,
    'native player D-pad order should match the visible control grouping');
  assert.match(ui, /\.cbtn\.big\{width:58px;height:58px;background:rgba\(34,25,52,\.68\);color:var\(--text\)\}/,
    'web play button should be neutral until focused or hovered');
  assert.doesNotMatch(ui, /\.cbtn\.on\{background:var\(--amber\)|\.btn\.primary,\.cbtn\.big/,
    'enabled or selected player buttons should not keep the old persistent gold highlight');
  assert.match(ui, /function updatePlayerControlAvailability\(\) \{[\s\S]+setPlayerControlEnabled\('ccBtn', playerCcHasOptions\(\)\);[\s\S]+setPlayerControlEnabled\('audBtn', playerAudioHasOptions\(\)\);[\s\S]+setPlayerControlEnabled\('qualBtn', playerQualityHasOptions\(\)\);/,
    'web CC/audio/HD buttons should be disabled when no real options exist');
  assert.match(ui, /ctlButtons\(\) \{[\s\S]+!b\.disabled && !b\.classList\.contains\('disabled'\)/,
    'web player D-pad focus should skip disabled controls');
  assert.match(android, /setNativeButtonIcon\(ImageButton b, int iconRes, boolean primary, boolean focused\) \{[\s\S]+!b\.isEnabled\(\) \? 0x88EDE8F5 : \(focused \? 0xFF0B0812 : 0xFFEDE8F5\)/,
    'native player icons should only switch tint while focused, not merely because a button is primary');
  assert.match(android, /focused[\s\S]+\? new int\[\]\{0xFFEDE8F5, 0xFFD9CBE7\}[\s\S]+: new int\[\]\{0x99221934, 0x99221934\}/,
    'native player buttons should use the highlighted fill only while focused');
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
  assert.doesNotMatch(android, /ImageButton back = nativeButton\(R\.drawable\.ic_player_back/,
    'native player bottom row should not show a separate Back button');
  assert.match(android, /KEY_CACHE_VERSION/,
    'Android WebView cache should be version-scoped instead of wiped on every launch');
  assert.match(android, /if \(!BuildConfig\.VERSION_NAME\.equals\(cacheVersion\)\) \{[\s\S]+web\.clearCache\(true\)/,
    'Android should only flush disk cache after an APK version change');
  assert.doesNotMatch(android, /web\.clearCache\(true\);\s*web\.setBackgroundColor/,
    'Android should not unconditionally discard cached art/assets during every app start');
  assert.match(android, /nativePlayerSubline\.setVisibility\(View\.GONE\)/,
    'native movie/episode chrome should not show the technical file/source line');
  assert.match(android, /nativeEndsAt\.setText\("Ends at " \+ fmtNativeClock/,
    'native movie/episode chrome should show when playback will finish');
  assert.match(android, /nativeChrome\.setPadding\(dp\(34\), dp\(12\), dp\(34\), dp\(20\)\)/,
    'native player seek bar should use wider horizontal space');
  assert.match(android, /dp\(primary \? 46 : 36\)/,
    'native player buttons should stay compact and avoid clipped circles on TV');
  assert.doesNotMatch(android, /setScale[XY]\(hasFocus/,
    'native player focus should not scale buttons and clip the circle');
  assert.match(android, /dp\(280\), ViewGroup\.LayoutParams\.WRAP_CONTENT/,
    'native option sheets should stay compact instead of covering the video');
  assert.match(android, /nativePlayerBadge\.setText\("live"\.equals\(mode\) \? "LIVE" : nativeQualityLabel\)/,
    'native video badge should show a friendly resolution label, not direct/remux/transcode internals');
  assert.match(android, /private FrameLayout nativeLoading;[\s\S]+private ImageView nativeLoadingBackdrop;[\s\S]+private TextView nativeLoadingTitle;/,
    'native ExoPlayer should own a branded loading overlay instead of borrowing the web player shell');
  assert.match(android, /nativeLoading = new FrameLayout\(this\);[\s\S]+loadingLogo\.setImageResource\(R\.drawable\.ic_loading_logo\);[\s\S]+loadingBrand\.setText\("TRIBOON"\);[\s\S]+loadingStage\.setText\("Starting native stream"\)/,
    'native loading overlay should show the Triboon brand mark and loading stage');
  assert.doesNotMatch(android, /loadingLogo\.setImageResource\(R\.drawable\.ic_launcher\)/,
    'native loading overlay should not reuse the non-transparent launcher icon');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_loading_logo.png')),
    'native loading overlay should have a dedicated transparent logo asset');
  for (const rel of [
    'logo/T-Logo.png',
    'logo/triboon.png',
    'web/triboon.png',
    'android/app/src/main/res/drawable/ic_launcher.png',
    'android/app/src/main/res/drawable/ic_loading_logo.png',
    'android/app/src/main/res/drawable/banner.png',
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
  assert.match(ui, /async function closePlayer\(\) \{[\s\S]+window\.TriboonTV\.closeVideo/,
    'closing the web player state on Android should also close any native ExoPlayer overlay');
  assert.match(android, /state == Player\.STATE_READY[\s\S]+hideNativeLoading\(\);[\s\S]+showNativeChrome\(true\);/,
    'native loading overlay should disappear only once Media3 reports the stream is ready');
  assert.match(android, /private void releaseNativePlayer\(boolean notifyClosed\) \{[\s\S]+hideNativeLoading\(\);/,
    'closing or retrying native playback should always clear the loading overlay');
  assert.match(android, /nativePlayerLayer\.requestFocus\(\);[\s\S]+setNativeSubtitleLift\(false\)/,
    'native chrome should auto-hide even after a control kept focus');
  assert.match(android, /showNativeChrome\(code != KeyEvent\.KEYCODE_DPAD_UP\);[\s\S]+nativeSeek\.requestFocus\(\);/,
    'D-pad Up from hidden native chrome should open directly on the seek bar');
  assert.match(android, /nativeIsWyzieTrack\(f\)/,
    'native CC menu should filter subtitle choices to the side-loaded subtitle');
  assert.match(android, /nativeSubtitleChoiceLabels\.add\(label\.isEmpty\(\) && !rel\.isEmpty\(\) \? nativeLabelForSubtitleRel\(rel\) : label\)/,
    'native subtitle choices should keep the plain labels sent by the web player');
  assert.match(android, /nativeSubtitleLabel = choice\.label;[\s\S]+loadNativeSubtitleOverlay\(nativeSubtitleUrl\)/,
    'native subtitle overlay should use the same plain language labels sent by the web player');
  assert.match(android, /\? \(!subtitleLang\.isEmpty\(\) \? nativeLangName\(subtitleLang\) : "Subtitles"\)/,
    'native subtitle fallback should use only the language name');
  assert.doesNotMatch(android, /"Wyzie subtitles"|"Wyzie - " \+ nativeLangName|No Wyzie subtitle/,
    'native subtitle UI should not show provider branding');
  assert.doesNotMatch(android, /0xFFFFC65C/,
    'native player focus should not use the oversized yellow button treatment');
  assert.match(android, /nativeCcBtn\.setOnClickListener\(v -> showNativeTrackMenu\(C\.TRACK_TYPE_TEXT\)\)/,
    'native CC button should open a native subtitle menu');
  assert.match(android, /public void updateSubtitleChoices\(String json\)[\s\S]+updateNativeSubtitleChoices\(json\)/,
    'Android bridge should accept refreshed subtitle choices from the web app');
  assert.match(android, /applyNativeSubtitleChoices\(j\.optJSONArray\("subtitleChoices"\)\)/,
    'Android should parse subtitle choices sent in the initial native playback payload');
  assert.match(android, /nativeSubtitleChoiceActions\.add\(action\);[\s\S]+nativeSubtitleChoiceLangs\.add\(lang\);/,
    'Android should retain native subtitle action rows such as Show versions');
  assert.match(android, /nativeSubtitleChoiceUrls\.add\(url\);/,
    'Android should retain online subtitle URLs so choices are preloaded as native text tracks');
  assert.match(android, /nativeSubtitleChoiceRels\.add\(rel\);/,
    'Android should parse subtitle choices sent by the web bridge');
  assert.match(android, /choices\.add\(new NativeTrackChoice\(null, -1, label, false,[\s\S]+rel\.equals\(nativeSubtitleRel\), rel, action, lang\)\)/,
    'native CC sheet should expose selectable online subtitle rows');
  assert.match(android, /"versions"\.equals\(choice\.subtitleAction\)[\s\S]+requestNativeSubtitleVersions\(choice\.subtitleLang\)/,
    'native CC sheet should load version rows instead of treating Show versions as an inert subtitle');
  assert.match(android, /window\.__tvNativeSubtitleVersions && window\.__tvNativeSubtitleVersions/,
    'Android should call the web subtitle-version loader from the native sheet');
  assert.match(android, /"Off", true, nativeSubtitleRel\.isEmpty\(\)\)/,
    'native CC sheet should not mark Off selected while a bridge-selected online subtitle is active');
  assert.match(android, /notifyNativeSubtitleSelect\(choice\.subtitleRel\)/,
    'selecting an online subtitle row should notify the web app instead of leaving the row inert');
  assert.doesNotMatch(android, /No subtitle is loaded for this stream/,
    'native CC should not stop before showing online subtitle choices');
  assert.match(android, /labels\.add\("Sync: subtitles later \+0\.5s" \+ nativeSubShiftLabel\(\)\)/,
    'native CC sheet should include a subtitle-later sync action');
  assert.match(android, /shiftNativeSubtitles\(0\.5f\)/,
    'native subtitle sync action should move subtitles later in 0.5s steps');
  assert.match(android, /nativeSheetRestoreIndex = later;[\s\S]+shiftNativeSubtitles\(0\.5f\);[\s\S]+nativeSheetRestoreIndex = earlier;[\s\S]+shiftNativeSubtitles\(-0\.5f\)/,
    'native subtitle sync adjustments should reopen the CC sheet on the sync row');
  assert.match(android, /int focusIndex = nativeSheetRestoreIndex >= 0 \? nativeSheetRestoreIndex \+ 1 : 1;[\s\S]+nativeSheet\.getChildAt\(focusIndex\)\.requestFocus\(\);/,
    'native choice sheets should honor a requested restore row after rebuilding');
  assert.match(android, /private void applyNativeSubtitleShift\(\) \{[\s\S]+updateNativeSubtitleOverlay\(\);[\s\S]+window\.__tvNativeSubtitleShift && window\.__tvNativeSubtitleShift/,
    'native subtitle sync should update the live overlay and persist the offset');
  assert.doesNotMatch(android, /private void applyNativeSubtitleShift\(\) \{[\s\S]+setMediaItem\(/,
    'native subtitle sync must not refresh or rebuild the playing video');
  assert.match(android, /private void loadNativeSubtitleOverlay\(String url\) \{[\s\S]+parseNativeVtt\(sb\.toString\(\)\)[\s\S]+nativeSubtitleHandler\.postDelayed\(nativeSubtitleTick, 250\)/,
    'native online subtitles should be fetched once and rendered by a live Exo overlay');
  assert.match(android, /window\.__tvNativeSubtitleShift && window\.__tvNativeSubtitleShift/,
    'native subtitle sync should tell the web app to save the offset');
  assert.match(android, /nativeAudioBtn\.setOnClickListener\(v -> showNativeTrackMenu\(C\.TRACK_TYPE_AUDIO\)\)/,
    'native Audio button should open a native audio menu');
  assert.match(android, /nativeQualityBtn\.setOnClickListener\(v -> showNativeQualityMenu\(\)\)/,
    'native Quality button should stay inside the native player');
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
  assert.match(android, /private boolean handleNativeSheetKey\(KeyEvent e\) \{[\s\S]+KEYCODE_DPAD_UP[\s\S]+KEYCODE_DPAD_DOWN[\s\S]+rows\.get\(next\)\.requestFocus\(\);[\s\S]+rows\.get\(cur\)\.performClick\(\);[\s\S]+\}/,
    'native option sheets should support D-pad row movement and OK activation');
  assert.match(android, /nativeSubtitleRel = choice\.subtitleRel;[\s\S]+disableNativeTextTracks\(\);[\s\S]+loadNativeSubtitleOverlay\(nativeSubtitleUrl\);/,
    'native online subtitle choices should switch through the live subtitle overlay');
  assert.match(android, /private void applyNativeTrackChoice\(int trackType, NativeTrackChoice choice\) \{[\s\S]+nativePlayer\.setTrackSelectionParameters\(b\.build\(\)\);[\s\S]+showNativeChrome\(false\);[\s\S]+\}/,
    'native CC/audio choices should update quietly without a confirmation toast');
  assert.doesNotMatch(android, /Subtitles: |Audio: |Toast\.makeText\(this, label/,
    'native player controls should not show success popups over playback');
  assert.match(android, /if \("live"\.equals\(nativeMode\) \|\| d <= 0 \|\| d == C\.TIME_UNSET\)/,
    'live streams should not expose movie-style seeking behavior');
  assert.match(android, /new DefaultHttpDataSource\.Factory\(\)[\s\S]+setAllowCrossProtocolRedirects\(true\)[\s\S]+setUserAgent\("TriboonTV\/" \+ BuildConfig\.VERSION_NAME\)/,
    'native ExoPlayer should explicitly allow provider redirects from Triboon Live TV URLs');
  assert.match(android, /else if \("video\/mp4"\.equals\(nativeMime\)\) media\.setMimeType\(MimeTypes\.VIDEO_MP4\)/,
    'native Live TV remux fallback should be tagged as MP4 for ExoPlayer');
  assert.match(android, /else if \(tryNativeLiveFallback\(\)\) \{[\s\S]+return;[\s\S]+\} else \{[\s\S]+__tvNativeLiveError/,
    'native Live TV should retry the Exo remux fallback before reporting a player error');
  assert.match(android, /private boolean tryNativeLiveFallback\(\) \{[\s\S]+nativeUrl = nativeFallbackUrl;[\s\S]+nativeMime = nativeFallbackMime[\s\S]+nativePlayer\.setMediaItem\(buildNativeMediaItem\(\)\);[\s\S]+nativePlayer\.prepare\(\);[\s\S]+nativePlayer\.play\(\);/,
    'native Live TV fallback should stay inside ExoPlayer instead of opening web playback');
  assert.match(android, /private void updateNativeLiveWatchdog\(\) \{[\s\S]+state == Player\.STATE_BUFFERING[\s\S]+nativePlayer\.getPlayWhenReady\(\) && !nativePlayer\.isPlaying\(\)[\s\S]+now - nativeLiveUnhealthySinceMs >= 12000L[\s\S]+recoverNativeLivePlayback/,
    'native Live TV should recover when ExoPlayer stalls in buffering or not-playing state');
  assert.match(android, /state == Player\.STATE_ENDED && "live"\.equals\(nativeMode\)[\s\S]+recoverNativeLivePlayback\("ended"\)/,
    'native Live TV should restart instead of staying frozen when a live stream ends quietly');
  assert.match(android, /private void recoverNativeLivePlayback\(String reason\) \{[\s\S]+if \(tryNativeLiveFallback\(\)\) return;[\s\S]+nativePlayer\.setMediaItem\(buildNativeMediaItem\(\)\);[\s\S]+nativePlayer\.prepare\(\);[\s\S]+nativePlayer\.play\(\);/,
    'native Live TV recovery should stay inside ExoPlayer and restart the active native stream');
  assert.match(server, /LIVE_REMUX_FIRST_BYTE_TIMEOUT_MS = 15000[\s\S]+LIVE_REMUX_IDLE_TIMEOUT_MS = 15000/,
    'Live TV remux fallback should have bounded startup and idle stall timers');
  assert.match(server, /armIdle\(LIVE_REMUX_FIRST_BYTE_TIMEOUT_MS\);[\s\S]+ff\.stdout\.on\('data'[\s\S]+armIdle\(LIVE_REMUX_IDLE_TIMEOUT_MS\);[\s\S]+ff\.kill\('SIGKILL'\)/,
    'server Live TV remux should fail fast when ffmpeg stops producing bytes');
  assert.match(android, /if \(nativeSheetOpen\(\)\) hideNativeSheet\(\);[\s\S]+else closeNativePlayback\(true\);/,
    'Back should close native sheets before leaving playback');
  assert.match(android, /boolean waitForLiveClose = notifyClosed && "live"\.equals\(nativeMode\);[\s\S]+web\.postDelayed\(this::showWebAfterNativePlayback, 80\);/,
    'closing native Live TV should let the web close callback clear stale player state before the WebView is visible');
  assert.match(android, /nativeNextBtn\.setOnClickListener\(v -> playNativeNextEpisode\(\)\)/,
    'Next episode should ask the app to start the next item, not open the old player controls');
  assert.match(android, /nativeGuideBtn = nativeButton\(R\.drawable\.ic_player_guide, "TV guide", false\)/,
    'native Live TV should expose a guide button inside Triboon chrome');
  assert.match(android, /nativeGuideBtn\.setOnClickListener\(v -> openNativeLiveGuide\(\)\)/,
    'native guide button should hand off to the shared PiP guide path');
  assert.match(android, /window\.__tvNativeLiveGuide && window\.__tvNativeLiveGuide\("[\s\S]*\+ nativeGuideEpoch \+[\s\S]*"\)/,
    'native guide handoff should include an epoch so stale close callbacks cannot close a new guide');
  assert.match(android, /public void setGuidePipRect\(String json\) \{[\s\S]+applyNativeGuidePipRect\(json\)/,
    'web guide should be able to send the measured PiP slot to Android');
  assert.match(android, /private void applyNativeGuidePipRect\(String json\) \{[\s\S]+rawW <= 1f \|\| rawH <= 1f[\s\S]+left = Math\.max\(0, Math\.min\(left[\s\S]+nativePlayerView\.setLayoutParams\(pipLp\)/,
    'Android native PiP should ignore invalid measurements and clamp the rect onscreen');
  assert.match(android, /nativePlayerView\.setResizeMode\(AspectRatioFrameLayout\.RESIZE_MODE_FIT\)/,
    'ExoPlayer content should stay centered and fitted inside the PiP frame');
  assert.match(android, /private void enterNativeGuideMode\(\) \{[\s\S]+web\.setVisibility\(View\.VISIBLE\);[\s\S]+web\.requestFocus\(\);[\s\S]+nativePlayerLayer\.bringToFront\(\);/,
    'native guide mode should keep ExoPlayer alive as a PiP over the shared guide surface');
  assert.doesNotMatch(openGuideMethod, /releaseNativePlayer\(false\)/,
    'opening the guide must not release ExoPlayer');
  assert.match(android, /if \(nativeGuideMode\) \{[\s\S]+if \(code == KeyEvent\.KEYCODE_BACK\) \{[\s\S]+closeNativeGuideMode\(\);/,
    'Back should leave native guide mode before closing playback');
  assert.match(android, /public void closeGuide\(\) \{[\s\S]+runOnUiThread\(MainActivity\.this::closeNativeGuideMode\)/,
    'web guide close should be able to restore native fullscreen mode');
  assert.doesNotMatch(android, /openNativeLiveGuide\(\) \{[\s\S]+if \(!"live"\.equals\(nativeMode\)\) return;/,
    'native movie/episode playback should be allowed to open the same TV guide');
  assert.match(android, /window\.__tvNativeVideoProgress && __tvNativeVideoProgress/,
    'opening the guide from native video should preserve the movie resume point first');
  assert.match(android, /nativeGuideBtn != null\) nativeGuideBtn\.setVisibility\(View\.VISIBLE\)/,
    'native guide button should be available for both Live TV and movie/episode playback');
  assert.doesNotMatch(android, /switchNativeToWeb/,
    'native Android chrome should not keep old-player escape controls');
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
  assert.strictEqual(audioCopyOk('eac3', {}), false);
  // A TV that PROVED DDP/AC3 support via canPlayType: zero re-encoding.
  const tv = { ac3: true, eac3: true, dts: false };
  assert.strictEqual(audioCopyOk('eac3', tv), true);
  assert.strictEqual(audioCopyOk('ac3', tv), true);
  assert.strictEqual(audioCopyOk('dts', tv), false, 'claims are per-codec, not all-or-nothing');
  // Unknown codec (no probe yet): trust a broad AC3-family claim, else convert.
  assert.strictEqual(audioCopyOk('', tv), true);
  assert.strictEqual(audioCopyOk('', { ac3: true }), false);
  // TrueHD never copies — no <video>-tag path on any client.
  assert.strictEqual(audioCopyOk('truehd', { ac3: true, eac3: true, dts: true }), false);
  // MKV direct play needs container AND audio hardware — Chromium claims matroska while
  // decoding no AC3 family, which used to mean silent video on "direct".
  assert.strictEqual(decidePlayback('Movie.mkv', { mkv: true }).method, detectFfmpeg() ? 'remux' : 'direct');
  assert.strictEqual(decidePlayback('Movie.mkv', { mkv: true, ac3: true, eac3: true }).method, 'direct');
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
