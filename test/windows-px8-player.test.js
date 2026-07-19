'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const bridgeSource = read('clients/windows-px8/ui/bridge.js');

function loadBridge() {
  const calls = [];
  const sandbox = {
    URL,
    location: { origin: 'https://triboon.test' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.__TRIBOON_WINDOWS_BOOTSTRAP__ = {
    chromeVersion: 4,
    playbackCaps: { hevc: true, hwdecRequested: 'd3d11-auto-safe' },
  };
  sandbox.__TRIBOON_WINDOWS_INVOKE__ = (command, args) => {
    calls.push({ command, args });
    return Promise.resolve(null);
  };
  vm.runInNewContext(bridgeSource, sandbox, { filename: 'bridge.js' });
  return { window: sandbox, calls };
}

test('Windows client: versions and production identity stay aligned', () => {
  const app = JSON.parse(read('package.json'));
  const client = JSON.parse(read('clients/windows-px8/package.json'));
  const tauri = JSON.parse(read('clients/windows-px8/src-tauri/tauri.conf.json'));
  const cargo = read('clients/windows-px8/src-tauri/Cargo.toml');
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo);

  assert.strictEqual(client.version, app.version, 'client package version matches Triboon');
  assert.strictEqual(tauri.version, app.version, 'Tauri bundle version matches Triboon');
  assert.strictEqual(cargoVersion && cargoVersion[1], app.version, 'Rust package version matches Triboon');
  assert.strictEqual(tauri.productName, 'Triboon');
  assert.strictEqual(tauri.identifier, 'app.triboon.windows', 'production id cannot reuse the PX8 preview id');
  assert.deepStrictEqual(tauri.bundle.targets, ['nsis'], 'the public Windows client is an NSIS installer');
});

test('Windows client: remote WebView gets only the guarded Triboon bridge', () => {
  const tauri = JSON.parse(read('clients/windows-px8/src-tauri/tauri.conf.json'));
  const main = read('clients/windows-px8/src-tauri/src/main.rs');
  const capabilities = ['connect', 'catalog', 'player'].map((name) =>
    JSON.parse(read(`clients/windows-px8/src-tauri/capabilities/${name}.json`)));
  const catalog = capabilities.find((capability) => capability.identifier === 'trusted-remote-catalog');

  assert.strictEqual(tauri.app.withGlobalTauri, false, 'general Tauri globals stay disabled');
  assert.ok(tauri.app.security.csp, 'the bundled connect/player pages have a CSP');
  assert.match(tauri.app.security.csp, /object-src 'none'/);
  assert.ok(catalog && catalog.local === false, 'the remote catalog has its own non-local capability');
  assert.deepStrictEqual(catalog.remote.urls, ['http://*:*', 'https://*:*'],
    'remote ACL includes Triboon custom ports such as 7777 and 8443');
  for (const remote of ['http://triboon.local:7777/', 'https://media.example:8443/']) {
    assert.ok(catalog.remote.urls.some((pattern) => new URLPattern(pattern).test(remote)),
      `remote ACL matches ${remote}`);
  }
  for (const capability of capabilities) {
    assert.ok(Array.isArray(capability.permissions));
    for (const permission of capability.permissions) {
      assert.doesNotMatch(permission, /^(?:core:default|shell|fs|process|clipboard|http):?/i,
        'no window has a broad default, shell, filesystem, process, clipboard, or HTTP capability');
    }
  }
  assert.match(main, /navigation_allowed[\s\S]+url\.origin\(\) == server/,
    'navigation is constrained to the configured exact origin');
  assert.match(main, /require_catalog_origin[\s\S]+require_player_or_catalog/,
    'native commands revalidate the caller instead of trusting JavaScript');
  assert.match(main, /include_str!\("\.\.\/\.\.\/ui\/bridge\.js"\)/,
    'the reviewed bridge is the code injected into the catalog');
  assert.match(main, /if trusted[\s\S]+webview\.eval\(bridge_script\(\)\)/,
    'bridge injection happens only after the configured origin check');
});

test('Windows client: a saved server reconnects without another click', () => {
  const connect = read('clients/windows-px8/ui/connect.html');
  assert.match(connect, /invoke\('last_server'\)[\s\S]+form\.requestSubmit\(\)/,
    'the local connect screen should immediately reopen a previously verified server');
});

test('Windows client: bridge exposes Android-compatible native playback controls', () => {
  const { window, calls } = loadBridge();
  const bridge = window.TriboonTV;
  const required = [
    'nativeChromeVersion', 'nativePlaybackCaps', 'showVideoLoading', 'playVideo', 'playLive',
    'closeVideo', 'play', 'pause', 'resume', 'togglePlay', 'seekTo', 'seekBy', 'nextEpisode',
    'selectQuality', 'selectAudio', 'selectSubtitle', 'updateSubtitleChoices',
    'updateActiveSubtitle', 'updateVideoDuration', 'updateEpisodeChoices', 'upNext',
    'upNextHide', 'setLiveFav', 'setLiveEpg', 'openGuide', 'closeGuide', 'setGuidePipRect',
  ];
  for (const name of required) assert.strictEqual(typeof bridge[name], 'function', `${name} is exposed`);
  assert.ok(bridge.nativeChromeVersion() >= 1, 'native handoff is enabled');

  const caps = JSON.parse(bridge.nativePlaybackCaps());
  assert.strictEqual(caps.player, 'libmpv');
  assert.strictEqual(caps.hwdecRequested, 'd3d11-auto-safe');
  assert.strictEqual(caps.softwareFallback, true);

  assert.strictEqual(bridge.playVideo(JSON.stringify({
    url: '/api/stream/movie?t=secret', playbackToken: 91, start: 12,
  })), true);
  assert.strictEqual(calls.at(-1).command, 'windows_player_play_vod');
  assert.strictEqual(calls.at(-1).args.payload.playbackToken, 91);
  assert.throws(() => bridge.playVideo(JSON.stringify({
    url: 'https://evil.example/movie?t=secret', playbackToken: 91,
  })), /invalid/i, 'VOD URLs cannot escape the configured server origin');

  bridge.seekTo(44);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(calls.at(-1))),
    { command: 'windows_player_control', args: { action: 'seek_absolute', payload: { seconds: 44 } } },
  );
});

