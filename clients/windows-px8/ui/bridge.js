/*
 * Triboon for Windows native-player bridge.
 *
 * This file is injected only into the configured Triboon server origin.  It deliberately exposes
 * a small, Android-compatible `window.TriboonTV` surface instead of Tauri's general API.  Rust
 * performs the authoritative caller-origin and payload validation for every command.
 */
(function installTriboonWindowsBridge() {
  'use strict';

  if (window.TriboonTV && window.TriboonTV.__triboonWindowsBridge === true) return;

  const MAX_JSON_BYTES = 2 * 1024 * 1024;
  const bootstrap = (window.__TRIBOON_WINDOWS_BOOTSTRAP__
    && typeof window.__TRIBOON_WINDOWS_BOOTSTRAP__ === 'object')
    ? window.__TRIBOON_WINDOWS_BOOTSTRAP__ : {};
  const fallbackCaps = Object.freeze({
    native: true,
    deviceClass: 'windows-desktop',
    player: 'libmpv',
    source: 'libmpv',
    mkv: true,
    mp4: true,
    h264: true,
    hevc: true,
    vp9: true,
    mpeg2: true,
    av1: false,
    dovi: false,
    aac: true,
    ac3: true,
    eac3: true,
    dts: true,
    truehd: true,
    passthrough: false,
    hwdecRequested: 'd3d11-auto-safe',
    softwareFallback: true,
  });
  const playbackCaps = Object.freeze({
    ...fallbackCaps,
    ...(bootstrap.playbackCaps && typeof bootstrap.playbackCaps === 'object'
      ? bootstrap.playbackCaps : {}),
    native: true,
  });

  function invokeNative(command, args) {
    const injected = window.__TRIBOON_WINDOWS_INVOKE__;
    if (typeof injected === 'function') return Promise.resolve(injected(command, args || {}));
    const publicInvoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (typeof publicInvoke === 'function') return Promise.resolve(publicInvoke(command, args || {}));
    const internalInvoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof internalInvoke === 'function') return Promise.resolve(internalInvoke(command, args || {}));
    return Promise.reject(new Error('native transport unavailable'));
  }

  function parsePayload(raw, label) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw !== 'string' || raw.length > MAX_JSON_BYTES) {
      throw new TypeError((label || 'Native player') + ' payload is invalid');
    }
    let value;
    try { value = JSON.parse(raw); }
    catch { throw new TypeError((label || 'Native player') + ' payload is invalid'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError((label || 'Native player') + ' payload is invalid');
    }
    return value;
  }

  function safeHttpUrl(value, sameOrigin) {
    if (!value) return '';
    let parsed;
    try { parsed = new URL(String(value), location.origin); } catch { return ''; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (sameOrigin && parsed.origin !== location.origin) return '';
    return parsed.href;
  }

  function sanitizeVodPayload(raw) {
    const payload = parsePayload(raw, 'Video');
    const url = safeHttpUrl(payload.url, true);
    if (!url) throw new TypeError('Video URL is invalid');
    payload.url = url;
    if (payload.subtitleUrl) payload.subtitleUrl = safeHttpUrl(payload.subtitleUrl, true);
    return payload;
  }

  function sanitizeLivePayload(raw) {
    const payload = parsePayload(raw, 'Live TV');
    const url = safeHttpUrl(payload.url, false);
    if (!url) throw new TypeError('Live TV URL is invalid');
    payload.url = url;
    if (payload.fallbackUrl) payload.fallbackUrl = safeHttpUrl(payload.fallbackUrl, false);
    if (Array.isArray(payload.fallbacks)) {
      payload.fallbacks = payload.fallbacks.slice(0, 8).map((item) => ({
        url: safeHttpUrl(item && item.url, false),
        mime: String(item && item.mime || '').slice(0, 128),
      })).filter((item) => item.url);
    }
    return payload;
  }

  function invokeQuiet(command, args, onFailure) {
    invokeNative(command, args).catch(() => {
      if (typeof onFailure === 'function') {
        try { onFailure(); } catch {}
      }
    });
    return true;
  }

  function playerControl(action, payload) {
    return invokeQuiet('windows_player_control', {
      action: String(action || ''),
      payload: payload && typeof payload === 'object' ? payload : {},
    });
  }

  function playerUpdate(kind, raw, defaultValue) {
    let payload = defaultValue || {};
    if (raw !== undefined && raw !== null && raw !== '') {
      payload = (typeof raw === 'string' && /^[\[{]/.test(raw.trim()))
        ? parsePayload(raw, 'Player update')
        : raw;
    }
    return invokeQuiet('windows_player_update', { kind, payload });
  }

  function callPage(name, args) {
    const callback = window[name];
    if (typeof callback !== 'function') return;
    try { callback.apply(window, Array.isArray(args) ? args : []); } catch {}
  }

  const bridge = {
    __triboonWindowsBridge: true,

    nativeChromeVersion() {
      const version = Number(bootstrap.chromeVersion);
      return Number.isFinite(version) && version >= 1 ? Math.floor(version) : 4;
    },

    nativePlaybackCaps() {
      return JSON.stringify(playbackCaps);
    },

    changeServer() {
      return invokeQuiet('windows_change_server', {});
    },

    showVideoLoading(raw) {
      const payload = parsePayload(raw, 'Loading');
      return invokeQuiet('windows_player_show_loading', { payload }, () => {
        callPage('__tvNativeVideoClosed', [0, 0, false, Number(payload.playbackToken || 0)]);
      });
    },

    playVideo(raw) {
      const payload = sanitizeVodPayload(raw);
      return invokeQuiet('windows_player_play_vod', { payload }, () => {
        callPage('__tvNativeVideoError', [
          'Windows player could not start',
          Number(payload.start || payload.startOffset || 0),
          Number(payload.duration || 0),
          Number(payload.playbackToken || 0),
        ]);
      });
    },

    playLive(raw) {
      const payload = sanitizeLivePayload(raw);
      return invokeQuiet('windows_player_play_live', { payload }, () => {
        callPage('__tvNativeLiveError', ['Windows player could not start Live TV']);
      });
    },

    closeVideo() { return playerControl('close'); },
    play() { return playerControl('play'); },
    pause() { return playerControl('pause'); },
    resume() { return playerControl('play'); },
    togglePlay() { return playerControl('toggle'); },
    seekTo(seconds) { return playerControl('seek_absolute', { seconds: Math.max(0, Number(seconds) || 0) }); },
    seekBy(seconds) { return playerControl('seek_relative', { seconds: Number(seconds) || 0 }); },
    nextEpisode() { return playerControl('next'); },
    selectQuality(quality) { return playerControl('quality', { quality }); },
    selectAudio(id) { return playerControl('audio', { id }); },
    selectSubtitle(rel) { return playerControl('subtitle', { rel: String(rel || '') }); },

    updateSubtitleChoices(raw) { return playerUpdate('subtitle_choices', raw); },
    updateActiveSubtitle(raw) { return playerUpdate('active_subtitle', raw); },
    updateVideoDuration(seconds) {
      return playerUpdate('duration', { seconds: Math.max(0, Number(seconds) || 0) });
    },
    updateEpisodeChoices(raw) { return playerUpdate('episode_choices', raw); },
    upNext(raw) { return playerUpdate('up_next', raw); },
    upNextHide() { return playerUpdate('up_next', { hidden: true }); },
    setLiveFav(on) { return playerUpdate('live_favorite', { on: !!on }); },
    setLiveEpg(raw) {
      let programs = [];
      try { programs = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
      return playerUpdate('live_epg', { programs: Array.isArray(programs) ? programs.slice(0, 100) : [] });
    },

    openGuide() { return invokeQuiet('windows_player_open_guide', {}); },
    closeGuide() { return invokeQuiet('windows_player_close_guide', {}); },
    setGuidePipRect(raw) {
      const payload = parsePayload(raw, 'Guide');
      return invokeQuiet('windows_player_set_guide_pip_rect', { payload });
    },
  };

  // Optional single-entry event router for integration tests and older native builds.  Current
  // builds call the exact callbacks directly; keeping this router token-aware makes the bridge
  // backwards compatible without exposing native commands to page scripts.
  Object.defineProperty(window, '__triboonWindowsPlayerEvent', {
    configurable: true,
    value(raw) {
      let event;
      try { event = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
      if (!event || typeof event !== 'object') return;
      const token = Number(event.playbackToken || event.token || 0);
      const pos = Math.max(0, Number(event.position ?? event.pos) || 0);
      const duration = Math.max(0, Number(event.duration) || 0);
      switch (String(event.type || '')) {
        case 'surface_ready': callPage('__tvNativePlaybackSurfaceReady', []); break;
        case 'ready': callPage('__tvNativeVideoReady', [pos, duration, token]); break;
        case 'playing': callPage('__tvNativeVideoPlaying', [pos, duration, token]); break;
        case 'paused': callPage('__tvNativeVideoPaused', [pos, duration, token]); break;
        case 'progress': callPage('__tvNativeVideoProgress', [pos, duration, token]); break;
        case 'stats': callPage('__tvNativeVideoStats', [JSON.stringify(event.stats || event), token]); break;
        case 'seek': callPage('__tvNativeVideoSeek', [pos, duration, Number(event.resume || pos), token, !!event.percentResume]); break;
        case 'ended': callPage('__tvNativeVideoEnded', [pos, duration, token]); break;
        case 'closed': callPage('__tvNativeVideoClosed', [pos, duration, !!event.ended, token]); break;
        case 'error': callPage('__tvNativeVideoError', ['Windows player error', pos, duration, token]); break;
        case 'next': callPage('__tvNativeVideoNext', [pos, duration, token]); break;
        case 'live_ready': callPage('__tvNativeLiveReady', []); break;
        case 'live_closed': callPage('__tvNativeLiveClosed', []); break;
        case 'live_error': callPage('__tvNativeLiveError', ['Windows player error']); break;
        case 'live_guide': callPage('__tvNativeLiveGuide', [Number(event.epoch || 0)]); break;
        case 'live_zap': callPage('__tvNativeLiveZap', [Number(event.direction || 1)]); break;
        default: break;
      }
    },
  });

  Object.freeze(bridge);
  Object.defineProperty(window, 'TriboonTV', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: bridge,
  });
  // Diagnostic alias retained for the old PX8 preview page.  It contains no Tauri transport.
  Object.defineProperty(window, 'TriboonPX8', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ nativeChromeVersion: bridge.nativeChromeVersion }),
  });
})();
