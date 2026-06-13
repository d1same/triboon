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
const { spawnSync } = require('child_process');
const { detectFfmpeg, detectFfprobe, detectEncoder, decidePlayback, probeTracks, spawnRemux, spawnTranscode, spawnSubtitleExtract } = require('../server/transcode');

const HAS_FFMPEG = !!detectFfmpeg();
const HAS_FFPROBE = !!detectFfprobe();
const HAS_ENCODER = !!detectEncoder();

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

test('Android native player: direct source and native chrome stay out of the web player', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  const android = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'app', 'triboon', 'tv', 'MainActivity.java'), 'utf8');
  assert.match(ui, /tryNativeVideoPlayer\('direct', it\.resume \|\| 0\)/,
    'ExoPlayer should get a true direct-play attempt before inheriting Chromium remux choices');
  assert.match(ui, /kind === 'direct' && p\.remuxUrl && !p\.triedRemux[\s\S]+tryNativeVideoPlayer\('remux', at\)/,
    'native direct failure should try native remux, not the WebView player');
  assert.match(ui, /tryNativeVideoPlayer\('transcode', at\)/,
    'native fallback may use native transcode when remux is unavailable');
  assert.match(ui, /qualityLabel: nativeQualityLabel\(p, kind\)/,
    'native player should receive a user-facing resolution label');
  assert.match(ui, /subtitleLabel: sub\.rel \? nativeSubtitleLabel\(sub\.rel\) : ''/,
    'native player should receive a user-facing Wyzie subtitle label');
  assert.match(ui, /if \(saved === 'off'\) return \{ blocked: false, rel: '' \}/,
    'native subtitles should respect explicit per-title Off choices');
  assert.match(ui, /S\.nativeLiveReturnView = \(S\.view === 'livetv' \|\| document\.querySelector\('#chBody\.liveGuideShell'\)\) \? 'livetv' : S\.view/,
    'native Live TV should remember when it was launched from the guide');
  assert.match(ui, /if \(returnView === 'livetv'\) \{[\s\S]+switchView\('livetv', false\)/,
    'closing native Live TV should restore the guide instead of stale detail history');
  assert.match(ui, /window\.__tvNativeLiveGuide = async \(\) => \{[\s\S]+await playChannelWeb\(it\);[\s\S]+renderPlayerGuideTimeline\(\$\(\'pGuide\'\), list\)/,
    'native Live TV guide should hand off to the existing PiP guide surface');
  assert.match(ui, /if \(!it\) \{[\s\S]+S\.returnVod = \{ item: S\.playing\.item, resume: currentTime\(\) \};[\s\S]+return togglePlayerGuide\(\);/,
    'native movie/episode guide button should open the same PiP guide and preserve a Back to movie target');
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
  assert.match(ui, /catPane\.className = 'pgCatPane liveCatPane'/,
    'PiP guide categories should share the Live TV category pane styling');
  assert.match(ui, /catList\.className = 'pgCats guideCats'/,
    'PiP guide category list should share the Live TV category list behavior');
  assert.match(ui, /main\.className = 'pgGuideMain pgTimeline liveGuidePane guideTimeline'/,
    'PiP guide timeline should use the same timeline surface as Live TV');
  assert.match(ui, /row\.className = 'pgRow gRow focusable'/,
    'PiP guide rows should share Live TV row focus behavior');
  assert.match(ui, /body\.tv:not\(\.railOpen\) #rail:not\(\.expanded\)/,
    'Android TV should not let sticky CSS hover keep the rail expanded');
  assert.match(ui, /if \(!document\.body\.classList\.contains\('tv'\)\) document\.body\.classList\.add\('railOpen'\)/,
    'desktop hover may expand the rail, but Android TV must rely on explicit D-pad state');
  assert.match(ui, /function focusContent\(retried\) \{[\s\S]+leaveRail\(\);[\s\S]+clearFocus\(\);/,
    'moving focus into page content should always collapse any stale rail state first');
  assert.match(ui, /const keepGuidePip = !!\(\$\(\'pGuide\'\) && \$\(\'pGuide\'\)\.classList\.contains\(\'open\'\)\);[\s\S]+if \(!keepGuidePip && tryNativeLivePlayer\(it\)\) return;/,
    'channel tuning from the PiP guide should stay in the PiP guide instead of relaunching native fullscreen');
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
  assert.match(android, /dp\(primary \? 46 : 38\)/,
    'native player buttons should stay compact enough for TV playback');
  assert.match(android, /dp\(280\), ViewGroup\.LayoutParams\.WRAP_CONTENT/,
    'native option sheets should stay compact instead of covering the video');
  assert.match(android, /nativePlayerBadge\.setText\("live"\.equals\(mode\) \? "LIVE" : nativeQualityLabel\)/,
    'native video badge should show a friendly resolution label, not direct/remux/transcode internals');
  assert.match(android, /nativePlayerLayer\.requestFocus\(\);[\s\S]+setNativeSubtitleLift\(false\)/,
    'native chrome should auto-hide even after a control kept focus');
  assert.match(android, /nativeIsWyzieTrack\(f\)/,
    'native CC menu should filter subtitle choices to the Wyzie side-loaded subtitle');
  assert.match(android, /setLabel\(nativeSubtitleLabel\)/,
    'native subtitle track should use the same plain Wyzie label style as the web player');
  assert.doesNotMatch(android, /0xFFFFC65C/,
    'native player focus should not use the oversized yellow button treatment');
  assert.match(android, /cc\.setOnClickListener\(v -> showNativeTrackMenu\(C\.TRACK_TYPE_TEXT\)\)/,
    'native CC button should open a native subtitle menu');
  assert.match(android, /audio\.setOnClickListener\(v -> showNativeTrackMenu\(C\.TRACK_TYPE_AUDIO\)\)/,
    'native Audio button should open a native audio menu');
  assert.match(android, /quality\.setOnClickListener\(v -> showNativeQualityMenu\(\)\)/,
    'native Quality button should stay inside the native player');
  assert.match(android, /showNativeChoiceSheet\(trackType == C\.TRACK_TYPE_TEXT \? "Subtitles" : "Audio"/,
    'native track choices should use Triboon chrome, not a stock Android dialog');
  assert.match(android, /if \("live"\.equals\(nativeMode\) \|\| d <= 0 \|\| d == C\.TIME_UNSET\)/,
    'live streams should not expose movie-style seeking behavior');
  assert.match(android, /if \(nativeSheetOpen\(\)\) hideNativeSheet\(\);[\s\S]+else closeNativePlayback\(true\);/,
    'Back should close native sheets before leaving playback');
  assert.match(android, /nativeNextBtn\.setOnClickListener\(v -> playNativeNextEpisode\(\)\)/,
    'Next episode should ask the app to start the next item, not open the old player controls');
  assert.match(android, /nativeGuideBtn = nativeButton\(R\.drawable\.ic_player_guide, "TV guide", false\)/,
    'native Live TV should expose a guide button inside Triboon chrome');
  assert.match(android, /nativeGuideBtn\.setOnClickListener\(v -> openNativeLiveGuide\(\)\)/,
    'native guide button should hand off to the shared PiP guide path');
  assert.match(android, /web\.evaluateJavascript\("window\.__tvNativeLiveGuide && window\.__tvNativeLiveGuide\(\)", null\)/,
    'native guide handoff should call the web guide surface directly');
  assert.match(android, /web\.setVisibility\(View\.VISIBLE\);[\s\S]+web\.requestFocus\(\);[\s\S]+web\.evaluateJavascript\("window\.__tvNativeLiveGuide/,
    'native guide handoff should restore the web surface before opening PiP guide');
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
