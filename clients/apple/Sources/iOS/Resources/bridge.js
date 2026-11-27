/*
 * Triboon for iOS / iPadOS native-player bridge.
 *
 * Injected at DocumentStart ONLY for the configured Triboon server origin.
 * Exposes the shared `window.TriboonTV` surface matching Android and Windows clients.
 */
(function installTriboonAppleBridge() {
  'use strict';

  if (window.TriboonTV && window.TriboonTV.__triboonAppleBridge === true) return;

  const MAX_JSON_BYTES = 2 * 1024 * 1024;
  const bootstrap = (window.__TRIBOON_APPLE_BOOTSTRAP__
    && typeof window.__TRIBOON_APPLE_BOOTSTRAP__ === 'object')
    ? window.__TRIBOON_APPLE_BOOTSTRAP__ : {};

  const fallbackCaps = Object.freeze({
    native: true,
    deviceClass: 'iphone',
    player: 'avplayer',
    source: 'avplayer',
    mkv: false,
    mp4: true,
    h264: true,
    hevc: true,
    vp9: false,
    mpeg2: false,
    av1: false,
    dovi: true,
    aac: true,
    ac3: true,
    eac3: true,
    dts: false,
    truehd: false,
    hls: true,
    airplay: true,
  });

  const playbackCaps = Object.freeze({
    ...fallbackCaps,
    ...(bootstrap.playbackCaps && typeof bootstrap.playbackCaps === 'object'
      ? bootstrap.playbackCaps : {}),
    native: true,
  });

  const bootstrapVersion = (bootstrap.appVersion && typeof bootstrap.appVersion === 'object')
    ? bootstrap.appVersion : {};
  const appVersion = Object.freeze({
    versionName: String(bootstrapVersion.versionName || ''),
    versionCode: Math.max(0, Number(bootstrapVersion.versionCode) || 0),
    tv: false,
    tablet: !!bootstrapVersion.tablet,
    platform: 'ios',
  });

  function postNative(command, payload) {
    const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.triboonBridge;
    if (!handler || typeof handler.postMessage !== 'function') {
      throw new Error('Apple bridge transport unavailable');
    }
    handler.postMessage({
      command: String(command || ''),
      payload: payload && typeof payload === 'object' ? payload : {},
    });
    return true;
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
    if (payload.remuxUrl) payload.remuxUrl = safeHttpUrl(payload.remuxUrl, true);
    if (payload.transcodeUrl) payload.transcodeUrl = safeHttpUrl(payload.transcodeUrl, true);
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
        mime: String((item && item.mime) || '').slice(0, 128),
      })).filter((item) => item.url);
    }
    return payload;
  }

  function callPage(name, args) {
    const callback = window[name];
    if (typeof callback !== 'function') return;
    try { callback.apply(window, Array.isArray(args) ? args : []); } catch {}
  }

  function control(action, payload) {
    try {
      return postNative('control', { action: String(action || ''), payload: payload || {} });
    } catch {
      return false;
    }
  }

  const bridge = {
    __triboonAppleBridge: true,

    nativeChromeVersion() {
      const version = Number(bootstrap.chromeVersion);
      return Number.isFinite(version) && version >= 1 ? Math.floor(version) : 4;
    },

    nativePlaybackCaps() {
      return JSON.stringify(playbackCaps);
    },

    appVersion() {
      return JSON.stringify(appVersion);
    },

    changeServer() {
      try { return postNative('change_server', {}); } catch { return false; }
    },

    showVideoLoading() { return true; },

    playVideo(raw) {
      const payload = sanitizeVodPayload(raw);
      try {
        return postNative('play_vod', payload);
      } catch {
        callPage('__tvNativeVideoError', [
          'Apple player could not start',
          Number(payload.start || payload.startOffset || 0),
          Number(payload.duration || 0),
          Number(payload.playbackToken || 0),
        ]);
        return false;
      }
    },

    playLive(raw) {
      const payload = sanitizeLivePayload(raw);
      try {
        return postNative('play_live', payload);
      } catch {
        callPage('__tvNativeLiveError', ['Apple player could not start Live TV']);
        return false;
      }
    },

    closeVideo() { return control('close'); },
    play() { return control('play'); },
    pause() { return control('pause'); },
    resume() { return control('play'); },
    togglePlay() { return control('toggle'); },
    seekTo(seconds) { return control('seek_absolute', { seconds: Math.max(0, Number(seconds) || 0) }); },
    seekBy(seconds) { return control('seek_relative', { seconds: Number(seconds) || 0 }); },
    playerToast(message) {
      try { return postNative('player_toast', { message: String(message || '').slice(0, 140) }); } catch { return false; }
    },
    updateSubtitleChoices() { return true; },
    updateOtherVersions() { return true; },
    updateActiveSubtitle() { return true; },
    updateVideoDuration() { return true; },
    updateEpisodeChoices() { return true; },
    updateTitleInfo() { return true; },
    showTitleInfo() { return true; },
    hideTitleInfo() { return true; },
    upNext() { return true; },
    upNextHide() { return true; },
    setLiveFav(on) {
      try { return postNative('live_fav', { on: !!on }); } catch { return false; }
    },
    setLiveEpg() { return true; },
  };

  function playerErrorText(event) {
    const raw = event && (event.message || event.error || event.reason);
    const text = String(raw == null ? '' : raw)
      .replace(/https?:\/\/\S+/gi, '[url]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    return text ? 'Apple player error: ' + text : 'Apple player error';
  }

  Object.defineProperty(window, '__triboonApplePlayerEvent', {
    configurable: true,
    value(raw) {
      let event;
      try { event = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
      if (!event || typeof event !== 'object') return;
      const token = Number(event.playbackToken || event.token || 0);
      const pos = Math.max(0, Number(event.position ?? event.pos) || 0);
      const duration = Math.max(0, Number(event.duration) || 0);
      switch (String(event.type || '')) {
        case 'ready': callPage('__tvNativeVideoReady', [pos, duration, token]); break;
        case 'playing': callPage('__tvNativeVideoPlaying', [pos, duration, token]); break;
        case 'paused': callPage('__tvNativeVideoPaused', [pos, duration, token]); break;
        case 'progress': callPage('__tvNativeVideoProgress', [pos, duration, token]); break;
        case 'ended': callPage('__tvNativeVideoEnded', [pos, duration, token]); break;
        case 'closed': callPage('__tvNativeVideoClosed', [pos, duration, !!event.ended, token]); break;
        case 'error': callPage('__tvNativeVideoError', [playerErrorText(event), pos, duration, token]); break;
        case 'live_ready': callPage('__tvNativeLiveReady', []); break;
        case 'live_closed': callPage('__tvNativeLiveClosed', []); break;
        case 'live_error': callPage('__tvNativeLiveError', [playerErrorText(event)]); break;
        case 'live_zap': callPage('__tvNativeLiveZap', [Number(event.direction) >= 0 ? 1 : -1]); break;
        case 'live_fav': callPage('__tvNativeLiveFav', [!!event.on]); break;
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
})();
