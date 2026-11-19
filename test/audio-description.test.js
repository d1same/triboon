'use strict';
// Audio Description (a narrator describing the picture) is never picked by default (brief 121).
// Part 1: release scoring. Every title, group and file here is made up.

const { test } = require('node:test');
const assert = require('node:assert');
const { rankReleases, scoreRelease, isAudioDescriptionRelease } = require('../server/scoring');

const GB = 1e9;
const rel = (name, extra = {}) => ({ name, sizeBytes: 4 * GB, ...extra });

test('scoring: an Audio Description release loses to a normal release of the same quality', () => {
  const ad = rel('Prairie.Days.2026.with.Audio.Description.1080p.NF.WEB-DL.DDP5.1.H.264-Kettle');
  const plain = rel('Prairie.Days.2026.1080p.NF.WEB-DL.DDP5.1.H.264-SPWEB');
  const ranked = rankReleases([ad, plain], { maxResolutionRank: 4 });
  assert.strictEqual(ranked[0].name, plain.name);
  assert.ok(ranked.find((c) => c.name === ad.name).reasons.some((r) => /audio-description/.test(r)));
});

test('scoring: a normal release wins even against a higher-resolution or preferred Audio Description release', () => {
  const ad4k = rel('Winter.Paws.2026.Audio.Description.2160p.AMZN.WEB-DL.DDP5.1.H.265-Kettle', { sizeBytes: 12 * GB });
  const plain720 = rel('Winter.Paws.2026.720p.AMZN.WEB-DL.DDP5.1.H.264-NTb', { sizeBytes: 2 * GB });
  const ranked = rankReleases([ad4k, plain720], { maxResolutionRank: 4, preferResolutionRank: 4 });
  assert.strictEqual(ranked[0].name, plain720.name);
});

test('scoring: an Audio Description release still plays when it is the only one', () => {
  const ad = rel('Quiet.Harbor.2026.with.Audio.Description.1080p.NF.WEB-DL.DDP5.1.H.264-Kettle');
  const { score } = scoreRelease(ad, { maxResolutionRank: 4 });
  assert.ok(score > -5000, `still auto-playable (score ${score})`);
});

test('scoring: the usual Audio Description spellings are caught', () => {
  for (const name of [
    'Quiet.Harbor.2026.with.Audio.Description.1080p.WEB-DL.H.264-Kettle',
    'Quiet.Harbor.2026.Audio.Description.1080p.WEB-DL.H.264-Kettle',
    'Quiet.Harbor.2026.AudioDescription.1080p.WEB-DL.H.264-Kettle',
    'Quiet Harbor 2026 Audio Described 1080p WEB-DL H 264-Kettle',
    'Quiet_Harbor_2026_Audio_Description_1080p_WEB-DL-Kettle',
    'Quiet.Harbor.2026.1080p.WEB-DL.with.AD.DDP5.1.H.264-Kettle',
    'Quiet.Harbor.2026.Descriptive.Audio.1080p.WEB-DL.H.264-Kettle',
    'Quiet.Harbor.2026.Described.Video.1080p.WEB-DL.H.264-Kettle',
    'Quiet.Harbor.2026.1080p.WEB-DL.DVS.DDP5.1.H.264-Kettle',
    'quiet.harbor.2026.1080p.web-dl.with.audio.description.h264-kettle',
  ]) assert.strictEqual(isAudioDescriptionRelease(name), true, name);
});

