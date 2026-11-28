'use strict';

(function (root) {
  function normalizeServerUrl(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';
    if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return '';
    const candidate = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? '' : 'http://' + trimmed);
    if (!candidate) return '';
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (!parsed.hostname) return '';
      if (parsed.username || parsed.password) return '';
      return parsed.origin;
    } catch {
      return '';
    }
  }

  function buildServerLaunchUrl(origin) {
    const clean = normalizeServerUrl(origin);
    if (!clean) return '';
    return clean + '/?triboon_client=tizen';
  }

  function isValidTriboonServerPayload(data) {
    if (!data || typeof data !== 'object') return false;
    if (typeof data.app === 'string' && data.app.toLowerCase() === 'triboon') return true;
    if (typeof data.name === 'string' && data.name.toLowerCase() === 'triboon') return true;
    return typeof data.version === 'string' && /^\d+\.\d+\.\d+/.test(data.version);
  }

  const api = {
    normalizeServerUrl,
    buildServerLaunchUrl,
    isValidTriboonServerPayload,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TriboonTizenUrl = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
