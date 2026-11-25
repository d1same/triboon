'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function loadAppleBridge({ origin = 'https://triboon.example', bootstrap = {} } = {}) {
  const posted = [];
  const callbacks = [];
  const windowObj = {
    __TRIBOON_APPLE_BOOTSTRAP__: bootstrap,
    webkit: {
      messageHandlers: {
        triboonBridge: {
          postMessage(msg) { posted.push(msg); },
        },
      },
    },
    __tvNativeVideoReady: (...a) => callbacks.push(['ready', ...a]),
    __tvNativeVideoPlaying: (...a) => callbacks.push(['playing', ...a]),
    __tvNativeVideoProgress: (...a) => callbacks.push(['progress', ...a]),
    __tvNativeVideoEnded: (...a) => callbacks.push(['ended', ...a]),
    __tvNativeVideoClosed: (...a) => callbacks.push(['closed', ...a]),
    __tvNativeVideoError: (...a) => callbacks.push(['error', ...a]),
    __tvNativeLiveReady: (...a) => callbacks.push(['live_ready', ...a]),
    __tvNativeLiveClosed: (...a) => callbacks.push(['live_closed', ...a]),
    __tvNativeLiveError: (...a) => callbacks.push(['live_error', ...a]),
  };
  const ctx = vm.createContext({
    window: windowObj,
    location: { origin },
    URL,
    Object,
    Array,
    Number,
    String,
    JSON,
    TypeError,
    Error,
    Math,
  });
  vm.runInContext(read('clients/apple/Sources/iOS/Resources/bridge.js'), ctx, { filename: 'apple-bridge.js' });
  return { bridge: windowObj.TriboonTV, windowObj, posted, callbacks };
}

test('Apple client: project.yml versions and Info.plist preservation stay aligned with package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  const yml = read('clients/apple/project.yml');
  const marketing = /MARKETING_VERSION:\s*"([^"]+)"/.exec(yml);
  assert.strictEqual(marketing && marketing[1], pkg.version, 'Apple MARKETING_VERSION matches package.json');
  assert.match(yml, /PRODUCT_BUNDLE_IDENTIFIER:\s*app\.triboon\.ios/);
  assert.match(yml, /PRODUCT_BUNDLE_IDENTIFIER:\s*app\.triboon\.appletv/);
  assert.match(yml, /GENERATE_INFOPLIST_FILE:\s*NO/);
  assert.match(yml, /INFOPLIST_FILE:\s*Sources\/iOS\/Resources\/Info\.plist/);
  assert.match(yml, /INFOPLIST_FILE:\s*Sources\/tvOS\/Resources\/Info\.plist/);
  assert.doesNotMatch(yml, /^\s+info:\s*$/m, 'XcodeGen info: block must not overwrite hand-authored Info.plist');
  const iosPlist = read('clients/apple/Sources/iOS/Resources/Info.plist');
  assert.match(iosPlist, /<key>UILaunchScreen<\/key>/);
  assert.match(iosPlist, /<key>NSAllowsArbitraryLoads<\/key>/);
  assert.ok(fs.existsSync(path.join(root, 'clients/apple/Packages/TriboonCore/Package.swift')));
  assert.ok(fs.existsSync(path.join(root, 'clients/apple/Sources/iOS/TriboonIOSApp.swift')));
  assert.ok(fs.existsSync(path.join(root, 'clients/apple/Sources/tvOS/TriboonTVApp.swift')));
});

test('Apple client: bridge.js enforces same-origin VOD URLs, sanitizes Live TV, and routes native events', () => {
  const { bridge, windowObj, posted, callbacks } = loadAppleBridge({
    origin: 'https://triboon.example',
    bootstrap: {
      chromeVersion: 4,
      appVersion: { versionName: '3.5.12', versionCode: 457, tablet: false, platform: 'ios' },
    },
  });

  assert.strictEqual(bridge.__triboonAppleBridge, true);
  assert.strictEqual(bridge.nativeChromeVersion(), 4);
  const caps = JSON.parse(bridge.nativePlaybackCaps());
  assert.strictEqual(caps.native, true);
  assert.strictEqual(caps.player, 'avplayer');
  assert.strictEqual(caps.hls, true);
  assert.strictEqual(caps.airplay, true);

  const ver = JSON.parse(bridge.appVersion());
  assert.strictEqual(ver.platform, 'ios');
  assert.strictEqual(ver.versionName, '3.5.12');

  // Same-origin VOD succeeds and normalizes relative path
  bridge.playVideo(JSON.stringify({ url: '/api/hls/m1/index.m3u8?t=tok', title: 'Movie', playbackToken: 7 }));
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].command, 'play_vod');
  assert.strictEqual(posted[0].payload.url, 'https://triboon.example/api/hls/m1/index.m3u8?t=tok');

  // Foreign-origin VOD is rejected
  assert.throws(() => bridge.playVideo(JSON.stringify({ url: 'https://evil.example/a.mp4' })), /Video URL is invalid/);

  // Live TV accepts HLS fallback and strips javascript: URLs
  bridge.playLive(JSON.stringify({
    title: 'News',
    url: 'https://cdn.example/live.m3u8',
    fallbacks: [
      { url: 'javascript:alert(1)', mime: 'text/plain' },
      { url: '/api/iptv/hls/1/index.m3u8?t=tok', mime: 'application/vnd.apple.mpegurl' },
    ],
  }));
  assert.strictEqual(posted[1].command, 'play_live');
  assert.strictEqual(posted[1].payload.fallbacks.length, 1);
  assert.strictEqual(posted[1].payload.fallbacks[0].url, 'https://triboon.example/api/iptv/hls/1/index.m3u8?t=tok');

  // Native events route cleanly and redact URLs in error messages
  windowObj.__triboonApplePlayerEvent({ type: 'progress', position: 42, duration: 1200, playbackToken: 7 });
  windowObj.__triboonApplePlayerEvent({ type: 'error', message: 'failed https://triboon.example/api/hls/m1?t=secret', position: 42, duration: 1200, playbackToken: 7 });
  windowObj.__triboonApplePlayerEvent({ type: 'live_closed' });
  assert.deepStrictEqual(callbacks[0], ['progress', 42, 1200, 7]);
  assert.strictEqual(callbacks[1][0], 'error');
  assert.doesNotMatch(callbacks[1][1], /secret/);
  assert.match(callbacks[1][1], /\[url\]/);
  assert.deepStrictEqual(callbacks[2], ['live_closed']);
});

test('Apple client: web/index.html wires AVPlayer HLS handoff, hides APK/EXE downloads, and guards Jellyfin redirect', () => {
  const html = read('web/index.html');
  assert.match(html, /window\.TriboonTV && window\.TriboonTV\.__triboonAppleBridge === true/);
  assert.match(html, /appleAvPlayer && p\.hlsUrl/);
  assert.match(html, /if \(id === 'avplayer'\) return 'AVPlayer'/);
  assert.match(html, /addLiveFallback\(it\._hlsUrl, 'application\/vnd\.apple\.mpegurl'\)/);
  assert.match(html, /function isAppleAppShell\(\)/);
  assert.match(html, /updates through TestFlight or the App Store/);
});