test('scoring: no false positives on titles, groups or words that only contain AD', () => {
  for (const name of [
    'Ad.Astra.2019.1080p.BluRay.x264-SPARKS',
    'A.D.Kingdom.and.Empire.S01E01.1080p.WEB-DL.H.264-NTb',
    'The.Bad.Guys.2022.1080p.WEB-DL.DDP5.1.H.264-FLUX',
    'Headless.2026.1080p.WEB-DL.DDP5.1.H.264-FLUX',
    'Sudden.Departure.2026.1080p.WEB-DL.ADD.H.264-NTb',
    'Ready.Player.2026.1080p.WEB-DL.DDP5.1.H.264-ADWeb',
    'Quiet.Harbor.2026.1080p.WEB-DL.H.264-AD',
    'Quiet.Harbor.2026.1080p.WEB-DL.H.264-DVS',
    'Quiet.Harbor.2026.1080p.WEB-DL.DV.HDR.H.265-FLUX',
    'The.Description.2026.1080p.WEB-DL.H.264-FLUX',
    'Audio.2026.1080p.WEB-DL.H.264-FLUX',
    'Made.With.Love.2026.1080p.WEB-DL.H.264-FLUX',
  ]) assert.strictEqual(isAudioDescriptionRelease(name), false, name);
});

// Part 2: the default audio track. A test MKV (made here with ffmpeg) has two English tracks: the
// first titled "English - Audio Description" with the visual-impaired flag, the second plain.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { probeTracks, isAudioDescriptionTrack, defaultAudioTrack, detectFfmpeg, detectFfprobe } = require('../server/transcode');
const { mediaStreamsFromProbe } = require('../server/jellyfin-api');

const tracks = (...rows) => rows.map((r, rel) => ({ rel, codec: 'aac', channels: 2, ...r }));

test('tracks: Audio Description is told by its flag or title, and normal titles are not', () => {
  for (const t of [
    { title: 'English - Audio Description' }, { title: 'Audio Description' }, { title: 'English (AD)' },
    { title: 'English AD' }, { title: 'Descriptive Audio' }, { title: 'English Descriptive' },
    { title: 'Described Video' }, { title: 'Visually Impaired' }, { title: 'DVS' }, { title: 'AudioDescription' },
    { title: '', visualImpaired: true }, { title: 'English', visualImpaired: true },
  ]) assert.strictEqual(isAudioDescriptionTrack(t), true, JSON.stringify(t));
  for (const t of [
    { title: 'English' }, { title: '' }, {}, { title: 'Dolby Digital 5.1' }, { title: 'Director Commentary' },
    { title: 'Headphone Mix' }, { title: 'Stereo' }, { title: 'Radio Edit' }, { title: 'English Adult Swim' },
    { title: 'DTS-HD MA 5.1' }, { title: 'Ad-free mix' },
  ]) assert.strictEqual(isAudioDescriptionTrack(t), false, JSON.stringify(t));
});

test('tracks: the default is the first normal track in the wanted language', () => {
  const adFirst = tracks({ lang: 'eng', title: 'English - Audio Description', visualImpaired: true }, { lang: 'eng', title: 'English' });
  assert.strictEqual(defaultAudioTrack(adFirst), 1, 'the file language: skip the AD track');
  assert.strictEqual(defaultAudioTrack(adFirst, 'en'), 1, 'the viewer language: skip the AD track');
  const mixed = tracks({ lang: 'eng', title: 'AD', visualImpaired: true }, { lang: 'fre', title: 'Francais' }, { lang: 'eng', title: 'English 5.1' });
  assert.strictEqual(defaultAudioTrack(mixed, 'en'), 2);
  assert.strictEqual(defaultAudioTrack(mixed, 'fr'), 1);
  assert.strictEqual(defaultAudioTrack(mixed), 2, 'no preference: the first track\'s language, without AD');
  const plainFirst = tracks({ lang: 'eng', title: 'English' }, { lang: 'eng', title: 'English - Audio Description' });
  assert.strictEqual(defaultAudioTrack(plainFirst, 'en'), 0, 'a normal first track is left alone');
});

test('tracks: Audio Description is the default only when it is the only track in that language', () => {
  assert.strictEqual(defaultAudioTrack(tracks({ lang: 'eng', title: 'Audio Description', visualImpaired: true })), 0);
  const onlyEnglishIsAd = tracks({ lang: 'fre', title: 'Francais' }, { lang: 'eng', title: 'English - Audio Description' });
  assert.strictEqual(defaultAudioTrack(onlyEnglishIsAd, 'en'), 1, 'the only English track plays for an English viewer');
  assert.strictEqual(defaultAudioTrack([], 'en'), 0);
});

