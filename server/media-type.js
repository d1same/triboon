'use strict';
// An IPTV upstream is not ours, and whatever content type it sends is served from Triboon's origin.
// Only media types pass. Anything else, HTML above all, becomes bytes a browser will not run.
const FALLBACK = 'application/octet-stream';
const PLAYLIST_TYPES = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/mpegurl']);

function safeMediaType(value) {
  const raw = String(value || '').trim();
  const type = raw.split(';')[0].trim().toLowerCase();
  if (type === FALLBACK || PLAYLIST_TYPES.has(type)) return raw;
  if (/^(?:video|audio)\/[a-z0-9][a-z0-9.+-]*$/.test(type)) return raw;
  return FALLBACK;
}

module.exports = { safeMediaType };
