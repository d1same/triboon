'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { isRadioLike, pickLiveVideoChannels } = require('../bench/live-channel-pick');
const { parseArgs } = require('../bench/verify-live');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('live-channel-pick: skips radio and offline rows when a TV channel exists', () => {
  const channels = [
    { name: 'SWE: [Radio][SE] Bandit Classic Rock [1080p]', group: 'Radio' },
    { name: 'Nightwave Radio', group: 'Music' },
    { name: 'ABC', group: 'US' },
    { name: 'ESPN', group: 'Sports' },
    { name: 'Offline Cam', group: 'offline' },
  ];
  assert.strictEqual(isRadioLike(channels[0]), true);
  assert.strictEqual(isRadioLike(channels[2]), false);
  const picks = pickLiveVideoChannels(channels, 2);
  assert.deepStrictEqual(picks.map((c) => c.name), ['ABC', 'ESPN']);
});

test('live-channel-pick: falls back to the raw list when every row is radio', () => {
  const channels = [
    { title: 'Lounge Radio', group: 'Radio' },
    { name: '[Radio] Jazz' },
  ];
  const picks = pickLiveVideoChannels(channels, 1);
  assert.strictEqual(picks.length, 1);
  assert.strictEqual(picks[0].title, 'Lounge Radio');
});

test('verify-live: --iptv does not invent default VOD titles', () => {
  const args = parseArgs(['--iptv', '--cc']);
  assert.strictEqual(args.iptv, true);
  assert.strictEqual(args.cc, true);
  assert.deepStrictEqual(args.titles, []);
});

test('verify-live: VOD defaults still apply when no titles and no --iptv', () => {
  const args = parseArgs([]);
  assert.ok(args.titles.length >= 1);
  assert.strictEqual(args.iptv, false);
});

test('verify:full household live and Android radio skip stay wired', () => {
  const verify = read('bench/verify-before-update.ps1');
  const stress = read('bench/android-tv-stress.ps1');
  assert.match(verify, /SkipHouseholdLive/, 'verify:full can skip household live only as an incomplete gate');
  assert.match(verify, /verify-live\.js[\s\S]+--iptv/, 'verify:full runs the IPTV first-byte retune smoke');
  assert.match(verify, /verify-live\.js[\s\S]+--concurrent/, 'verify:full runs the overlapping Play soak');
  assert.match(verify, /TRIBOON_USER[\s\S]+TRIBOON_PASS[\s\S]+TRIBOON_TOKEN/,
    'household live requires login env rather than silently skipping');
  assert.match(stress, /videoLike[\s\S]+\\\[radio\\\]\|\\bradio\\b\|offline/,
    'Android stress prefers video channels over radio');
  assert.match(stress, /started a radio channel even though video channels were available/,
    'Android stress fails closed if Live TV still lands on radio');
  assert.match(stress, /nudgeSeek\(\$delta\)/,
    'Android VOD seeks must use nudgeSeek, not emulator media keys that never reach ExoPlayer');
  assert.match(stress, /mapTmdb\(\{ \.\.\.d, media_type: parsed\[1\] \}\)/,
    'Android stress must resolve the VOD fixture from TMDB when it is not on a shelf');
  assert.match(stress, /return S\.view === 'player' \|\| !!p\.usingNative \|\| document\.body\.classList\.contains\('videoOpen'\)/,
    'Android VOD ready must accept native ExoPlayer, not only #player.open');
  assert.match(stress, /if \(typeof closePlayerGuide === 'function'\) closePlayerGuide\(\);/,
    'PiP guide close must use JS so an emulator Back key cannot dump the later VOD');
  assert.match(stress, /openPlayerAbout\(\);[\s\S]+closePlayerAbout\(\)[\s\S]+Player About did not open and close without killing VOD/,
    'Android stress must open and close in-player About on a living VOD, not only pin the source text');
  assert.match(stress, /const midResume = duration > 600 \? Math\.min\(3200, Math\.floor\(duration \* 0\.45\)\) : 0/,
    'Android VOD stress resumes mid-file when Continue Watching is empty so emulator start-from-zero does not false-fail');
});