function makeAdMkv() {
  if (!detectFfmpeg() || !detectFfprobe()) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-ad-'));
  const file = path.join(dir, 'ad.mkv');
  const r = spawnSync(detectFfmpeg().path, ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-f', 'lavfi', '-i', 'sine=frequency=660',
    '-t', '2', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'mpeg4', '-c:a', 'aac',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English - Audio Description', '-disposition:a:0', 'default+visual_impaired',
    '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=English', '-disposition:a:1', '0', file], { windowsHide: true });
  if (r.status !== 0) throw new Error('ffmpeg could not build the test MKV: ' + String(r.stderr || '').slice(0, 300));
  return { dir, file };
}

test('tracks: the probe of a real MKV flags the Audio Description track and the default is the second track', async (t) => {
  const mkv = makeAdMkv();
  if (!mkv) return t.skip('ffmpeg/ffprobe not available');
  try {
    const probe = await probeTracks(mkv.file);
    assert.strictEqual(probe.audio.length, 2);
    assert.strictEqual(probe.audio[0].visualImpaired, true, 'Matroska FlagVisualImpaired is read');
    assert.strictEqual(probe.audio[0].audioDescription, true);
    assert.strictEqual(probe.audio[1].audioDescription, false);
    assert.strictEqual(defaultAudioTrack(probe.audio), 1);
    assert.strictEqual(defaultAudioTrack(probe.audio, 'en'), 1);
    // Jellyfin clients take IsDefault as the playing audio.
    const audioRows = mediaStreamsFromProbe(probe).filter((s) => s.Type === 'Audio');
    assert.deepStrictEqual(audioRows.map((s) => s.IsDefault), [false, true]);
  } finally { fs.rmSync(mkv.dir, { recursive: true, force: true }); }
});

test('server: remux, transcode and HLS without audio= play the default track; a named track always wins', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const start = src.indexOf('function requestedAudioTrack(ctx, vf) {');
  const end = src.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start, 'requestedAudioTrack is in index.js');
  const requestedAudioTrack = new Function('defaultAudioTrack', `${src.slice(start, end)}\nreturn requestedAudioTrack;`)(defaultAudioTrack);
  const vf = { _tracks: { audio: tracks({ lang: 'eng', title: 'English - Audio Description', visualImpaired: true }, { lang: 'eng', title: 'English' }) } };
  const ctx = (q) => ({ url: new URL(`http://x/api/remux/m1${q}`) });
  assert.strictEqual(requestedAudioTrack(ctx('?t=a'), vf), 1, 'no audio=: the normal track');
  assert.strictEqual(requestedAudioTrack(ctx('?t=a&audio='), vf), 1);
  assert.strictEqual(requestedAudioTrack(ctx('?t=a&audio=0'), vf), 0, 'a saved or manual pick of the AD track is kept');
  assert.strictEqual(requestedAudioTrack(ctx('?t=a&audio=1'), vf), 1);
  assert.strictEqual(requestedAudioTrack(ctx('?t=a'), {}), 0, 'not probed yet: track 0 as before');
  const uses = src.match(/const audioTrack = requestedAudioTrack\(ctx, vf\);/g) || [];
  assert.strictEqual(uses.length, 3, 'remux, transcode and HLS all use it');
  assert.ok(!src.includes("const audioTrack = parseInt(ctx.url.searchParams.get('audio') || '0', 10) || 0;"),
    'no endpoint falls back to track 0 on its own');
});

// Web player: the page's own functions, run as written in web/index.html.
const ui = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const webFn = (name) => {
  const start = ui.indexOf(`function ${name}(`);
  const end = ui.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start, `${name} should be extractable`);
  return ui.slice(start, end);
};
const webLoad = (names, deps = {}) => {
  const keys = Object.keys(deps);
  return new Function(...keys, `${names.map(webFn).join('\n')}\nreturn { ${names.join(', ')} };`)(...keys.map((k) => deps[k]));
};
const langKey = (c) => ({ eng: 'en', en: 'en', fre: 'fr', fra: 'fr', fr: 'fr', ger: 'de', de: 'de' })[String(c || '').toLowerCase()] || '';

