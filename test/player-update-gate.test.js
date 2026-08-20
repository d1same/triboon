'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('every update: start, seek, sources, and About stay wired on web, Android, and Windows', () => {
  const ui = read('web/index.html');
  const android = read('android/app/src/main/java/app/triboon/tv/MainActivity.java');
  const stress = read('bench/android-tv-stress.ps1');
  const verify = read('VERIFY.md');
  const windows = read('test/windows-px8-player.test.js');

  assert.match(ui, /async function play\(it, pick, opts = \{\}\) \{/,
    'web Play owns start for browser, Android WebView, and Windows catalog');
  assert.match(ui, /function nudgeSeek\(delta\) \{[\s\S]+function seekTo\(seconds\) \{/,
    'web seek back/forth is one nudgeSeek/seekTo path');
  assert.match(ui, /function playbackRequestBody\(it, pick/,
    'source finding goes through the shared play request body');
  assert.match(ui, /id="aboutBtn"[\s\S]+function openPlayerAbout\(\) \{[\s\S]+function closePlayerAbout\(\)/,
    'web and Windows catalog About is the in-player card, not the details page');

  assert.match(android, /public void showTitleInfo\(String json\)/,
    'Android native About opens through showTitleInfo');
  assert.match(android, /public void hideTitleInfo\(\)/,
    'Android native About closes through hideTitleInfo');
  assert.match(android, /nativeAboutBtn = nativeButton\(R\.drawable\.ic_player_about, "About this title"/,
    'Android chrome has an About button next to Guide');

  assert.match(stress, /await play\(item\);/,
    'Android stress actually starts the requested VOD');
  assert.match(stress, /nudgeSeek\(\$delta\)/,
    'Android stress seeks forward and back through nudgeSeek');
  assert.match(stress, /maxResolutionRank=' \+ rank[\s\S]+1080p[\s\S]+2160p/,
    'Android stress checks that 1080p and 4K source ranks stay separated');
  assert.match(stress, /openPlayerAbout\(\);[\s\S]+closePlayerAbout\(\)/,
    'Android stress opens About on a living VOD and closes it');

  assert.match(windows, /seekBy\(-20\)/,
    'Windows seek back/forth is covered on the native bridge');
  assert.match(windows, /id="aboutBtn"[\s\S]+openPlayerAbout/,
    'Windows catalog About is pinned to the shared web card');

  assert.match(verify, /Player About \(web \+ Android \+ Windows\)/,
    'VERIFY.md keeps About on the required live-smoke list for every push');
});