test('Windows client: native events preserve playback identity and full lifecycle', () => {
  const { window } = loadBridge();
  const seen = [];
  const callbacks = [
    '__tvNativePlaybackSurfaceReady', '__tvNativeVideoReady', '__tvNativeVideoPlaying',
    '__tvNativeVideoPaused', '__tvNativeVideoProgress', '__tvNativeVideoStats',
    '__tvNativeVideoSeek', '__tvNativeVideoEnded', '__tvNativeVideoClosed',
    '__tvNativeVideoError', '__tvNativeVideoNext', '__tvNativeLiveReady',
    '__tvNativeLiveClosed', '__tvNativeLiveError', '__tvNativeLiveGuide', '__tvNativeLiveZap',
  ];
  for (const name of callbacks) window[name] = (...args) => seen.push([name, args]);

  window.__triboonWindowsPlayerEvent({ type: 'ready', position: 9, duration: 100, playbackToken: 73 });
  window.__triboonWindowsPlayerEvent({ type: 'progress', position: 10, duration: 100, playbackToken: 73 });
  window.__triboonWindowsPlayerEvent({ type: 'closed', position: 11, duration: 100, playbackToken: 73 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(seen)), [
    ['__tvNativeVideoReady', [9, 100, 73]],
    ['__tvNativeVideoProgress', [10, 100, 73]],
    ['__tvNativeVideoClosed', [11, 100, false, 73]],
  ]);

  for (const callback of callbacks) {
    assert.match(bridgeSource, new RegExp(callback), `${callback} is routed by the bridge`);
  }
});

test('Windows client: Rust owns a persistent, observable D3D11/libmpv player', () => {
  const main = read('clients/windows-px8/src-tauri/src/main.rs');
  const player = read('clients/windows-px8/src-tauri/src/player.rs');
  const playerUi = read('clients/windows-px8/ui/player.js');

  for (const command of [
    'windows_player_show_loading', 'windows_player_play_vod', 'windows_player_play_live',
    'windows_player_control', 'windows_player_update', 'windows_player_open_guide',
    'windows_player_close_guide', 'windows_player_set_guide_pip_rect',
  ]) {
    assert.match(main, new RegExp(`player::${command}`), `${command} is registered`);
    assert.match(player, new RegExp(`(?:fn|pub fn) ${command}`), `${command} is implemented`);
  }

  assert.match(player, /hwdec["']?\s*,\s*["']auto-safe|auto-safe[\s\S]+hwdec/i,
    'hardware decode uses the safe automatic path');
  assert.match(player, /d3d11/i, 'Windows rendering selects D3D11');
  assert.match(player, /hwdec-current/i, 'runtime hardware decoder state is observed');
  assert.match(player, /"audioId": ui\.audio_id/, 'runtime stats expose the selected audio track');
  assert.match(player, /time-pos/i, 'native progress uses mpv playback time');
  assert.match(player, /demuxer-cache|cache-duration|paused-for-cache/i, 'buffering is observable');
  assert.match(player, /playback_token|playbackToken/i, 'events carry playback identity');
  assert.match(player, /redact|query\(|split\('\?'\)|set_query\(None\)/i,
    'native errors/logs have a URL-token redaction path');
  assert.match(playerUi, /ArrowLeft|ArrowRight|MediaPlayPause|fullscreen/i,
    'native chrome handles keyboard/media/fullscreen controls');
});

test('Windows client: LGPL runtime and honest hardware verification are documented', () => {
  const readme = read('clients/windows-px8/README.md');
  const source = read('clients/windows-px8/LIBMPV-SOURCE.md');
  const license = read('clients/windows-px8/LIBMPV-LICENSE.LGPL');
  const verify = read('VERIFY.md');
  const notices = read('THIRD-PARTY-NOTICES.md');

  for (const doc of [readme, verify]) {
    assert.match(doc, /hwdec-current/i, 'GPU proof uses runtime decoder state');
    assert.match(doc, /software\s+fallback|falls?\s+back\s+to\s+software/i,
      'unsupported hardware decode has a safe fallback');
  }
  assert.match(source, /e5486b96d7d06dd148337899bfdc46bf25101663/);
  assert.match(source, /b4b1088c30e8821e012fd20052de4c2d3a8eaad4/);
  assert.match(source, /1016b6029da77f96e3a2831d2c33107eee43f798374ba90f56dce45717ed7932/);
  assert.match(source, /replace|replacement/i);
  assert.match(license, /GNU LESSER GENERAL PUBLIC LICENSE[\s\S]+Version 2\.1/);
  assert.match(notices, /dynamically loads `libmpv-2\.dll`/);
  assert.doesNotMatch(readme, /Dolby Vision[^\n]+guarantee/i,
    'hardware-chain-dependent Dolby Vision is not promised universally');
});