test('web: the page tells Audio Description tracks the same way as the server', () => {
  const web = webLoad(['isAudioDescriptionTrack']).isAudioDescriptionTrack;
  for (const t of [
    { title: 'English - Audio Description' }, { title: 'English (AD)' }, { title: 'Descriptive Audio' }, { title: 'DVS' },
    { title: '', visualImpaired: true }, { title: 'English' }, { title: 'Ad-free mix' }, { title: 'Headphone Mix' },
    { title: 'Director Commentary' }, {},
  ]) assert.strictEqual(web(t), isAudioDescriptionTrack(t), JSON.stringify(t));
});

test('web: playback starts on a normal track, never on Audio Description, unless it is the only one in the language', () => {
  let pref = '';
  const { preferredAudioTrackForPlayer } = webLoad(['isAudioDescriptionTrack', 'selectedPlayerAudioTrack', 'preferredAudioTrackForPlayer'],
    { prefAudioLang: () => pref, audioLangKey: langKey });
  const p = (audioTrack, ...rows) => ({ audioTrack, tracks: { audio: tracks(...rows) } });
  const adFirst = [{ lang: 'eng', title: 'English - Audio Description', visualImpaired: true }, { lang: 'eng', title: 'English' }];
  pref = '';
  assert.strictEqual(preferredAudioTrackForPlayer(p(0, ...adFirst)).rel, 1, 'no language wish: move off the AD track');
  assert.strictEqual(preferredAudioTrackForPlayer(p(1, ...adFirst)), null, 'already on the normal track');
  pref = 'en';
  assert.strictEqual(preferredAudioTrackForPlayer(p(0, ...adFirst)).rel, 1, 'English wish: the normal English track');
  assert.strictEqual(preferredAudioTrackForPlayer(p(1, ...adFirst)), null);
  const flagOnly = [{ lang: 'eng', title: 'English', visualImpaired: true }, { lang: 'eng', title: 'English' }];
  assert.strictEqual(preferredAudioTrackForPlayer(p(0, ...flagOnly)).rel, 1, 'the flag alone is enough');
  const onlyAdEnglish = [{ lang: 'fre', title: 'Francais' }, { lang: 'eng', title: 'English - Audio Description' }];
  assert.strictEqual(preferredAudioTrackForPlayer(p(0, ...onlyAdEnglish)).rel, 1, 'the only English track still plays for English');
  pref = '';
  assert.strictEqual(preferredAudioTrackForPlayer(p(0, { lang: 'eng', title: 'English' }, { lang: 'eng', title: 'Audio Description' })), null,
    'a normal start is left alone');
  pref = 'fr';
  assert.strictEqual(preferredAudioTrackForPlayer(p(0, { lang: 'eng', title: 'AD' }, { lang: 'fre', title: 'AD' }, { lang: 'fre', title: 'Francais' })).rel, 2);
});

test('web: track prefs after the probe use that choice, and the native app gets the Audio Description tracks', () => {
  const apply = webFn('applyTrackPrefs');
  assert.match(apply, /const best = preferredAudioTrackForPlayer\(p\);\s+if \(best && best\.rel !== p\.audioTrack\) setAudio\(best\.rel\);/);
  assert.match(apply, /if \(p\._userPickedAudio\) \{ updateSrndBtn\(\); return; \}/, 'a manual pick still wins');
  const S = { playing: { tracks: { audio: tracks({ lang: 'eng', title: 'English - Audio Description', visualImpaired: true }, { lang: 'eng', title: 'English' }) } } };
  const { nativeAudioDescriptionRels } = webLoad(['isAudioDescriptionTrack', 'nativeAudioDescriptionRels'], { S });
  assert.deepStrictEqual(nativeAudioDescriptionRels(), [0]);
  assert.match(ui, /audioDescriptionRels: nativeAudioDescriptionRels\(\),/, 'the native payload carries them');
});
